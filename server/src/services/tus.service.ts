import { BadRequestException, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { StorageCore } from 'src/cores/storage.core';
import { OnJob } from 'src/decorators';
import { AuthDto } from 'src/dtos/auth.dto';
import { AssetFileType, AssetVisibility, JobName, JobStatus, QueueName, StorageFolder } from 'src/enum';
import { BaseService } from 'src/services/base.service';
import { mimeTypes } from 'src/utils/mime-types';

const TUS_EXPIRATION_MS = 24 * 60 * 60 * 1000; // 24 hours

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

type TusServer = {
  handle: (req: Request, res: Response) => Promise<void>;
  cleanUpExpiredUploads: () => Promise<number>;
};

// TUS library types headers as Web API Headers, so we need .get()
const getHeader = (headers: Headers, name: string): string | undefined => {
  return headers.get(name) ?? undefined;
};

@Injectable()
export class TusService extends BaseService implements OnApplicationShutdown {
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

    const self = this;

    this.tusServer = new Server({
      path: '/api/upload',
      datastore: new FileStore({
        directory: uploadPath,
        expirationPeriodInMilliseconds: TUS_EXPIRATION_MS,
      }),
      relativeLocation: true,
      getFileIdFromRequest: (req) => {
        const url = req.url?.split('?')[0] || '';
        const match = url.match(/\/api\/upload\/(.+)/);
        return match?.[1];
      },
      namingFunction: (req, _metadata) => {
        const uuid = self.cryptoRepository.randomUUID();
        const userId = getHeader(req.headers, 'x-immich-user-id');
        if (userId) {
          const folder = StorageCore.getNestedFolder(StorageFolder.Upload, userId, uuid);
          self.storageRepository.mkdirSync(folder);
          return join(userId, uuid.slice(0, 2), uuid.slice(2, 4), uuid);
        }
        return uuid;
      },
      onIncomingRequest: async (req, uploadId) => {
        const userId = getHeader(req.headers, 'x-immich-user-id');
        if (!userId) {
          self.logger.warn('TUS request rejected: missing x-immich-user-id header');
          throw self.toTusError(401, 'Unauthorized');
        }

        // For PATCH, HEAD, DELETE requests, verify user owns the upload
        if (uploadId && req.method !== 'POST') {
          // Extract user ID from upload path (format: userId/xx/yy/uuid)
          const uploadPathParts = uploadId.split('/');
          if (uploadPathParts.length !== 4) {
            throw self.toTusError(403, 'Forbidden: Invalid upload path format');
          }
          const uploadUserId = uploadPathParts[0];
          if (uploadUserId !== userId) {
            throw self.toTusError(403, 'Forbidden: Upload does not belong to user');
          }
        }
      },
      onUploadCreate: async (req, upload) => {
        const userId = getHeader(req.headers, 'x-immich-user-id');
        if (!userId) {
          self.logger.warn('TUS upload rejected: missing x-immich-user-id header');
          throw self.toTusError(401, 'Unauthorized');
        }

        // Validate required metadata
        const metadata = self.parseMetadata(upload.metadata);

        if (!metadata.filename) {
          self.logger.warn('TUS upload rejected: missing filename metadata');
          throw self.toTusError(400, 'Missing required metadata: filename');
        }
        if (!metadata.deviceAssetId) {
          self.logger.warn('TUS upload rejected: missing deviceAssetId metadata');
          throw self.toTusError(400, 'Missing required metadata: deviceAssetId');
        }
        if (!metadata.deviceId) {
          self.logger.warn('TUS upload rejected: missing deviceId metadata');
          throw self.toTusError(400, 'Missing required metadata: deviceId');
        }

        // Validate file type
        const filename = metadata.filename.toLowerCase();
        if (!mimeTypes.isAsset(filename)) {
          self.logger.warn(`TUS upload rejected: unsupported file type ${filename}`);
          throw self.toTusError(400, `Unsupported file type: ${filename}`);
        }

        // Check quota
        const quotaSize = getHeader(req.headers, 'x-immich-quota-size');
        const quotaUsage = getHeader(req.headers, 'x-immich-quota-usage');
        const uploadSize = upload.size || 0;
        if (quotaSize && Number(quotaSize) < Number(quotaUsage) + uploadSize) {
          self.logger.warn('TUS upload rejected: quota exceeded');
          throw self.toTusError(400, 'Quota has been exceeded!');
        }

        return {};
      },
      onUploadFinish: async (req, upload) => {
        const userId = getHeader(req.headers, 'x-immich-user-id');
        if (!userId) {
          throw self.toTusError(401, 'Unauthorized');
        }

        const uploadPath = StorageCore.getBaseFolder(StorageFolder.Upload);
        const filePath = join(uploadPath, upload.id);

        try {
          const { assetId, isDuplicate } = await self.createAssetFromUpload(userId, upload);
          self.logger.log(`Upload finished: ${upload.id} -> Asset ${assetId}${isDuplicate ? ' (duplicate)' : ''}`);

          // Return asset ID and duplicate status in response headers
          return {
            headers: {
              'X-Immich-Asset-Id': assetId,
              'X-Immich-Duplicate': isDuplicate ? 'true' : 'false',
            },
          };
        } catch (error) {
          self.logger.error(`Failed to create asset from upload ${upload.id}: ${error}`);

          // Clean up uploaded file and .info file on failure
          try {
            const infoFilePath = `${filePath}.info`;
            await self.jobRepository.queue({ name: JobName.FileDelete, data: { files: [filePath, infoFilePath] } });
          } catch (cleanupError) {
            self.logger.error(`Failed to clean up files for ${upload.id}: ${cleanupError}`);
          }

          throw self.toTusError(500, 'Failed to create asset');
        }
      },
    });
  }

  async handleTusUpload(auth: AuthDto, req: Request, res: Response): Promise<void> {
    // Pass auth via custom header - TUS library preserves headers
    req.headers['x-immich-user-id'] = auth.user.id;
    req.headers['x-immich-quota-size'] = String(auth.user.quotaSizeInBytes ?? '');
    req.headers['x-immich-quota-usage'] = String(auth.user.quotaUsageInBytes ?? 0);

    const server = await this.initializeTusServer();
    await server.handle(req, res);
  }

  async onApplicationShutdown() {
    this.logger.log('Shutting down TUS service and cleaning up resources');
    this.tusServer = null;
    this.initPromise = null;
  }

  @OnJob({ name: JobName.TusUploadCleanup, queue: QueueName.BackgroundTask })
  async handleUploadCleanup(): Promise<JobStatus> {
    const server = await this.initializeTusServer();
    const deletedCount = await server.cleanUpExpiredUploads();
    if (deletedCount > 0) {
      this.logger.log(`Cleaned up ${deletedCount} expired TUS uploads`);
    }
    return JobStatus.Success;
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

  private async createAssetFromUpload(userId: string, upload: Upload): Promise<{ assetId: string; isDuplicate: boolean }> {
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
      // Clean up the uploaded file since it's a duplicate
      await this.jobRepository.queue({ name: JobName.FileDelete, data: { files: [filePath] } });
      return { assetId: existingAssetId, isDuplicate: true };
    }

    const parseDate = (dateString: string | undefined): Date => {
      if (!dateString) {
        return new Date();
      }
      const parsed = new Date(dateString);
      if (isNaN(parsed.getTime())) {
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
    const asset = await this.assetRepository.create({
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
    });

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
