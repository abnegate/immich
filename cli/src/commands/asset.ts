import {
  Action,
  AssetBulkUploadCheckItem,
  AssetBulkUploadCheckResult,
  AssetMediaResponseDto,
  AssetMediaStatus,
  addAssetsToAlbum,
  checkBulkUpload,
  createAlbum,
  defaults,
  getAllAlbums,
  getSupportedMediaTypes,
} from '@immich/sdk';
import byteSize from 'byte-size';
import { Matcher, watch as watchFs } from 'chokidar';
import { MultiBar, Presets, SingleBar } from 'cli-progress';
import { chunk } from 'lodash-es';
import micromatch from 'micromatch';
import { createHash } from 'node:crypto';
import { createReadStream, type ReadStream, type Stats } from 'node:fs';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path, { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { Queue } from 'src/queue';
import { BaseOptions, Batcher, authenticate, crawl, sha1 } from 'src/utils';
import * as tus from 'tus-js-client';

class FileUrlStorage implements tus.UrlStorage {
  private readonly directory = join(homedir(), '.cache', 'immich-cli', 'tus-uploads');

  private async ensureDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
  }

  private paths(fingerprint: string): [current: string, legacy: string] {
    const hash = createHash('sha256').update(fingerprint).digest('hex');
    const legacy = Buffer.from(fingerprint).toString('base64url');
    return [join(this.directory, `${hash}.json`), join(this.directory, `${legacy}.json`)];
  }

  async findAllUploads(): Promise<tus.PreviousUpload[]> {
    return [];
  }

  async findUploadsByFingerprint(fingerprint: string): Promise<tus.PreviousUpload[]> {
    try {
      await this.ensureDirectory();
    } catch {
      return [];
    }

    for (const filename of this.paths(fingerprint)) {
      try {
        const data = await readFile(filename, 'utf8');
        const upload = JSON.parse(data) as tus.PreviousUpload;
        return [{ ...upload, urlStorageKey: fingerprint }];
      } catch {
        // The other cache filename may still contain the resume URL.
      }
    }
    return [];
  }

  async removeUpload(fingerprint: string): Promise<void> {
    await Promise.allSettled(this.paths(fingerprint).map((filename) => unlink(filename)));
  }

  async addUpload(fingerprint: string, upload: tus.PreviousUpload): Promise<string> {
    try {
      await this.ensureDirectory();
      const [filename] = this.paths(fingerprint);
      await writeFile(filename, JSON.stringify(upload));
      return fingerprint;
    } catch {
      // tus accepts an empty storage key when no resume entry was saved.
      return '';
    }
  }
}

const urlStorage = new FileUrlStorage();

const UPLOAD_WATCH_BATCH_SIZE = 100;
const UPLOAD_WATCH_DEBOUNCE_TIME_MS = 10_000;

const s = (count: number) => (count === 1 ? '' : 's');

// TODO figure out why `id` is missing
type AssetBulkUploadCheckResults = Array<AssetBulkUploadCheckResult & { id: string }>;
type Asset = { id: string; filepath: string };

const RESUMABLE_CHUNK_SIZE = 50 * 1024 * 1024;

export interface UploadOptionsDto {
  recursive?: boolean;
  ignore?: string;
  dryRun?: boolean;
  skipHash?: boolean;
  delete?: boolean;
  deleteDuplicates?: boolean;
  album?: boolean;
  albumName?: string;
  includeHidden?: boolean;
  concurrency: number;
  progress?: boolean;
  watch?: boolean;
  jsonOutput?: boolean;
  resumable?: boolean;
}

class UploadFile extends File {
  private activeStream?: ReadStream;

  constructor(
    private readonly filepath: string,
    private readonly length: number,
  ) {
    super([], basename(filepath));
  }

  override get size(): number {
    return this.length;
  }

  override stream(): ReturnType<File['stream']> {
    this.activeStream?.destroy();
    const stream = createReadStream(this.filepath);
    this.activeStream = stream;

    stream.once('close', () => {
      if (this.activeStream === stream) {
        this.activeStream = undefined;
      }
    });

    // Node and DOM declarations describe the same runtime web stream differently.
    return Readable.toWeb(stream) as ReturnType<File['stream']>;
  }
}

const uploadBatch = async (files: string[], options: UploadOptionsDto) => {
  const { newFiles, duplicates } = await checkForDuplicates(files, options);
  const newAssets = await uploadFiles(newFiles, options);
  if (options.jsonOutput) {
    console.log(JSON.stringify({ newFiles, duplicates, newAssets }, undefined, 4));
  }
  await updateAlbums([...newAssets, ...duplicates], options);

  await deleteFiles(newAssets, duplicates, options);
};

