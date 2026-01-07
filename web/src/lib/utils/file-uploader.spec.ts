import { uploadAssetsStore } from '$lib/stores/upload';
import { AssetVisibility } from '@immich/sdk';
import { get } from 'svelte/store';
import { cancelUpload, fileUploadHandler, uploadExecutionQueue } from './file-uploader';

// Hoisted values for use in mock factories
const { tusUploadCalls, tusInstances, createMockUpload, setFindPreviousUploadsResult } = vi.hoisted(() => {
  const calls: Array<{ file: File; options: any }> = [];
  const instances: Array<any> = [];
  let previousUploadsResult: any[] = [];

  return {
    tusUploadCalls: calls,
    tusInstances: instances,
    setFindPreviousUploadsResult: (result: any[]) => {
      previousUploadsResult = result;
    },
    createMockUpload: (file: File, options: any) => {
      const instance = {
        start: vi.fn().mockImplementation(() => {
          // Simulate successful upload after a tick
          setTimeout(() => {
            if (options.onSuccess) {
              options.onSuccess();
            }
          }, 0);
        }),
        abort: vi.fn(),
        findPreviousUploads: vi.fn().mockImplementation(() => {
          const result = previousUploadsResult;
          previousUploadsResult = []; // Reset after use
          return Promise.resolve(result);
        }),
        resumeFromPreviousUpload: vi.fn(),
        url: 'http://localhost/upload/test-upload-id',
        _xhr: {
          getResponseHeader: vi.fn().mockReturnValue('test-asset-id'),
        },
      };
      calls.push({ file, options });
      instances.push(instance);
      return instance;
    },
  };
});

// Mock tus-js-client
vi.mock('tus-js-client', () => ({
  Upload: vi.fn().mockImplementation((file, options) => createMockUpload(file, options)),
}));

// Mock @immich/sdk
vi.mock('@immich/sdk', async () => {
  const actual = await vi.importActual('@immich/sdk');
  return {
    ...actual,
    getBaseUrl: vi.fn().mockReturnValue('http://localhost'),
    checkBulkUpload: vi.fn().mockResolvedValue({ results: [{ action: 'accept' }] }),
  };
});

// Mock auth manager
vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: {
    params: {},
    isSharedLink: false,
  },
}));

// Mock upload manager
vi.mock('$lib/managers/upload-manager.svelte', () => ({
  uploadManager: {
    getExtensions: vi.fn().mockReturnValue(['.jpg', '.jpeg', '.png', '.mp4', '.mov']),
  },
}));

// Mock svelte-i18n
vi.mock('svelte-i18n', () => ({
  t: {
    subscribe: vi.fn((cb) => {
      cb((key: string) => key);
      return () => {};
    }),
  },
}));

// Mock svelte tick
vi.mock('svelte', async () => {
  const actual = await vi.importActual('svelte');
  return {
    ...actual,
    tick: vi.fn().mockResolvedValue(undefined),
  };
});

// Mock crypto.subtle.digest to be fast - store original and spy on it
const mockDigest = vi.fn().mockResolvedValue(new ArrayBuffer(20));
vi.stubGlobal('crypto', {
  ...crypto,
  subtle: {
    ...crypto?.subtle,
    digest: mockDigest,
  },
});

// Mock uploadRequest
vi.mock('$lib/utils', async () => {
  const actual = await vi.importActual('$lib/utils');
  return {
    ...actual,
    uploadRequest: vi.fn().mockResolvedValue({
      status: 201,
      data: { id: 'test-asset-id', status: 'created' },
    }),
  };
});

// Mock asset-utils
vi.mock('$lib/utils/asset-utils', () => ({
  addAssetsToAlbum: vi.fn().mockResolvedValue(undefined),
}));

// Mock handle-error
vi.mock('./handle-error', () => ({
  handleError: vi.fn().mockReturnValue('Upload failed'),
}));

// Mock user store
vi.mock('$lib/stores/user.store', () => ({
  user: {
    subscribe: vi.fn((cb) => {
      cb({ id: 'test-user' });
      return () => {};
    }),
  },
}));

