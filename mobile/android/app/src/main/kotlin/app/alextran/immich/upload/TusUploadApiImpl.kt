package app.alextran.immich.upload

import android.content.Context
import app.alextran.immich.core.ImmichPlugin
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.BinaryMessenger
import io.tus.java.client.TusClient
import io.tus.java.client.TusUpload
import io.tus.java.client.TusUploader
import kotlinx.coroutines.*
import java.io.File
import java.net.URL
import java.util.concurrent.ConcurrentHashMap

class TusUploadApiImpl(context: Context) : ImmichPlugin(), TusUploadApi {
  companion object {
    const val name = "TusUploadApi"
    private const val CHUNK_SIZE = 50 * 1024 * 1024 // 50MB chunks for better performance
  }

  private val ctx: Context = context.applicationContext
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

  override fun startUpload(data: TusUploadData, callback: (Result<String>) -> Unit) {
    val uploadId = data.deviceAssetId

    val job = scope.launch {
      try {
        val file = File(data.filePath)
        if (!file.exists()) {
          callback(Result.failure(Exception("File not found: ${data.filePath}")))
          return@launch
        }

        val client = TusClient().apply {
          uploadCreationURL = URL("${data.serverEndpoint}/upload")
          enableResuming(TusPreferencesURLStore(ctx, uploadId))
        }

        // Note: Do NOT set Tus-Resumable here - tus-java-client sets it automatically
        // Setting it twice results in "1.0.0, 1.0.0" which fails validation
        client.headers = data.headers

        val upload = TusUpload(file).apply {
          // Set metadata
          metadata = buildMetadata(data)
        }

        withContext(Dispatchers.Main) {
          callbackApi?.onStatusChange(
            TusStatusUpdate(
              uploadId = uploadId,
              status = "uploading",
              assetId = null,
              error = null
            )
          ) {}
        }

        val uploader = client.resumeOrCreateUpload(upload)
        uploader.chunkSize = CHUNK_SIZE

        var bytesUploaded = uploader.offset
        val totalBytes = upload.size

        while (uploader.uploadChunk() > -1) {
          val job = activeUploads[uploadId]
          if (job == null || !job.isActive) {
            uploader.finish()
            throw CancellationException("Upload cancelled")
          }

          bytesUploaded = uploader.offset

          withContext(Dispatchers.Main) {
            callbackApi?.onProgress(
              TusProgressUpdate(
                uploadId = uploadId,
                bytesUploaded = bytesUploaded,
                totalBytes = totalBytes
              )
            ) {}
          }
        }

        uploader.finish()

        // Fetch asset ID from server via HEAD request using the upload URL from uploader
        val assetId = fetchAssetIdFromServer(uploader.uploadURL, data.headers)

        val urlStore = TusPreferencesURLStore(ctx, uploadId)
        urlStore.clear()

        withContext(Dispatchers.Main) {
          callbackApi?.onStatusChange(
            TusStatusUpdate(
              uploadId = uploadId,
              status = "completed",
              assetId = assetId,
              error = null
            )
          ) {}
        }

        callback(Result.success(uploadId))

      } catch (e: CancellationException) {
        callback(Result.failure(Exception("Upload cancelled")))
        withContext(Dispatchers.Main) {
          callbackApi?.onStatusChange(
            TusStatusUpdate(
              uploadId = uploadId,
              status = "cancelled",
              assetId = null,
              error = "Upload cancelled"
            )
          ) {}
        }
      } catch (e: Exception) {
        callback(Result.failure(e))
        withContext(Dispatchers.Main) {
          callbackApi?.onStatusChange(
            TusStatusUpdate(
              uploadId = uploadId,
              status = "failed",
              assetId = null,
              error = e.message
            )
          ) {}
        }
      } finally {
        activeUploads.remove(uploadId)
      }
    }

    activeUploads[uploadId] = job
  }

  override fun cancelUpload(uploadId: String, callback: (Result<Boolean>) -> Unit) {
    val job = activeUploads[uploadId]
    if (job != null) {
      job.cancel()
      activeUploads.remove(uploadId)
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
    activeUploads.clear()
  }

  override fun getUploadOffset(uploadId: String, callback: (Result<Long?>) -> Unit) {
    scope.launch {
      try {
        val urlStore = TusPreferencesURLStore(ctx, uploadId)
        val url = urlStore.get(uploadId)
        if (url != null) {
          // We would need to make a HEAD request to get the offset
          callback(Result.success(null))
        } else {
          callback(Result.success(null))
        }
      } catch (e: Exception) {
        callback(Result.success(null))
      }
    }
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

  private fun fetchAssetIdFromServer(
    uploadUrl: URL?,
    headers: Map<String, String>
  ): String? {
    if (uploadUrl == null) return null
    return try {
      val connection = uploadUrl.openConnection() as java.net.HttpURLConnection
      connection.requestMethod = "HEAD"
      connection.setRequestProperty("Tus-Resumable", "1.0.0")
      headers.forEach { (key, value) -> connection.setRequestProperty(key, value) }
      connection.connect()

      val assetId = connection.getHeaderField("X-Immich-Asset-Id")
        ?: connection.getHeaderField("x-immich-asset-id")

      connection.disconnect()
      assetId
    } catch (e: Exception) {
      null
    }
  }
}