export const startWatch = async (
  paths: string[],
  options: UploadOptionsDto,
  {
    batchSize = UPLOAD_WATCH_BATCH_SIZE,
    debounceTimeMs = UPLOAD_WATCH_DEBOUNCE_TIME_MS,
  }: { batchSize?: number; debounceTimeMs?: number } = {},
) => {
  const watcherIgnored: Matcher[] = [];
  const { image, video } = await getSupportedMediaTypes();
  const extensions = new Set([...image, ...video]);

  if (options.ignore) {
    watcherIgnored.push((path) => micromatch.contains(path, `**/${options.ignore}`));
  }

  const pathsBatcher = new Batcher<string>({
    batchSize,
    debounceTimeMs,
    onBatch: async (paths: string[]) => {
      const uniquePaths = [...new Set(paths)];
      await uploadBatch(uniquePaths, options);
    },
  });

  const onFile = async (path: string, stats?: Stats) => {
    if (stats?.isDirectory()) {
      return;
    }
    const ext = '.' + path.split('.').pop()?.toLowerCase();
    if (!ext || !extensions.has(ext)) {
      return;
    }

    if (!options.progress) {
      // logging when progress is disabled as it can cause issues with the progress bar rendering
      console.log(`Change detected: ${path}`);
    }
    pathsBatcher.add(path);
  };
  const fsWatcher = watchFs(paths, {
    ignoreInitial: true,
    ignored: watcherIgnored,
    alwaysStat: true,
    awaitWriteFinish: true,
    depth: options.recursive ? undefined : 1,
    persistent: true,
  })
    .on('add', onFile)
    .on('change', onFile)
    .on('error', (error) => console.error(`Watcher error: ${error}`));

  process.on('SIGINT', async () => {
    console.log('Exiting...');
    await fsWatcher.close();
    process.exit();
  });
};

export const upload = async (paths: string[], baseOptions: BaseOptions, options: UploadOptionsDto) => {
  await authenticate(baseOptions);

  const scanFiles = await scan(paths, options);

  if (scanFiles.length === 0) {
    if (options.watch) {
      console.log('No files found initially.');
    } else {
      console.log('No files found, exiting');
      return;
    }
  }

  if (options.watch) {
    console.log('Watching for changes...');
    await startWatch(paths, options);
    // watcher does not handle the initial scan
    // as the scan() is a more efficient quick start with batched results
  }

  await uploadBatch(scanFiles, options);
};

const scan = async (pathsToCrawl: string[], options: UploadOptionsDto) => {
  const { image, video } = await getSupportedMediaTypes();

  console.log('Crawling for assets...');
  const files = await crawl({
    pathsToCrawl,
    recursive: options.recursive,
    exclusionPattern: options.ignore,
    includeHidden: options.includeHidden,
    extensions: [...image, ...video],
  });

  return files;
};

export const checkForDuplicates = async (files: string[], { concurrency, skipHash, progress }: UploadOptionsDto) => {
  if (skipHash) {
    console.log('Skipping hash check, assuming all files are new');
    return { newFiles: files, duplicates: [] };
  }

  let multiBar: MultiBar | undefined;

  if (progress) {
    multiBar = new MultiBar(
      { format: '{message} | {bar} | {percentage}% | ETA: {eta}s | {value}/{total} assets' },
      Presets.shades_classic,
    );
  } else {
    console.log(`Received ${files.length} files, hashing...`);
  }

  const hashProgressBar = multiBar?.create(files.length, 0, { message: 'Hashing files          ' });
  const checkProgressBar = multiBar?.create(files.length, 0, { message: 'Checking for duplicates' });

  const newFiles: string[] = [];
  const duplicates: Asset[] = [];

  const checkBulkUploadQueue = new Queue<AssetBulkUploadCheckItem[], void>(
    async (assets: AssetBulkUploadCheckItem[]) => {
      const response = await checkBulkUpload({ assetBulkUploadCheckDto: { assets } });

      const results = response.results as AssetBulkUploadCheckResults;

      for (const { id: filepath, assetId, action } of results) {
        if (action === Action.Accept) {
          newFiles.push(filepath);
        } else {
          // rejects are always duplicates
          duplicates.push({ id: assetId as string, filepath });
        }
      }

      checkProgressBar?.increment(assets.length);
    },
    { concurrency, retry: 3 },
  );

  const results: { id: string; checksum: string }[] = [];
  let checkBulkUploadRequests: AssetBulkUploadCheckItem[] = [];

  const queue = new Queue<string, AssetBulkUploadCheckItem[]>(
    async (filepath: string): Promise<AssetBulkUploadCheckItem[]> => {
      const dto = { id: filepath, checksum: await sha1(filepath) };

      results.push(dto);
      checkBulkUploadRequests.push(dto);
      if (checkBulkUploadRequests.length === 5000) {
        const batch = checkBulkUploadRequests;
        checkBulkUploadRequests = [];
        void checkBulkUploadQueue.push(batch);
      }

      hashProgressBar?.increment();
      return results;
    },
    { concurrency, retry: 3 },
  );

  for (const item of files) {
    void queue.push(item);
  }

  await queue.drained();

  if (checkBulkUploadRequests.length > 0) {
    void checkBulkUploadQueue.push(checkBulkUploadRequests);
  }

  await checkBulkUploadQueue.drained();

  multiBar?.stop();

  console.log(`Found ${newFiles.length} new files and ${duplicates.length} duplicate${s(duplicates.length)}`);

  // Report failures
  const failedTasks = queue.tasks.filter((task) => task.status === 'failed');
  if (failedTasks.length > 0) {
    console.log(`Failed to verify ${failedTasks.length} file${s(failedTasks.length)}:`);
    for (const task of failedTasks) {
      console.log(`- ${task.data} - ${task.error}`);
    }
  }

  return { newFiles, duplicates };
};

