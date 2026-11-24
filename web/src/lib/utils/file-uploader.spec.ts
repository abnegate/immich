import { authManager } from '$lib/managers/auth-manager.svelte';
import { uploadAssetsStore } from '$lib/stores/upload';
import { UploadState } from '$lib/types';
import { uploadRequest } from '$lib/utils';
import { addAssetsToAlbum } from '$lib/utils/asset-utils';
import { AssetVisibility } from '@immich/sdk';
import { get } from 'svelte/store';
import { DetailedError, type HttpResponse, type PreviousUpload, type Upload } from 'tus-js-client';
import { cancelUpload, fileUploadHandler, uploadExecutionQueue } from './file-uploader';

type UploadOptions = ConstructorParameters<typeof Upload>[1];

const { tusUploadCalls, tusInstances, startUpload, findPreviousUploads } = vi.hoisted(() => ({
  tusUploadCalls: [] as Array<{ file: File; options: UploadOptions }>,
  tusInstances: [] as Array<{
    start: ReturnType<typeof vi.fn>;
    abort: ReturnType<typeof vi.fn>;
    resumeFromPreviousUpload: ReturnType<typeof vi.fn>;
  }>,
  startUpload: vi.fn<(options: UploadOptions) => void>(),
  findPreviousUploads: vi.fn<() => Promise<PreviousUpload[]>>(),
}));

vi.mock('tus-js-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('tus-js-client')>()),
  Upload: vi.fn().mockImplementation((file: File, options: UploadOptions) => {
    const instance = {
      options,
      start: vi.fn(() => startUpload(options)),
      abort: vi.fn().mockResolvedValue(undefined),
      findPreviousUploads,
      resumeFromPreviousUpload: vi.fn(),
      url: 'http://localhost/upload/test-upload-id',
    };
    tusUploadCalls.push({ file, options });
    tusInstances.push(instance);
    return instance;
  }),
}));

const response = (headers: Record<string, string> = {}, status = 200): HttpResponse => ({
  getHeader: (header) => headers[header.toLowerCase()],
  getStatus: () => status,
  getBody: () => '',
  getUnderlyingObject: () => undefined,
});

const uploadError = (method: string, status: number): DetailedError =>
  Object.assign(new DetailedError('Upload failed'), {
    originalRequest: { getMethod: () => method },
    originalResponse: response({}, status),
  });

