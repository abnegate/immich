import * as fs from 'node:fs';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it, MockedFunction, vi } from 'vitest';

import { Action, checkBulkUpload, defaults, getSupportedMediaTypes, Reason } from '@immich/sdk';
import { DefaultHttpStack, DetailedError, type HttpResponse, type PreviousUpload, type Upload } from 'tus-js-client';
import createFetchMock from 'vitest-fetch-mock';

import { checkForDuplicates, getAlbumName, startWatch, uploadFiles, UploadOptionsDto } from 'src/commands/asset';

vi.mock('@immich/sdk');
vi.mock('node:fs/promises', { spy: true });
type UploadOptions = ConstructorParameters<typeof Upload>[1];
const NativeResponse = globalThis.Response;

const { startUpload, findPreviousUploads } = vi.hoisted(() => ({
  startUpload: vi.fn<(options: UploadOptions) => void>(),
  findPreviousUploads: vi.fn<() => Promise<PreviousUpload[]>>(),
}));

vi.mock('tus-js-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('tus-js-client')>()),
  Upload: class MockUpload {
    constructor(
      _file: fs.ReadStream,
      private readonly options: UploadOptions,
    ) {}

    start() {
      startUpload(this.options);
    }

    findPreviousUploads = findPreviousUploads;
    resumeFromPreviousUpload() {}
  },
}));

const response = (headers: Record<string, string> = {}, status = 200): HttpResponse => ({
  getHeader: (header) => headers[header.toLowerCase()],
  getStatus: () => status,
  getBody: () => '',
  getUnderlyingObject: vi.fn(),
});

const uploadError = (method: string, status: number): DetailedError =>
  Object.assign(new DetailedError('Upload failed'), {
    originalRequest: { getMethod: () => method },
    originalResponse: response({}, status),
  });

describe('getAlbumName', () => {
  it('should return a non-undefined value', () => {
    if (os.platform() === 'win32') {
      // This is meaningless for Unix systems.
      expect(getAlbumName(String.raw`D:\test\Filename.txt`, {} as UploadOptionsDto)).toBe('test');
    }
    expect(getAlbumName('D:/parentfolder/test/Filename.txt', {} as UploadOptionsDto)).toBe('test');
  });

  it('has higher priority to return `albumName` in `options`', () => {
    expect(getAlbumName('/parentfolder/test/Filename.txt', { albumName: 'example' } as UploadOptionsDto)).toBe(
      'example',
    );
  });
});

describe('uploadFiles', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-'));
  const testFilePath = path.join(testDir, 'test.png');
  const testFileData = 'test';
  const baseUrl = 'http://example.com';
  const apiKey = 'key';
  const retry = 3;

  const fetchMocker = createFetchMock(vi);

  beforeEach(() => {
    // Create a test file
    fs.writeFileSync(testFilePath, testFileData);

    // Defaults
    vi.mocked(defaults).baseUrl = baseUrl;
    vi.mocked(defaults).headers = { 'x-api-key': apiKey };

    fetchMocker.enableMocks();
    fetchMocker.resetMocks();
  });

  it('returns new assets when upload file is successful', async () => {
    fetchMocker.doMockIf(new RegExp(`${baseUrl}/assets$`), () => {
      return {
        status: 200,
        body: JSON.stringify({ id: 'fc5621b1-86f6-44a1-9905-403e607df9f5', status: 'created' }),
      };
    });

    await expect(uploadFiles([testFilePath], { concurrency: 1 })).resolves.toEqual([
      {
        filepath: testFilePath,
        id: 'fc5621b1-86f6-44a1-9905-403e607df9f5',
      },
    ]);
  });

  it('returns new assets when upload file retry is successful', async () => {
    let counter = 0;
    fetchMocker.doMockIf(new RegExp(`${baseUrl}/assets$`), () => {
      counter++;
      if (counter < retry) {
        throw new Error('Network error');
      }

      return {
        status: 200,
        body: JSON.stringify({ id: 'fc5621b1-86f6-44a1-9905-403e607df9f5', status: 'created' }),
      };
    });

    await expect(uploadFiles([testFilePath], { concurrency: 1 })).resolves.toEqual([
      {
        filepath: testFilePath,
        id: 'fc5621b1-86f6-44a1-9905-403e607df9f5',
      },
    ]);
  });

  it('returns new assets when upload file retry is failed', async () => {
    fetchMocker.doMockIf(new RegExp(`${baseUrl}/assets$`), () => {
      throw new Error('Network error');
    });

    await expect(uploadFiles([testFilePath], { concurrency: 1 })).resolves.toEqual([]);
  });
});