export const uploadFiles = async (
  files: string[],
  { dryRun, concurrency, progress, resumable }: UploadOptionsDto,
): Promise<Asset[]> => {
  if (files.length === 0) {
    console.log('All assets were already uploaded, nothing to do.');
    return [];
  }

  // Compute total size first
  let totalSize = 0;
  const statsMap = new Map<string, Stats>();
  for (const filepath of files) {
    const stats = await stat(filepath);
    statsMap.set(filepath, stats);
    totalSize += stats.size;
  }

  if (dryRun) {
    console.log(`Would have uploaded ${files.length} asset${s(files.length)} (${byteSize(totalSize)})`);
    return files.map((filepath) => ({ id: '', filepath }));
  }

  let uploadProgress: SingleBar | undefined;

  if (progress) {
    uploadProgress = new SingleBar(
      {
        format: 'Uploading assets | {bar} | {percentage}% | ETA: {eta_formatted} | {value_formatted}/{total_formatted}',
      },
      Presets.shades_classic,
    );
  } else {
    console.log(`Uploading ${files.length} asset${s(files.length)} (${byteSize(totalSize)})`);
  }
  uploadProgress?.start(totalSize, 0);
  uploadProgress?.update({ value_formatted: 0, total_formatted: byteSize(totalSize) });

  let duplicateCount = 0;
  let duplicateSize = 0;
  let successCount = 0;
  let successSize = 0;

  const newAssets: Asset[] = [];

  const queue = new Queue<string, AssetMediaResponseDto>(
    async (filepath: string) => {
      const stats = statsMap.get(filepath);
      if (!stats) {
        throw new Error(`Stats not found for ${filepath}`);
      }

      const response = await uploadFile(filepath, stats, {
        resumable,
        onProgress: (bytesUploaded) => {
          uploadProgress?.update(successSize + bytesUploaded, {
            value_formatted: byteSize(successSize + duplicateSize + bytesUploaded),
          });
        },
      });
      newAssets.push({ id: response.id, filepath });
      if (response.status === AssetMediaStatus.Duplicate) {
        duplicateCount++;
        duplicateSize += stats.size ?? 0;
      } else {
        successCount++;
        successSize += stats.size ?? 0;
      }

      uploadProgress?.update(successSize, { value_formatted: byteSize(successSize + duplicateSize) });

      return response;
    },
    { concurrency, retry: 3 },
  );

  for (const item of files) {
    void queue.push(item);
  }

  await queue.drained();

  uploadProgress?.stop();

  console.log(`Successfully uploaded ${successCount} new asset${s(successCount)} (${byteSize(successSize)})`);
  if (duplicateCount > 0) {
    console.log(`Skipped ${duplicateCount} duplicate asset${s(duplicateCount)} (${byteSize(duplicateSize)})`);
  }

  // Report failures
  const failedTasks = queue.tasks.filter((task) => task.status === 'failed');
  if (failedTasks.length > 0) {
    console.log(`Failed to upload ${failedTasks.length} asset${s(failedTasks.length)}:`);
    for (const task of failedTasks) {
      console.log(`- ${task.data} - ${task.error}`);
    }
  }

  return newAssets;
};