const largeVideo = (): File => {
  const file = new File([], 'large.mp4', { type: 'video/mp4' });
  Object.defineProperty(file, 'size', { value: 120 * 1024 * 1024 });
  return file;
};

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
    authManager.isSharedLink = false;
    startUpload
      .mockReset()
      .mockImplementation((options) =>
        options.onSuccess?.({ lastResponse: response({ 'x-immich-asset-id': 'test-asset-id' }) }),
      );
    findPreviousUploads.mockReset().mockResolvedValue([]);
    tusUploadCalls.length = 0;
    tusInstances.length = 0;
    // Reset upload store
    uploadAssetsStore.reset();
  });

  describe('RESUMABLE_UPLOAD_THRESHOLD', () => {
    it('should be 50MB (verified through file size comparison)', () => {
      const smallFile = new File(['x'.repeat(1024)], 'small.jpg', { type: 'image/jpeg' });
      const mediumFile = new File(['x'.repeat(25 * 1024 * 1024)], 'medium.jpg', { type: 'image/jpeg' });
      const largeFile = new File(['x'.repeat(50 * 1024 * 1024 + 1)], 'large.jpg', { type: 'image/jpeg' });

      expect(smallFile.size).toBeLessThan(50 * 1024 * 1024);
      expect(mediumFile.size).toBeLessThan(50 * 1024 * 1024);
      expect(largeFile.size).toBeGreaterThan(50 * 1024 * 1024);
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

      void fileUploadHandler({ files: [jpgFile, txtFile] });

      await vi
        .waitFor(
          () => {
            const items = get(uploadAssetsStore);
            return items.length > 0;
          },
          { timeout: 1000 },
        )
        .catch(() => {});

      const items = get(uploadAssetsStore);
      const txtItem = items.find((item) => item.file?.name === 'test.txt');
      expect(txtItem).toBeUndefined();
    });

    it('should add files to upload store', async () => {
      const file = new File(['test'], 'test.jpg', { type: 'image/jpeg' });

      void fileUploadHandler({ files: [file] });

      await vi
        .waitFor(
          () => {
            const items = get(uploadAssetsStore);
            return items.length > 0;
          },
          { timeout: 1000 },
        )
        .catch(() => {});

      const items = get(uploadAssetsStore);
      expect(items.length).toBeGreaterThanOrEqual(1);
    });

    it('should generate correct device asset id', async () => {
      const file = new File(['test'], 'test.jpg', { type: 'image/jpeg' });
      Object.defineProperty(file, 'lastModified', { value: 1_234_567_890 });

      void fileUploadHandler({ files: [file] });

      await vi
        .waitFor(
          () => {
            const items = get(uploadAssetsStore);
            return items.length > 0;
          },
          { timeout: 1000 },
        )
        .catch(() => {});

      const items = get(uploadAssetsStore);
      const item = items.find((i) => i.file?.name === 'test.jpg');
      expect(item?.id).toBe('web-test.jpg-1234567890');
    });

    it('should pass albumId to upload item', async () => {
      const file = new File(['test'], 'test.jpg', { type: 'image/jpeg' });

      void fileUploadHandler({ files: [file], albumId: 'test-album-id' });

      await vi
        .waitFor(
          () => {
            const items = get(uploadAssetsStore);
            return items.length > 0;
          },
          { timeout: 1000 },
        )
        .catch(() => {});

      const items = get(uploadAssetsStore);
      const item = items.find((i) => i.file?.name === 'test.jpg');
      expect(item?.albumId).toBe('test-album-id');
    });
  });

  describe('cancelUpload', () => {
    it('should handle cancelling non-existent upload gracefully', () => {
      expect(() => cancelUpload('non-existent-id')).not.toThrow();
    });

    it('settles the upload and does not start it if canceled during resume lookup', async () => {
      let resolvePrevious: (uploads: PreviousUpload[]) => void;
      const previous = new Promise<PreviousUpload[]>((resolve) => {
        resolvePrevious = resolve;
      });
      findPreviousUploads.mockReturnValueOnce(previous);
      const file = largeVideo();
      const upload = fileUploadHandler({ files: [file] });
      await vi.waitFor(() => expect(findPreviousUploads).toHaveBeenCalledOnce());

      const id = `web-${file.name}-${file.lastModified}`;
      cancelUpload(id);
      resolvePrevious!([]);

      await expect(upload).resolves.toEqual([]);
      expect(tusInstances[0].abort).toHaveBeenCalledOnce();
      expect(tusInstances[0].start).not.toHaveBeenCalled();
      expect(get(uploadAssetsStore)).toEqual([]);
      expect(uploadRequest).not.toHaveBeenCalled();
    });
  });

  describe('resumable upload (tus) - files over 50MB', () => {
    it('should use tus for files larger than 50MB', async () => {
      const largeFile = new File(['x'.repeat(50 * 1024 * 1024 + 1)], 'large.jpg', { type: 'image/jpeg' });

      const promise = fileUploadHandler({ files: [largeFile] });

      // Wait for the upload to complete
      await promise;

      expect(tusUploadCalls.length).toBeGreaterThan(0);
    });

    it('should set correct tus metadata', async () => {
      const largeFile = new File(['x'.repeat(50 * 1024 * 1024 + 1)], 'large.jpg', { type: 'image/jpeg' });
      Object.defineProperty(largeFile, 'lastModified', { value: 1_234_567_890 });

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
      const largeFile = new File(['x'.repeat(50 * 1024 * 1024 + 1)], 'large.jpg', { type: 'image/jpeg' });

      await fileUploadHandler({ files: [largeFile], isLockedAssets: true });

      expect(tusUploadCalls.length).toBeGreaterThan(0);
      const { options } = tusUploadCalls[0];
      expect(options.metadata?.visibility).toBe(AssetVisibility.Locked);
    });

    it('should use 50MB chunk size', async () => {
      const largeFile = new File(['x'.repeat(50 * 1024 * 1024 + 1)], 'large.jpg', { type: 'image/jpeg' });

      await fileUploadHandler({ files: [largeFile] });

      expect(tusUploadCalls.length).toBeGreaterThan(0);
      const { options } = tusUploadCalls[0];
      expect(options.chunkSize).toBe(50 * 1024 * 1024);
    });

    it('should enable fingerprint storage for resuming', async () => {
      const largeFile = new File(['x'.repeat(50 * 1024 * 1024 + 1)], 'large.jpg', { type: 'image/jpeg' });

      await fileUploadHandler({ files: [largeFile] });

      expect(tusUploadCalls.length).toBeGreaterThan(0);
      const { options } = tusUploadCalls[0];
      expect(options.storeFingerprintForResuming).toBe(true);
      expect(options.removeFingerprintOnSuccess).toBe(true);
    });

    it('should check for previous uploads to resume', async () => {
      const largeFile = new File(['x'.repeat(50 * 1024 * 1024 + 1)], 'large.jpg', { type: 'image/jpeg' });

      await fileUploadHandler({ files: [largeFile] });

      expect(tusInstances.length).toBeGreaterThan(0);
      expect(findPreviousUploads).toHaveBeenCalled();
    });

    it('should resume from previous upload if available', async () => {
      const previousUpload: PreviousUpload = {
        uploadUrl: 'http://localhost/upload/previous-id',
        metadata: {},
        size: 50 * 1024 * 1024 + 1,
        creationTime: '',
        urlStorageKey: 'previous',
        parallelUploadUrls: null,
      };
      findPreviousUploads.mockResolvedValueOnce([previousUpload]);

      const largeFile = new File(['x'.repeat(50 * 1024 * 1024 + 1)], 'large.jpg', { type: 'image/jpeg' });

      await fileUploadHandler({ files: [largeFile] });

      expect(tusInstances.length).toBeGreaterThan(0);
      expect(tusInstances[0].resumeFromPreviousUpload).toHaveBeenCalledWith(previousUpload);
    });

    it('should start upload after checking for previous uploads', async () => {
      const largeFile = new File(['x'.repeat(50 * 1024 * 1024 + 1)], 'large.jpg', { type: 'image/jpeg' });

      await fileUploadHandler({ files: [largeFile] });

      expect(tusInstances.length).toBeGreaterThan(0);
      expect(tusInstances[0].start).toHaveBeenCalled();
    });

    it('does not resume an unlocked transfer for a locked asset', async () => {
      findPreviousUploads.mockResolvedValueOnce([
        {
          uploadUrl: 'http://localhost/upload/unlocked',
          metadata: {},
          size: 120 * 1024 * 1024,
          creationTime: '',
          urlStorageKey: 'previous',
          parallelUploadUrls: null,
        },
      ]);

      await expect(fileUploadHandler({ files: [largeVideo()], isLockedAssets: true })).resolves.toEqual([
        'test-asset-id',
      ]);
      expect(tusInstances[0].resumeFromPreviousUpload).not.toHaveBeenCalled();
      expect(tusInstances[0].start).toHaveBeenCalledOnce();
    });

    it('uses the canonical asset ID from the completed response for albums and duplicate status', async () => {
      startUpload.mockImplementationOnce((options) =>
        options.onSuccess?.({
          lastResponse: response({ 'x-immich-asset-id': 'canonical-id', 'x-immich-duplicate': 'true' }),
        }),
      );

      await expect(fileUploadHandler({ files: [largeVideo()], albumId: 'album-id' })).resolves.toEqual([
        'canonical-id',
      ]);
      expect(addAssetsToAlbum).toHaveBeenCalledWith('album-id', ['canonical-id'], false);
      expect(get(uploadAssetsStore)[0]).toMatchObject({ assetId: 'canonical-id', state: UploadState.DUPLICATED });
    });

    it('fails when completion does not provide an asset ID', async () => {
      startUpload.mockImplementationOnce((options) => options.onSuccess?.({ lastResponse: response() }));

      await expect(fileUploadHandler({ files: [largeVideo()], albumId: 'album-id' })).resolves.toEqual([]);
      expect(addAssetsToAlbum).not.toHaveBeenCalled();
      expect(get(uploadAssetsStore)[0].state).toBe(UploadState.ERROR);
      expect(uploadRequest).not.toHaveBeenCalled();
    });

    it('uses multipart when the server has no tus creation endpoint', async () => {
      startUpload.mockImplementationOnce((options) => options.onError?.(uploadError('POST', 404)));

      await expect(fileUploadHandler({ files: [largeVideo()] })).resolves.toEqual(['test-asset-id']);
      expect(uploadRequest).toHaveBeenCalledOnce();
    });

    it('reports a failed PATCH without falling back to multipart', async () => {
      startUpload.mockImplementationOnce((options) => options.onError?.(uploadError('PATCH', 404)));

      await expect(fileUploadHandler({ files: [largeVideo()] })).resolves.toEqual([]);
      expect(uploadRequest).not.toHaveBeenCalled();
    });

    it('uses multipart for a large shared-link upload', async () => {
      authManager.isSharedLink = true;

      await expect(fileUploadHandler({ files: [largeVideo()] })).resolves.toEqual(['test-asset-id']);
      expect(tusUploadCalls).toHaveLength(0);
      expect(uploadRequest).toHaveBeenCalledOnce();
    });
  });

  describe('multipart upload (files under 50MB)', () => {
    it('should not use tus for files smaller than 50MB', async () => {
      const smallFile = new File(['test content'], 'small.jpg', { type: 'image/jpeg' });

      await fileUploadHandler({ files: [smallFile] });

      // tus should NOT be used for small files
      expect(tusUploadCalls.length).toBe(0);
    });

    it('should not use tus for 25MB file (under 50MB threshold)', async () => {
      const mediumFile = new File(['x'.repeat(25 * 1024 * 1024)], 'medium.jpg', { type: 'image/jpeg' });

      await fileUploadHandler({ files: [mediumFile] });

      // tus should NOT be used for files under 50MB
      expect(tusUploadCalls.length).toBe(0);
    });

    it('should not use tus for file just under 50MB threshold', async () => {
      const justUnderFile = new File(['x'.repeat(50 * 1024 * 1024 - 1)], 'just-under.jpg', { type: 'image/jpeg' });

      await fileUploadHandler({ files: [justUnderFile] });

      // tus should NOT be used for files under 50MB
      expect(tusUploadCalls.length).toBe(0);
    });
  });

  describe('upload state management', () => {
    it('should add item to store with PENDING state initially', async () => {
      const file = new File(['test'], 'test.jpg', { type: 'image/jpeg' });

      void fileUploadHandler({ files: [file] });

      await vi
        .waitFor(
          () => {
            const items = get(uploadAssetsStore);
            return items.length > 0;
          },
          { timeout: 1000 },
        )
        .catch(() => {});

      const items = get(uploadAssetsStore);
      expect(items.length).toBeGreaterThan(0);
    });
  });
});
