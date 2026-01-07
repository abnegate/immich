import Foundation
import Flutter
import TUSKit

class TusUploadApiImpl: NSObject, TusUploadApi, FlutterPlugin {
  static let name = "TusUploadApi"

  private var tusClient: TUSClient?
  private var callbackApi: TusUploadCallbackApi?
  private var activeUploads: [String: UUID] = [:]
  private var uploadIdToDeviceAssetId: [UUID: String] = [:]
  private var currentServerEndpoint: String?

  static func register(with registrar: FlutterPluginRegistrar) {
    let instance = TusUploadApiImpl()
    TusUploadApiSetup.setUp(binaryMessenger: registrar.messenger(), api: instance)
    instance.callbackApi = TusUploadCallbackApi(binaryMessenger: registrar.messenger())
    registrar.publish(instance)
  }

  private func getTusClient(serverEndpoint: String) throws -> TUSClient {
    if let client = tusClient, currentServerEndpoint == serverEndpoint {
      return client
    }

    guard let uploadURL = URL(string: "\(serverEndpoint)/upload") else {
      throw NSError(domain: "TusUploadApiImpl", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid server endpoint"])
    }

    do {
      let client = try TUSClient(
        server: uploadURL,
        sessionIdentifier: "immich-tus-session",
        sessionConfiguration: .default,
        storageDirectory: FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!.appendingPathComponent("tus-uploads"),
        chunkSize: 5 * 1024 * 1024 // 5MB chunks
      )

      client.delegate = self
      tusClient = client
      currentServerEndpoint = serverEndpoint
      return client
    } catch {
      tusClient = nil
      currentServerEndpoint = nil
      throw error
    }
  }

  func startUpload(data: TusUploadData, completion: @escaping (Result<String, Error>) -> Void) {
    do {
      let client = try getTusClient(serverEndpoint: data.serverEndpoint)

      let fileURL = URL(fileURLWithPath: data.filePath)

      var metadata: [String: String] = [:]
      metadata["filename"] = encodeBase64(data.filename)
      metadata["deviceAssetId"] = encodeBase64(data.deviceAssetId)
      metadata["deviceId"] = encodeBase64(data.deviceId)
      metadata["fileCreatedAt"] = encodeBase64(data.fileCreatedAt)
      metadata["fileModifiedAt"] = encodeBase64(data.fileModifiedAt)
      metadata["isFavorite"] = encodeBase64(String(data.isFavorite))

      if let duration = data.duration {
        metadata["duration"] = encodeBase64(duration)
      }
      if let livePhotoVideoId = data.livePhotoVideoId {
        metadata["livePhotoVideoId"] = encodeBase64(livePhotoVideoId)
      }

      var headers: [String: String] = [:]
      for (key, value) in data.headers {
        headers[key] = value
      }

      let uploadId = try client.uploadFileAt(
        filePath: fileURL,
        customHeaders: headers,
        customMetadata: metadata
      )

      activeUploads[data.deviceAssetId] = uploadId
      uploadIdToDeviceAssetId[uploadId] = data.deviceAssetId

      callbackApi?.onStatusChange(
        update: TusStatusUpdate(
          uploadId: data.deviceAssetId,
          status: "uploading",
          assetId: nil,
          error: nil
        )
      ) { _ in }

      completion(.success(data.deviceAssetId))

    } catch {
      completion(.failure(error))
    }
  }

  func cancelUpload(uploadId: String, completion: @escaping (Result<Bool, Error>) -> Void) {
    guard let tusUploadId = activeUploads[uploadId] else {
      completion(.success(false))
      return
    }

    do {
      try tusClient?.cancel(id: tusUploadId)
      activeUploads.removeValue(forKey: uploadId)
      uploadIdToDeviceAssetId.removeValue(forKey: tusUploadId)
      completion(.success(true))
    } catch {
      completion(.failure(error))
    }
  }

  func cancelAllUploads(completion: @escaping (Result<Void, Error>) -> Void) {
    do {
      try tusClient?.cancelAll()
      activeUploads.removeAll()
      uploadIdToDeviceAssetId.removeAll()
      completion(.success(()))
    } catch {
      completion(.failure(error))
    }
  }

  func getUploadOffset(uploadId: String, completion: @escaping (Result<Int64?, Error>) -> Void) {
    // TUSKit doesn't expose offset directly, return nil
    completion(.success(nil))
  }

  func getPendingUploadIds(completion: @escaping (Result<[String], Error>) -> Void) {
    completion(.success(Array(activeUploads.keys)))
  }

  private func encodeBase64(_ value: String) -> String {
    return Data(value.utf8).base64EncodedString()
  }

  private func fetchAssetIdFromServer(uploadId: UUID, client: TUSClient, upload: TUSKit.Upload) async -> String? {
    guard let uploadURL = try? await client.getUploadURL(forUploadId: uploadId) else {
      return nil
    }

    var request = URLRequest(url: uploadURL)
    request.httpMethod = "HEAD"
    request.setValue("1.0.0", forHTTPHeaderField: "Tus-Resumable")

    do {
      let (_, response) = try await URLSession.shared.data(for: request)
      if let httpResponse = response as? HTTPURLResponse {
        return httpResponse.value(forHTTPHeaderField: "X-Immich-Asset-Id")
      }
    } catch {
      NSLog("Failed to fetch asset ID from server: \(error)")
    }

    return nil
  }
}

// MARK: - TUSClientDelegate

extension TusUploadApiImpl: TUSClientDelegate {
  func didStartUpload(id: UUID, client: TUSClient, forUpload upload: TUSKit.Upload, context: [String: String]?) {
    guard let deviceAssetId = uploadIdToDeviceAssetId[id] else { return }

    callbackApi?.onStatusChange(
      update: TusStatusUpdate(
        uploadId: deviceAssetId,
        status: "uploading",
        assetId: nil,
        error: nil
      )
    ) { _ in }
  }

