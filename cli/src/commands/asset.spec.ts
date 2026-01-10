import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it, MockedFunction, vi } from 'vitest';

import { Action, checkBulkUpload, defaults, getSupportedMediaTypes, Reason } from '@immich/sdk';
import createFetchMock from 'vitest-fetch-mock';

import { checkForDuplicates, getAlbumName, startWatch, uploadFiles, UploadOptionsDto } from 'src/commands/asset';

vi.mock('@immich/sdk');
vi.mock('tus-js-client', () => ({
  Upload: class MockUpload {
    private options: any;
    url = 'http://example.com/upload/test-upload-id';

    constructor(_fileStream: any, options: any) {
      this.options = options;
    }

    start() {
      // Simulate onAfterResponse with asset ID header
      if (this.options.onAfterResponse) {
        this.options.onAfterResponse(null, {
          getHeader: (name: string) => {
            if (name === 'x-immich-asset-id') return 'test-upload-id';
            if (name === 'x-immich-duplicate') return 'false';
            return null;
          },
        });
      }
      // Simulate successful upload after a tick
      setTimeout(() => {
        if (this.options.onSuccess) {
          this.options.onSuccess();
        }
      }, 0);
    }

    abort() {}

    findPreviousUploads() {
      return Promise.resolve([]);
    }

    resumeFromPreviousUpload() {}
  },
}));

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
  const smallTestFileData = 'small file data'; // Few bytes (well under 50MB threshold)
  const mediumTestFileData = 'a'.repeat(25 * 1024 * 1024); // 25MB (under 50MB threshold - single request)
  const largeTestFileData = 'a'.repeat(75 * 1024 * 1024); // 75MB (over 50MB threshold - requires chunking)
  const baseUrl = 'http://example.com';
  const apiKey = 'key';

  const fetchMocker = createFetchMock(vi);

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-resumable-'));
    testFilePath = path.join(testDir, 'test.png');
    mediumTestFilePath = path.join(testDir, 'medium-test.png');
    largeTestFilePath = path.join(testDir, 'large-test.png');

    fs.writeFileSync(testFilePath, smallTestFileData);
    fs.writeFileSync(mediumTestFilePath, mediumTestFileData);
    fs.writeFileSync(largeTestFilePath, largeTestFileData);

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
    it('should use TUS resumable upload for 75MB file (over 50MB threshold)', async () => {
      // Large files use TUS protocol via the mocked tus-js-client
      // The mock returns a URL with test-upload-id
      await expect(uploadFiles([largeTestFilePath], { concurrency: 1, resumable: true })).resolves.toEqual([
        {
          filepath: largeTestFilePath,
          id: 'test-upload-id',
        },
      ]);
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
