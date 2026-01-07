import { BadRequestException, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { StorageCore } from 'src/cores/storage.core';
import { AuthDto } from 'src/dtos/auth.dto';
import { AssetFileType, AssetVisibility, JobName, StorageFolder } from 'src/enum';
import { BaseService } from 'src/services/base.service';
import { mimeTypes } from 'src/utils/mime-types';

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
      datastore: new FileStore({ directory: uploadPath }),
      respectForwardedHeaders: true,
      namingFunction: (req, _metadata) => {
        // Generate a unique ID for the upload
        const uuid = self.cryptoRepository.randomUUID();
        // Get metadata to create proper folder structure
        const auth = (req as any).auth as AuthDto | undefined;
        if (auth?.user?.id) {
          const folder = StorageCore.getNestedFolder(StorageFolder.Upload, auth.user.id, uuid);
          self.storageRepository.mkdirSync(folder);
          return join(auth.user.id, uuid.slice(0, 2), uuid.slice(2, 4), uuid);
        }
        return uuid;
      },
      onIncomingRequest: async (req, _res, uploadId) => {
        // Validate auth for all requests
        const auth = (req as any).auth as AuthDto | undefined;
        if (!auth?.user) {
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
          if (uploadUserId !== auth.user.id) {
            throw self.toTusError(403, 'Forbidden: Upload does not belong to user');
          }
        }
      },
      onUploadCreate: async (req, upload) => {
        // Validate authentication
        const auth = (req as any).auth as AuthDto | undefined;
        if (!auth?.user) {
          throw self.toTusError(401, 'Unauthorized');
        }

        // Validate required metadata
        const metadata = self.parseMetadata(upload.metadata);
        if (!metadata.filename) {
          throw self.toTusError(400, 'Missing required metadata: filename');
        }
        if (!metadata.deviceAssetId) {
          throw self.toTusError(400, 'Missing required metadata: deviceAssetId');
        }
        if (!metadata.deviceId) {
          throw self.toTusError(400, 'Missing required metadata: deviceId');
        }

        // Validate file type
        const filename = metadata.filename.toLowerCase();
        if (!mimeTypes.isAsset(filename)) {
          throw self.toTusError(400, `Unsupported file type: ${filename}`);
        }

        // Check quota
        const uploadSize = upload.size || 0;
        if (
          auth.user.quotaSizeInBytes !== null &&
          auth.user.quotaSizeInBytes < auth.user.quotaUsageInBytes + uploadSize
        ) {
          throw self.toTusError(400, 'Quota has been exceeded!');
        }

        self.logger.log(`Upload created: ${upload.id} for user ${auth.user.id}`);
        return {};
      },
      onUploadFinish: async (req, upload) => {
        const auth = (req as any).auth as AuthDto | undefined;
        if (!auth?.user) {
          throw self.toTusError(401, 'Unauthorized');
        }

        const uploadPath = StorageCore.getBaseFolder(StorageFolder.Upload);
        const filePath = join(uploadPath, upload.id);

        try {
          const { assetId, isDuplicate } = await self.createAssetFromUpload(auth, upload);
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
    // Attach auth to request for use in tus callbacks
    (req as any).auth = auth;

    const server = await this.initializeTusServer();
    return server.handle(req, res);
  }

  async onApplicationShutdown() {
    this.logger.log('Shutting down TUS service and cleaning up resources');
    // The tus server will automatically clean up incomplete uploads
    // We just need to reset our state
    this.tusServer = null;
    this.initPromise = null;
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

    // Helper function to decode base64 values
    const decodeValue = (value: string | null | undefined): string | undefined => {
      if (!value) return undefined;
      try {
        return Buffer.from(value, 'base64').toString('utf-8');
      } catch (error) {
        this.logger.warn(`Failed to decode base64 value: ${error}`);
        return value;
      }
    };

    return {
      filename: decodeValue(metadata.filename),
      filetype: decodeValue(metadata.filetype),
      deviceAssetId: decodeValue(metadata.deviceAssetId),
      deviceId: decodeValue(metadata.deviceId),
      fileCreatedAt: decodeValue(metadata.fileCreatedAt),
      fileModifiedAt: decodeValue(metadata.fileModifiedAt),
      duration: decodeValue(metadata.duration),
      isFavorite: decodeValue(metadata.isFavorite),
      visibility: decodeValue(metadata.visibility),
      livePhotoVideoId: decodeValue(metadata.livePhotoVideoId),
      sidecarData: decodeValue(metadata.sidecarData),
    };
  }

  private async createAssetFromUpload(auth: AuthDto, upload: Upload): Promise<{ assetId: string; isDuplicate: boolean }> {
    const metadata = this.parseMetadata(upload.metadata);

    if (!metadata.filename || !metadata.deviceAssetId || !metadata.deviceId) {
      throw new BadRequestException('Missing required metadata');
    }

    const uploadPath = StorageCore.getBaseFolder(StorageFolder.Upload);
    const filePath = join(uploadPath, upload.id);

    // Calculate checksum
    const checksum = await this.calculateChecksum(filePath);

    // Check for duplicate
    const existingAssetId = await this.assetRepository.getUploadAssetIdByChecksum(auth.user.id, checksum);
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
      ownerId: auth.user.id,
      libraryId: null,
      checksum,
      originalPath: filePath,
      deviceAssetId: metadata.deviceAssetId,
      deviceId: metadata.deviceId,
      fileCreatedAt,
      fileModifiedAt,
      localDateTime: fileCreatedAt,
      type: mimeTypes.assetType(filePath),
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
    await this.userRepository.updateUsage(auth.user.id, fileSize);

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
