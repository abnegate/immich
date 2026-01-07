/**
 * TUS (Resumable Upload) Protocol E2E Tests
 *
 * This test suite provides comprehensive coverage of the TUS protocol implementation
 * for resumable file uploads in Immich. It tests all aspects of the protocol including
 * upload creation, chunked uploading, status checking, cancellation, and metadata handling.
 */
import { LoginResponseDto } from '@immich/sdk';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createUserDto, uuidDto } from 'src/fixtures';
import { makeRandomImage } from 'src/generators';
import { errorDto } from 'src/responses';
import { app, testAssetDir, utils } from 'src/utils';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Helper to encode metadata in base64 as required by TUS protocol
const encodeMetadata = (metadata: Record<string, string>): string => {
  return Object.entries(metadata)
    .map(([key, value]) => `${key} ${Buffer.from(value).toString('base64')}`)
    .join(',');
};

// Helper to create TUS upload with required metadata
const createTusUpload = async (
  accessToken: string,
  options: {
    filename?: string;
    size?: number;
    metadata?: Record<string, string>;
  } = {},
) => {
  const defaultMetadata = {
    filename: options.filename || 'test-image.png',
    deviceAssetId: 'test-device-asset-1',
    deviceId: 'test-device',
    fileCreatedAt: new Date().toISOString(),
    fileModifiedAt: new Date().toISOString(),
    ...options.metadata,
  };

  const uploadLength = options.size || makeRandomImage().length;

  return request(app)
    .post('/upload')
    .set('Authorization', `Bearer ${accessToken}`)
    .set('Upload-Length', uploadLength.toString())
    .set('Upload-Metadata', encodeMetadata(defaultMetadata))
    .set('Tus-Resumable', '1.0.0');
};

// Helper to upload chunk via PATCH
const uploadChunk = async (
  accessToken: string,
  uploadId: string,
  data: Buffer,
  offset: number = 0,
) => {
  return request(app)
    .patch(`/upload/${uploadId}`)
    .set('Authorization', `Bearer ${accessToken}`)
    .set('Content-Type', 'application/offset+octet-stream')
    .set('Upload-Offset', offset.toString())
    .set('Tus-Resumable', '1.0.0')
    .send(data);
};

// Helper to get upload status via HEAD
const getUploadStatus = async (accessToken: string, uploadId: string) => {
  return request(app)
    .head(`/upload/${uploadId}`)
    .set('Authorization', `Bearer ${accessToken}`)
    .set('Tus-Resumable', '1.0.0');
};

// Helper to delete/cancel upload
const cancelUpload = async (accessToken: string, uploadId: string) => {
  return request(app)
    .delete(`/upload/${uploadId}`)
    .set('Authorization', `Bearer ${accessToken}`)
    .set('Tus-Resumable', '1.0.0');
};

