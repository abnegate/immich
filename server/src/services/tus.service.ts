import { BadRequestException, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { Request, Response } from 'express';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { setTimeout } from 'node:timers/promises';
import { lock } from 'proper-lockfile';
import { StorageCore } from 'src/cores/storage.core';
import { OnJob } from 'src/decorators';
import { AuthDto } from 'src/dtos/auth.dto';
import { AssetFileType, AssetVisibility, JobName, JobStatus, QueueName, StorageFolder } from 'src/enum';
import { BaseService } from 'src/services/base.service';
import { isAssetChecksumConstraint } from 'src/utils/database';
import { mimeTypes } from 'src/utils/mime-types';

const TUS_EXPIRATION_MS = 24 * 60 * 60 * 1000;
const TUS_PATH = '/api/upload';
const TUS_VERSION = '1.0.0';
const LOCK_STALE_MS = 60_000;
const LOCK_RETRY_MS = 30_000;
const ASSET_ID_HEADER = 'X-Immich-Asset-Id';
const DUPLICATE_HEADER = 'X-Immich-Duplicate';
const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const SHARD = /^[a-f0-9]{2}$/i;
const OWNER = new RegExp(`^${UUID}$`, 'i');
const JSON_FILE = new RegExp(String.raw`^${UUID}\.json$`, 'i');
const UPLOAD_SEGMENTS = [OWNER, SHARD, SHARD, JSON_FILE];
const UPLOAD_ID = new RegExp(`^(${UUID})/[a-f0-9]{2}/[a-f0-9]{2}/${UUID}$`, 'i');

interface TusUploadMetadata {
  filename: string;
  filetype?: string;
  deviceAssetId: string;
  deviceId: string;
  fileCreatedAt: string;
  fileModifiedAt: string;
  duration?: string;
  isFavorite?: string;
  visibility?: string;
  livePhotoVideoId?: string;
  sidecarData?: string;
}

interface Upload {
  id: string;
  size?: number;
  offset: number;
  metadata?: Record<string, string | null>;
  creation_date?: string;
}

interface UploadResult {
  readonly assetId: string;
  readonly isDuplicate: boolean;
}

interface UploadRecord extends Upload {
  readonly result?: UploadResult;
}

type Release = () => Promise<void>;

type TusServer = {
  handle: (request: Request, response: Response) => Promise<void>;
};

// TUS library types headers as Web API Headers, so we need .get()
const getHeader = (headers: Headers, name: string): string | undefined => {
  return headers.get(name) ?? undefined;
};

@Injectable()
export class TusService extends BaseService implements OnApplicationShutdown {
  private readonly creation = new AsyncLocalStorage<{ release?: Release }>();
  private tusServer: TusServer | null = null;
  private initPromise: Promise<void> | null = null;

  private async initializeTusServer(): Promise<TusServer> {
    if (!this.initPromise) {
      this.initPromise = this.createTusServer().catch((error) => {
        this.initPromise = null; // Allow retry on failure
        throw error;
      });
    }

    await this.initPromise;
    return this.tusServer!;
  }

  private async createTusServer(): Promise<void> {
    // Dynamic import for ESM modules
    const { Server } = await import('@tus/server');
    const { FileStore } = await import('@tus/file-store');

    const uploadPath = StorageCore.getBaseFolder(StorageFolder.Upload);
    this.storageRepository.mkdirSync(uploadPath);

    const datastore = new FileStore({
      directory: uploadPath,
      expirationPeriodInMilliseconds: TUS_EXPIRATION_MS,
    });
    datastore.extensions = datastore.extensions.filter((extension) => extension !== 'creation-defer-length');

    this.tusServer = new Server({
      path: TUS_PATH,
      datastore,
      relativeLocation: true,
      disableTerminationForFinishedUploads: true,
      allowedHeaders: ['Authorization', 'x-api-key', 'x-immich-user-token'],
      exposedHeaders: [ASSET_ID_HEADER, DUPLICATE_HEADER],
      getFileIdFromRequest: (request) => this.getUploadId(request.url),
      namingFunction: (req, _metadata) => {
        const uuid = this.cryptoRepository.randomUUID();
        const userId = getHeader(req.headers, 'x-immich-user-id');
        if (userId) {
          const folder = StorageCore.getNestedFolder(StorageFolder.Upload, userId, uuid);
          this.storageRepository.mkdirSync(folder);
          return join(userId, uuid.slice(0, 2), uuid.slice(2, 4), uuid);
        }
        return uuid;
      },
      onIncomingRequest: (req, uploadId) => {
        const userId = getHeader(req.headers, 'x-immich-user-id');
        if (!userId) {
          this.logger.warn('TUS request rejected: missing x-immich-user-id header');
          return Promise.reject(this.toTusError(401, 'Unauthorized'));
        }

        // For PATCH, HEAD, DELETE requests, verify user owns the upload
        if (uploadId && req.method !== 'POST') {
          const uploadUserId = UPLOAD_ID.exec(uploadId)?.[1];
          if (!uploadUserId) {
            return Promise.reject(this.toTusError(403, 'Forbidden: Invalid upload path format'));
          }
          if (uploadUserId !== userId) {
            return Promise.reject(this.toTusError(403, 'Forbidden: Upload does not belong to user'));
          }
        }
        return Promise.resolve();
      },
      onUploadCreate: async (req, upload) => {
        const userId = getHeader(req.headers, 'x-immich-user-id');
        if (!userId) {
          this.logger.warn('TUS upload rejected: missing x-immich-user-id header');
          throw this.toTusError(401, 'Unauthorized');
        }

        // Validate required metadata
        const metadata = this.parseMetadata(upload.metadata);

        if (!metadata.filename) {
          this.logger.warn('TUS upload rejected: missing filename metadata');
          throw this.toTusError(400, 'Missing required metadata: filename');
        }
        if (!metadata.deviceAssetId) {
          this.logger.warn('TUS upload rejected: missing deviceAssetId metadata');
          throw this.toTusError(400, 'Missing required metadata: deviceAssetId');
        }
        if (!metadata.deviceId) {
          this.logger.warn('TUS upload rejected: missing deviceId metadata');
          throw this.toTusError(400, 'Missing required metadata: deviceId');
        }

        // Validate file type
        const filename = metadata.filename.toLowerCase();
        if (!mimeTypes.isAsset(filename)) {
          this.logger.warn(`TUS upload rejected: unsupported file type ${filename}`);
          throw this.toTusError(400, `Unsupported file type: ${filename}`);
        }

        // Check quota
        const quotaSize = getHeader(req.headers, 'x-immich-quota-size');
        const quotaUsage = getHeader(req.headers, 'x-immich-quota-usage');
        if (upload.size === undefined) {
          throw this.toTusError(400, 'Upload-Length is required');
        }
        if (quotaSize && Number(quotaSize) < Number(quotaUsage) + upload.size) {
          this.logger.warn('TUS upload rejected: quota exceeded');
          throw this.toTusError(400, 'Quota has been exceeded!');
        }

        const creation = this.creation.getStore();
        if (creation) {
          creation.release = await this.lockUpload(upload.id, false);
        }
        return {};
      },
      onUploadFinish: async (req, upload) => {
        const userId = getHeader(req.headers, 'x-immich-user-id');
        if (!userId) {
          throw this.toTusError(401, 'Unauthorized');
        }

        try {
          const result = await this.completeUpload(userId, upload);
          // The creation-with-upload handler still reads the file after its finish hook.
          if (result.isDuplicate && req.method === 'PATCH') {
            const path = this.getUploadPath(upload.id);
            await this.removeDuplicate(userId, result.assetId, path).catch((error: unknown) => {
              this.logger.warn(`Could not remove duplicate upload ${upload.id}: ${error}`);
            });
          }
          return { headers: this.getResultHeaders(result) };
        } catch (error) {
          this.logger.error(`Failed to finalize upload ${upload.id}: ${error}`);
          throw this.toTusError(500, 'Failed to create asset');
        }
      },
    });
  }

  async handleTusOptions(request: Request, response: Response): Promise<void> {
    const server = await this.initializeTusServer();
    await server.handle(request, response);
  }

  async handleTusUpload(auth: AuthDto, request: Request, response: Response): Promise<void> {
    request.headers['x-immich-user-id'] = auth.user.id;
    request.headers['x-immich-quota-size'] = String(auth.user.quotaSizeInBytes ?? '');
    request.headers['x-immich-quota-usage'] = String(auth.user.quotaUsageInBytes ?? 0);

    const server = await this.initializeTusServer();
    if (request.method === 'POST') {
      const creation: { release?: Release } = {};
      return this.creation.run(creation, async () => {
        try {
          await server.handle(request, response);
        } finally {
          await creation.release?.();
        }
      });
    }

    const id = this.getUploadId(request.url);
    if (!id || UPLOAD_ID.exec(id)?.[1] !== auth.user.id || !['HEAD', 'PATCH', 'DELETE'].includes(request.method)) {
      return server.handle(request, response);
    }

    let release: Release;
    try {
      release = await this.lockUpload(id, true);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return server.handle(request, response);
      }
      if (code === 'ELOCKED') {
        response.statusCode = 409;
        response.setHeader('Tus-Resumable', TUS_VERSION);
        response.end();
        return;
      }
      throw error;
    }

    try {
      if (request.method === 'HEAD' && request.headers['tus-resumable'] === TUS_VERSION) {
        const upload = await this.readUpload(id);
        if (upload && !this.isExpired(upload) && upload.size !== undefined) {
          const result =
            upload.result ??
            ((await this.getFileSize(this.getUploadPath(id))) === upload.size
              ? await this.completeUpload(auth.user.id, upload)
              : undefined);
          if (result) {
            await this.sendCompletedHead(request, response, upload, result);
            return;
          }
        }
      }

      await server.handle(request, response);
    } finally {
      await release();
    }
  }

  onApplicationShutdown(): void {
    this.logger.log('Shutting down TUS service and cleaning up resources');
    this.tusServer = null;
    this.initPromise = null;
  }

  @OnJob({ name: JobName.TusUploadCleanup, queue: QueueName.BackgroundTask })
  async handleUploadCleanup(): Promise<JobStatus> {
    const directory = StorageCore.getBaseFolder(StorageFolder.Upload);
    let deletedCount = 0;
    for await (const id of this.findUploads(directory, [])) {
      const release = await this.lockUpload(id, false).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT' && error.code !== 'ELOCKED') {
          throw error;
        }
      });
      if (!release) {
        continue;
      }
      try {
        deletedCount += Number(await this.removeExpiredUpload(id));
      } finally {
        await release();
      }
    }
    if (deletedCount > 0) {
      this.logger.log(`Cleaned up ${deletedCount} expired TUS uploads`);
    }
    return JobStatus.Success;
  }

  private getUploadId(url: string | undefined): string | undefined {
    const path = url?.startsWith('/') ? url.split('?', 1)[0] : url && URL.parse(url)?.pathname;
    const prefix = `${TUS_PATH}/`;
    return path?.startsWith(prefix) ? path.slice(prefix.length) : undefined;
  }

  private getUploadPath(id: string): string {
    return join(StorageCore.getBaseFolder(StorageFolder.Upload), id);
  }

  private async lockUpload(id: string, wait: boolean): Promise<Release> {
    // The API and the daily cleanup job run in different workers and share the upload volume.
    const path = this.getUploadPath(id);
    const deadline = performance.now() + LOCK_RETRY_MS;
    let delay = 50;
    while (true) {
      try {
        return await lock(path, { realpath: false, stale: LOCK_STALE_MS });
      } catch (error) {
        if (!wait || (error as NodeJS.ErrnoException).code !== 'ELOCKED' || performance.now() >= deadline) {
          throw error;
        }
      }
      await setTimeout(delay);
      delay = Math.min(delay * 2, 1000);
    }
  }

  private getResultHeaders(result: UploadResult): Record<string, string> {
    return {
      [ASSET_ID_HEADER]: result.assetId,
      [DUPLICATE_HEADER]: String(result.isDuplicate),
    };
  }

  private async sendCompletedHead(
    request: Request,
    response: Response,
    upload: Upload,
    result: UploadResult,
  ): Promise<void> {
    response.statusCode = 200;
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Tus-Resumable', TUS_VERSION);
    response.setHeader('Upload-Length', String(upload.size));
    response.setHeader('Upload-Offset', String(upload.size));
    response.setHeader('Access-Control-Allow-Origin', request.headers.origin ?? '*');
    response.setHeader(
      'Access-Control-Expose-Headers',
      `Tus-Resumable, Upload-Length, Upload-Offset, Upload-Metadata, ${ASSET_ID_HEADER}, ${DUPLICATE_HEADER}`,
    );
    if (upload.metadata) {
      const { Metadata } = await import('@tus/server');
      const metadata = Metadata.stringify(upload.metadata);
      if (metadata) {
        response.setHeader('Upload-Metadata', metadata);
      }
    }
    for (const [name, value] of Object.entries(this.getResultHeaders(result))) {
      response.setHeader(name, value);
    }
    response.end();
  }

  private async readUpload(id: string): Promise<UploadRecord | undefined> {
    try {
      return JSON.parse(await this.storageRepository.readTextFile(`${this.getUploadPath(id)}.json`)) as UploadRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  private async getFileSize(path: string): Promise<number | undefined> {
    try {
      const file = await this.storageRepository.stat(path);
      return file.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  private isExpired(upload: Upload): boolean {
    return !!upload.creation_date && Date.parse(upload.creation_date) + TUS_EXPIRATION_MS <= Date.now();
  }

  private async completeUpload(userId: string, upload: Upload): Promise<UploadResult> {
    const record = await this.readUpload(upload.id);
    if (!record) {
      throw new Error('Missing upload record');
    }
    if (record.result) {
      return record.result;
    }

    const result = await this.createAssetFromUpload(userId, upload);
    const file = `${this.getUploadPath(upload.id)}.json`;
    const temporary = `${file}.tmp`;
    await this.storageRepository.createOrOverwriteFile(temporary, Buffer.from(JSON.stringify({ ...record, result })));
    await this.storageRepository.rename(temporary, file);
    this.logger.log(`Upload finished: ${upload.id} -> Asset ${result.assetId}`);
    return result;
  }

  private async *findUploads(directory: string, parts: string[]): AsyncGenerator<string> {
    let names: string[];
    try {
      names = await this.storageRepository.readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }

    for (const name of names) {
      if (!UPLOAD_SEGMENTS[parts.length].test(name)) {
        continue;
      }
      if (parts.length === UPLOAD_SEGMENTS.length - 1) {
        yield [...parts, name.slice(0, -'.json'.length)].join('/');
      } else {
        yield* this.findUploads(join(directory, name), [...parts, name]);
      }
    }
  }

  private async removeExpiredUpload(id: string): Promise<boolean> {
    const upload = await this.readUpload(id);
    if (!upload || !this.isExpired(upload)) {
      return false;
    }

    const path = this.getUploadPath(id);
    const size = await this.getFileSize(path);
    if (size !== undefined) {
      if (upload.result?.isDuplicate) {
        const owner = UPLOAD_ID.exec(id)![1];
        await this.removeDuplicate(owner, upload.result.assetId, path);
      } else if (!upload.result && size < (upload.size ?? Number.POSITIVE_INFINITY)) {
        // Legacy completed uploads point directly to these bytes and may have no result.
        await this.storageRepository.unlink(path);
      }
    }
    const temporary = `${path}.json.tmp`;
    if (await this.storageRepository.checkFileExists(temporary)) {
      await this.storageRepository.unlink(temporary);
    }
    await this.storageRepository.unlink(`${path}.json`);
    return true;
  }

  /**
   * Convert an error to TUS error format.
   * The TUS library requires errors to be returned as { status_code, body } objects.
   */
  private toTusError(statusCode: number, message: string): { status_code: number; body: string } {
    return { status_code: statusCode, body: message };
  }

  private parseMetadata(metadata?: Record<string, string | null>): Partial<TusUploadMetadata> {
    if (!metadata) {
      return {};
    }

    return {
      filename: metadata.filename ?? undefined,
      filetype: metadata.filetype ?? undefined,
      deviceAssetId: metadata.deviceAssetId ?? undefined,
      deviceId: metadata.deviceId ?? undefined,
      fileCreatedAt: metadata.fileCreatedAt ?? undefined,
      fileModifiedAt: metadata.fileModifiedAt ?? undefined,
      duration: metadata.duration ?? undefined,
      isFavorite: metadata.isFavorite ?? undefined,
      visibility: metadata.visibility ?? undefined,
      livePhotoVideoId: metadata.livePhotoVideoId ?? undefined,
      sidecarData: metadata.sidecarData ?? undefined,
    };
  }

  private async getRegisteredOriginal(userId: string, assetId: string): Promise<string | undefined> {
    const asset = await this.assetRepository.getById(assetId);
    return asset?.ownerId === userId ? asset.originalPath : undefined;
  }

  private async getExistingUploadResult(userId: string, assetId: string, path: string): Promise<UploadResult> {
    const original = await this.getRegisteredOriginal(userId, assetId);
    if (!original) {
      throw new Error('Could not verify the registered asset original');
    }
    return { assetId, isDuplicate: original !== path };
  }

  private async removeDuplicate(userId: string, assetId: string, path: string): Promise<void> {
    const original = await this.getRegisteredOriginal(userId, assetId);
    if (original && original !== path) {
      await this.storageRepository.unlink(path);
    }
  }

  private async createAssetFromUpload(userId: string, upload: Upload): Promise<UploadResult> {
    const metadata = this.parseMetadata(upload.metadata);

    if (!metadata.filename || !metadata.deviceAssetId || !metadata.deviceId) {
      throw new BadRequestException('Missing required metadata');
    }

    const uploadPath = StorageCore.getBaseFolder(StorageFolder.Upload);
    const filePath = join(uploadPath, upload.id);

    // Calculate checksum
    const checksum = await this.calculateChecksum(filePath);

    // Check for duplicate
    const existingAssetId = await this.assetRepository.getUploadAssetIdByChecksum(userId, checksum);
    if (existingAssetId) {
      return this.getExistingUploadResult(userId, existingAssetId, filePath);
    }

    const parseDate = (dateString: string | undefined): Date => {
      if (!dateString) {
        return new Date();
      }
      const parsed = new Date(dateString);
      if (Number.isNaN(parsed.getTime())) {
        this.logger.warn(`Invalid date string: ${dateString}, using current date`);
        return new Date();
      }
      return parsed;
    };

    const fileCreatedAt = parseDate(metadata.fileCreatedAt);
    const fileModifiedAt = parseDate(metadata.fileModifiedAt);

    // Parse and validate visibility (case-insensitive)
    let visibility: AssetVisibility | undefined;
    if (metadata.visibility) {
      const lowerVisibility = metadata.visibility.toLowerCase();
      const validVisibilities = Object.values(AssetVisibility);
      if (validVisibilities.includes(lowerVisibility as AssetVisibility)) {
        visibility = lowerVisibility as AssetVisibility;
      } else {
        this.logger.warn(`Invalid visibility value: ${metadata.visibility}, defaulting to timeline`);
      }
    }

    // Create asset
    const asset = await this.assetRepository
      .create({
        ownerId: userId,
        libraryId: null,
        checksum,
        originalPath: filePath,
        deviceAssetId: metadata.deviceAssetId,
        deviceId: metadata.deviceId,
        fileCreatedAt,
        fileModifiedAt,
        localDateTime: fileCreatedAt,
        type: mimeTypes.assetType(metadata.filename),
        isFavorite: metadata.isFavorite === 'true',
        duration: metadata.duration || null,
        visibility: visibility ?? AssetVisibility.Timeline,
        livePhotoVideoId: metadata.livePhotoVideoId || null,
        originalFileName: metadata.filename,
      })
      .catch((error: unknown) => {
        if (!isAssetChecksumConstraint(error)) {
          throw error;
        }
      });

    if (!asset) {
      const assetId = await this.assetRepository.getUploadAssetIdByChecksum(userId, checksum);
      if (!assetId) {
        throw new Error('Could not find the asset for the duplicate checksum');
      }
      return this.getExistingUploadResult(userId, assetId, filePath);
    }

    // Handle sidecar if provided as base64 in metadata
    if (metadata.sidecarData) {
      try {
        const sidecarBuffer = Buffer.from(metadata.sidecarData, 'base64');
        const sidecarPath = filePath + '.xmp';
        await this.storageRepository.createOrOverwriteFile(sidecarPath, sidecarBuffer);
        await this.assetRepository.upsertFile({
          assetId: asset.id,
          path: sidecarPath,
          type: AssetFileType.Sidecar,
        });
      } catch (error) {
        this.logger.warn(`Failed to save sidecar for asset ${asset.id}: ${error}`);
      }
    }

    // Update file timestamps
    await this.storageRepository.utimes(filePath, new Date(), fileModifiedAt);

    // Update exif with file size
    let fileSize = 0;
    try {
      const stats = await this.storageRepository.stat(filePath);
      fileSize = stats.size;
      await this.assetRepository.upsertExif(
        { assetId: asset.id, fileSizeInByte: stats.size },
        { lockedPropertiesBehavior: 'override' },
      );
    } catch (error) {
      this.logger.error(`Failed to get file stats for ${filePath}: ${error}`);
      // Continue with default file size of 0 rather than failing the entire upload
    }

    // Update user quota
    await this.userRepository.updateUsage(userId, fileSize);

    // Emit event
    await this.eventRepository.emit('AssetCreate', { asset });

    // Queue metadata extraction
    await this.jobRepository.queue({ name: JobName.AssetExtractMetadata, data: { id: asset.id, source: 'upload' } });

    return { assetId: asset.id, isDuplicate: false };
  }

  private async calculateChecksum(filePath: string): Promise<Buffer> {
    const hash = createHash('sha1');
    const stream = createReadStream(filePath);
    await pipeline(stream, hash);
    return hash.digest();
  }
}
