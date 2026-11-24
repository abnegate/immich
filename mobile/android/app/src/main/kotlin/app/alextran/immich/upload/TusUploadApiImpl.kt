package app.alextran.immich.upload

import android.content.Context
import app.alextran.immich.connectivity.ConnectivityApiImpl
import app.alextran.immich.connectivity.NetworkCapability
import app.alextran.immich.core.ImmichPlugin
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.tus.java.client.ProtocolException
import io.tus.java.client.TusClient
import io.tus.java.client.TusUpload
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap

class TusUploadApiImpl(
  context: Context,
) : ImmichPlugin(),
  TusUploadApi {
  companion object {
    private const val BUFFER_SIZE = 2 * 1024 * 1024
    private const val REQUEST_PAYLOAD_SIZE = 10 * 1024 * 1024
    private const val RESPONSE_TIMEOUT_MS = 30_000
  }

  private val context = context.applicationContext
  private val connectivity = ConnectivityApiImpl(this.context)
  private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
  private val activeUploads = ConcurrentHashMap<String, Job>()
  private var callbackApi: TusUploadCallbackApi? = null

  override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
    super.onAttachedToEngine(binding)
    TusUploadApi.setUp(binding.binaryMessenger, this)
    callbackApi = TusUploadCallbackApi(binding.binaryMessenger)
  }

  override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
    super.onDetachedFromEngine(binding)
    TusUploadApi.setUp(binding.binaryMessenger, null)
    cancelAllUploadsSync()
    scope.cancel()
    callbackApi = null
  }

  override fun startUpload(
    data: TusUploadData,
    callback: (Result<String>) -> Unit,
  ) {
    val uploadId = data.deviceAssetId

    val job =
      scope.launch(start = CoroutineStart.LAZY) {
        try {
          val file = File(data.filePath)
          check(file.isFile) { "File not found: ${data.filePath}" }
          requireUnmeteredNetwork(data.requiresWiFi)

          val endpoint = URL("${data.serverEndpoint}/upload")
          val store = TusPreferencesURLStore(context, "${data.serverEndpoint}:$uploadId")
          val client =
            object : TusClient() {
              override fun prepareConnection(connection: HttpURLConnection) {
                check(
                  connection.url.protocol == endpoint.protocol && connection.url.host == endpoint.host &&
                    connection.url.effectivePort == endpoint.effectivePort,
                ) { "Upload URL changed origin" }
                super.prepareConnection(connection)
                connection.instanceFollowRedirects = false
                connection.readTimeout = RESPONSE_TIMEOUT_MS
              }
            }.apply {
              uploadCreationURL = endpoint
              enableResuming(store)
              headers = data.headers.filterKeys { !it.equals("Tus-Resumable", ignoreCase = true) }
            }
          val upload =
            TusUpload(file).apply {
              metadata = buildMetadata(data)
            }

          reportStatus(TusStatusUpdate(uploadId = uploadId, status = "uploading"))
          val uploader =
            try {
              client.resumeOrCreateUpload(upload)
            } catch (error: ProtocolException) {
              if (error.causingConnection?.responseCode != 410) throw error
              store.clear()
              client.createUpload(upload)
            }
          try {
            uploader.chunkSize = BUFFER_SIZE
            uploader.requestPayloadSize = REQUEST_PAYLOAD_SIZE

            while (uploader.offset < upload.size) {
              currentCoroutineContext().ensureActive()
              requireUnmeteredNetwork(data.requiresWiFi)
              if (uploader.uploadChunk() <= 0) throw IOException("Upload file ended before the expected size")

              withContext(Dispatchers.Main) {
                callbackApi?.onProgress(TusProgressUpdate(uploadId, uploader.offset, upload.size)) {}
              }
            }
          } finally {
            uploader.finish()
          }

          currentCoroutineContext().ensureActive()
          requireUnmeteredNetwork(data.requiresWiFi)
          val result = fetchUploadResult(client, uploader.uploadURL)
          store.clear()
          reportStatus(TusStatusUpdate(uploadId, "completed", result.assetId, result.isDuplicate))
        } catch (_: CancellationException) {
          reportStatus(TusStatusUpdate(uploadId = uploadId, status = "cancelled"))
        } catch (error: Exception) {
          val status = if (currentCoroutineContext()[Job]?.isCancelled == true) "cancelled" else "failed"
          reportStatus(TusStatusUpdate(uploadId = uploadId, status = status, error = error.message))
        }
      }

    if (activeUploads.putIfAbsent(uploadId, job) != null) {
      job.cancel()
      callback(Result.failure(IllegalStateException("Upload is already active")))
      return
    }
    job.invokeOnCompletion { activeUploads.remove(uploadId, job) }
    callback(Result.success(uploadId))
    job.start()
  }

  private suspend fun reportStatus(update: TusStatusUpdate) =
    withContext(Dispatchers.Main + NonCancellable) {
      callbackApi?.onStatusChange(update) {}
    }

  private fun requireUnmeteredNetwork(required: Boolean) {
    if (required && NetworkCapability.UNMETERED !in connectivity.getCapabilities()) {
      throw IOException("An unmetered connection is required to upload this file")
    }
  }

  private val URL.effectivePort: Int
    get() = if (port == -1) defaultPort else port

  override fun cancelUpload(
    uploadId: String,
    callback: (Result<Boolean>) -> Unit,
  ) {
    val job = activeUploads[uploadId]
    if (job != null) {
      job.cancel()
      callback(Result.success(true))
    } else {
      callback(Result.success(false))
    }
  }

  override fun cancelAllUploads(callback: (Result<Unit>) -> Unit) {
    cancelAllUploadsSync()
    callback(Result.success(Unit))
  }

  private fun cancelAllUploadsSync() {
    activeUploads.values.forEach { it.cancel() }
  }

  override fun getUploadOffset(
    uploadId: String,
    callback: (Result<Long?>) -> Unit,
  ) {
    callback(Result.success(null))
  }

  override fun getPendingUploadIds(callback: (Result<List<String>>) -> Unit) {
    callback(Result.success(activeUploads.keys.toList()))
  }

  private fun buildMetadata(data: TusUploadData): Map<String, String> {
    // Note: Do NOT Base64 encode values here - tus-java-client handles encoding automatically
    val metadata = mutableMapOf<String, String>()
    metadata["filename"] = data.filename
    metadata["deviceAssetId"] = data.deviceAssetId
    metadata["deviceId"] = data.deviceId
    metadata["fileCreatedAt"] = data.fileCreatedAt
    metadata["fileModifiedAt"] = data.fileModifiedAt
    metadata["isFavorite"] = data.isFavorite.toString()

    data.duration?.let { metadata["duration"] = it }
    data.livePhotoVideoId?.let { metadata["livePhotoVideoId"] = it }

    return metadata
  }

  private data class UploadResult(
    val assetId: String,
    val isDuplicate: Boolean,
  )

  private fun fetchUploadResult(
    client: TusClient,
    uploadUrl: URL,
  ): UploadResult {
    val connection = uploadUrl.openConnection() as HttpURLConnection
    try {
      connection.requestMethod = "HEAD"
      client.prepareConnection(connection)
      val status = connection.responseCode
      check(status in 200..299) { "Upload completion request failed with status $status" }
      val assetId = connection.getHeaderField("X-Immich-Asset-Id")
      val duplicate = connection.getHeaderField("X-Immich-Duplicate")
      check(!assetId.isNullOrBlank() && (duplicate == "true" || duplicate == "false")) { "The server returned no upload result" }
      return UploadResult(assetId, duplicate == "true")
    } finally {
      connection.disconnect()
    }
  }
}
