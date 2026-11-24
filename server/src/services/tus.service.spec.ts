import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Request, Response } from 'express';
import { Stats } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { lock } from 'proper-lockfile';
import { AssetFileType, AssetType, AssetVisibility, JobName } from 'src/enum';
import { TusService } from 'src/services/tus.service';
import { ASSET_CHECKSUM_CONSTRAINT } from 'src/utils/database';
import { assetStub } from 'test/fixtures/asset.stub';
import { authStub } from 'test/fixtures/auth.stub';
import { userStub } from 'test/fixtures/user.stub';
import { newTestService, ServiceMocks } from 'test/utils';
import { vi } from 'vitest';

// Mock the TUS modules to avoid real filesystem operations
vi.mock('@tus/server', () => ({
  Server: vi.fn().mockImplementation((options) => {
    // Store the options for testing
    return {
      options,
      handle: vi.fn().mockImplementation(() => Promise.resolve()),
    };
  }),
}));

vi.mock('@tus/file-store', () => ({
  FileStore: vi.fn().mockImplementation(() => ({ extensions: ['creation', 'creation-defer-length'] })),
}));

vi.mock('proper-lockfile', () => ({
  lock: vi.fn().mockImplementation(() => Promise.resolve(() => Promise.resolve())),
}));

// TUS library decodes base64 metadata before passing to callbacks, so use plain text
const mockUpload = {
  id: 'upload-id.jpg',
  size: 1000,
  offset: 0,
  metadata: {
    filename: 'test.jpg',
    deviceAssetId: 'device-asset-id',
    deviceId: 'device-id',
    fileCreatedAt: '2023-01-01T00:00:00.000Z',
    fileModifiedAt: '2023-01-01T00:00:00.000Z',
  },
  creation_date: '2023-01-01T00:00:00.000Z',
};

const mockUploadWithSidecar = {
  ...mockUpload,
  metadata: {
    ...mockUpload.metadata,
    sidecarData: Buffer.from('sidecar content').toString('base64'), // sidecarData is still base64 encoded
  },
};

const mockUploadVideo = {
  ...mockUpload,
  id: 'upload-id.mp4',
  metadata: {
    ...mockUpload.metadata,
    filename: 'test.mp4',
    duration: '10.5',
  },
};

// Helper to create mock request with Web API Headers (as TUS library provides)
const createMockRequest = (userId?: string, quotaSize?: number | null, quotaUsage?: number) => {
  const headersMap = new Map<string, string>();
  if (userId) {
    headersMap.set('x-immich-user-id', userId);
  }
  if (quotaSize !== undefined) {
    headersMap.set('x-immich-quota-size', String(quotaSize ?? ''));
  }
  if (quotaUsage !== undefined) {
    headersMap.set('x-immich-quota-usage', String(quotaUsage));
  }
  return {
    headers: {
      get: (name: string) => headersMap.get(name) ?? null,
    },
  };
};

