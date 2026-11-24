import 'dart:async';
import 'dart:io';

import 'package:cancellation_token/cancellation_token.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/store.model.dart';
import 'package:immich_mobile/domain/services/store.service.dart';
import 'package:immich_mobile/infrastructure/repositories/store.repository.dart';
import 'package:immich_mobile/platform/tus_upload_api.g.dart';
import 'package:immich_mobile/repositories/native_tus_upload.repository.dart';
import 'package:mocktail/mocktail.dart';

class MockStoreRepository extends Mock implements IStoreRepository {}

class MockFile extends Mock implements File {
  @override
  String get path => '/test/path/image.jpg';

  @override
  int lengthSync() => 10 * 1024 * 1024; // 10MB
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  const namespace = 'dev.flutter.pigeon.immich_mobile';
  const start = BasicMessageChannel<Object?>('$namespace.TusUploadApi.startUpload', TusUploadApi.pigeonChannelCodec);
  const cancel = BasicMessageChannel<Object?>('$namespace.TusUploadApi.cancelUpload', TusUploadApi.pigeonChannelCodec);
  final store = MockStoreRepository();
  const metadata = NativeTusUploadMetadata(
    filename: 'video.mp4',
    deviceAssetId: 'device-asset-id',
    deviceId: 'device-id',
    fileCreatedAt: '2023-01-01T00:00:00.000Z',
    fileModifiedAt: '2023-01-01T00:00:00.000Z',
  );

  Future<void> emitStatus(TusStatusUpdate status) async {
    await messenger.handlePlatformMessage(
      '$namespace.TusUploadCallbackApi.onStatusChange',
      TusUploadCallbackApi.pigeonChannelCodec.encodeMessage([status]),
      null,
    );
  }

  setUpAll(() async {
    when(store.getAll).thenAnswer(
      (_) async => const [
        StoreDto(StoreKey.serverEndpoint, 'https://immich.example/api'),
        StoreDto(StoreKey.accessToken, 'test-token'),
      ],
    );
    await StoreService.init(storeRepository: store, listenUpdates: false);
  });

  group('uploadFile', () {
    late ProviderContainer container;
    late NativeTusUploadRepository repository;
    late Completer<TusUploadData> started;

    setUp(() {
      container = ProviderContainer();
      repository = container.read(nativeTusUploadRepositoryProvider);
      started = Completer<TusUploadData>();
      messenger.setMockDecodedMessageHandler(start, (message) async {
        started.complete((message as List<Object?>).single! as TusUploadData);
        return [metadata.deviceAssetId];
      });
    });

    tearDown(() {
      messenger.setMockDecodedMessageHandler(start, null);
      messenger.setMockDecodedMessageHandler(cancel, null);
      container.dispose();
    });

    test('fails when completion has no asset ID', () async {
      final result = repository.uploadFile(MockFile(), metadata);
      await started.future;
      await emitStatus(TusStatusUpdate(uploadId: metadata.deviceAssetId, status: 'completed'));

      expect((await result).error, 'The server returned no asset ID for the completed upload');
    });

    test('returns the server asset ID and duplicate status', () async {
      final result = repository.uploadFile(MockFile(), metadata, requiresWiFi: true);
      final request = await started.future;
      expect(request.requiresWiFi, true);
      expect(request.headers['x-immich-user-token'], 'test-token');

      await emitStatus(
        TusStatusUpdate(
          uploadId: metadata.deviceAssetId,
          status: 'completed',
          assetId: 'existing-server-asset',
          isDuplicate: true,
        ),
      );

      final completed = await result;
      expect(completed.isSuccess, true);
      expect(completed.assetId, 'existing-server-asset');
      expect(completed.isDuplicate, true);
    });

    test('cancels the active native upload when the backup token is cancelled', () async {
      final token = CancellationToken();
      final cancelled = Completer<String>();
      messenger.setMockDecodedMessageHandler(cancel, (message) async {
        cancelled.complete((message as List<Object?>).single! as String);
        return [true];
      });

      final result = repository.uploadFile(MockFile(), metadata, cancellationToken: token);
      await started.future;
      token.cancel();

      expect(await cancelled.future, metadata.deviceAssetId);
      final failure = await result;
      expect(failure.isCancelled, true);
      expect(failure.isSuccess, false);
    });
  });

