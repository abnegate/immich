import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/platform/tus_upload_api.g.dart';
import 'package:immich_mobile/repositories/native_tus_upload.repository.dart';
import 'package:mocktail/mocktail.dart';

class MockTusUploadApi extends Mock implements TusUploadApi {}

class MockFile extends Mock implements File {
  @override
  String get path => '/test/path/image.jpg';

  @override
  int lengthSync() => 10 * 1024 * 1024; // 10MB
}

void main() {
  setUpAll(() {
    registerFallbackValue(TusUploadData(
      filePath: '/test/path',
      filename: 'test.jpg',
      serverEndpoint: 'http://test.com',
      headers: {},
      deviceAssetId: 'device-asset-id',
      deviceId: 'device-id',
      fileCreatedAt: '2023-01-01T00:00:00.000Z',
      fileModifiedAt: '2023-01-01T00:00:00.000Z',
      isFavorite: false,
    ));
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
      const result = NativeTusUploadResult(
        assetId: 'existing-asset',
        isDuplicate: true,
      );

      expect(result.isSuccess, true);
      expect(result.assetId, 'existing-asset');
      expect(result.isDuplicate, true);
    });

    test('isSuccess should be false when assetId is null', () {
      const result = NativeTusUploadResult(assetId: null);

      expect(result.isSuccess, false);
    });

    test('isSuccess should be false when error is present', () {
      const result = NativeTusUploadResult(
        assetId: 'asset-123',
        error: 'Some error',
      );

      expect(result.isSuccess, false);
    });
  });

  group('TusProgressUpdate handling', () {
    test('should correctly construct progress update', () {
      final update = TusProgressUpdate(
        uploadId: 'upload-123',
        bytesUploaded: 5000,
        totalBytes: 10000,
      );

      expect(update.uploadId, 'upload-123');
      expect(update.bytesUploaded, 5000);
      expect(update.totalBytes, 10000);
    });
  });

  group('TusStatusUpdate handling', () {
    test('should correctly construct status update for uploading', () {
      final update = TusStatusUpdate(
        uploadId: 'upload-123',
        status: 'uploading',
        assetId: null,
        error: null,
      );

      expect(update.uploadId, 'upload-123');
      expect(update.status, 'uploading');
      expect(update.assetId, isNull);
      expect(update.error, isNull);
    });

    test('should correctly construct status update for completed', () {
      final update = TusStatusUpdate(
        uploadId: 'upload-123',
        status: 'completed',
        assetId: 'asset-456',
        error: null,
      );

      expect(update.uploadId, 'upload-123');
      expect(update.status, 'completed');
      expect(update.assetId, 'asset-456');
      expect(update.error, isNull);
    });

    test('should correctly construct status update for failed', () {
      final update = TusStatusUpdate(
        uploadId: 'upload-123',
        status: 'failed',
        assetId: null,
        error: 'Network error',
      );

      expect(update.uploadId, 'upload-123');
      expect(update.status, 'failed');
      expect(update.assetId, isNull);
      expect(update.error, 'Network error');
    });

    test('should correctly construct status update for cancelled', () {
      final update = TusStatusUpdate(
        uploadId: 'upload-123',
        status: 'cancelled',
        assetId: null,
        error: null,
      );

      expect(update.uploadId, 'upload-123');
      expect(update.status, 'cancelled');
    });
  });

  group('kNativeTusUploadThreshold', () {
    test('should be 10MB', () {
      expect(kNativeTusUploadThreshold, 10 * 1024 * 1024);
    });
  });
}