const getSidecarPath = async (input: string): Promise<string | undefined> => {
  const assetPath = path.parse(input);
  const noExtension = path.join(assetPath.dir, assetPath.name);

  // XMP sidecars can come in two filename formats. For a photo named photo.ext, the filenames are photo.ext.xmp and photo.xmp
  for (const sidecarPath of [`${noExtension}.xmp`, `${input}.xmp`]) {
    try {
      await stat(sidecarPath);
      return sidecarPath;
    } catch {
      // File doesn't exist, try next
    }
  }
  return undefined;
};

const uploadFileResumable = async (
  input: string,
  stats: Stats,
  onProgress?: (bytesUploaded: number) => void,
): Promise<AssetMediaResponseDto | void> => {
  const { baseUrl, headers } = defaults;

  const sidecarPath = await getSidecarPath(input);
  let sidecarData: string | undefined;
  if (sidecarPath) {
    const sidecarBuffer = await readFile(sidecarPath);
    sidecarData = sidecarBuffer.toString('base64');
  }

  const deviceAssetId = `${basename(input)}-${stats.size}`.replaceAll(/\s+/g, '');

  const file = createReadStream(input);
  try {
    return await new Promise<AssetMediaResponseDto | void>((resolve, reject) => {
      let hasUploadUrl = false;
      const upload = new tus.Upload(file, {
        endpoint: `${baseUrl}/upload`,
        headers: headers as Record<string, string>,
        uploadSize: stats.size,
        chunkSize: RESUMABLE_CHUNK_SIZE,
        metadata: {
          filename: basename(input),
          filetype: '',
          deviceAssetId,
          deviceId: 'CLI',
          fileCreatedAt: stats.mtime.toISOString(),
          fileModifiedAt: stats.mtime.toISOString(),
          isFavorite: 'false',
          ...(sidecarData && { sidecarData }),
        },
        storeFingerprintForResuming: true,
        urlStorage,
        removeFingerprintOnSuccess: true,
        onUploadUrlAvailable: () => {
          hasUploadUrl = true;
        },
        onError: (error) => {
          if (!hasUploadUrl && error instanceof tus.DetailedError && error.originalRequest?.getMethod() === 'POST') {
            const status = error.originalResponse?.getStatus();
            if (status === 404 || status === 405) {
              resolve();
              return;
            }
          }

          reject(error);
        },
        onProgress,
        onSuccess: ({ lastResponse }) => {
          const id = lastResponse.getHeader('X-Immich-Asset-Id');
          if (!id) {
            reject(new Error('Resumable upload response did not include an asset ID'));
            return;
          }

          const duplicate = lastResponse.getHeader('X-Immich-Duplicate')?.toLowerCase() === 'true';
          resolve({ id, status: duplicate ? AssetMediaStatus.Duplicate : AssetMediaStatus.Created });
        },
      });

      file.once('error', reject);
      void upload
        .findPreviousUploads()
        .catch(() => [])
        .then(([previous]) => {
          if (previous?.uploadUrl) {
            hasUploadUrl = true;
            upload.resumeFromPreviousUpload(previous);
          }
          upload.start();
        })
        .catch(reject);
    });
  } finally {
    file.destroy();
  }
};

const uploadFileFormData = async (input: string, stats: Stats): Promise<AssetMediaResponseDto> => {
  const { baseUrl, headers } = defaults;

  const sidecarPath = await getSidecarPath(input);
  let sidecarFile: UploadFile | undefined;
  if (sidecarPath) {
    const sidecarStats = await stat(sidecarPath);
    sidecarFile = new UploadFile(sidecarPath, sidecarStats.size);
  }

  const formData = new FormData();
  formData.append('deviceAssetId', `${basename(input)}-${stats.size}`.replaceAll(/\s+/g, ''));
  formData.append('deviceId', 'CLI');
  formData.append('fileCreatedAt', stats.mtime.toISOString());
  formData.append('fileModifiedAt', stats.mtime.toISOString());
  formData.append('fileSize', String(stats.size));
  formData.append('isFavorite', 'false');
  formData.append('assetData', new UploadFile(input, stats.size));

  if (sidecarFile) {
    formData.append('sidecarData', sidecarFile);
  }

  const response = await fetch(`${baseUrl}/assets`, {
    method: 'post',
    redirect: 'error',
    headers: headers as Record<string, string>,
    body: formData,
  });
  if (response.status !== 200 && response.status !== 201) {
    throw new Error(await response.text());
  }

  return response.json();
};