  group('NativeTusUploadMetadata', () {
    test('should create metadata with required fields', () {
      const metadata = NativeTusUploadMetadata(
        filename: 'test.jpg',
        deviceAssetId: 'device-asset-id',
        deviceId: 'device-id',
        fileCreatedAt: '2023-01-01T00:00:00.000Z',
        fileModifiedAt: '2023-01-01T00:00:00.000Z',
      );

      expect(metadata.filename, 'test.jpg');
      expect(metadata.deviceAssetId, 'device-asset-id');
      expect(metadata.deviceId, 'device-id');
      expect(metadata.fileCreatedAt, '2023-01-01T00:00:00.000Z');
      expect(metadata.fileModifiedAt, '2023-01-01T00:00:00.000Z');
      expect(metadata.isFavorite, false);
      expect(metadata.duration, isNull);
      expect(metadata.livePhotoVideoId, isNull);
    });

    test('should create metadata with optional fields', () {
      const metadata = NativeTusUploadMetadata(
        filename: 'video.mp4',
        deviceAssetId: 'device-asset-id',
        deviceId: 'device-id',
        fileCreatedAt: '2023-01-01T00:00:00.000Z',
        fileModifiedAt: '2023-01-01T00:00:00.000Z',
        isFavorite: true,
        duration: '10.5',
        livePhotoVideoId: 'video-id',
      );

      expect(metadata.filename, 'video.mp4');
      expect(metadata.isFavorite, true);
      expect(metadata.duration, '10.5');
      expect(metadata.livePhotoVideoId, 'video-id');
    });
  });

  group('NativeTusUploadResult', () {
    test('should create success result with assetId', () {
      const result = NativeTusUploadResult(assetId: 'asset-123');

      expect(result.isSuccess, true);
      expect(result.assetId, 'asset-123');
      expect(result.isDuplicate, false);
      expect(result.error, isNull);
    });

    test('should create failure result with error', () {
      const result = NativeTusUploadResult(error: 'Upload failed');

      expect(result.isSuccess, false);
      expect(result.assetId, isNull);
      expect(result.error, 'Upload failed');
    });

    test('should create duplicate result', () {
      const result = NativeTusUploadResult(assetId: 'existing-asset', isDuplicate: true);

      expect(result.isSuccess, true);
      expect(result.assetId, 'existing-asset');
      expect(result.isDuplicate, true);
    });

    test('isSuccess should be false when assetId is null', () {
      const result = NativeTusUploadResult(assetId: null);

      expect(result.isSuccess, false);
    });

    test('isSuccess should be false when error is present', () {
      const result = NativeTusUploadResult(assetId: 'asset-123', error: 'Some error');

      expect(result.isSuccess, false);
    });
  });

  group('TusProgressUpdate handling', () {
    test('should correctly construct progress update', () {
      final update = TusProgressUpdate(uploadId: 'upload-123', bytesUploaded: 5000, totalBytes: 10000);

      expect(update.uploadId, 'upload-123');
      expect(update.bytesUploaded, 5000);
      expect(update.totalBytes, 10000);
    });
  });

  group('TusStatusUpdate handling', () {
    test('should correctly construct status update for uploading', () {
      final update = TusStatusUpdate(uploadId: 'upload-123', status: 'uploading', assetId: null, error: null);

      expect(update.uploadId, 'upload-123');
      expect(update.status, 'uploading');
      expect(update.assetId, isNull);
      expect(update.error, isNull);
    });

    test('should correctly construct status update for completed', () {
      final update = TusStatusUpdate(uploadId: 'upload-123', status: 'completed', assetId: 'asset-456', error: null);

      expect(update.uploadId, 'upload-123');
      expect(update.status, 'completed');
      expect(update.assetId, 'asset-456');
      expect(update.error, isNull);
    });

    test('should correctly construct status update for failed', () {
      final update = TusStatusUpdate(uploadId: 'upload-123', status: 'failed', assetId: null, error: 'Network error');

      expect(update.uploadId, 'upload-123');
      expect(update.status, 'failed');
      expect(update.assetId, isNull);
      expect(update.error, 'Network error');
    });

    test('should correctly construct status update for cancelled', () {
      final update = TusStatusUpdate(uploadId: 'upload-123', status: 'cancelled', assetId: null, error: null);

      expect(update.uploadId, 'upload-123');
      expect(update.status, 'cancelled');
    });
  });

  group('kNativeTusUploadThreshold', () {
    test('should be 50MB', () {
      expect(kNativeTusUploadThreshold, 50 * 1024 * 1024);
    });
  });
}
