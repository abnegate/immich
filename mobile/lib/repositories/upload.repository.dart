import 'dart:convert';
import 'dart:io';

import 'package:background_downloader/background_downloader.dart';
import 'package:cancellation_token_http/http.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/constants/constants.dart';
import 'package:immich_mobile/domain/models/store.model.dart';
import 'package:immich_mobile/entities/store.entity.dart';
import 'package:immich_mobile/repositories/native_tus_upload.repository.dart';
import 'package:logging/logging.dart';
import 'package:immich_mobile/utils/debug_print.dart';

class UploadTaskWithFile {
  final File file;
  final UploadTask task;

  const UploadTaskWithFile({required this.file, required this.task});
}

final uploadRepositoryProvider = Provider((ref) {
  final nativeTusRepository = ref.watch(nativeTusUploadRepositoryProvider);
  return UploadRepository(nativeTusRepository);
});

class UploadRepository {
  final NativeTusUploadRepository nativeTusRepository;
  void Function(TaskStatusUpdate)? onUploadStatus;
  void Function(TaskProgressUpdate)? onTaskProgress;

  UploadRepository(this.nativeTusRepository) {
    FileDownloader().registerCallbacks(
      group: kBackupGroup,
      taskStatusCallback: (update) => onUploadStatus?.call(update),
      taskProgressCallback: (update) => onTaskProgress?.call(update),
    );
    FileDownloader().registerCallbacks(
      group: kBackupLivePhotoGroup,
      taskStatusCallback: (update) => onUploadStatus?.call(update),
      taskProgressCallback: (update) => onTaskProgress?.call(update),
    );
    FileDownloader().registerCallbacks(
      group: kManualUploadGroup,
      taskStatusCallback: (update) => onUploadStatus?.call(update),
      taskProgressCallback: (update) => onTaskProgress?.call(update),
    );
  }

  Future<void> enqueueBackground(UploadTask task) {
    return FileDownloader().enqueue(task);
  }

  Future<List<bool>> enqueueBackgroundAll(List<UploadTask> tasks) {
    return FileDownloader().enqueueAll(tasks);
  }

  Future<void> deleteDatabaseRecords(String group) {
    return FileDownloader().database.deleteAllRecords(group: group);
  }

  Future<bool> cancelAll(String group) {
    return FileDownloader().cancelAll(group: group);
  }

  Future<int> reset(String group) {
    return FileDownloader().reset(group: group);
  }

  /// Get a list of tasks that are ENQUEUED or RUNNING
  Future<List<Task>> getActiveTasks(String group) {
    return FileDownloader().allTasks(group: group);
  }

  Future<void> start() {
    return FileDownloader().start();
  }

  Future<void> getUploadInfo() async {
    final [enqueuedTasks, runningTasks, canceledTasks, waitingTasks, pausedTasks] = await Future.wait([
      FileDownloader().database.allRecordsWithStatus(TaskStatus.enqueued, group: kBackupGroup),
      FileDownloader().database.allRecordsWithStatus(TaskStatus.running, group: kBackupGroup),
      FileDownloader().database.allRecordsWithStatus(TaskStatus.canceled, group: kBackupGroup),
      FileDownloader().database.allRecordsWithStatus(TaskStatus.waitingToRetry, group: kBackupGroup),
      FileDownloader().database.allRecordsWithStatus(TaskStatus.paused, group: kBackupGroup),
    ]);

    dPrint(
      () =>
          """
      Upload Info:
      Enqueued: ${enqueuedTasks.length}
      Running: ${runningTasks.length}
      Canceled: ${canceledTasks.length}
      Waiting: ${waitingTasks.length}
      Paused: ${pausedTasks.length}
    """,
    );
  }

  Future<void> backupWithDartClient(Iterable<UploadTaskWithFile> tasks, CancellationToken cancelToken) async {
    final httpClient = Client();
    final String savedEndpoint = Store.get(StoreKey.serverEndpoint);
    final String deviceId = Store.get(StoreKey.deviceId);

    Logger logger = Logger('UploadRepository');
    for (final candidate in tasks) {
      if (cancelToken.isCancelled) {
        logger.warning("Backup was cancelled by the user");
        break;
      }

      try {
        final fileSize = candidate.file.lengthSync();

        if (fileSize >= kNativeTusUploadThreshold) {
          final metadata = NativeTusUploadMetadata(
            filename: candidate.task.fields['filename'] ?? candidate.task.filename,
            deviceAssetId: candidate.task.fields['deviceAssetId'] ?? '',
            deviceId: deviceId,
            fileCreatedAt: candidate.task.fields['fileCreatedAt'] ?? DateTime.now().toUtc().toIso8601String(),
            fileModifiedAt: candidate.task.fields['fileModifiedAt'] ?? DateTime.now().toUtc().toIso8601String(),
            isFavorite: candidate.task.fields['isFavorite'] == 'true',
            duration: candidate.task.fields['duration'],
            livePhotoVideoId: candidate.task.fields['livePhotoVideoId'],
          );

          // Emit running status when upload starts
          onUploadStatus?.call(TaskStatusUpdate(
            candidate.task,
            TaskStatus.running,
          ));

          final result = await nativeTusRepository.uploadFile(
            candidate.file,
            metadata,
            onProgress: (bytesUploaded, totalBytes) {
              logger.fine('Native tus upload progress: $bytesUploaded / $totalBytes');
              onTaskProgress?.call(TaskProgressUpdate(
                candidate.task,
                bytesUploaded / totalBytes,
                totalBytes,
              ));
            },
          );

          if (result.isSuccess && result.assetId != null) {
            // Emit a TaskStatusUpdate to trigger the backup state update
            final responseBody = jsonEncode({'id': result.assetId, 'status': result.isDuplicate ? 'duplicate' : 'created'});
            final update = TaskStatusUpdate(
              candidate.task,
              TaskStatus.complete,
              null, // exception
              responseBody,
              null, // responseHeaders
              result.isDuplicate ? 200 : 201, // responseStatusCode
            );
            onUploadStatus?.call(update);
            logger.fine('Native tus upload completed for ${candidate.task.filename}: assetId=${result.assetId}');
          } else {
            logger.warning('Native tus upload failed for ${candidate.task.filename}: ${result.error}');
            // Emit a failed status update
            final update = TaskStatusUpdate(
              candidate.task,
              TaskStatus.failed,
              TaskException(result.error ?? 'Unknown error'),
            );
            onUploadStatus?.call(update);
          }
          continue;
        }

        final fileStream = candidate.file.openRead();
        final assetRawUploadData = MultipartFile(
          "assetData",
          fileStream,
          fileSize,
          filename: candidate.task.filename,
        );

        final baseRequest = MultipartRequest('POST', Uri.parse('$savedEndpoint/assets'));

        baseRequest.headers.addAll(candidate.task.headers);
        baseRequest.fields.addAll(candidate.task.fields);
        baseRequest.files.add(assetRawUploadData);

        final response = await httpClient.send(baseRequest, cancellationToken: cancelToken);

        final responseBody = jsonDecode(await response.stream.bytesToString());

        if (![200, 201].contains(response.statusCode)) {
          final error = responseBody;

          logger.warning(
            "Error(${error['statusCode']}) uploading ${candidate.task.filename} | Created on ${candidate.task.fields["fileCreatedAt"]} | ${error['error']}",
          );

          continue;
        }
      } on CancelledException {
        logger.warning("Backup was cancelled by the user");
        break;
      } catch (error, stackTrace) {
        logger.warning("Error backup asset: ${error.toString()}: $stackTrace");
        continue;
      }
    }
  }
}