describe('checkForDuplicates', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-'));
  const testFilePath = path.join(testDir, 'test.png');
  const testFileData = 'test';
  const testFileChecksum = 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3'; // SHA1
  const retry = 3;

  beforeEach(() => {
    // Create a test file
    fs.writeFileSync(testFilePath, testFileData);
  });

  it('checks duplicates', async () => {
    vi.mocked(checkBulkUpload).mockResolvedValue({
      results: [
        {
          action: Action.Accept,
          id: testFilePath,
        },
      ],
    });

    await checkForDuplicates([testFilePath], { concurrency: 1 });

    expect(checkBulkUpload).toHaveBeenCalledWith({
      assetBulkUploadCheckDto: {
        assets: [
          {
            checksum: testFileChecksum,
            id: testFilePath,
          },
        ],
      },
    });
  });

  it('returns duplicates when check duplicates is rejected', async () => {
    vi.mocked(checkBulkUpload).mockResolvedValue({
      results: [
        {
          action: Action.Reject,
          id: testFilePath,
          assetId: 'fc5621b1-86f6-44a1-9905-403e607df9f5',
          reason: Reason.Duplicate,
        },
      ],
    });

    await expect(checkForDuplicates([testFilePath], { concurrency: 1 })).resolves.toEqual({
      duplicates: [
        {
          filepath: testFilePath,
          id: 'fc5621b1-86f6-44a1-9905-403e607df9f5',
        },
      ],
      newFiles: [],
    });
  });

  it('returns new assets when check duplicates is accepted', async () => {
    vi.mocked(checkBulkUpload).mockResolvedValue({
      results: [
        {
          action: Action.Accept,
          id: testFilePath,
        },
      ],
    });

    await expect(checkForDuplicates([testFilePath], { concurrency: 1 })).resolves.toEqual({
      duplicates: [],
      newFiles: [testFilePath],
    });
  });

  it('returns results when check duplicates retry is successful', async () => {
    let mocked = vi.mocked(checkBulkUpload);
    for (let i = 1; i < retry; i++) {
      mocked = mocked.mockRejectedValueOnce(new Error('Network error'));
    }
    mocked.mockResolvedValue({
      results: [
        {
          action: Action.Accept,
          id: testFilePath,
        },
      ],
    });

    await expect(checkForDuplicates([testFilePath], { concurrency: 1 })).resolves.toEqual({
      duplicates: [],
      newFiles: [testFilePath],
    });
  });

  it('returns results when check duplicates retry is failed', async () => {
    vi.mocked(checkBulkUpload).mockRejectedValue(new Error('Network error'));

    await expect(checkForDuplicates([testFilePath], { concurrency: 1 })).resolves.toEqual({
      duplicates: [],
      newFiles: [],
    });
  });
});

