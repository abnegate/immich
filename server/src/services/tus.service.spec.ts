import { BadRequestException } from '@nestjs/common';
import { Stats } from 'node:fs';
import { Request, Response } from 'express';
import { AssetFileType, AssetType, AssetVisibility, JobName } from 'src/enum';
import { TusService } from 'src/services/tus.service';
import { authStub } from 'test/fixtures/auth.stub';
import { newTestService, ServiceMocks } from 'test/utils';
import { vi } from 'vitest';

// Mock the TUS modules to avoid real filesystem operations
vi.mock('@tus/server', () => ({
  Server: vi.fn().mockImplementation((options) => {
    // Store the options for testing
    return {
      options,
      handle: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));

vi.mock('@tus/file-store', () => ({
  FileStore: vi.fn().mockImplementation(() => ({})),
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

describe(TusService.name, () => {
  let sut: TusService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(TusService));
    // Mock storage mkdirSync to avoid filesystem operations
    mocks.storage.mkdirSync.mockReturnValue(undefined);
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
      });
    });

    it('should handle missing metadata gracefully', () => {
      const result = (sut as any).parseMetadata(undefined);
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
      });
    });
  });

  describe('onUploadCreate validation', () => {
    // Helper to create mock request with Web API Headers (as TUS library provides)
    const createMockReq = (userId?: string, quotaSize?: number | null, quotaUsage?: number) => {
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

    let mockReq: any;
    let upload: any;

    beforeEach(() => {
      mockReq = createMockReq(authStub.user1.user.id, null, 0);
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
      mockReq = createMockReq(); // No user ID

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
      mockReq = createMockReq(authStub.user1.user.id, 1000, 500);
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
      mockReq = createMockReq(authStub.user1.user.id, null, 500);
      upload.size = 1_000_000; // Large file

      const tusServer = await (sut as any).initializeTusServer();
      const onUploadCreate = (tusServer as any).options.onUploadCreate;

      const result = await onUploadCreate(mockReq, upload);

      expect(result).toEqual({});
    });

    it('should allow upload when quota not exceeded', async () => {
      mockReq = createMockReq(authStub.user1.user.id, 10_000, 5_000);
      upload.size = 4_000; // Within quota

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

      // Mock calculateChecksum to avoid file system access
      vi.spyOn(sut as any, 'calculateChecksum').mockResolvedValue(checksum);
    });

    it('should create asset with correct metadata', async () => {
      const upload = mockUpload;

      mocks.asset.getUploadAssetIdByChecksum.mockResolvedValue(null);
      mocks.asset.create.mockResolvedValue({
        id: 'asset-id',
        ownerId: userId,
      } as any);

      const result = await (sut as any).createAssetFromUpload(userId, upload);

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

      const result = await (sut as any).createAssetFromUpload(userId, upload);

      expect(result).toEqual({ assetId: 'existing-asset-id', isDuplicate: true });
      expect(mocks.asset.create).not.toHaveBeenCalled();
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.FileDelete,
        data: { files: ['/data/upload/upload-id.jpg'] },
      });
    });

    it('should handle sidecar data', async () => {
      const upload = mockUploadWithSidecar;

      mocks.asset.getUploadAssetIdByChecksum.mockResolvedValue(null);
      mocks.asset.create.mockResolvedValue({
        id: 'asset-id',
        ownerId: userId,
      } as any);

      const result = await (sut as any).createAssetFromUpload(userId, upload);

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

      mocks.asset.getUploadAssetIdByChecksum.mockResolvedValue(null);
      mocks.asset.create.mockResolvedValue({
        id: 'asset-id',
        ownerId: userId,
      } as any);

      // Mock storage to throw an error when writing sidecar
      mocks.storage.createOrOverwriteFile.mockRejectedValue(new Error('Write error'));

      // Should not throw even when sidecar write fails
      const result = await (sut as any).createAssetFromUpload(userId, upload);

      expect(result).toEqual({ assetId: 'asset-id', isDuplicate: false });
      // Sidecar file write should have been attempted
      expect(mocks.storage.createOrOverwriteFile).toHaveBeenCalled();
      // Asset should still be created despite sidecar error
      expect(mocks.asset.create).toHaveBeenCalled();
    });

    it('should update user quota', async () => {
      const upload = mockUpload;

      mocks.asset.getUploadAssetIdByChecksum.mockResolvedValue(null);
      mocks.asset.create.mockResolvedValue({
        id: 'asset-id',
        ownerId: userId,
      } as any);

      await (sut as any).createAssetFromUpload(userId, upload);

      expect(mocks.user.updateUsage).toHaveBeenCalledWith(userId, 1000);
    });

    it('should queue metadata extraction job', async () => {
      const upload = mockUpload;

      mocks.asset.getUploadAssetIdByChecksum.mockResolvedValue(null);
      mocks.asset.create.mockResolvedValue({
        id: 'asset-id',
        ownerId: userId,
      } as any);

      await (sut as any).createAssetFromUpload(userId, upload);

      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.AssetExtractMetadata,
        data: { id: 'asset-id', source: 'upload' },
      });
    });

    it('should emit AssetCreate event', async () => {
      const upload = mockUpload;

      mocks.asset.getUploadAssetIdByChecksum.mockResolvedValue(null);
      mocks.asset.create.mockResolvedValue({
        id: 'asset-id',
        ownerId: userId,
      } as any);

      await (sut as any).createAssetFromUpload(userId, upload);

      expect(mocks.event.emit).toHaveBeenCalledWith('AssetCreate', {
        asset: expect.objectContaining({ id: 'asset-id' }),
      });
    });

    it('should handle video assets correctly', async () => {
      const upload = mockUploadVideo;

      mocks.asset.getUploadAssetIdByChecksum.mockResolvedValue(null);
      mocks.asset.create.mockResolvedValue({
        id: 'asset-id',
        ownerId: userId,
      } as any);

      await (sut as any).createAssetFromUpload(userId, upload);

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

      mocks.asset.getUploadAssetIdByChecksum.mockResolvedValue(null);
      mocks.asset.create.mockResolvedValue({
        id: 'asset-id',
        ownerId: userId,
      } as any);

      await (sut as any).createAssetFromUpload(userId, upload);

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

      mocks.asset.getUploadAssetIdByChecksum.mockResolvedValue(null);
      mocks.asset.create.mockResolvedValue({
        id: 'asset-id',
        ownerId: userId,
      } as any);

      await (sut as any).createAssetFromUpload(userId, upload);

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

      mocks.asset.getUploadAssetIdByChecksum.mockResolvedValue(null);
      mocks.asset.create.mockResolvedValue({
        id: 'asset-id',
        ownerId: userId,
      } as any);

      await (sut as any).createAssetFromUpload(userId, upload);

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

      mocks.asset.getUploadAssetIdByChecksum.mockResolvedValue(null);
      mocks.asset.create.mockResolvedValue({
        id: 'asset-id',
        ownerId: userId,
      } as any);

      await (sut as any).createAssetFromUpload(userId, upload);

      expect(mocks.asset.create).toHaveBeenCalledWith(
        expect.objectContaining({
          visibility: AssetVisibility.Timeline,
        }),
      );
    });

    it('should set livePhotoVideoId from metadata', async () => {
      const upload = {
        ...mockUpload,
        metadata: {
          ...mockUpload.metadata,
          livePhotoVideoId: 'video-id',
        },
      };

      mocks.asset.getUploadAssetIdByChecksum.mockResolvedValue(null);
      mocks.asset.create.mockResolvedValue({
        id: 'asset-id',
        ownerId: userId,
      } as any);

      await (sut as any).createAssetFromUpload(userId, upload);

      expect(mocks.asset.create).toHaveBeenCalledWith(
        expect.objectContaining({
          livePhotoVideoId: 'video-id',
        }),
      );
    });

    it('should update file timestamps', async () => {
      const upload = mockUpload;

      mocks.asset.getUploadAssetIdByChecksum.mockResolvedValue(null);
      mocks.asset.create.mockResolvedValue({
        id: 'asset-id',
        ownerId: userId,
      } as any);

      await (sut as any).createAssetFromUpload(userId, upload);

      expect(mocks.storage.utimes).toHaveBeenCalledWith(
        '/data/upload/upload-id.jpg',
        expect.any(Date),
        new Date('2023-01-01T00:00:00.000Z'),
      );
    });

    it('should upsert exif with file size', async () => {
      const upload = mockUpload;

      mocks.asset.getUploadAssetIdByChecksum.mockResolvedValue(null);
      mocks.asset.create.mockResolvedValue({
        id: 'asset-id',
        ownerId: userId,
      } as any);

      await (sut as any).createAssetFromUpload(userId, upload);

      expect(mocks.asset.upsertExif).toHaveBeenCalledWith(
        { assetId: 'asset-id', fileSizeInByte: 1000 },
        { lockedPropertiesBehavior: 'override' },
      );
    });

    it('should throw BadRequestException if filename is missing', async () => {
      const upload = {
        ...mockUpload,
        metadata: {
          deviceAssetId: 'device-asset-id',
          deviceId: 'device-id',
        },
      };

      await expect((sut as any).createAssetFromUpload(userId, upload)).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if deviceAssetId is missing', async () => {
      const upload = {
        ...mockUpload,
        metadata: {
          filename: 'test.jpg',
          deviceId: 'device-id',
        },
      };

      await expect((sut as any).createAssetFromUpload(userId, upload)).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if deviceId is missing', async () => {
      const upload = {
        ...mockUpload,
        metadata: {
          filename: 'test.jpg',
          deviceAssetId: 'device-asset-id',
        },
      };

      await expect((sut as any).createAssetFromUpload(userId, upload)).rejects.toThrow(BadRequestException);
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

      mocks.asset.getUploadAssetIdByChecksum.mockResolvedValue(null);
      mocks.asset.create.mockResolvedValue({
        id: 'asset-id',
        ownerId: userId,
      } as any);

      await (sut as any).createAssetFromUpload(userId, upload);

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

      await (sut as any).createAssetFromUpload(userId, upload);

      expect(mocks.user.updateUsage).not.toHaveBeenCalled();
    });
  });

  describe('handleTusUpload', () => {
    it('should attach auth to request headers and call tus server', async () => {
      const auth = authStub.user1;
      const mockReq = { headers: {} } as unknown as Request;
      const mockRes = {} as Response;

      const mockHandle = vi.fn().mockResolvedValue(undefined);
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

  describe('onApplicationShutdown', () => {
    it('should reset server state on shutdown', async () => {
      // Set up the internal state to simulate an initialized server
      const mockServer = {
        handle: vi.fn().mockResolvedValue(undefined),
      };
      (sut as any).tusServer = mockServer;
      (sut as any).initPromise = Promise.resolve();

      // Verify server was initialized
      expect((sut as any).tusServer).toBeTruthy();

      // Call shutdown
      await sut.onApplicationShutdown();

      // Verify state was reset
      expect((sut as any).tusServer).toBeNull();
      expect((sut as any).initPromise).toBeNull();
    });

    it('should handle shutdown when server not initialized', async () => {
      // Ensure server is not initialized
      (sut as any).tusServer = null;
      (sut as any).initPromise = null;

      // Call shutdown without initializing server
      await expect(sut.onApplicationShutdown()).resolves.not.toThrow();

      // Verify state is still null
      expect((sut as any).tusServer).toBeNull();
      expect((sut as any).initPromise).toBeNull();
    });
  });
});