  func didFinishUpload(id: UUID, client: TUSClient, forUpload upload: TUSKit.Upload, context: [String: String]?) {
    guard let deviceAssetId = uploadIdToDeviceAssetId[id] else { return }

    let assetIdFromContext = context?["x-immich-asset-id"] ?? context?["X-Immich-Asset-Id"]

    if let assetId = assetIdFromContext, !assetId.isEmpty {
      completeUpload(deviceAssetId: deviceAssetId, tusId: id, assetId: assetId)
    } else {
      Task {
        let assetId = await fetchAssetIdFromServer(uploadId: id, client: client, upload: upload)
        completeUpload(deviceAssetId: deviceAssetId, tusId: id, assetId: assetId)
      }
    }
  }

  private func completeUpload(deviceAssetId: String, tusId: UUID, assetId: String?) {
    callbackApi?.onStatusChange(
      update: TusStatusUpdate(
        uploadId: deviceAssetId,
        status: "completed",
        assetId: assetId,
        error: nil
      )
    ) { _ in }

    activeUploads.removeValue(forKey: deviceAssetId)
    uploadIdToDeviceAssetId.removeValue(forKey: tusId)
  }

  func uploadFailed(id: UUID, client: TUSClient, forUpload upload: TUSKit.Upload, error: Error, context: [String: String]?) {
    guard let deviceAssetId = uploadIdToDeviceAssetId[id] else { return }

    callbackApi?.onStatusChange(
      update: TusStatusUpdate(
        uploadId: deviceAssetId,
        status: "failed",
        assetId: nil,
        error: error.localizedDescription
      )
    ) { _ in }

    activeUploads.removeValue(forKey: deviceAssetId)
    uploadIdToDeviceAssetId.removeValue(forKey: id)
  }

  func fileError(error: TUSClientError, client: TUSClient) {
    NSLog("TUS file error: \(error.localizedDescription)")
  }

  func totalProgress(bytesUploaded: Int, totalBytes: Int, client: TUSClient) {
    // This is global progress, not per-upload
  }

  func progressFor(id: UUID, bytesUploaded: Int, totalBytes: Int, client: TUSClient) {
    guard let deviceAssetId = uploadIdToDeviceAssetId[id] else { return }

    callbackApi?.onProgress(
      update: TusProgressUpdate(
        uploadId: deviceAssetId,
        bytesUploaded: Int64(bytesUploaded),
        totalBytes: Int64(totalBytes)
      )
    ) { _ in }
  }
}