describe('startWatch', () => {
  let testFolder: string;
  let checkBulkUploadMocked: MockedFunction<typeof checkBulkUpload>;

  beforeEach(async () => {
    vi.restoreAllMocks();

    vi.mocked(getSupportedMediaTypes).mockResolvedValue({
      image: ['.jpg'],
      sidecar: ['.xmp'],
      video: ['.mp4'],
    });

    testFolder = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'test-startWatch-'));
    checkBulkUploadMocked = vi.mocked(checkBulkUpload);
    checkBulkUploadMocked.mockResolvedValue({
      results: [],
    });
  });

  it('should start watching a directory and upload new files', async () => {
    const testFilePath = path.join(testFolder, 'test.jpg');

    await startWatch([testFolder], { concurrency: 1 }, { batchSize: 1, debounceTimeMs: 10 });
    await sleep(100); // to debounce the watcher from considering the test file as a existing file
    await fs.promises.writeFile(testFilePath, 'testjpg');

    await vi.waitUntil(() => checkBulkUploadMocked.mock.calls.length > 0, 3000);
    expect(checkBulkUpload).toHaveBeenCalledWith({
      assetBulkUploadCheckDto: {
        assets: [
          expect.objectContaining({
            id: testFilePath,
          }),
        ],
      },
    });
  });

  it('should filter out unsupported files', async () => {
    const testFilePath = path.join(testFolder, 'test.jpg');
    const unsupportedFilePath = path.join(testFolder, 'test.txt');

    await startWatch([testFolder], { concurrency: 1 }, { batchSize: 1, debounceTimeMs: 10 });
    await sleep(100); // to debounce the watcher from considering the test file as a existing file
    await fs.promises.writeFile(testFilePath, 'testjpg');
    await fs.promises.writeFile(unsupportedFilePath, 'testtxt');

    await vi.waitUntil(() => checkBulkUploadMocked.mock.calls.length > 0, 3000);
    expect(checkBulkUpload).toHaveBeenCalledWith({
      assetBulkUploadCheckDto: {
        assets: expect.arrayContaining([
          expect.objectContaining({
            id: testFilePath,
          }),
        ]),
      },
    });

    expect(checkBulkUpload).not.toHaveBeenCalledWith({
      assetBulkUploadCheckDto: {
        assets: expect.arrayContaining([
          expect.objectContaining({
            id: unsupportedFilePath,
          }),
        ]),
      },
    });
  });

  it('should filter out ignored patterns', async () => {
    const testFilePath = path.join(testFolder, 'test.jpg');
    const ignoredPattern = 'ignored';
    const ignoredFolder = path.join(testFolder, ignoredPattern);
    await fs.promises.mkdir(ignoredFolder, { recursive: true });
    const ignoredFilePath = path.join(ignoredFolder, 'ignored.jpg');

    await startWatch([testFolder], { concurrency: 1, ignore: ignoredPattern }, { batchSize: 1, debounceTimeMs: 10 });
    await sleep(100); // to debounce the watcher from considering the test file as a existing file
    await fs.promises.writeFile(testFilePath, 'testjpg');
    await fs.promises.writeFile(ignoredFilePath, 'ignoredjpg');

    await vi.waitUntil(() => checkBulkUploadMocked.mock.calls.length > 0, 3000);
    expect(checkBulkUpload).toHaveBeenCalledWith({
      assetBulkUploadCheckDto: {
        assets: expect.arrayContaining([
          expect.objectContaining({
            id: testFilePath,
          }),
        ]),
      },
    });

    expect(checkBulkUpload).not.toHaveBeenCalledWith({
      assetBulkUploadCheckDto: {
        assets: expect.arrayContaining([
          expect.objectContaining({
            id: ignoredFilePath,
          }),
        ]),
      },
    });
  });

  afterEach(async () => {
    await fs.promises.rm(testFolder, { recursive: true, force: true });
  });
});