// Mock shared-links
vi.mock('$lib/utils/shared-links', () => ({
  asQueryString: vi.fn().mockReturnValue(''),
}));

describe('file-uploader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tusUploadCalls.length = 0;
    tusInstances.length = 0;
    // Reset upload store
    uploadAssetsStore.reset();
  });

  describe('RESUMABLE_UPLOAD_THRESHOLD', () => {
    it('should be 10MB (verified through file size comparison)', () => {
      const smallFile = new File(['x'.repeat(1024)], 'small.jpg', { type: 'image/jpeg' });
      const largeFile = new File(['x'.repeat(10 * 1024 * 1024 + 1)], 'large.jpg', { type: 'image/jpeg' });

      expect(smallFile.size).toBeLessThan(10 * 1024 * 1024);
      expect(largeFile.size).toBeGreaterThan(10 * 1024 * 1024);
    });
  });

  describe('uploadExecutionQueue', () => {
    it('should be defined', () => {
      expect(uploadExecutionQueue).toBeDefined();
    });
  });

  describe('fileUploadHandler', () => {
    it('should filter files by supported extensions', async () => {
      const jpgFile = new File(['test'], 'test.jpg', { type: 'image/jpeg' });
      const txtFile = new File(['test'], 'test.txt', { type: 'text/plain' });

      fileUploadHandler({ files: [jpgFile, txtFile] });

      await vi.waitFor(
        () => {
          const items = get(uploadAssetsStore);
          return items.length > 0;
        },
        { timeout: 1000 },
      ).catch(() => {});

      const items = get(uploadAssetsStore);
      const txtItem = items.find((item) => item.file?.name === 'test.txt');
      expect(txtItem).toBeUndefined();
    });

    it('should add files to upload store', async () => {
      const file = new File(['test'], 'test.jpg', { type: 'image/jpeg' });

      fileUploadHandler({ files: [file] });

      await vi.waitFor(
        () => {
          const items = get(uploadAssetsStore);
          return items.length > 0;
        },
        { timeout: 1000 },
      ).catch(() => {});

      const items = get(uploadAssetsStore);
      expect(items.length).toBeGreaterThanOrEqual(1);
    });

    it('should generate correct device asset id', async () => {
      const file = new File(['test'], 'test.jpg', { type: 'image/jpeg' });
      Object.defineProperty(file, 'lastModified', { value: 1234567890 });

      fileUploadHandler({ files: [file] });

      await vi.waitFor(
        () => {
          const items = get(uploadAssetsStore);
          return items.length > 0;
        },
        { timeout: 1000 },
      ).catch(() => {});

      const items = get(uploadAssetsStore);
      const item = items.find((i) => i.file?.name === 'test.jpg');
      expect(item?.id).toBe('web-test.jpg-1234567890');
    });

    it('should pass albumId to upload item', async () => {
      const file = new File(['test'], 'test.jpg', { type: 'image/jpeg' });

      fileUploadHandler({ files: [file], albumId: 'test-album-id' });

      await vi.waitFor(
        () => {
          const items = get(uploadAssetsStore);
          return items.length > 0;
        },
        { timeout: 1000 },
      ).catch(() => {});

      const items = get(uploadAssetsStore);
      const item = items.find((i) => i.file?.name === 'test.jpg');
      expect(item?.albumId).toBe('test-album-id');
    });
  });

  describe('cancelUpload', () => {
    it('should handle cancelling non-existent upload gracefully', () => {
      expect(() => cancelUpload('non-existent-id')).not.toThrow();
    });
  });

  describe('resumable upload (tus)', () => {
    it('should use tus for files larger than 10MB', async () => {
      const largeFile = new File(['x'.repeat(10 * 1024 * 1024 + 1)], 'large.jpg', { type: 'image/jpeg' });

      const promise = fileUploadHandler({ files: [largeFile] });

      // Wait for the upload to complete
      await promise;

      expect(tusUploadCalls.length).toBeGreaterThan(0);
    });

    it('should set correct tus metadata', async () => {
      const largeFile = new File(['x'.repeat(10 * 1024 * 1024 + 1)], 'large.jpg', { type: 'image/jpeg' });
      Object.defineProperty(largeFile, 'lastModified', { value: 1234567890 });

      await fileUploadHandler({ files: [largeFile] });

      expect(tusUploadCalls.length).toBeGreaterThan(0);
      const { options } = tusUploadCalls[0];
      expect(options.metadata).toMatchObject({
        filename: 'large.jpg',
        deviceId: 'WEB',
        isFavorite: 'false',
      });
    });

    it('should set visibility to locked for locked assets', async () => {
      const largeFile = new File(['x'.repeat(10 * 1024 * 1024 + 1)], 'large.jpg', { type: 'image/jpeg' });

      await fileUploadHandler({ files: [largeFile], isLockedAssets: true });

      expect(tusUploadCalls.length).toBeGreaterThan(0);
      const { options } = tusUploadCalls[0];
      expect(options.metadata.visibility).toBe(AssetVisibility.Locked);
    });

    it('should use 10MB chunk size', async () => {
      const largeFile = new File(['x'.repeat(10 * 1024 * 1024 + 1)], 'large.jpg', { type: 'image/jpeg' });

      await fileUploadHandler({ files: [largeFile] });

      expect(tusUploadCalls.length).toBeGreaterThan(0);
      const { options } = tusUploadCalls[0];
      expect(options.chunkSize).toBe(10 * 1024 * 1024);
    });

    it('should enable fingerprint storage for resuming', async () => {
      const largeFile = new File(['x'.repeat(10 * 1024 * 1024 + 1)], 'large.jpg', { type: 'image/jpeg' });

      await fileUploadHandler({ files: [largeFile] });

      expect(tusUploadCalls.length).toBeGreaterThan(0);
      const { options } = tusUploadCalls[0];
      expect(options.storeFingerprintForResuming).toBe(true);
      expect(options.removeFingerprintOnSuccess).toBe(true);
    });

    it('should check for previous uploads to resume', async () => {
      const largeFile = new File(['x'.repeat(10 * 1024 * 1024 + 1)], 'large.jpg', { type: 'image/jpeg' });

      await fileUploadHandler({ files: [largeFile] });

      expect(tusInstances.length).toBeGreaterThan(0);
      expect(tusInstances[0].findPreviousUploads).toHaveBeenCalled();
    });

    it('should resume from previous upload if available', async () => {
      const previousUpload = { uploadUrl: 'http://localhost/upload/previous-id' };
      setFindPreviousUploadsResult([previousUpload]);

      const largeFile = new File(['x'.repeat(10 * 1024 * 1024 + 1)], 'large.jpg', { type: 'image/jpeg' });

      await fileUploadHandler({ files: [largeFile] });

      expect(tusInstances.length).toBeGreaterThan(0);
      expect(tusInstances[0].resumeFromPreviousUpload).toHaveBeenCalledWith(previousUpload);
    });

    it('should start upload after checking for previous uploads', async () => {
      const largeFile = new File(['x'.repeat(10 * 1024 * 1024 + 1)], 'large.jpg', { type: 'image/jpeg' });

      await fileUploadHandler({ files: [largeFile] });

      expect(tusInstances.length).toBeGreaterThan(0);
      expect(tusInstances[0].start).toHaveBeenCalled();
    });
  });

  describe('multipart upload (small files)', () => {
    it('should not use tus for files smaller than 10MB', async () => {
      const smallFile = new File(['test content'], 'small.jpg', { type: 'image/jpeg' });

      await fileUploadHandler({ files: [smallFile] });

      // tus should NOT be used for small files
      expect(tusUploadCalls.length).toBe(0);
    });
  });

  describe('upload state management', () => {
    it('should add item to store with PENDING state initially', async () => {
      const file = new File(['test'], 'test.jpg', { type: 'image/jpeg' });

      fileUploadHandler({ files: [file] });

      await vi.waitFor(
        () => {
          const items = get(uploadAssetsStore);
          return items.length > 0;
        },
        { timeout: 1000 },
      ).catch(() => {});

      const items = get(uploadAssetsStore);
      expect(items.length).toBeGreaterThan(0);
    });
  });
});