describe('/upload (TUS protocol)', () => {
  let admin: LoginResponseDto;
  let user: LoginResponseDto;
  let quotaUser: LoginResponseDto;

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup({ onboarding: false });
    user = await utils.userSetup(admin.accessToken, createUserDto.create('tus-user'));
    quotaUser = await utils.userSetup(admin.accessToken, createUserDto.userQuota);
  });

  describe('POST /upload (create upload)', () => {
    it('should require authentication', async () => {
      const { status, body } = await request(app)
        .post('/upload')
        .set('Upload-Length', '1000')
        .set('Upload-Metadata', encodeMetadata({ filename: 'test.png' }))
        .set('Tus-Resumable', '1.0.0');

      expect(status).toBe(401);
      expect(body).toEqual(errorDto.unauthorized);
    });

    it('should create upload with valid metadata', async () => {
      const imageData = makeRandomImage();
      const response = await createTusUpload(user.accessToken, {
        filename: 'test-image.png',
        size: imageData.length,
      });

      expect(response.status).toBe(201);
      expect(response.headers['location']).toBeDefined();
      expect(response.headers['upload-offset']).toBe('0');
      expect(response.headers['tus-resumable']).toBe('1.0.0');

      const location = response.headers['location'];
      expect(location).toContain('/upload/');
    });

    it('should reject without required metadata: filename', async () => {
      const { status, body } = await request(app)
        .post('/upload')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .set('Upload-Length', '1000')
        .set(
          'Upload-Metadata',
          encodeMetadata({
            deviceAssetId: 'test-device-asset-1',
            deviceId: 'test-device',
            fileCreatedAt: new Date().toISOString(),
            fileModifiedAt: new Date().toISOString(),
          }),
        )
        .set('Tus-Resumable', '1.0.0');

      expect(status).toBe(400);
      expect(body).toBe('Missing required metadata: filename');
    });

    it('should reject without required metadata: deviceAssetId', async () => {
      const { status, body } = await request(app)
        .post('/upload')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .set('Upload-Length', '1000')
        .set(
          'Upload-Metadata',
          encodeMetadata({
            filename: 'test.png',
            deviceId: 'test-device',
            fileCreatedAt: new Date().toISOString(),
            fileModifiedAt: new Date().toISOString(),
          }),
        )
        .set('Tus-Resumable', '1.0.0');

      expect(status).toBe(400);
      expect(body).toBe('Missing required metadata: deviceAssetId');
    });

    it('should reject without required metadata: deviceId', async () => {
      const { status, body } = await request(app)
        .post('/upload')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .set('Upload-Length', '1000')
        .set(
          'Upload-Metadata',
          encodeMetadata({
            filename: 'test.png',
            deviceAssetId: 'test-device-asset-1',
            fileCreatedAt: new Date().toISOString(),
            fileModifiedAt: new Date().toISOString(),
          }),
        )
        .set('Tus-Resumable', '1.0.0');

      expect(status).toBe(400);
      expect(body).toBe('Missing required metadata: deviceId');
    });

    it('should reject unsupported file types', async () => {
      const { status, body } = await createTusUpload(user.accessToken, {
        filename: 'malicious.exe',
        size: 1000,
      });

      expect(status).toBe(400);
      expect(body).toContain('Unsupported file type');
    });

    it('should reject upload if quota exceeded', async () => {
      const imageData = Buffer.alloc(600); // Exceeds quota of 512 bytes
      const { status, body } = await createTusUpload(quotaUser.accessToken, {
        filename: 'large-file.png',
        size: imageData.length,
      });

      expect(status).toBe(400);
      expect(body).toBe('Quota has been exceeded!');
    });

    it('should accept various supported image types', async () => {
      const supportedTypes = ['test.jpg', 'test.jpeg', 'test.png', 'test.webp', 'test.heic', 'test.avif'];

      for (const filename of supportedTypes) {
        const response = await createTusUpload(user.accessToken, {
          filename,
          size: 1000,
          metadata: {
            deviceAssetId: `test-${filename}`,
          },
        });

        expect(response.status).toBe(201);
        expect(response.headers['location']).toBeDefined();
      }
    });

    it('should accept video file types', async () => {
      const response = await createTusUpload(user.accessToken, {
        filename: 'test-video.mp4',
        size: 1000,
        metadata: {
          deviceAssetId: 'test-video-1',
          duration: '10.5',
        },
      });

      expect(response.status).toBe(201);
      expect(response.headers['location']).toBeDefined();
    });
  });

  describe('PATCH /upload/:id (upload chunks)', () => {
    it('should require authentication', async () => {
      const { status, body } = await request(app)
        .patch(`/upload/${uuidDto.notFound}`)
        .set('Content-Type', 'application/offset+octet-stream')
        .set('Upload-Offset', '0')
        .set('Tus-Resumable', '1.0.0')
        .send(Buffer.from('test'));

      expect(status).toBe(401);
      expect(body).toEqual(errorDto.unauthorized);
    });

    it('should accept chunk uploads', async () => {
      const imageData = makeRandomImage();
      const createResponse = await createTusUpload(user.accessToken, {
        filename: 'chunk-test.png',
        size: imageData.length,
        metadata: {
          deviceAssetId: 'chunk-test-1',
        },
      });

      expect(createResponse.status).toBe(201);
      const uploadId = createResponse.headers['location'].split('/').pop();
      const patchResponse = await uploadChunk(user.accessToken, uploadId, imageData, 0);

      expect(patchResponse.status).toBe(204);
      expect(patchResponse.headers['upload-offset']).toBe(imageData.length.toString());
      expect(patchResponse.headers['tus-resumable']).toBe('1.0.0');
    });

    it('should track upload progress with Upload-Offset header', async () => {
      const imageData = makeRandomImage();
      const halfLength = Math.floor(imageData.length / 2);

      const createResponse = await createTusUpload(user.accessToken, {
        filename: 'progress-test.png',
        size: imageData.length,
        metadata: {
          deviceAssetId: 'progress-test-1',
        },
      });

      const uploadId = createResponse.headers['location'].split('/').pop();

      const firstChunk = imageData.subarray(0, halfLength);
      const firstPatch = await uploadChunk(user.accessToken, uploadId, firstChunk, 0);

      expect(firstPatch.status).toBe(204);
      expect(firstPatch.headers['upload-offset']).toBe(halfLength.toString());

      const secondChunk = imageData.subarray(halfLength);
      const secondPatch = await uploadChunk(user.accessToken, uploadId, secondChunk, halfLength);

      expect(secondPatch.status).toBe(204);
      expect(secondPatch.headers['upload-offset']).toBe(imageData.length.toString());
    });

    it('should complete upload and return asset ID', async () => {
      const imageData = makeRandomImage();
      const createResponse = await createTusUpload(user.accessToken, {
        filename: 'complete-test.png',
        size: imageData.length,
        metadata: {
          deviceAssetId: 'complete-test-1',
        },
      });

      const uploadId = createResponse.headers['location'].split('/').pop();

      const patchResponse = await uploadChunk(user.accessToken, uploadId, imageData, 0);

      expect(patchResponse.status).toBe(204);
      expect(patchResponse.headers['x-immich-asset-id']).toBeDefined();

      const assetId = patchResponse.headers['x-immich-asset-id'];
      expect(assetId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

      const asset = await utils.getAssetInfo(user.accessToken, assetId);
      expect(asset).toBeDefined();
      expect(asset.id).toBe(assetId);
      expect(asset.originalFileName).toBe('complete-test.png');
    });

    it('should handle multiple chunks correctly', async () => {
      const imageData = makeRandomImage();
      const chunkSize = Math.floor(imageData.length / 3);

      const createResponse = await createTusUpload(user.accessToken, {
        filename: 'multi-chunk-test.png',
        size: imageData.length,
        metadata: {
          deviceAssetId: 'multi-chunk-test-1',
        },
      });

      const uploadId = createResponse.headers['location'].split('/').pop();

      let offset = 0;
      const chunk1 = imageData.subarray(0, chunkSize);
      const patch1 = await uploadChunk(user.accessToken, uploadId, chunk1, offset);
      expect(patch1.status).toBe(204);
      offset += chunkSize;

      const chunk2 = imageData.subarray(chunkSize, chunkSize * 2);
      const patch2 = await uploadChunk(user.accessToken, uploadId, chunk2, offset);
      expect(patch2.status).toBe(204);
      offset += chunkSize;

      const chunk3 = imageData.subarray(chunkSize * 2);
      const patch3 = await uploadChunk(user.accessToken, uploadId, chunk3, offset);
      expect(patch3.status).toBe(204);
      expect(patch3.headers['upload-offset']).toBe(imageData.length.toString());
      expect(patch3.headers['x-immich-asset-id']).toBeDefined();
    });

    it('should upload real image file with metadata extraction', async () => {
      const filepath = join(testAssetDir, 'formats/png/density_plot.png');
      const imageData = await readFile(filepath);
      const filename = basename(filepath);

      const createResponse = await createTusUpload(user.accessToken, {
        filename,
        size: imageData.length,
        metadata: {
          deviceAssetId: 'real-image-test-1',
        },
      });

      const uploadId = createResponse.headers['location'].split('/').pop();
      const patchResponse = await uploadChunk(user.accessToken, uploadId, imageData, 0);

      expect(patchResponse.status).toBe(204);
      const assetId = patchResponse.headers['x-immich-asset-id'];
      expect(assetId).toBeDefined();

      await utils.waitForQueueFinish(admin.accessToken, 'metadataExtraction');

      const asset = await utils.getAssetInfo(user.accessToken, assetId);
      expect(asset.exifInfo).toBeDefined();
      expect(asset.exifInfo?.exifImageWidth).toBe(800);
      expect(asset.exifInfo?.exifImageHeight).toBe(800);
    });
  });

  describe('HEAD /upload/:id (get upload status)', () => {
    it('should require authentication', async () => {
      const { status } = await request(app)
        .head(`/upload/${uuidDto.notFound}`)
        .set('Tus-Resumable', '1.0.0');

      expect(status).toBe(401);
    });

    it('should return current upload offset', async () => {
      const imageData = makeRandomImage();
      const halfLength = Math.floor(imageData.length / 2);

      const createResponse = await createTusUpload(user.accessToken, {
        filename: 'head-test.png',
        size: imageData.length,
        metadata: {
          deviceAssetId: 'head-test-1',
        },
      });

      const uploadId = createResponse.headers['location'].split('/').pop();

      const headResponse1 = await getUploadStatus(user.accessToken, uploadId);
      expect(headResponse1.status).toBe(200);
      expect(headResponse1.headers['upload-offset']).toBe('0');
      expect(headResponse1.headers['upload-length']).toBe(imageData.length.toString());

      const chunk = imageData.subarray(0, halfLength);
      await uploadChunk(user.accessToken, uploadId, chunk, 0);

      const headResponse2 = await getUploadStatus(user.accessToken, uploadId);
      expect(headResponse2.status).toBe(200);
      expect(headResponse2.headers['upload-offset']).toBe(halfLength.toString());
      expect(headResponse2.headers['upload-length']).toBe(imageData.length.toString());
    });

    it('should return Upload-Length header', async () => {
      const uploadLength = 5000;
      const createResponse = await createTusUpload(user.accessToken, {
        filename: 'length-test.png',
        size: uploadLength,
        metadata: {
          deviceAssetId: 'length-test-1',
        },
      });

      const uploadId = createResponse.headers['location'].split('/').pop();
      const headResponse = await getUploadStatus(user.accessToken, uploadId);

      expect(headResponse.status).toBe(200);
      expect(headResponse.headers['upload-length']).toBe(uploadLength.toString());
      expect(headResponse.headers['tus-resumable']).toBe('1.0.0');
    });

    it('should return 404 for non-existent upload', async () => {
      const headResponse = await getUploadStatus(user.accessToken, uuidDto.notFound);
      expect(headResponse.status).toBe(404);
    });
  });

  describe('DELETE /upload/:id (cancel upload)', () => {
    it('should require authentication', async () => {
      const { status, body } = await request(app)
        .delete(`/upload/${uuidDto.notFound}`)
        .set('Tus-Resumable', '1.0.0');

      expect(status).toBe(401);
      expect(body).toEqual(errorDto.unauthorized);
    });

    it('should cancel and clean up upload', async () => {
      const imageData = makeRandomImage();
      const createResponse = await createTusUpload(user.accessToken, {
        filename: 'delete-test.png',
        size: imageData.length,
        metadata: {
          deviceAssetId: 'delete-test-1',
        },
      });

      const uploadId = createResponse.headers['location'].split('/').pop();

      const chunk = imageData.subarray(0, Math.floor(imageData.length / 2));
      await uploadChunk(user.accessToken, uploadId, chunk, 0);

      const deleteResponse = await cancelUpload(user.accessToken, uploadId);
      expect(deleteResponse.status).toBe(204);

      const headResponse = await getUploadStatus(user.accessToken, uploadId);
      expect(headResponse.status).toBe(404);
    });

    it('should return 404 for non-existent upload', async () => {
      const deleteResponse = await cancelUpload(user.accessToken, uuidDto.notFound);
      expect(deleteResponse.status).toBe(404);
    });
  });

  describe('Large file uploads', () => {
    it('should handle large file upload with multiple 10MB chunks', async () => {
      // Create a 25MB buffer to test chunked upload behavior (exceeds 10MB threshold)
      const fileSize = 25 * 1024 * 1024;
      const largeData = Buffer.alloc(fileSize);
      // Fill with random-ish data to avoid compression issues
      for (let i = 0; i < fileSize; i += 1024) {
        largeData[i] = i % 256;
      }

      const createResponse = await createTusUpload(user.accessToken, {
        filename: 'large-file-test.bin',
        size: fileSize,
        metadata: {
          deviceAssetId: 'large-file-test-1',
        },
      });

      expect(createResponse.status).toBe(201);
      const uploadId = createResponse.headers['location'].split('/').pop();

      const chunkSize = 10 * 1024 * 1024;
      let offset = 0;
      let lastResponse;

      while (offset < fileSize) {
        const end = Math.min(offset + chunkSize, fileSize);
        const chunk = largeData.subarray(offset, end);

        lastResponse = await uploadChunk(user.accessToken, uploadId, chunk, offset);
        expect(lastResponse.status).toBe(204);
        expect(lastResponse.headers['upload-offset']).toBe(end.toString());

        offset = end;
      }

      // Verify upload completed successfully
      expect(lastResponse!.headers['x-immich-asset-id']).toBeDefined();
      const assetId = lastResponse!.headers['x-immich-asset-id'];

      // Verify asset was created
      const asset = await utils.getAssetInfo(user.accessToken, assetId);
      expect(asset).toBeDefined();
      expect(asset.id).toBe(assetId);
      expect(asset.originalFileName).toBe('large-file-test.bin');
    }, 60_000); // 60 second timeout for large upload

    it('should resume large file upload after interruption', async () => {
      // Create a 15MB buffer
      const fileSize = 15 * 1024 * 1024;
      const largeData = Buffer.alloc(fileSize);
      for (let i = 0; i < fileSize; i += 1024) {
        largeData[i] = i % 256;
      }

      const createResponse = await createTusUpload(user.accessToken, {
        filename: 'resume-large-test.bin',
        size: fileSize,
        metadata: {
          deviceAssetId: 'resume-large-test-1',
        },
      });

      const uploadId = createResponse.headers['location'].split('/').pop();

      // Upload first 5MB chunk
      const firstChunkSize = 5 * 1024 * 1024;
      const firstChunk = largeData.subarray(0, firstChunkSize);
      await uploadChunk(user.accessToken, uploadId, firstChunk, 0);

      // Simulate "interruption" - check status via HEAD
      const statusResponse = await getUploadStatus(user.accessToken, uploadId);
      expect(statusResponse.status).toBe(200);
      expect(statusResponse.headers['upload-offset']).toBe(firstChunkSize.toString());

      // Resume upload from where we left off
      const offset = Number.parseInt(statusResponse.headers['upload-offset']);
      const remainingData = largeData.subarray(offset);
      const resumeResponse = await uploadChunk(user.accessToken, uploadId, remainingData, offset);

      expect(resumeResponse.status).toBe(204);
      expect(resumeResponse.headers['upload-offset']).toBe(fileSize.toString());
      expect(resumeResponse.headers['x-immich-asset-id']).toBeDefined();

      const assetId = resumeResponse.headers['x-immich-asset-id'];
      const asset = await utils.getAssetInfo(user.accessToken, assetId);
      expect(asset.originalFileName).toBe('resume-large-test.bin');
    }, 60_000);

    it('should resume upload after partial chunk failure', async () => {
      // Create a 20MB buffer
      const fileSize = 20 * 1024 * 1024;
      const largeData = Buffer.alloc(fileSize);
      for (let i = 0; i < fileSize; i += 1024) {
        largeData[i] = i % 256;
      }

      const createResponse = await createTusUpload(user.accessToken, {
        filename: 'failure-resume-test.bin',
        size: fileSize,
        metadata: {
          deviceAssetId: 'failure-resume-test-1',
        },
      });

      expect(createResponse.status).toBe(201);
      const uploadId = createResponse.headers['location'].split('/').pop();

      // Upload first chunk successfully (5MB)
      const chunkSize = 5 * 1024 * 1024;
      const chunk1 = largeData.subarray(0, chunkSize);
      const response1 = await uploadChunk(user.accessToken, uploadId, chunk1, 0);
      expect(response1.status).toBe(204);

      // Upload second chunk successfully (5MB)
      const chunk2 = largeData.subarray(chunkSize, chunkSize * 2);
      const response2 = await uploadChunk(user.accessToken, uploadId, chunk2, chunkSize);
      expect(response2.status).toBe(204);

      // Simulate failure recovery: check status via HEAD to get current offset
      const statusAfterPartial = await getUploadStatus(user.accessToken, uploadId);
      expect(statusAfterPartial.status).toBe(200);
      const currentOffset = Number.parseInt(statusAfterPartial.headers['upload-offset']);
      expect(currentOffset).toBe(chunkSize * 2); // Should be at 10MB

      // Resume from the correct offset (simulating client recovery after failure)
      const chunk3 = largeData.subarray(currentOffset, currentOffset + chunkSize);
      const response3 = await uploadChunk(user.accessToken, uploadId, chunk3, currentOffset);
      expect(response3.status).toBe(204);

      // Final chunk
      const chunk4 = largeData.subarray(currentOffset + chunkSize);
      const response4 = await uploadChunk(user.accessToken, uploadId, chunk4, currentOffset + chunkSize);
      expect(response4.status).toBe(204);
      expect(response4.headers['x-immich-asset-id']).toBeDefined();

      // Verify the asset was created correctly
      const assetId = response4.headers['x-immich-asset-id'];
      const asset = await utils.getAssetInfo(user.accessToken, assetId);
      expect(asset).toBeDefined();
      expect(asset.originalFileName).toBe('failure-resume-test.bin');
    }, 60_000);
  });

  describe('Resumable upload flow', () => {
    it('should resume interrupted upload', async () => {
      const imageData = makeRandomImage();
      const chunkSize = Math.floor(imageData.length / 3);

      // Create upload
      const createResponse = await createTusUpload(user.accessToken, {
        filename: 'resume-test.png',
        size: imageData.length,
        metadata: {
          deviceAssetId: 'resume-test-1',
        },
      });

      const uploadId = createResponse.headers['location'].split('/').pop();

      const chunk1 = imageData.subarray(0, chunkSize);
      await uploadChunk(user.accessToken, uploadId, chunk1, 0);

      const statusResponse = await getUploadStatus(user.accessToken, uploadId);
      expect(statusResponse.headers['upload-offset']).toBe(chunkSize.toString());

      const offset = Number.parseInt(statusResponse.headers['upload-offset']);
      const remainingData = imageData.subarray(offset);
      const resumeResponse = await uploadChunk(user.accessToken, uploadId, remainingData, offset);

      expect(resumeResponse.status).toBe(204);
      expect(resumeResponse.headers['upload-offset']).toBe(imageData.length.toString());
      expect(resumeResponse.headers['x-immich-asset-id']).toBeDefined();

      const assetId = resumeResponse.headers['x-immich-asset-id'];
      const asset = await utils.getAssetInfo(user.accessToken, assetId);
      expect(asset).toBeDefined();
      expect(asset.originalFileName).toBe('resume-test.png');
    });

    it('should handle concurrent uploads', async () => {
      const upload1Data = makeRandomImage();
      const upload2Data = makeRandomImage();

      // Create two uploads
      const [create1, create2] = await Promise.all([
        createTusUpload(user.accessToken, {
          filename: 'concurrent-1.png',
          size: upload1Data.length,
          metadata: {
            deviceAssetId: 'concurrent-test-1',
          },
        }),
        createTusUpload(user.accessToken, {
          filename: 'concurrent-2.png',
          size: upload2Data.length,
          metadata: {
            deviceAssetId: 'concurrent-test-2',
          },
        }),
      ]);

      const uploadId1 = create1.headers['location'].split('/').pop();
      const uploadId2 = create2.headers['location'].split('/').pop();

      const [patch1, patch2] = await Promise.all([
        uploadChunk(user.accessToken, uploadId1, upload1Data, 0),
        uploadChunk(user.accessToken, uploadId2, upload2Data, 0),
      ]);

      expect(patch1.status).toBe(204);
      expect(patch2.status).toBe(204);

      const assetId1 = patch1.headers['x-immich-asset-id'];
      const assetId2 = patch2.headers['x-immich-asset-id'];

      expect(assetId1).toBeDefined();
      expect(assetId2).toBeDefined();
      expect(assetId1).not.toBe(assetId2);

      const [asset1, asset2] = await Promise.all([
        utils.getAssetInfo(user.accessToken, assetId1),
        utils.getAssetInfo(user.accessToken, assetId2),
      ]);

      expect(asset1.originalFileName).toBe('concurrent-1.png');
      expect(asset2.originalFileName).toBe('concurrent-2.png');
    });

    it('should handle duplicate uploads', async () => {
      const imageData = makeRandomImage();

      // Upload first time
      const create1 = await createTusUpload(user.accessToken, {
        filename: 'duplicate-test.png',
        size: imageData.length,
        metadata: {
          deviceAssetId: 'duplicate-test-1',
        },
      });

      const uploadId1 = create1.headers['location'].split('/').pop();
      const patch1 = await uploadChunk(user.accessToken, uploadId1, imageData, 0);
      const assetId1 = patch1.headers['x-immich-asset-id'];

      const create2 = await createTusUpload(user.accessToken, {
        filename: 'duplicate-test.png',
        size: imageData.length,
        metadata: {
          deviceAssetId: 'duplicate-test-2',
        },
      });

      const uploadId2 = create2.headers['location'].split('/').pop();
      const patch2 = await uploadChunk(user.accessToken, uploadId2, imageData, 0);
      const assetId2 = patch2.headers['x-immich-asset-id'];

      expect(assetId1).toBe(assetId2);
    });
  });

  describe('Advanced metadata handling', () => {
    it('should handle favorite flag', async () => {
      const imageData = makeRandomImage();
      const createResponse = await createTusUpload(user.accessToken, {
        filename: 'favorite-test.png',
        size: imageData.length,
        metadata: {
          deviceAssetId: 'favorite-test-1',
          isFavorite: 'true',
        },
      });

      const uploadId = createResponse.headers['location'].split('/').pop();
      const patchResponse = await uploadChunk(user.accessToken, uploadId, imageData, 0);
      const assetId = patchResponse.headers['x-immich-asset-id'];

      const asset = await utils.getAssetInfo(user.accessToken, assetId);
      expect(asset.isFavorite).toBe(true);
    });

    it('should handle visibility setting', async () => {
      const imageData = makeRandomImage();
      const createResponse = await createTusUpload(user.accessToken, {
        filename: 'archive-test.png',
        size: imageData.length,
        metadata: {
          deviceAssetId: 'archive-test-1',
          visibility: 'ARCHIVE',
        },
      });

      const uploadId = createResponse.headers['location'].split('/').pop();
      const patchResponse = await uploadChunk(user.accessToken, uploadId, imageData, 0);
      const assetId = patchResponse.headers['x-immich-asset-id'];

      const asset = await utils.getAssetInfo(user.accessToken, assetId);
      expect(asset.isArchived).toBe(true);
    });

    it('should handle video duration metadata', async () => {
      const videoFilepath = join(testAssetDir, 'formats/mp4/video.mp4');
      let videoData: Buffer;

      try {
        videoData = await readFile(videoFilepath);
      } catch {
        // Skip test if video file doesn't exist
        console.log(`Skipping test: ${videoFilepath} not found`);
        return;
      }

      const createResponse = await createTusUpload(user.accessToken, {
        filename: 'video.mp4',
        size: videoData.length,
        metadata: {
          deviceAssetId: 'video-duration-test-1',
          duration: '15.5',
        },
      });

      const uploadId = createResponse.headers['location'].split('/').pop();
      const patchResponse = await uploadChunk(user.accessToken, uploadId, videoData, 0);
      const assetId = patchResponse.headers['x-immich-asset-id'];

      const asset = await utils.getAssetInfo(user.accessToken, assetId);
      expect(asset.duration).toBeDefined();
    });

    it('should handle custom file timestamps', async () => {
      const imageData = makeRandomImage();
      const customCreatedAt = new Date('2020-01-15T10:30:00Z').toISOString();
      const customModifiedAt = new Date('2020-01-15T11:30:00Z').toISOString();

      const createResponse = await createTusUpload(user.accessToken, {
        filename: 'timestamp-test.png',
        size: imageData.length,
        metadata: {
          deviceAssetId: 'timestamp-test-1',
          fileCreatedAt: customCreatedAt,
          fileModifiedAt: customModifiedAt,
        },
      });

      const uploadId = createResponse.headers['location'].split('/').pop();
      const patchResponse = await uploadChunk(user.accessToken, uploadId, imageData, 0);
      const assetId = patchResponse.headers['x-immich-asset-id'];

      const asset = await utils.getAssetInfo(user.accessToken, assetId);
      expect(new Date(asset.fileCreatedAt).toISOString()).toBe(customCreatedAt);
    });
  });

  describe('OPTIONS /upload (CORS preflight)', () => {
    it('should handle OPTIONS request for CORS', async () => {
      const response = await request(app)
        .options('/upload')
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'upload-length,upload-metadata,tus-resumable');

      // Status may vary based on implementation (200 or 204)
      expect([200, 204]).toContain(response.status);
    });
  });

  describe('Negative test cases', () => {
    it('should reject PATCH with incorrect offset', async () => {
      const imageData = makeRandomImage();
      const createResponse = await createTusUpload(user.accessToken, {
        filename: 'offset-test.png',
        size: imageData.length,
        metadata: {
          deviceAssetId: 'offset-test-1',
        },
      });

      const uploadId = createResponse.headers['location'].split('/').pop();

      const patchResponse = await uploadChunk(user.accessToken, uploadId, imageData, 1000);

      expect(patchResponse.status).toBe(409); // Conflict - offset mismatch
    });

    it('should reject access to another user\'s upload', async () => {
      const imageData = makeRandomImage();
      const createResponse = await createTusUpload(user.accessToken, {
        filename: 'access-test.png',
        size: imageData.length,
        metadata: {
          deviceAssetId: 'access-test-1',
        },
      });

      const uploadId = createResponse.headers['location'].split('/').pop();

      const patchResponse = await uploadChunk(admin.accessToken, uploadId, imageData, 0);

      expect(patchResponse.status).toBe(403); // Forbidden
    });

    it('should reject upload exceeding declared size', async () => {
      const imageData = makeRandomImage();
      const declaredSize = Math.floor(imageData.length / 2);

      const createResponse = await createTusUpload(user.accessToken, {
        filename: 'size-exceed-test.png',
        size: declaredSize,
        metadata: {
          deviceAssetId: 'size-exceed-test-1',
        },
      });

      const uploadId = createResponse.headers['location'].split('/').pop();

      const patchResponse = await uploadChunk(user.accessToken, uploadId, imageData, 0);

      expect(patchResponse.status).toBe(413); // Payload too large
    });

    it('should reject PATCH without Upload-Offset header', async () => {
      const imageData = makeRandomImage();
      const createResponse = await createTusUpload(user.accessToken, {
        filename: 'no-offset-test.png',
        size: imageData.length,
        metadata: {
          deviceAssetId: 'no-offset-test-1',
        },
      });

      const uploadId = createResponse.headers['location'].split('/').pop();

      const response = await request(app)
        .patch(`/upload/${uploadId}`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .set('Content-Type', 'application/offset+octet-stream')
        .set('Tus-Resumable', '1.0.0')
        .send(imageData);

      expect(response.status).toBe(400); // Bad request
    });

    it('should reject POST without Upload-Length header', async () => {
      const response = await request(app)
        .post('/upload')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .set('Upload-Metadata', encodeMetadata({
          filename: 'no-length-test.png',
          deviceAssetId: 'no-length-test-1',
          deviceId: 'test-device',
          fileCreatedAt: new Date().toISOString(),
          fileModifiedAt: new Date().toISOString(),
        }))
        .set('Tus-Resumable', '1.0.0');

      expect(response.status).toBe(400); // Bad request
    });
  });
});