describe('uploadFiles with resumable option', () => {
  let testDir: string;
  let testFilePath: string;
  let mediumTestFilePath: string;
  let largeTestFilePath: string;
  const baseUrl = 'http://example.com';
  const apiKey = 'key';

  const fetchMocker = createFetchMock(vi);

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-resumable-'));
    testFilePath = path.join(testDir, 'test.png');
    mediumTestFilePath = path.join(testDir, 'medium-test.png');
    largeTestFilePath = path.join(testDir, 'large-test.mp4');

    fs.writeFileSync(testFilePath, 'small file data');
    fs.writeFileSync(mediumTestFilePath, '');
    fs.truncateSync(mediumTestFilePath, 25 * 1024 * 1024);
    fs.writeFileSync(largeTestFilePath, '');
    fs.truncateSync(largeTestFilePath, 75 * 1024 * 1024);

    startUpload
      .mockReset()
      .mockImplementation((options) =>
        options.onSuccess?.({ lastResponse: response({ 'x-immich-asset-id': 'test-asset-id' }) }),
      );
    findPreviousUploads.mockReset().mockResolvedValue([]);

    vi.mocked(defaults).baseUrl = baseUrl;
    vi.mocked(defaults).headers = { 'x-api-key': apiKey };

    fetchMocker.enableMocks();
    fetchMocker.resetMocks();
  });

  afterEach(async () => {
    await fs.promises.rm(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('small files (under 50MB threshold)', () => {
    it('should use multipart upload for small files even with resumable flag', async () => {
      fetchMocker.doMockIf(new RegExp(`${baseUrl}/assets$`), () => {
        return {
          status: 200,
          body: JSON.stringify({ id: 'fc5621b1-86f6-44a1-9905-403e607df9f5', status: 'created' }),
        };
      });

      await expect(uploadFiles([testFilePath], { concurrency: 1, resumable: true })).resolves.toEqual([
        {
          filepath: testFilePath,
          id: 'fc5621b1-86f6-44a1-9905-403e607df9f5',
        },
      ]);
    });

    it('should use multipart upload for 25MB file (under 50MB threshold)', async () => {
      fetchMocker.doMockIf(new RegExp(`${baseUrl}/assets$`), () => {
        return {
          status: 200,
          body: JSON.stringify({ id: 'medium-asset-id', status: 'created' }),
        };
      });

      await expect(uploadFiles([mediumTestFilePath], { concurrency: 1, resumable: true })).resolves.toEqual([
        {
          filepath: mediumTestFilePath,
          id: 'medium-asset-id',
        },
      ]);
    });

    it('should use regular multipart upload when resumable is false', async () => {
      fetchMocker.doMockIf(new RegExp(`${baseUrl}/assets$`), () => {
        return {
          status: 200,
          body: JSON.stringify({ id: 'fc5621b1-86f6-44a1-9905-403e607df9f5', status: 'created' }),
        };
      });

      await expect(uploadFiles([testFilePath], { concurrency: 1, resumable: false })).resolves.toEqual([
        {
          filepath: testFilePath,
          id: 'fc5621b1-86f6-44a1-9905-403e607df9f5',
        },
      ]);
    });
  });

  describe('large files (over 50MB threshold)', () => {
    it('returns the canonical asset ID from the completed response', async () => {
      await expect(uploadFiles([largeTestFilePath], { concurrency: 1, resumable: true })).resolves.toEqual([
        {
          filepath: largeTestFilePath,
          id: 'test-asset-id',
        },
      ]);
      expect(startUpload).toHaveBeenCalledWith(expect.objectContaining({ chunkSize: 50 * 1024 * 1024 }));
      expect(fetchMocker).not.toHaveBeenCalled();
    });

    it('should use multipart for large file when resumable is false', async () => {
      fetchMocker.doMockIf(new RegExp(`${baseUrl}/assets$`), () => {
        return {
          status: 200,
          body: JSON.stringify({ id: 'large-multipart-id', status: 'created' }),
        };
      });

      await expect(uploadFiles([largeTestFilePath], { concurrency: 1, resumable: false })).resolves.toEqual([
        {
          filepath: largeTestFilePath,
          id: 'large-multipart-id',
        },
      ]);
    });

    it('starts an upload if resume storage is unavailable', async () => {
      findPreviousUploads.mockRejectedValueOnce(new Error('Resume storage unavailable'));

      await expect(uploadFiles([largeTestFilePath], { concurrency: 1, resumable: true })).resolves.toEqual([
        { filepath: largeTestFilePath, id: 'test-asset-id' },
      ]);
      expect(startUpload).toHaveBeenCalledOnce();
    });

    it('keeps transfer available when storing a resume URL fails', async () => {
      await uploadFiles([largeTestFilePath], { concurrency: 1, resumable: true });
      const storage = startUpload.mock.calls[0][0].urlStorage;
      expect(storage).toBeDefined();
      vi.mocked(mkdir).mockRejectedValueOnce(new Error('Resume directory unavailable'));

      await expect(
        storage!.addUpload('test-key', {
          uploadUrl: 'http://example.com/upload/pending',
          metadata: {},
          size: 75 * 1024 * 1024,
          creationTime: '',
          urlStorageKey: '',
          parallelUploadUrls: null, // eslint-disable-line unicorn/no-null -- tus expects null for non-parallel transfers.
        }),
      ).resolves.toBe('');
    });

    it('returns the storage key needed to remove a resumed upload after completion', async () => {
      await uploadFiles([largeTestFilePath], { concurrency: 1, resumable: true });
      const storage = startUpload.mock.calls[0][0].urlStorage;
      expect(storage).toBeDefined();
      vi.mocked(mkdir).mockResolvedValueOnce('unused-cache-directory');
      vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify({ uploadUrl: 'http://example.com/upload/pending' }));

      await expect(storage!.findUploadsByFingerprint('test-key')).resolves.toEqual([
        { uploadUrl: 'http://example.com/upload/pending', urlStorageKey: 'test-key' },
      ]);
    });

    it('stores a long fingerprint in a bounded cache filename', async () => {
      await uploadFiles([largeTestFilePath], { concurrency: 1, resumable: true });
      const storage = startUpload.mock.calls[0][0].urlStorage!;
      const fingerprint = `node-file-${'directory/'.repeat(40)}video.mp4`;
      vi.mocked(mkdir).mockResolvedValueOnce('unused-cache-directory');
      vi.mocked(writeFile).mockImplementationOnce((filename) => {
        expect(path.basename(String(filename))).toMatch(/^[a-f\d]{64}\.json$/);
        return Promise.resolve();
      });

      await expect(
        storage.addUpload(fingerprint, {
          uploadUrl: 'http://example.com/upload/pending',
          metadata: {},
          size: 75 * 1024 * 1024,
          creationTime: '',
          urlStorageKey: '',
          parallelUploadUrls: null, // eslint-disable-line unicorn/no-null -- tus expects null for non-parallel transfers.
        }),
      ).resolves.toBe(fingerprint);
    });

    it('reads and removes a resume URL cached by the previous CLI', async () => {
      await uploadFiles([largeTestFilePath], { concurrency: 1, resumable: true });
      const storage = startUpload.mock.calls[0][0].urlStorage!;
      const fingerprint = 'node-file-existing.mp4';
      const legacyFilename = `${Buffer.from(fingerprint).toString('base64url')}.json`;
      const uploadUrl = 'http://example.com/upload/previous';
      vi.mocked(mkdir).mockResolvedValueOnce('unused-cache-directory');
      vi.mocked(readFile)
        .mockRejectedValueOnce(new Error('File not found'))
        .mockResolvedValueOnce(JSON.stringify({ uploadUrl }));
      vi.mocked(unlink)
        .mockImplementationOnce(() => Promise.resolve())
        .mockImplementationOnce(() => Promise.resolve());

      await expect(storage.findUploadsByFingerprint(fingerprint)).resolves.toEqual([
        { uploadUrl, urlStorageKey: fingerprint },
      ]);
      expect(readFile).toHaveBeenLastCalledWith(expect.stringContaining(legacyFilename), 'utf8');
      await storage.removeUpload(fingerprint);
      expect(unlink).toHaveBeenCalledWith(expect.stringContaining(legacyFilename));
    });

    it('uses multipart when the server has no tus creation endpoint', async () => {
      startUpload.mockImplementationOnce((options) => options.onError?.(uploadError('POST', 405)));
      fetchMocker.doMockIf(new RegExp(`${baseUrl}/assets$`), () => ({
        status: 201,
        body: JSON.stringify({ id: 'multipart-id', status: 'created' }),
      }));

      await expect(uploadFiles([largeTestFilePath], { concurrency: 1, resumable: true })).resolves.toEqual([
        { filepath: largeTestFilePath, id: 'multipart-id' },
      ]);
      expect(startUpload).toHaveBeenCalledOnce();
      expect(fetchMocker).toHaveBeenCalledOnce();
    });

    it('reports a failed PATCH without falling back to multipart', async () => {
      startUpload.mockImplementation((options) => options.onError?.(uploadError('PATCH', 404)));

      await expect(uploadFiles([largeTestFilePath], { concurrency: 1, resumable: true })).resolves.toEqual([]);
      expect(fetchMocker).not.toHaveBeenCalled();
    });

    it('fails when completion does not provide an asset ID', async () => {
      startUpload.mockImplementation((options) => options.onSuccess?.({ lastResponse: response() }));

      await expect(uploadFiles([largeTestFilePath], { concurrency: 1, resumable: true })).resolves.toEqual([]);
      expect(fetchMocker).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should handle upload errors gracefully', async () => {
      fetchMocker.doMockIf(new RegExp(`${baseUrl}/assets$`), () => {
        throw new Error('Network error');
      });

      await expect(uploadFiles([testFilePath], { concurrency: 1, resumable: false })).resolves.toEqual([]);
    });

    it('should return empty array for empty file list', async () => {
      await expect(uploadFiles([], { concurrency: 1 })).resolves.toEqual([]);
    });
  });

  describe('resumable XMP sidecars', () => {
    const uploadUrl = `${baseUrl}/upload/user-id/ab/cd/video-id`;
    const xmp = [
      '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
      '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
      '<rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/">',
      '<dc:description><rdf:Alt><rdf:li xml:lang="x-default">',
      'Extended video description for archival metadata. '.repeat(400),
      '</rdf:li></rdf:Alt></dc:description>',
      '</rdf:Description></rdf:RDF></x:xmpmeta>',
    ].join('');
    const stack = new DefaultHttpStack({});

    beforeEach(() => {
      fs.writeFileSync(path.join(testDir, 'large-test.xmp'), xmp);
    });

    it('stages a large XMP body once before sending media chunks', async () => {
      expect(Buffer.byteLength(xmp)).toBeGreaterThan(16_384);
      fetchMocker.doMockIf(`${uploadUrl}/sidecar`, () => ({ status: 204 }));
      const create = stack.createRequest('POST', `${baseUrl}/upload`);
      const head = stack.createRequest('HEAD', uploadUrl);
      const created = response({ location: uploadUrl }, 201);
      const partial = response({ 'upload-length': String(75 * 1024 * 1024), 'upload-offset': '0' });
      startUpload.mockImplementation((options) => {
        void Promise.resolve(options.onAfterResponse?.(create, created))
          .then(() => options.onAfterResponse?.(head, partial))
          .then(() => options.onSuccess?.({ lastResponse: response({ 'x-immich-asset-id': 'video-asset-id' }) }))
          .catch((error: Error) => options.onError?.(error));
      });

      await expect(uploadFiles([largeTestFilePath], { concurrency: 1, resumable: true })).resolves.toEqual([
        { filepath: largeTestFilePath, id: 'video-asset-id' },
      ]);
      const metadata = startUpload.mock.calls[0][0].metadata;
      expect(metadata).toMatchObject({ sidecarRequired: 'true' });
      expect(metadata).not.toHaveProperty('sidecarData');
      expect(fetchMocker).toHaveBeenCalledOnce();
      const [url, options] = fetchMocker.mock.calls[0];
      expect(url.toString()).toBe(`${uploadUrl}/sidecar`);
      expect(options?.method).toBe('PUT');
      expect(options?.redirect).toBe('error');
      const headers = new Headers(options?.headers);
      expect(headers.get('x-api-key')).toBe(apiKey);
      expect(headers.get('content-type')).toBe('application/octet-stream');
      expect(headers.get('content-length')).toBe(String(Buffer.byteLength(xmp)));
      const body = options?.body as File;
      expect(await new NativeResponse(body.stream()).text()).toBe(xmp);
    });

    it('does not complete media when XMP staging fails', async () => {
      fetchMocker.doMockIf(`${uploadUrl}/sidecar`, () => ({ status: 413 }));
      const create = stack.createRequest('POST', `${baseUrl}/upload`);
      const created = response({ location: uploadUrl }, 201);
      const sendPatch = vi.fn();
      startUpload.mockImplementation((options) => {
        void Promise.resolve(options.onAfterResponse?.(create, created))
          .then(() => {
            sendPatch();
            options.onSuccess?.({ lastResponse: response({ 'x-immich-asset-id': 'video-asset-id' }) });
          })
          .catch((error: Error) => options.onError?.(error));
      });

      await expect(uploadFiles([largeTestFilePath], { concurrency: 1, resumable: true })).resolves.toEqual([]);
      expect(sendPatch).not.toHaveBeenCalled();
    });

    it('does not forward credentials to a different origin', async () => {
      const patch = stack.createRequest('PATCH', 'http://different.example/upload/video-id');
      const sendPatch = vi.fn();
      startUpload.mockImplementation((options) => {
        void Promise.resolve(options.onBeforeRequest?.(patch))
          .then(() => {
            sendPatch();
            options.onSuccess?.({ lastResponse: response({ 'x-immich-asset-id': 'video-asset-id' }) });
          })
          .catch((error: Error) => options.onError?.(error));
      });

      await expect(uploadFiles([largeTestFilePath], { concurrency: 1, resumable: true })).resolves.toEqual([]);
      expect(sendPatch).not.toHaveBeenCalled();
      expect(fetchMocker).not.toHaveBeenCalled();
    });

    it('recognizes a completed resume that already included its sidecar', async () => {
      findPreviousUploads.mockResolvedValueOnce([
        {
          uploadUrl,
          metadata: { sidecarRequired: 'true' },
          size: 75 * 1024 * 1024,
          creationTime: '',
          urlStorageKey: 'previous',
          parallelUploadUrls: null, // eslint-disable-line unicorn/no-null -- tus expects null for non-parallel transfers.
        },
      ]);
      const head = stack.createRequest('HEAD', uploadUrl);
      const size = String(75 * 1024 * 1024);
      const lastResponse = response({
        'upload-length': size,
        'upload-offset': size,
        'x-immich-asset-id': 'video-asset-id',
      });
      startUpload.mockImplementation((options) => {
        void Promise.resolve(options.onAfterResponse?.(head, lastResponse))
          .then(() => options.onSuccess?.({ lastResponse }))
          .catch((error: Error) => options.onError?.(error));
      });

      await expect(uploadFiles([largeTestFilePath], { concurrency: 1, resumable: true })).resolves.toEqual([
        { filepath: largeTestFilePath, id: 'video-asset-id' },
      ]);
      expect(fetchMocker).not.toHaveBeenCalled();
    });

    it('rejects a completed response when the required sidecar was never staged', async () => {
      await expect(uploadFiles([largeTestFilePath], { concurrency: 1, resumable: true })).resolves.toEqual([]);
    });

    it('preserves the multipart sidecar when the tus endpoint is unavailable', async () => {
      startUpload.mockImplementation((options) => options.onError?.(uploadError('POST', 404)));
      fetchMocker.doMockIf(`${baseUrl}/assets`, () => ({
        status: 201,
        body: JSON.stringify({ id: 'multipart-asset-id', status: 'created' }),
      }));

      await expect(uploadFiles([largeTestFilePath], { concurrency: 1, resumable: true })).resolves.toEqual([
        { filepath: largeTestFilePath, id: 'multipart-asset-id' },
      ]);
      expect(fetchMocker).toHaveBeenCalledOnce();
      const body = fetchMocker.mock.calls[0][1]?.body as FormData;
      expect(body.get('sidecarData')).toEqual(expect.objectContaining({ size: Buffer.byteLength(xmp) }));
    });
  });

  describe('special modes', () => {
    it('should handle dry run mode', async () => {
      const result = await uploadFiles([testFilePath], { concurrency: 1, dryRun: true });

      expect(result).toEqual([{ id: '', filepath: testFilePath }]);
      expect(fetchMocker.mock.calls.length).toBe(0);
    });

    it('should handle duplicate uploads', async () => {
      fetchMocker.doMockIf(new RegExp(`${baseUrl}/assets$`), () => {
        return {
          status: 200,
          body: JSON.stringify({ id: 'fc5621b1-86f6-44a1-9905-403e607df9f5', status: 'duplicate' }),
        };
      });

      const result = await uploadFiles([testFilePath], { concurrency: 1 });

      expect(result).toEqual([
        {
          filepath: testFilePath,
          id: 'fc5621b1-86f6-44a1-9905-403e607df9f5',
        },
      ]);
    });
  });
});
