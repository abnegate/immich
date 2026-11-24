import Flutter
import Foundation
import TUSKit

class TusUploadApiImpl: NSObject, TusUploadApi, FlutterPlugin, URLSessionTaskDelegate {
  static let name = "TusUploadApi"

  private struct Upload {
    let deviceAssetId: String
    let endpoint: URL
    let client: TUSClient
    let session: URLSession
  }

  private var callbackApi: TusUploadCallbackApi?
  private var uploads: [UUID: Upload] = [:]

  static func register(with registrar: FlutterPluginRegistrar) {
    let instance = TusUploadApiImpl()
    TusUploadApiSetup.setUp(binaryMessenger: registrar.messenger(), api: instance)
    instance.callbackApi = TusUploadCallbackApi(binaryMessenger: registrar.messenger())
    registrar.publish(instance)
  }

  func startUpload(data: TusUploadData, completion: @escaping (Result<String, Error>) -> Void) {
    do {
      guard !uploads.values.contains(where: { $0.deviceAssetId == data.deviceAssetId }) else {
        throw uploadError("Upload is already active")
      }

      guard let endpoint = URL(string: "\(data.serverEndpoint)/upload"),
            let cache = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else {
        throw uploadError("Invalid upload endpoint or cache directory")
      }

      // TUSKit persists per-upload custom headers along with the resume metadata.
      let configuration = URLSessionConfiguration.ephemeral
      configuration.httpAdditionalHeaders = data.headers.filter {
        $0.key.caseInsensitiveCompare("Tus-Resumable") != .orderedSame
      }
      configuration.allowsCellularAccess = !data.requiresWiFi
      configuration.allowsExpensiveNetworkAccess = !data.requiresWiFi
      configuration.waitsForConnectivity = true

      let client = try TUSClient(
        server: endpoint,
        sessionIdentifier: "immich-tus-session",
        sessionConfiguration: configuration,
        storageDirectory: cache.appendingPathComponent("tus-uploads"),
        chunkSize: 50 * 1024 * 1024
      )
      client.delegate = self

      var metadata = [
        "filename": data.filename,
        "deviceAssetId": data.deviceAssetId,
        "deviceId": data.deviceId,
        "fileCreatedAt": data.fileCreatedAt,
        "fileModifiedAt": data.fileModifiedAt,
        "isFavorite": String(data.isFavorite),
      ]
      metadata["duration"] = data.duration
      metadata["livePhotoVideoId"] = data.livePhotoVideoId

      let id = try client.uploadFileAt(filePath: URL(fileURLWithPath: data.filePath), context: metadata)
      let session = URLSession(configuration: configuration, delegate: self, delegateQueue: .main)
      uploads[id] = Upload(deviceAssetId: data.deviceAssetId, endpoint: endpoint, client: client, session: session)
      completion(.success(data.deviceAssetId))
    } catch {
      completion(.failure(error))
    }
  }

  func cancelUpload(uploadId: String, completion: @escaping (Result<Bool, Error>) -> Void) {
    guard let (id, upload) = uploads.first(where: { $0.value.deviceAssetId == uploadId }) else {
      completion(.success(false))
      return
    }

    do {
      try upload.client.cancel(id: id)
      finish(id: id, status: "cancelled")
      completion(.success(true))
    } catch {
      completion(.failure(error))
    }
  }

  func cancelAllUploads(completion: @escaping (Result<Void, Error>) -> Void) {
    for (id, upload) in Array(uploads) {
      upload.client.stopAndCancelAll()
      finish(id: id, status: "cancelled")
    }
    completion(.success(()))
  }

  func getUploadOffset(uploadId: String, completion: @escaping (Result<Int64?, Error>) -> Void) {
    completion(.success(nil))
  }

  func getPendingUploadIds(completion: @escaping (Result<[String], Error>) -> Void) {
    completion(.success(uploads.values.map(\.deviceAssetId)))
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) {
    completionHandler(nil)
  }

  private func uploadError(_ message: String) -> NSError {
    NSError(domain: Self.name, code: 1, userInfo: [NSLocalizedDescriptionKey: message])
  }

  private func isSameOrigin(_ url: URL, as endpoint: URL) -> Bool {
    url.scheme == endpoint.scheme && url.host == endpoint.host &&
      (url.port ?? (url.scheme == "https" ? 443 : 80)) ==
      (endpoint.port ?? (endpoint.scheme == "https" ? 443 : 80))
  }

  private func finish(id: UUID, status: String, assetId: String? = nil, isDuplicate: Bool? = nil, error: String? = nil) {
    guard let upload = uploads.removeValue(forKey: id) else { return }
    upload.session.invalidateAndCancel()
    callbackApi?.onStatusChange(
      update: TusStatusUpdate(
        uploadId: upload.deviceAssetId,
        status: status,
        assetId: assetId,
        isDuplicate: isDuplicate,
        error: error
      )
    ) { _ in }
  }
}

extension TusUploadApiImpl: TUSClientDelegate {
  func didStartUpload(id: UUID, context: [String: String]?, client: TUSClient) {
    guard let upload = uploads[id] else { return }
    callbackApi?.onStatusChange(update: TusStatusUpdate(uploadId: upload.deviceAssetId, status: "uploading")) { _ in }
  }

  func didFinishUpload(id: UUID, url: URL, context: [String: String]?, client: TUSClient) {
    guard let upload = uploads[id] else { return }
    guard isSameOrigin(url, as: upload.endpoint) else {
      finish(id: id, status: "failed", error: "Upload URL changed origin")
      return
    }

    var request = URLRequest(url: url)
    request.httpMethod = "HEAD"
    request.setValue("1.0.0", forHTTPHeaderField: "Tus-Resumable")
    upload.session.dataTask(with: request) { [weak self] _, response, error in
      guard let self else { return }
      if let error {
        self.finish(id: id, status: "failed", error: error.localizedDescription)
        return
      }
      guard let response = response as? HTTPURLResponse, (200...299).contains(response.statusCode),
            let assetId = response.value(forHTTPHeaderField: "X-Immich-Asset-Id"), !assetId.isEmpty,
            let duplicate = response.value(forHTTPHeaderField: "X-Immich-Duplicate"),
            let isDuplicate = Bool(duplicate) else {
        self.finish(id: id, status: "failed", error: "The server returned no upload result")
        return
      }
      self.finish(id: id, status: "completed", assetId: assetId, isDuplicate: isDuplicate)
    }.resume()
  }

  func uploadFailed(id: UUID, error: Error, context: [String: String]?, client: TUSClient) {
    finish(id: id, status: "failed", error: error.localizedDescription)
  }

  func fileError(error: TUSClientError, client: TUSClient) {
    NSLog("TUS file error: %@", error.localizedDescription)
  }

  func totalProgress(bytesUploaded: Int, totalBytes: Int, client: TUSClient) {}

  func progressFor(id: UUID, context: [String: String]?, bytesUploaded: Int, totalBytes: Int, client: TUSClient) {
    guard let upload = uploads[id] else { return }
    callbackApi?.onProgress(
      update: TusProgressUpdate(
        uploadId: upload.deviceAssetId,
        bytesUploaded: Int64(bytesUploaded),
        totalBytes: Int64(totalBytes)
      )
    ) { _ in }
  }
}