const uploadFile = async (
  input: string,
  stats: Stats,
  options: { resumable?: boolean; onProgress?: (bytesUploaded: number) => void } = {},
): Promise<AssetMediaResponseDto> => {
  if (options.resumable && stats.size >= RESUMABLE_CHUNK_SIZE) {
    const response = await uploadFileResumable(input, stats, options.onProgress);
    if (response) {
      return response;
    }
  }

  return uploadFileFormData(input, stats);
};

const deleteFiles = async (uploaded: Asset[], duplicates: Asset[], options: UploadOptionsDto): Promise<void> => {
  let fileCount = 0;
  if (options.delete) {
    fileCount += uploaded.length;
  }

  if (options.deleteDuplicates) {
    fileCount += duplicates.length;
  }

  if (options.dryRun) {
    console.log(`Would have deleted ${fileCount} local asset${s(fileCount)}`);
    return;
  }

  if (fileCount === 0) {
    return;
  }

  console.log('Deleting assets that have been uploaded...');
  const deletionProgress = new SingleBar(
    { format: 'Deleting local assets | {bar} | {percentage}% | ETA: {eta}s | {value}/{total} assets' },
    Presets.shades_classic,
  );
  deletionProgress.start(fileCount, 0);

  const chunkDelete = async (files: Asset[]) => {
    for (const assetBatch of chunk(files, options.concurrency)) {
      await Promise.all(assetBatch.map((input: Asset) => unlink(input.filepath)));
      deletionProgress.update(assetBatch.length);
    }
  };

  try {
    if (options.delete) {
      await chunkDelete(uploaded);
    }

    if (options.deleteDuplicates) {
      await chunkDelete(duplicates);
    }
  } finally {
    deletionProgress.stop();
  }
};

const updateAlbums = async (assets: Asset[], options: UploadOptionsDto) => {
  if (!options.album && !options.albumName) {
    return;
  }
  const { dryRun, concurrency } = options;

  const albums = await getAllAlbums({});
  const existingAlbums = new Map(albums.map((album) => [album.albumName, album.id]));
  const newAlbums: Set<string> = new Set();
  for (const { filepath } of assets) {
    const albumName = getAlbumName(filepath, options);
    if (albumName && !existingAlbums.has(albumName)) {
      newAlbums.add(albumName);
    }
  }

  if (dryRun) {
    // TODO print asset counts for new albums
    console.log(`Would have created ${newAlbums.size} new album${s(newAlbums.size)}`);
    console.log(`Would have updated albums of ${assets.length} asset${s(assets.length)}`);
    return;
  }

  const progressBar = new SingleBar(
    { format: 'Creating albums | {bar} | {percentage}% | ETA: {eta}s | {value}/{total} albums' },
    Presets.shades_classic,
  );
  progressBar.start(newAlbums.size, 0);

  try {
    for (const albumNames of chunk([...newAlbums], concurrency)) {
      const items = await Promise.all(
        albumNames.map((albumName: string) => createAlbum({ createAlbumDto: { albumName } })),
      );
      for (const { id, albumName } of items) {
        existingAlbums.set(albumName, id);
      }
      progressBar.increment(albumNames.length);
    }
  } finally {
    progressBar.stop();
  }

  console.log(`Successfully created ${newAlbums.size} new album${s(newAlbums.size)}`);
  console.log(`Successfully updated ${assets.length} asset${s(assets.length)}`);

  const albumToAssets = new Map<string, string[]>();
  for (const asset of assets) {
    const albumName = getAlbumName(asset.filepath, options);
    if (!albumName) {
      continue;
    }
    const albumId = existingAlbums.get(albumName);
    if (albumId) {
      if (!albumToAssets.has(albumId)) {
        albumToAssets.set(albumId, []);
      }
      albumToAssets.get(albumId)?.push(asset.id);
    }
  }

  const albumUpdateProgress = new SingleBar(
    { format: 'Adding assets to albums | {bar} | {percentage}% | ETA: {eta}s | {value}/{total} assets' },
    Presets.shades_classic,
  );
  albumUpdateProgress.start(assets.length, 0);

  try {
    for (const [albumId, assets] of albumToAssets.entries()) {
      for (const assetBatch of chunk(assets, Math.min(1000 * concurrency, 65_000))) {
        await addAssetsToAlbum({ id: albumId, bulkIdsDto: { ids: assetBatch } });
        albumUpdateProgress.increment(assetBatch.length);
      }
    }
  } finally {
    albumUpdateProgress.stop();
  }
};

// `filepath` valid format:
// - Windows: `D:\\test\\Filename.txt` or `D:/test/Filename.txt`
// - Unix: `/test/Filename.txt`
export const getAlbumName = (filepath: string, options: UploadOptionsDto) => {
  return options.albumName ?? path.basename(path.dirname(filepath));
};
