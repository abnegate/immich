import 'dart:async';
import 'dart:io';

import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/store.model.dart';
import 'package:immich_mobile/entities/store.entity.dart';
import 'package:immich_mobile/platform/tus_upload_api.g.dart';
import 'package:immich_mobile/services/api.service.dart';
import 'package:logging/logging.dart';

final nativeTusUploadRepositoryProvider = Provider((ref) {
  final repository = NativeTusUploadRepository._internal();
  ref.onDispose(() => repository.dispose());
  return repository;
});

const int kNativeTusUploadThreshold = 10 * 1024 * 1024;

class NativeTusUploadResult {
  final String? assetId;
  final bool isDuplicate;
  final String? error;

  const NativeTusUploadResult({this.assetId, this.isDuplicate = false, this.error});

  bool get isSuccess => assetId != null && error == null;
}

class NativeTusUploadMetadata {
  final String filename;
  final String deviceAssetId;
  final String deviceId;
  final String fileCreatedAt;
  final String fileModifiedAt;
  final bool isFavorite;
  final String? duration;
  final String? livePhotoVideoId;

  const NativeTusUploadMetadata({
    required this.filename,
    required this.deviceAssetId,
    required this.deviceId,
    required this.fileCreatedAt,
    required this.fileModifiedAt,
    this.isFavorite = false,
    this.duration,
    this.livePhotoVideoId,
  });
}

/// Callback implementation that forwards events to streams
class _TusUploadCallbackHandler extends TusUploadCallbackApi {
  final StreamController<TusProgressUpdate> progressController;
  final StreamController<TusStatusUpdate> statusController;

  _TusUploadCallbackHandler({
    required this.progressController,
    required this.statusController,
  });

  @override
  void onProgress(TusProgressUpdate update) {
    if (!progressController.isClosed) {
      progressController.add(update);
    }
  }

  @override
  void onStatusChange(TusStatusUpdate update) {
    if (!statusController.isClosed) {
      statusController.add(update);
    }
  }
}

class NativeTusUploadRepository {
  final Logger _logger = Logger('NativeTusUploadRepository');
  final TusUploadApi _api = TusUploadApi();

  final StreamController<TusProgressUpdate> _progressController =
      StreamController<TusProgressUpdate>.broadcast();
  final StreamController<TusStatusUpdate> _statusController =
      StreamController<TusStatusUpdate>.broadcast();

  Stream<TusProgressUpdate> get progressStream => _progressController.stream;
  Stream<TusStatusUpdate> get statusStream => _statusController.stream;

  NativeTusUploadRepository._internal() {
    _setupCallbacks();
  }

  void _setupCallbacks() {
    final handler = _TusUploadCallbackHandler(
      progressController: _progressController,
      statusController: _statusController,
    );
    TusUploadCallbackApi.setUp(handler);
  }

  void dispose() {
    TusUploadCallbackApi.setUp(null);
    _progressController.close();
    _statusController.close();
  }

  Future<NativeTusUploadResult> uploadFile(
    File file,
    NativeTusUploadMetadata metadata, {
    void Function(int bytesUploaded, int totalBytes)? onProgress,
  }) async {
    final serverEndpoint = Store.get(StoreKey.serverEndpoint);
    final headers = ApiService.getRequestHeaders();

    final data = TusUploadData(
      filePath: file.path,
      filename: metadata.filename,
      serverEndpoint: serverEndpoint,
      headers: headers,
      deviceAssetId: metadata.deviceAssetId,
      deviceId: metadata.deviceId,
      fileCreatedAt: metadata.fileCreatedAt,
      fileModifiedAt: metadata.fileModifiedAt,
      isFavorite: metadata.isFavorite,
      duration: metadata.duration,
      livePhotoVideoId: metadata.livePhotoVideoId,
    );

    StreamSubscription<TusProgressUpdate>? progressSubscription;
    StreamSubscription<TusStatusUpdate>? statusSubscription;
    final completer = Completer<NativeTusUploadResult>();

    try {
      if (onProgress != null) {
        progressSubscription = progressStream
            .where((update) => update.uploadId == metadata.deviceAssetId)
            .listen((update) {
          onProgress(update.bytesUploaded.toInt(), update.totalBytes.toInt());
        });
      }

      statusSubscription = statusStream
          .where((update) => update.uploadId == metadata.deviceAssetId)
          .listen((update) {
        switch (update.status) {
          case 'completed':
            if (!completer.isCompleted) {
              completer.complete(NativeTusUploadResult(assetId: update.assetId));
            }
            break;
          case 'failed':
            if (!completer.isCompleted) {
              completer.complete(NativeTusUploadResult(error: update.error ?? 'Upload failed'));
            }
            break;
          case 'cancelled':
            if (!completer.isCompleted) {
              completer.complete(const NativeTusUploadResult(error: 'Upload cancelled'));
            }
            break;
          default:
            // uploading - do nothing, wait for completion
            break;
        }
      });

      await _api.startUpload(data);

      // Resumable uploads can take a long time for large files on slow connections,
      // but we need some upper bound to prevent hanging uploads
      return await completer.future.timeout(
        const Duration(hours: 4),
        onTimeout: () => const NativeTusUploadResult(error: 'Upload timed out after 4 hours'),
      );
    } catch (e) {
      _logger.severe('Native tus upload failed: $e');
      return NativeTusUploadResult(error: e.toString());
    } finally {
      await progressSubscription?.cancel();
      await statusSubscription?.cancel();
    }
  }

  /// Cancel an ongoing upload
  Future<bool> cancelUpload(String uploadId) async {
    try {
      return await _api.cancelUpload(uploadId);
    } catch (e) {
      _logger.warning('Failed to cancel upload: $e');
      return false;
    }
  }

  /// Cancel all ongoing uploads
  Future<void> cancelAllUploads() async {
    try {
      await _api.cancelAllUploads();
    } catch (e) {
      _logger.warning('Failed to cancel all uploads: $e');
    }
  }

  /// Get pending upload IDs
  Future<List<String>> getPendingUploadIds() async {
    try {
      return await _api.getPendingUploadIds();
    } catch (e) {
      _logger.warning('Failed to get pending upload IDs: $e');
      return [];
    }
  }
}