describe(TusService.name, () => {
  let sut: TusService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(TusService));
    // Mock storage mkdirSync to avoid filesystem operations
    mocks.storage.mkdirSync.mockImplementation(() => {});
    mocks.storage.unlink.mockImplementation(() => Promise.resolve());
  });

  describe('parseMetadata', () => {
    // Note: TUS library decodes base64 metadata before passing to callbacks,
    // so parseMetadata just handles null-to-undefined conversion
    it('should pass through already-decoded metadata values', () => {
      const metadata = {
        filename: 'test.jpg',
        deviceAssetId: 'device-asset-id',
        deviceId: 'device-id',
      };

      const result = (sut as any).parseMetadata(metadata);

      expect(result).toEqual({
        filename: 'test.jpg',
        deviceAssetId: 'device-asset-id',
        deviceId: 'device-id',
        filetype: undefined,
        fileCreatedAt: undefined,
        fileModifiedAt: undefined,
        duration: undefined,
        isFavorite: undefined,
        visibility: undefined,
        livePhotoVideoId: undefined,
        sidecarData: undefined,
        sidecarRequired: undefined,
      });
    });

    it('should handle missing metadata gracefully', () => {
      const result = (sut as any).parseMetadata();
      expect(result).toEqual({});
    });

    it('should handle empty metadata object', () => {
      const result = (sut as any).parseMetadata({});
      expect(result).toEqual({
        filename: undefined,
        filetype: undefined,
        deviceAssetId: undefined,
        deviceId: undefined,
        fileCreatedAt: undefined,
        fileModifiedAt: undefined,
        duration: undefined,
        isFavorite: undefined,
        visibility: undefined,
        livePhotoVideoId: undefined,
        sidecarData: undefined,
        sidecarRequired: undefined,
      });
    });

    it('should handle null metadata values', () => {
      const metadata = {
        filename: null,
        deviceAssetId: null,
        deviceId: null,
      };

      const result = (sut as any).parseMetadata(metadata);

      expect(result).toEqual({
        filename: undefined,
        filetype: undefined,
        deviceAssetId: undefined,
        deviceId: undefined,
        fileCreatedAt: undefined,
        fileModifiedAt: undefined,
        duration: undefined,
        isFavorite: undefined,
        visibility: undefined,
        livePhotoVideoId: undefined,
        sidecarData: undefined,
        sidecarRequired: undefined,
      });
    });

    it('should pass through all supported metadata fields', () => {
      // TUS library decodes base64 metadata before passing to callbacks
      const metadata = {
        filename: 'test.jpg',
        filetype: 'image/jpeg',
        deviceAssetId: 'device-asset-id',
        deviceId: 'device-id',
        fileCreatedAt: '2023-01-01T00:00:00.000Z',
        fileModifiedAt: '2023-01-02T00:00:00.000Z',
        duration: '10.5',
        isFavorite: 'true',
        visibility: 'timeline',
        livePhotoVideoId: 'video-id',
        sidecarData: 'c2lkZWNhciBjb250ZW50', // sidecarData stays as base64 for us to decode
        sidecarRequired: 'true',
      };

      const result = (sut as any).parseMetadata(metadata);

      expect(result).toEqual({
        filename: 'test.jpg',
        filetype: 'image/jpeg',
        deviceAssetId: 'device-asset-id',
        deviceId: 'device-id',
        fileCreatedAt: '2023-01-01T00:00:00.000Z',
        fileModifiedAt: '2023-01-02T00:00:00.000Z',
        duration: '10.5',
        isFavorite: 'true',
        visibility: 'timeline',
        livePhotoVideoId: 'video-id',
        sidecarData: 'c2lkZWNhciBjb250ZW50',
        sidecarRequired: 'true',
      });
    });
  });

  describe('onUploadCreate validation', () => {
    let mockReq: any;
    let upload: any;

    beforeEach(() => {
      mockReq = createMockRequest(authStub.user1.user.id, null, 0);
      // TUS library decodes base64 metadata before passing to callbacks
      upload = {
        id: 'upload-id',
        size: 1000,
        metadata: {
          filename: 'test.jpg',
          deviceAssetId: 'device-asset-id',
          deviceId: 'device-id',
        },
      };
    });

    it('should reject if user not authenticated', async () => {
      mockReq = createMockRequest(); // No user ID

      const tusServer = await (sut as any).initializeTusServer();
      const onUploadCreate = (tusServer as any).options.onUploadCreate;

      await expect(onUploadCreate(mockReq, upload)).rejects.toEqual({
        status_code: 401,
        body: 'Unauthorized',
      });
    });

    it('should reject if filename missing', async () => {
      upload.metadata = {
        deviceAssetId: 'device-asset-id',
        deviceId: 'device-id',
      };

      const tusServer = await (sut as any).initializeTusServer();
      const onUploadCreate = (tusServer as any).options.onUploadCreate;

      await expect(onUploadCreate(mockReq, upload)).rejects.toEqual({
        status_code: 400,
        body: 'Missing required metadata: filename',
      });
    });

    it('should reject if deviceAssetId missing', async () => {
      upload.metadata = {
        filename: 'test.jpg',
        deviceId: 'device-id',
      };

      const tusServer = await (sut as any).initializeTusServer();
      const onUploadCreate = (tusServer as any).options.onUploadCreate;

      await expect(onUploadCreate(mockReq, upload)).rejects.toEqual({
        status_code: 400,
        body: 'Missing required metadata: deviceAssetId',
      });
    });

    it('should reject if deviceId missing', async () => {
      upload.metadata = {
        filename: 'test.jpg',
        deviceAssetId: 'device-asset-id',
      };

      const tusServer = await (sut as any).initializeTusServer();
      const onUploadCreate = (tusServer as any).options.onUploadCreate;

      await expect(onUploadCreate(mockReq, upload)).rejects.toEqual({
        status_code: 400,
        body: 'Missing required metadata: deviceId',
      });
    });

    it('should reject unsupported file types', async () => {
      upload.metadata = {
        filename: 'test.txt',
        deviceAssetId: 'device-asset-id',
        deviceId: 'device-id',
      };

      const tusServer = await (sut as any).initializeTusServer();
      const onUploadCreate = (tusServer as any).options.onUploadCreate;

      await expect(onUploadCreate(mockReq, upload)).rejects.toEqual({
        status_code: 400,
        body: 'Unsupported file type: test.txt',
      });
    });

    it('should reject if quota exceeded', async () => {
      mockReq = createMockRequest(authStub.user1.user.id, 1000, 500);
      upload.size = 600; // Would exceed quota

      const tusServer = await (sut as any).initializeTusServer();
      const onUploadCreate = (tusServer as any).options.onUploadCreate;

      await expect(onUploadCreate(mockReq, upload)).rejects.toEqual({
        status_code: 400,
        body: 'Quota has been exceeded!',
      });
    });

    it('should allow valid upload with image', async () => {
      const tusServer = await (sut as any).initializeTusServer();
      const onUploadCreate = (tusServer as any).options.onUploadCreate;

      const result = await onUploadCreate(mockReq, upload);

      expect(result).toEqual({});
    });

    it('should allow valid upload with video', async () => {
      upload.metadata = {
        filename: 'test.mp4',
        deviceAssetId: 'device-asset-id',
        deviceId: 'device-id',
      };

      const tusServer = await (sut as any).initializeTusServer();
      const onUploadCreate = (tusServer as any).options.onUploadCreate;

      const result = await onUploadCreate(mockReq, upload);

      expect(result).toEqual({});
    });

    it('should allow upload when quota is null (unlimited)', async () => {
      mockReq = createMockRequest(authStub.user1.user.id, null, 500);
      upload.size = 1_000_000; // Large file

      const tusServer = await (sut as any).initializeTusServer();
      const onUploadCreate = (tusServer as any).options.onUploadCreate;

      const result = await onUploadCreate(mockReq, upload);

      expect(result).toEqual({});
    });

    it('should allow upload when quota not exceeded', async () => {
      mockReq = createMockRequest(authStub.user1.user.id, 10_000, 5000);
      upload.size = 4000; // Within quota

      const tusServer = await (sut as any).initializeTusServer();
      const onUploadCreate = (tusServer as any).options.onUploadCreate;

      const result = await onUploadCreate(mockReq, upload);

      expect(result).toEqual({});
    });
  });

  describe('createAssetFromUpload', () => {
    const checksum = Buffer.from('test-checksum');
    const userId = authStub.user1.user.id;

    beforeEach(() => {
      mocks.crypto.randomUUID.mockReturnValue('random-uuid');
      mocks.storage.stat.mockResolvedValue({ size: 1000 } as Stats);
      mocks.user.get.mockResolvedValue(userStub.user1);

      // Mock calculateChecksum to avoid file system access
      vi.spyOn(sut as any, 'calculateChecksum').mockResolvedValue(checksum);
    });

    it('should create asset with correct metadata', async () => {
      const upload = mockUpload;

      mocks.asset.create.mockResolvedValue({
        id: 'asset-id',
        ownerId: userId,
      } as any);

      const result = await (sut as any).createAssetFromUpload(userId, upload, checksum);

      expect(result).toEqual({ assetId: 'asset-id', isDuplicate: false });
      expect(mocks.asset.create).toHaveBeenCalledWith({
        ownerId: userId,
        libraryId: null,
        checksum,
        originalPath: '/data/upload/upload-id.jpg',
        deviceAssetId: 'device-asset-id',
        deviceId: 'device-id',
        fileCreatedAt: new Date('2023-01-01T00:00:00.000Z'),
        fileModifiedAt: new Date('2023-01-01T00:00:00.000Z'),
        localDateTime: new Date('2023-01-01T00:00:00.000Z'),
        type: AssetType.Image,
        isFavorite: false,
        duration: null,
        visibility: AssetVisibility.Timeline,
        livePhotoVideoId: null,
        originalFileName: 'test.jpg',
      });
    });

    it('should detect and handle duplicate uploads', async () => {
      const upload = mockUpload;

      mocks.asset.getUploadAssetIdByChecksum.mockResolvedValue('existing-asset-id');
      mocks.asset.getById.mockResolvedValue({
        ...assetStub.image,
        ownerId: userId,
        originalPath: '/data/upload/existing.jpg',
      });

      const result = await (sut as any).createAssetFromUpload(userId, upload, checksum);

      expect(result).toEqual({ assetId: 'existing-asset-id', isDuplicate: true });
      expect(mocks.asset.create).not.toHaveBeenCalled();
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('should retain the registered original when another worker finalized the same upload', async () => {
      const upload = { ...mockUpload, offset: mockUpload.size };
      const originalPath = '/data/upload/upload-id.jpg';
      const asset = { ...assetStub.image, id: 'winning-asset-id', ownerId: userId, originalPath };
      mocks.storage.readTextFile.mockResolvedValue(JSON.stringify(upload));
      mocks.asset.getUploadAssetIdByChecksum.mockImplementation(() =>
        Promise.resolve(mocks.asset.create.mock.calls.length > 0 ? asset.id : undefined),
      );
      mocks.asset.create.mockRejectedValue(
        Object.assign(new Error('conflict'), {
          constraint_name: ASSET_CHECKSUM_CONSTRAINT,
        }),
      );
      mocks.asset.getById.mockResolvedValue(asset);

      const server = await (sut as any).initializeTusServer();
      const result = await server.options.onUploadFinish({ ...createMockRequest(userId), method: 'PATCH' }, upload);

      expect(result.headers).toEqual({ 'X-Immich-Asset-Id': asset.id, 'X-Immich-Duplicate': 'false' });
      expect(mocks.storage.unlink).not.toHaveBeenCalled();
    });

    it('should retain upload bytes when the existing asset cannot be verified', async () => {
      const upload = { ...mockUpload, offset: mockUpload.size };
      mocks.storage.readTextFile.mockResolvedValue(JSON.stringify(upload));
      mocks.asset.getUploadAssetIdByChecksum.mockResolvedValue('missing-asset-id');

      const server = await (sut as any).initializeTusServer();
      const request = { ...createMockRequest(userId), method: 'PATCH' };

      await expect(server.options.onUploadFinish(request, upload)).rejects.toMatchObject({ status_code: 500 });
      expect(mocks.storage.unlink).not.toHaveBeenCalled();
    });

    it('should handle sidecar data', async () => {
      const upload = mockUploadWithSidecar;

      mocks.asset.create.mockResolvedValue({
        id: 'asset-id',
        ownerId: userId,
      } as any);

      const result = await (sut as any).createAssetFromUpload(userId, upload, checksum);

      expect(result).toEqual({ assetId: 'asset-id', isDuplicate: false });
      expect(mocks.storage.createOrOverwriteFile).toHaveBeenCalledWith(
        expect.stringContaining('.xmp'),
        expect.any(Buffer),
      );
      expect(mocks.asset.upsertFile).toHaveBeenCalledWith({
        assetId: 'asset-id',
        path: expect.stringContaining('.xmp'),
        type: AssetFileType.Sidecar,
      });
    });

    it('should handle sidecar write errors gracefully', async () => {
      const upload = mockUploadWithSidecar;

      mocks.asset.create.mockResolvedValue({
        id: 'asset-id',
        ownerId: userId,
      } as any);

      // Mock storage to throw an error when writing sidecar
      mocks.storage.createOrOverwriteFile.mockRejectedValue(new Error('Write error'));

      // Should not throw even when sidecar write fails
      const result = await (sut as any).createAssetFromUpload(userId, upload, checksum);

      expect(result).toEqual({ assetId: 'asset-id', isDuplicate: false });
      // Sidecar file write should have been attempted
      expect(mocks.storage.createOrOverwriteFile).toHaveBeenCalled();
      // Asset should still be created despite sidecar error
      expect(mocks.asset.create).toHaveBeenCalled();
    });

    it('should update user quota', async () => {
      const upload = mockUpload;

      mocks.asset.create.mockResolvedValue({
        id: 'asset-id',
        ownerId: userId,
      } as any);

      await (sut as any).createAssetFromUpload(userId, upload, checksum);

      expect(mocks.user.updateUsage).toHaveBeenCalledWith(userId, 1000);
    });

    it('should queue metadata extraction job', async () => {
      const upload = mockUpload;

      mocks.asset.create.mockResolvedValue({
        id: 'asset-id',
        ownerId: userId,
      } as any);

      await (sut as any).createAssetFromUpload(userId, upload, checksum);

      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.AssetExtractMetadata,
        data: { id: 'asset-id', source: 'upload' },
      });
    });

    it('should emit AssetCreate event', async () => {
      const upload = mockUpload;

      mocks.asset.create.mockResolvedValue({
        id: 'asset-id',
        ownerId: userId,
      } as any);

      await (sut as any).createAssetFromUpload(userId, upload, checksum);

      expect(mocks.event.emit).toHaveBeenCalledWith('AssetCreate', {
        asset: expect.objectContaining({ id: 'asset-id' }),
      });
    });

    it('should handle video assets correctly', async () => {
      const upload = mockUploadVideo;

      mocks.asset.create.mockResolvedValue({
        id: 'asset-id',
        ownerId: userId,
      } as any);

      await (sut as any).createAssetFromUpload(userId, upload, checksum);

      expect(mocks.asset.create).toHaveBeenCalledWith(
        expect.objectContaining({
          type: AssetType.Video,
          duration: '10.5',
        }),
      );
    });

    it('should set isFavorite when metadata is true', async () => {
      // TUS library decodes base64 metadata before passing to callbacks
      const upload = {
        ...mockUpload,
        metadata: {
          ...mockUpload.metadata,
          isFavorite: 'true',
        },
      };

      mocks.asset.create.mockResolvedValue({
        id: 'asset-id',
        ownerId: userId,
      } as any);

      await (sut as any).createAssetFromUpload(userId, upload, checksum);

      expect(mocks.asset.create).toHaveBeenCalledWith(
        expect.objectContaining({
          isFavorite: true,
        }),
      );
    });

    it('should set isFavorite to false when metadata is not true', async () => {
      const upload = {
        ...mockUpload,
        metadata: {
          ...mockUpload.metadata,
          isFavorite: 'false',
        },
      };

      mocks.asset.create.mockResolvedValue({
        id: 'asset-id',
        ownerId: userId,
      } as any);

      await (sut as any).createAssetFromUpload(userId, upload, checksum);

      expect(mocks.asset.create).toHaveBeenCalledWith(
        expect.objectContaining({
          isFavorite: false,
        }),
      );
    });

    it('should set visibility from metadata', async () => {
      const upload = {
        ...mockUpload,
        metadata: {
          ...mockUpload.metadata,
          visibility: 'hidden',
        },
      };

      mocks.asset.create.mockResolvedValue({
        id: 'asset-id',
        ownerId: userId,
      } as any);

      await (sut as any).createAssetFromUpload(userId, upload, checksum);

      expect(mocks.asset.create).toHaveBeenCalledWith(
        expect.objectContaining({
          visibility: AssetVisibility.Hidden,
        }),
      );
    });

    it('should default to timeline visibility for invalid visibility value', async () => {
      const upload = {
        ...mockUpload,
        metadata: {
          ...mockUpload.metadata,
          visibility: 'invalid-visibility',
        },
      };

      mocks.asset.create.mockResolvedValue({
        id: 'asset-id',
        ownerId: userId,
      } as any);

      await (sut as any).createAssetFromUpload(userId, upload, checksum);

      expect(mocks.asset.create).toHaveBeenCalledWith(
        expect.objectContaining({
          visibility: AssetVisibility.Timeline,
        }),
      );
    });

    it('should associate an owned live photo video and hide it from the timeline', async () => {
      const videoId = '435f449b-d897-4e23-82dd-f45cd3cc4652';
      const upload = { ...mockUpload, metadata: { ...mockUpload.metadata, livePhotoVideoId: videoId } };
      const video = {
        ...assetStub.image,
        id: videoId,
        ownerId: userId,
        type: AssetType.Video,
        visibility: AssetVisibility.Timeline,
      };
      mocks.asset.getById.mockResolvedValue(video);
      mocks.asset.create.mockResolvedValue({ ...assetStub.image, ownerId: userId });

      await (sut as any).createAssetFromUpload(userId, upload, checksum);

      expect(mocks.asset.create).toHaveBeenCalledWith(expect.objectContaining({ livePhotoVideoId: videoId }));
      expect(mocks.asset.update).toHaveBeenCalledWith({ id: videoId, visibility: AssetVisibility.Hidden });
      expect(mocks.event.emit).toHaveBeenCalledWith('AssetHide', { assetId: videoId, userId });
    });

    it('should deny selecting another owner’s live photo video', async () => {
      mocks.asset.create.mockResolvedValue({ ...assetStub.image, ownerId: userId });
      const videoId = '435f449b-d897-4e23-82dd-f45cd3cc4652';
      const upload = { ...mockUpload, metadata: { ...mockUpload.metadata, livePhotoVideoId: videoId } };
      mocks.asset.getById.mockResolvedValue({
        ...assetStub.image,
        id: videoId,
        ownerId: authStub.user2.user.id,
        type: AssetType.Video,
      });

      await expect((sut as any).createAssetFromUpload(userId, upload, checksum)).rejects.toThrow(ForbiddenException);
      expect(mocks.asset.create).not.toHaveBeenCalled();
      expect(mocks.asset.update).not.toHaveBeenCalled();
    });

    it('should verify the registered media size against the latest quota before creating an asset', async () => {
      mocks.asset.create.mockResolvedValue({ ...assetStub.image, ownerId: userId });
      mocks.user.get.mockResolvedValue({
        ...userStub.user1,
        quotaSizeInBytes: 1200,
        quotaUsageInBytes: 500,
      });

      await expect((sut as any).createAssetFromUpload(userId, mockUpload, checksum)).rejects.toThrow(
        'Quota has been exceeded!',
      );
      expect(mocks.user.get).toHaveBeenCalledWith(userId, {});
      expect(mocks.asset.create).not.toHaveBeenCalled();
      expect(mocks.user.updateUsage).not.toHaveBeenCalled();
    });

    it('should report a quota rejected finalization as a 400 response', async () => {
      mocks.asset.create.mockResolvedValue({ ...assetStub.image, ownerId: userId });
      const upload = { ...mockUpload, offset: mockUpload.size };
      mocks.storage.readTextFile.mockResolvedValue(JSON.stringify(upload));
      mocks.user.get.mockResolvedValue({
        ...userStub.user1,
        quotaSizeInBytes: 1200,
        quotaUsageInBytes: 500,
      });
      const server = await (sut as any).initializeTusServer();

      await expect(
        server.options.onUploadFinish({ ...createMockRequest(userId), method: 'PATCH' }, upload),
      ).rejects.toMatchObject({ status_code: 400, body: 'Quota has been exceeded!' });
      expect(mocks.asset.create).not.toHaveBeenCalled();
    });

    it('should require the declared sidecar before registering a resumable asset', async () => {
      mocks.asset.create.mockResolvedValue({ ...assetStub.image, ownerId: userId });
      const upload = { ...mockUpload, metadata: { ...mockUpload.metadata, sidecarRequired: 'true' } };

      await expect((sut as any).createAssetFromUpload(userId, upload, checksum)).rejects.toThrow(ConflictException);
      expect(mocks.asset.create).not.toHaveBeenCalled();
    });

    it('should move staged sidecar bytes and register them for metadata extraction', async () => {
      const upload = { ...mockUpload, metadata: { ...mockUpload.metadata, sidecarRequired: 'true' } };
      const path = '/data/upload/upload-id.jpg';
      const asset = { ...assetStub.image, ownerId: userId };
      mocks.asset.create.mockResolvedValue(asset);
      mocks.storage.checkFileExists.mockImplementation((file) => Promise.resolve(file === `${path}.sidecar`));

      await (sut as any).createAssetFromUpload(userId, upload, checksum);

      expect(mocks.storage.rename).toHaveBeenCalledWith(`${path}.sidecar`, `${path}.xmp`);
      expect(mocks.asset.upsertFile).toHaveBeenCalledWith({
        assetId: asset.id,
        path: `${path}.xmp`,
        type: AssetFileType.Sidecar,
      });
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.AssetExtractMetadata,
        data: { id: asset.id, source: 'upload' },
      });
    });

    it('should update file timestamps', async () => {
      const upload = mockUpload;

      mocks.asset.create.mockResolvedValue({
        id: 'asset-id',
        ownerId: userId,
      } as any);

      await (sut as any).createAssetFromUpload(userId, upload, checksum);

      expect(mocks.storage.utimes).toHaveBeenCalledWith(
        '/data/upload/upload-id.jpg',
        expect.any(Date),
        new Date('2023-01-01T00:00:00.000Z'),
      );
    });

    it('should upsert exif with file size', async () => {
      const upload = mockUpload;

      mocks.asset.create.mockResolvedValue({
        id: 'asset-id',
        ownerId: userId,
      } as any);

      await (sut as any).createAssetFromUpload(userId, upload, checksum);

      expect(mocks.asset.upsertExif).toHaveBeenCalledWith(
        { assetId: 'asset-id', fileSizeInByte: 1000 },
        { lockedPropertiesBehavior: 'override' },
      );
    });

    it('should finalize and queue extraction when preliminary EXIF storage fails', async () => {
      const upload = { ...mockUpload, offset: mockUpload.size };
      const asset = { ...assetStub.image, ownerId: userId };
      mocks.asset.create.mockResolvedValue(asset);
      mocks.asset.upsertExif.mockRejectedValue(new Error('EXIF write failed'));
      mocks.storage.readTextFile.mockResolvedValue(JSON.stringify(upload));

      const server = await (sut as any).initializeTusServer();
      const result = await server.options.onUploadFinish({ ...createMockRequest(userId), method: 'PATCH' }, upload);

      expect(result.headers).toEqual({ 'X-Immich-Asset-Id': asset.id, 'X-Immich-Duplicate': 'false' });
      expect(mocks.event.emit).toHaveBeenCalledWith('AssetCreate', { asset });
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.AssetExtractMetadata,
        data: { id: asset.id, source: 'upload' },
      });
    });

    it('should throw BadRequestException if filename is missing', async () => {
      const upload = {
        ...mockUpload,
        metadata: {
          deviceAssetId: 'device-asset-id',
          deviceId: 'device-id',
        },
      };

      await expect((sut as any).createAssetFromUpload(userId, upload, checksum)).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if deviceAssetId is missing', async () => {
      const upload = {
        ...mockUpload,
        metadata: {
          filename: 'test.jpg',
          deviceId: 'device-id',
        },
      };

      await expect((sut as any).createAssetFromUpload(userId, upload, checksum)).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if deviceId is missing', async () => {
      const upload = {
        ...mockUpload,
        metadata: {
          filename: 'test.jpg',
          deviceAssetId: 'device-asset-id',
        },
      };

      await expect((sut as any).createAssetFromUpload(userId, upload, checksum)).rejects.toThrow(BadRequestException);
    });

    it('should use current date for fileCreatedAt if not provided', async () => {
      const upload = {
        ...mockUpload,
        metadata: {
          filename: 'test.jpg',
          deviceAssetId: 'device-asset-id',
          deviceId: 'device-id',
        },
      };

      mocks.asset.create.mockResolvedValue({
        id: 'asset-id',
        ownerId: userId,
      } as any);

      await (sut as any).createAssetFromUpload(userId, upload, checksum);

      expect(mocks.asset.create).toHaveBeenCalledWith(
        expect.objectContaining({
          fileCreatedAt: expect.any(Date),
          fileModifiedAt: expect.any(Date),
        }),
      );
    });

    it('should not update usage when duplicate is found', async () => {
      const upload = mockUpload;

      mocks.asset.getUploadAssetIdByChecksum.mockResolvedValue('existing-asset-id');
      mocks.asset.getById.mockResolvedValue({
        ...assetStub.image,
        ownerId: userId,
        originalPath: '/data/upload/existing.jpg',
      });

      await (sut as any).createAssetFromUpload(userId, upload, checksum);

      expect(mocks.user.updateUsage).not.toHaveBeenCalled();
    });
  });

  describe('handleTusUpload', () => {
    it('should attach auth to request headers and call tus server', async () => {
      const auth = authStub.user1;
      const mockReq = { headers: {} } as unknown as Request;
      const mockRes = {} as Response;

      const mockHandle = vi.fn().mockImplementation(() => Promise.resolve());
      const mockServer = {
        handle: mockHandle,
      };

      // Mock the tus server initialization
      vi.spyOn(sut as any, 'initializeTusServer').mockResolvedValue(mockServer);

      await sut.handleTusUpload(auth, mockReq, mockRes);

      expect(mockReq.headers['x-immich-user-id']).toBe(auth.user.id);
      expect(mockReq.headers['x-immich-quota-size']).toBe(String(auth.user.quotaSizeInBytes ?? ''));
      expect(mockReq.headers['x-immich-quota-usage']).toBe(String(auth.user.quotaUsageInBytes ?? 0));
      expect(mockHandle).toHaveBeenCalledWith(mockReq, mockRes);
    });
  });

  describe('completed uploads', () => {
    const auth = {
      ...authStub.user1,
      user: { ...authStub.user1.user, id: 'febfcca0-9aaa-49de-9676-4044e5a5cd58' },
    };
    const uploadId = `${auth.user.id}/de/fa/defab6b4-85ac-4938-9f2e-305742a7bdf3`;
    const assetId = '83dbc180-6560-421a-8a7a-0da2bb6a2250';
    const upload = { ...mockUpload, id: uploadId, creation_date: new Date().toISOString(), metadata: undefined };

    it('should retrieve the persisted asset ID after the upload file has moved', async () => {
      mocks.storage.readTextFile.mockResolvedValue(
        JSON.stringify({ ...upload, result: { assetId, isDuplicate: false } }),
      );
      const request = {
        method: 'HEAD',
        url: `/api/upload/${uploadId}`,
        headers: { 'tus-resumable': '1.0.0' },
      } as unknown as Request;
      const response = {
        setHeader: vi.fn(),
        end: vi.fn(),
      } as unknown as Response;

      await sut.handleTusUpload(auth, request, response);

      expect(mocks.storage.readTextFile).toHaveBeenCalledWith(`/data/upload/${uploadId}.json`);
      expect(response.setHeader).toHaveBeenCalledWith('X-Immich-Asset-Id', assetId);
      expect(response.setHeader).toHaveBeenCalledWith('X-Immich-Duplicate', 'false');
      expect(response.setHeader).toHaveBeenCalledWith('Upload-Offset', '1000');
      expect(response.statusCode).toBe(200);
      expect(response.end).toHaveBeenCalled();
    });

    it('should keep a registered original without a persisted tus result', async () => {
      const path = `/data/upload/${uploadId}`;
      const [owner, first, second, filename] = uploadId.split('/');
      mocks.storage.readdir
        .mockResolvedValueOnce([owner])
        .mockResolvedValueOnce([first])
        .mockResolvedValueOnce([second])
        .mockResolvedValueOnce([`${filename}.json`]);
      mocks.storage.readTextFile.mockResolvedValue(
        JSON.stringify({ ...upload, offset: 0, creation_date: '2023-01-01T00:00:00.000Z' }),
      );
      mocks.storage.stat.mockResolvedValue({ size: upload.size } as Stats);

      mocks.asset.hasOriginal.mockResolvedValue(true);

      await sut.handleUploadCleanup();

      expect(mocks.asset.hasOriginal).toHaveBeenCalledExactlyOnceWith(auth.user.id, path);

      expect(mocks.storage.unlink).toHaveBeenCalledExactlyOnceWith(`${path}.json`);
    });

    it('should reclaim a fully staged expired upload when finalization never registered an asset', async () => {
      const path = `/data/upload/${uploadId}`;
      const [owner, first, second, filename] = uploadId.split('/');
      mocks.storage.readdir
        .mockResolvedValueOnce([owner])
        .mockResolvedValueOnce([first])
        .mockResolvedValueOnce([second])
        .mockResolvedValueOnce([`${filename}.json`]);
      mocks.storage.readTextFile.mockResolvedValue(
        JSON.stringify({ ...upload, creation_date: '2023-01-01T00:00:00.000Z' }),
      );
      mocks.storage.stat.mockResolvedValue({ size: upload.size } as Stats);
      mocks.storage.checkFileExists.mockImplementation((file) => Promise.resolve(file === `${path}.sidecar`));

      await sut.handleUploadCleanup();

      expect(mocks.storage.unlink.mock.calls).toEqual([[path], [`${path}.sidecar`], [`${path}.json`]]);
    });

    it('should keep the upload record when expiration cleanup needs a retry', async () => {
      const path = `/data/upload/${uploadId}`;
      const [owner, first, second, filename] = uploadId.split('/');
      mocks.storage.readdir
        .mockResolvedValueOnce([owner])
        .mockResolvedValueOnce([first])
        .mockResolvedValueOnce([second])
        .mockResolvedValueOnce([`${filename}.json`]);
      mocks.storage.readTextFile.mockResolvedValue(
        JSON.stringify({ ...upload, creation_date: '2023-01-01T00:00:00.000Z' }),
      );
      mocks.storage.stat.mockResolvedValue({ size: upload.size } as Stats);
      mocks.storage.unlink.mockRejectedValueOnce(new Error('Temporary storage failure'));

      await expect(sut.handleUploadCleanup()).rejects.toThrow('Temporary storage failure');
      expect(mocks.storage.unlink).toHaveBeenCalledExactlyOnceWith(path);
    });

    it('should remove an expired nested partial upload and its staged sidecar', async () => {
      const path = `/data/upload/${uploadId}`;
      const [owner, first, second, filename] = uploadId.split('/');
      mocks.storage.readdir
        .mockResolvedValueOnce([owner])
        .mockResolvedValueOnce([first])
        .mockResolvedValueOnce([second])
        .mockResolvedValueOnce([`${filename}.json`]);
      mocks.storage.readTextFile.mockResolvedValue(
        JSON.stringify({ ...upload, creation_date: '2023-01-01T00:00:00.000Z' }),
      );
      mocks.storage.stat.mockResolvedValue({ size: 100 } as Stats);

      mocks.storage.checkFileExists.mockImplementation((file) => Promise.resolve(file === `${path}.sidecar`));

      await sut.handleUploadCleanup();

      expect(mocks.storage.unlink.mock.calls).toEqual([[path], [`${path}.sidecar`], [`${path}.json`]]);
    });

    it('should leave a transfer alone while another worker holds its upload lock', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'immich-tus-'));
      const path = join(directory, 'upload');
      const { lock: lockFile } = await vi.importActual<typeof import('proper-lockfile')>('proper-lockfile');
      vi.mocked(lock).mockImplementationOnce(lockFile).mockImplementationOnce(lockFile);

      const cleanup = newTestService(TusService);
      const [owner, first, second, filename] = uploadId.split('/');
      cleanup.mocks.storage.readdir
        .mockResolvedValueOnce([owner])
        .mockResolvedValueOnce([first])
        .mockResolvedValueOnce([second])
        .mockResolvedValueOnce([`${filename}.json`]);
      cleanup.mocks.storage.readTextFile.mockResolvedValue(
        JSON.stringify({ ...upload, creation_date: '2023-01-01T00:00:00.000Z' }),
      );
      cleanup.mocks.storage.stat.mockResolvedValue({ size: 100 } as Stats);

      vi.spyOn(sut as any, 'getUploadPath').mockReturnValue(path);
      vi.spyOn(cleanup.sut as any, 'getUploadPath').mockReturnValue(path);

      let started!: () => void;
      const writing = new Promise<void>((resolve) => {
        started = resolve;
      });
      let finish!: () => void;
      const written = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const server = await (sut as any).initializeTusServer();
      server.handle.mockImplementation(() => {
        started();
        return written;
      });
      const request = {
        method: 'PATCH',
        url: `/api/upload/${uploadId}`,
        headers: { 'tus-resumable': '1.0.0' },
      } as unknown as Request;

      const transfer = sut.handleTusUpload(auth, request, {} as Response);
      try {
        await Promise.race([writing, transfer]);
        await cleanup.sut.handleUploadCleanup();
        expect(cleanup.mocks.storage.unlink).not.toHaveBeenCalled();
      } finally {
        finish();
        await transfer;
        await rm(directory, { recursive: true });
      }
    });

    it('should allow staging a sidecar for a fully transferred upload before registration', async () => {
      const path = `/data/upload/${uploadId}`;
      const contents = Buffer.from('XMP data');
      const temporary = `${path}.sidecar.tmp`;
      const request = Object.assign(Readable.from([contents]), {
        url: `/api/upload/${uploadId}/sidecar`,
        headers: { 'content-type': 'application/octet-stream', 'content-length': String(contents.length) },
      }) as unknown as Request;
      const written: Buffer[] = [];
      mocks.storage.readTextFile.mockResolvedValue(JSON.stringify(upload));
      mocks.storage.stat.mockImplementation((file) =>
        Promise.resolve({ size: file === temporary ? contents.length : upload.size } as Stats),
      );
      mocks.storage.createWriteStream.mockReturnValue(
        new Writable({
          write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
            written.push(chunk);
            callback();
          },
        }),
      );

      await sut.stageSidecar(auth, request);

      expect(written).toEqual([contents]);
      expect(mocks.storage.rename).toHaveBeenCalledExactlyOnceWith(temporary, `${path}.sidecar`);
    });

    it('should reject staging a sidecar after a legacy original was registered', async () => {
      mocks.storage.readTextFile.mockResolvedValue(JSON.stringify(upload));
      mocks.storage.stat.mockResolvedValue({ size: upload.size } as Stats);
      mocks.asset.hasOriginal.mockResolvedValue(true);
      const request = {
        url: `/api/upload/${uploadId}/sidecar`,
        headers: { 'content-type': 'application/octet-stream', 'content-length': '0' },
      } as unknown as Request;

      await expect(sut.stageSidecar(auth, request)).rejects.toThrow(ConflictException);
      expect(mocks.asset.hasOriginal).toHaveBeenCalledExactlyOnceWith(auth.user.id, `/data/upload/${uploadId}`);
      expect(mocks.storage.createWriteStream).not.toHaveBeenCalled();
    });

    it('should configure tus to protect the bytes of completed uploads from termination', async () => {
      const server = await (sut as any).initializeTusServer();

      expect(server.options.disableTerminationForFinishedUploads).toBe(true);
    });
  });

  describe('onApplicationShutdown', () => {
    it('should reset server state on shutdown', () => {
      // Set up the internal state to simulate an initialized server
      const mockServer = {
        handle: vi.fn().mockImplementation(() => Promise.resolve()),
      };
      (sut as any).tusServer = mockServer;
      (sut as any).initPromise = Promise.resolve();

      // Verify server was initialized
      expect((sut as any).tusServer).toBeTruthy();

      // Call shutdown
      sut.onApplicationShutdown();

      // Verify state was reset
      expect((sut as any).tusServer).toBeNull();
      expect((sut as any).initPromise).toBeNull();
    });

    it('should handle shutdown when server not initialized', () => {
      // Ensure server is not initialized
      (sut as any).tusServer = null;
      (sut as any).initPromise = null;

      // Call shutdown without initializing server
      expect(() => sut.onApplicationShutdown()).not.toThrow();

      // Verify state is still null
      expect((sut as any).tusServer).toBeNull();
      expect((sut as any).initPromise).toBeNull();
    });
  });
});
