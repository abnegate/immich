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
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap

class TusUploadApiImpl(context: Context) : ImmichPlugin(), TusUploadApi {
  companion object {
    const val name = "TusUploadApi"
    private const val CHUNK_SIZE = 5 * 1024 * 1024 // 5MB chunks
  }

  private val ctx: Context = context.applicationContext
  private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
  private val activeUploads = ConcurrentHashMap<String, Job>()
  private var callbackApi: TusUploadCallbackApi? = null

  override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
    super.onAttachedToEngine(binding)
    TusUploadApiSetup.setUp(binding.binaryMessenger, this)
    callbackApi = TusUploadCallbackApi(binding.binaryMessenger)
  }

  override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
    super.onDetachedFromEngine(binding)
    TusUploadApiSetup.setUp(binding.binaryMessenger, null)
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

        val headers = data.headers.toMutableMap()
        headers["Tus-Resumable"] = "1.0.0"
        client.headers = headers

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

        // HTTP headers are case-insensitive, but getHeaderField is case-sensitive
        val assetId = uploader.httpURLConnection?.getHeaderField("X-Immich-Asset-Id")
          ?: uploader.httpURLConnection?.getHeaderField("x-immich-asset-id")

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
    val metadata = mutableMapOf<String, String>()
    metadata["filename"] = encodeBase64(data.filename)
    metadata["deviceAssetId"] = encodeBase64(data.deviceAssetId)
    metadata["deviceId"] = encodeBase64(data.deviceId)
    metadata["fileCreatedAt"] = encodeBase64(data.fileCreatedAt)
    metadata["fileModifiedAt"] = encodeBase64(data.fileModifiedAt)
    metadata["isFavorite"] = encodeBase64(data.isFavorite.toString())

    data.duration?.let { metadata["duration"] = encodeBase64(it) }
    data.livePhotoVideoId?.let { metadata["livePhotoVideoId"] = encodeBase64(it) }

    return metadata
  }

  private fun encodeBase64(value: String): String {
    return Base64.getEncoder().encodeToString(value.toByteArray(Charsets.UTF_8))
  }
}
