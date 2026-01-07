import 'package:pigeon/pigeon.dart';

@ConfigurePigeon(
  PigeonOptions(
    dartOut: 'lib/platform/tus_upload_api.g.dart',
    swiftOut: 'ios/Runner/Upload/TusUpload.g.swift',
    kotlinOut:
        'android/app/src/main/kotlin/app/alextran/immich/upload/TusUpload.g.kt',
    kotlinOptions: KotlinOptions(package: 'app.alextran.immich.upload'),
    dartPackageName: 'immich_mobile',
  ),
)

/// Metadata for tus upload
class TusUploadData {
  const TusUploadData({
    required this.filePath,
    required this.filename,
    required this.serverEndpoint,
    required this.headers,
    required this.deviceAssetId,
    required this.deviceId,
    required this.fileCreatedAt,
    required this.fileModifiedAt,
    required this.isFavorite,
    this.duration,
    this.livePhotoVideoId,
  });

  final String filePath;
  final String filename;
  final String serverEndpoint;
  final Map<String, String> headers;
  final String deviceAssetId;
  final String deviceId;
  final String fileCreatedAt;
  final String fileModifiedAt;
  final bool isFavorite;
  final String? duration;
  final String? livePhotoVideoId;
}

/// Progress update for tus upload
class TusProgressUpdate {
  const TusProgressUpdate({
    required this.uploadId,
    required this.bytesUploaded,
    required this.totalBytes,
  });

  final String uploadId;
  final int bytesUploaded;
  final int totalBytes;
}

/// Status update for tus upload
class TusStatusUpdate {
  const TusStatusUpdate({
    required this.uploadId,
    required this.status,
    this.assetId,
    this.error,
  });

  final String uploadId;
  final String status; // 'uploading', 'completed', 'failed', 'cancelled'
  final String? assetId;
  final String? error;
}

/// Host API for tus upload operations (Dart calls native)
@HostApi()
abstract class TusUploadApi {
  /// Upload a file using the tus protocol
  /// Returns the upload ID that can be used to track progress or cancel
  @async
  String startUpload(TusUploadData data);

  /// Cancel an ongoing upload
  @async
  bool cancelUpload(String uploadId);

  /// Cancel all ongoing uploads
  @async
  void cancelAllUploads();

  /// Get the current offset of an upload (for resumption)
  @async
  int? getUploadOffset(String uploadId);

  /// Check if there are any pending uploads that can be resumed
  @async
  List<String> getPendingUploadIds();
}

/// Flutter API for receiving upload callbacks (native calls Dart)
@FlutterApi()
abstract class TusUploadCallbackApi {
  /// Called when upload progress changes
  void onProgress(TusProgressUpdate update);

  /// Called when upload status changes
  void onStatusChange(TusStatusUpdate update);
}
