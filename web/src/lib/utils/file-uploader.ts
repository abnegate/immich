import { authManager } from '$lib/managers/auth-manager.svelte';
import { uploadManager } from '$lib/managers/upload-manager.svelte';
import { uploadAssetsStore } from '$lib/stores/upload';
import { user } from '$lib/stores/user.store';
import { UploadState } from '$lib/types';
import { uploadRequest } from '$lib/utils';
import { addAssetsToAlbum } from '$lib/utils/asset-utils';
import { ExecutorQueue } from '$lib/utils/executor-queue';
import { asQueryString } from '$lib/utils/shared-links';
import {
  Action,
  AssetMediaStatus,
  AssetVisibility,
  checkBulkUpload,
  getBaseUrl,
  type AssetMediaResponseDto,
} from '@immich/sdk';
import { tick } from 'svelte';
import { t } from 'svelte-i18n';
import { get } from 'svelte/store';
import * as tus from 'tus-js-client';
import { handleError } from './handle-error';

export const addDummyItems = () => {
  uploadAssetsStore.addItem({ id: 'asset-0', file: { name: 'asset0.jpg', size: 123_456 } as File });
  uploadAssetsStore.updateItem('asset-0', { state: UploadState.PENDING });
  uploadAssetsStore.addItem({ id: 'asset-1', file: { name: 'asset1.jpg', size: 123_456 } as File });
  uploadAssetsStore.updateItem('asset-1', { state: UploadState.STARTED });
  uploadAssetsStore.updateProgress('asset-1', 75, 100);
  uploadAssetsStore.addItem({ id: 'asset-2', file: { name: 'asset2.jpg', size: 123_456 } as File });
  uploadAssetsStore.updateItem('asset-2', { state: UploadState.ERROR, error: new Error('Internal server error') });
  uploadAssetsStore.addItem({ id: 'asset-3', file: { name: 'asset3.jpg', size: 123_456 } as File });
  uploadAssetsStore.updateItem('asset-3', { state: UploadState.DUPLICATED, assetId: 'asset-2' });
  uploadAssetsStore.addItem({ id: 'asset-4', file: { name: 'asset3.jpg', size: 123_456 } as File });
  uploadAssetsStore.updateItem('asset-4', { state: UploadState.DUPLICATED, assetId: 'asset-2', isTrashed: true });
  uploadAssetsStore.addItem({ id: 'asset-10', file: { name: 'asset3.jpg', size: 123_456 } as File });
  uploadAssetsStore.updateItem('asset-10', { state: UploadState.DONE });
  uploadAssetsStore.track('error');
  uploadAssetsStore.track('success');
  uploadAssetsStore.track('duplicate');
};

// addDummyItems();

// Threshold for using resumable uploads (50 MB) - matches mobile and CLI
const RESUMABLE_UPLOAD_THRESHOLD = 50 * 1024 * 1024;

export const uploadExecutionQueue = new ExecutorQueue({ concurrency: 2 });

type FileUploadParam = { multiple?: boolean; albumId?: string };

export const openFileUploadDialog = async (options: FileUploadParam = {}) => {
  const { albumId, multiple = true } = options;
  const extensions = uploadManager.getExtensions();

  return new Promise<string[]>((resolve, reject) => {
    try {
      const fileSelector = document.createElement('input');

      fileSelector.type = 'file';
      fileSelector.multiple = multiple;
      fileSelector.accept = extensions.join(',');
      fileSelector.addEventListener(
        'change',
        (e: Event) => {
          const target = e.target as HTMLInputElement;
          if (!target.files) {
            return;
          }
          const files = Array.from(target.files);

          resolve(fileUploadHandler({ files, albumId }));
        },
        { passive: true },
      );

      fileSelector.click();
    } catch (error) {
      console.log('Error selecting file', error);
      reject(error);
    }
  });
};

type FileUploadHandlerParams = Omit<FileUploaderParams, 'deviceAssetId' | 'assetFile'> & {
  files: File[];
};

export const fileUploadHandler = async ({
  files,
  albumId,
  isLockedAssets = false,
}: FileUploadHandlerParams): Promise<string[]> => {
  const extensions = uploadManager.getExtensions();
  const promises = [];
  for (const file of files) {
    const name = file.name.toLowerCase();
    if (extensions.some((extension) => name.endsWith(extension))) {
      const deviceAssetId = getDeviceAssetId(file);
      uploadAssetsStore.addItem({ id: deviceAssetId, file, albumId });
      promises.push(
        uploadExecutionQueue.addTask(() => fileUploader({ assetFile: file, deviceAssetId, albumId, isLockedAssets })),
      );
    }
  }

  const results = await Promise.all(promises);
  return results.filter((result): result is string => !!result);
};

function getDeviceAssetId(asset: File) {
  return 'web' + '-' + asset.name + '-' + asset.lastModified;
}

type FileUploaderParams = {
  assetFile: File;
  albumId?: string;
  replaceAssetId?: string;
  isLockedAssets?: boolean;
  deviceAssetId: string;
};

/**
 * Upload a file using tus resumable protocol
 * @param assetFile The file to upload
 * @param deviceAssetId Unique identifier for the asset
 * @param fileCreatedAt ISO timestamp of file creation
 * @param onProgress Progress callback
 * @param isLockedAssets Whether this is a locked asset
 * @returns Promise resolving to asset response data and the upload instance for cancellation
 */
async function uploadFileResumable(
  assetFile: File,
  deviceAssetId: string,
  fileCreatedAt: string,
  onProgress: (bytesUploaded: number, bytesTotal: number) => void,
  isLockedAssets = false,
): Promise<AssetMediaResponseDto> {
  const baseUrl = getBaseUrl();
  const queryParams = asQueryString(authManager.params);

  // Build metadata for tus upload
  const metadata: Record<string, string> = {
    filename: assetFile.name,
    filetype: assetFile.type || '',
    deviceAssetId,
    deviceId: 'WEB',
    fileCreatedAt,
    fileModifiedAt: new Date(assetFile.lastModified).toISOString(),
    isFavorite: 'false',
    duration: '0:00:00.000000',
  };

  if (isLockedAssets) {
    metadata.visibility = AssetVisibility.Locked;
  }

  return new Promise<AssetMediaResponseDto>((resolve, reject) => {
    const upload = new tus.Upload(assetFile, {
      endpoint: `${baseUrl}/upload${queryParams ? `?${queryParams}` : ''}`,
      metadata,
      chunkSize: 50 * 1024 * 1024, // 50MB chunks
      removeFingerprintOnSuccess: true,
      // Store upload URL in localStorage to enable resuming
      storeFingerprintForResuming: true,
      // Include credentials (cookies) for authentication
      headers: {},
      onError: (error) => {
        // Clean up from active uploads map on error
        activeUploads.delete(deviceAssetId);
        reject(error);
      },
      onProgress: (bytesUploaded, bytesTotal) => {
        onProgress(bytesUploaded, bytesTotal);
      },
      onSuccess: () => {
        // Clean up from active uploads map
        activeUploads.delete(deviceAssetId);

        // Try to get X-Immich-Asset-Id and X-Immich-Duplicate headers from the upload response
        // The tus-js-client library doesn't expose response headers cleanly,
        // so we need to access the internal XHR object as a workaround
        // TODO: This should be replaced with a proper API when tus-js-client provides header access
        let responseAssetId: string | null = null;
        let isDuplicate = false;
        try {
          const xhr = (upload as any)._xhr;
          if (xhr && typeof xhr.getResponseHeader === 'function') {
            responseAssetId = xhr.getResponseHeader('X-Immich-Asset-Id') ||
                             xhr.getResponseHeader('x-immich-asset-id');
            const duplicateHeader = xhr.getResponseHeader('X-Immich-Duplicate') ||
                                   xhr.getResponseHeader('x-immich-duplicate');
            isDuplicate = duplicateHeader?.toLowerCase() === 'true';
          }
        } catch (error) {
          console.warn('Failed to extract headers from response:', error);
        }

        // Fallback to extracting from upload URL if header is not available
        if (!responseAssetId) {
          const uploadUrl = upload.url;
          responseAssetId = uploadUrl?.split('/').pop() || '';
        }

        resolve({
          id: responseAssetId,
          status: isDuplicate ? AssetMediaStatus.Duplicate : AssetMediaStatus.Created,
        });
      },
    });

    // Store upload instance for potential cancellation
    (upload as any)._deviceAssetId = deviceAssetId;
    activeUploads.set(deviceAssetId, upload);

    // Enable resumable uploads by checking for previous uploads
    upload.findPreviousUploads().then((previousUploads) => {
      if (previousUploads.length > 0) {
        upload.resumeFromPreviousUpload(previousUploads[0]);
      }
      upload.start();
    }).catch((error) => {
      // If finding previous uploads fails, just start fresh
      console.warn('Could not check for previous uploads:', error);
      upload.start();
    });
  });
}

// Track active tus uploads for cancellation support
const activeUploads = new Map<string, tus.Upload>();

/**
 * Cancel an active upload
 * @param deviceAssetId The device asset ID of the upload to cancel
 */
export function cancelUpload(deviceAssetId: string): void {
  const upload = activeUploads.get(deviceAssetId);
  if (upload) {
    upload.abort();
    activeUploads.delete(deviceAssetId);
  }
}

// TODO: should probably use the @api SDK
async function fileUploader({
  assetFile,
  deviceAssetId,
  albumId,
  isLockedAssets = false,
}: FileUploaderParams): Promise<string | undefined> {
  const fileCreatedAt = new Date(assetFile.lastModified).toISOString();
  const $t = get(t);

  uploadAssetsStore.markStarted(deviceAssetId);

  try {
    const formData = new FormData();
    for (const [key, value] of Object.entries({
      deviceAssetId,
      deviceId: 'WEB',
      fileCreatedAt,
      fileModifiedAt: new Date(assetFile.lastModified).toISOString(),
      isFavorite: 'false',
      duration: '0:00:00.000000',
      assetData: new File([assetFile], assetFile.name),
    })) {
      formData.append(key, value);
    }

    if (isLockedAssets) {
      formData.append('visibility', AssetVisibility.Locked);
    }

    let responseData: { id: string; status: AssetMediaStatus; isTrashed?: boolean } | undefined;
    if (crypto?.subtle?.digest && !authManager.isSharedLink) {
      uploadAssetsStore.updateItem(deviceAssetId, { message: $t('asset_hashing') });
      await tick();
      try {
        const bytes = await assetFile.arrayBuffer();
        const hash = await crypto.subtle.digest('SHA-1', bytes);
        const checksum = Array.from(new Uint8Array(hash))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');

        const {
          results: [checkUploadResult],
        } = await checkBulkUpload({ assetBulkUploadCheckDto: { assets: [{ id: assetFile.name, checksum }] } });
        if (checkUploadResult.action === Action.Reject && checkUploadResult.assetId) {
          responseData = {
            status: AssetMediaStatus.Duplicate,
            id: checkUploadResult.assetId,
            isTrashed: checkUploadResult.isTrashed,
          };
        }
      } catch (error) {
        console.error(`Error calculating sha1 file=${assetFile.name})`, error);
      }
    }

    if (!responseData) {
      uploadAssetsStore.updateItem(deviceAssetId, { message: $t('asset_uploading') });

      // Use resumable upload for files larger than 10MB
      if (assetFile.size >= RESUMABLE_UPLOAD_THRESHOLD) {
        responseData = await uploadFileResumable(
          assetFile,
          deviceAssetId,
          fileCreatedAt,
          (bytesUploaded, bytesTotal) => uploadAssetsStore.updateProgress(deviceAssetId, bytesUploaded, bytesTotal),
          isLockedAssets,
        );
      } else {
        // Use multipart upload for smaller files
        const queryParams = asQueryString(authManager.params);
        const response = await uploadRequest<AssetMediaResponseDto>({
          url: getBaseUrl() + '/assets' + (queryParams ? `?${queryParams}` : ''),
          data: formData,
          onUploadProgress: (event) => uploadAssetsStore.updateProgress(deviceAssetId, event.loaded, event.total),
        });

        if (![200, 201].includes(response.status)) {
          throw new Error($t('errors.unable_to_upload_file'));
        }

        responseData = response.data;
      }
    }

    if (responseData.status === AssetMediaStatus.Duplicate) {
      uploadAssetsStore.track('duplicate');
    } else {
      uploadAssetsStore.track('success');
    }

    if (albumId) {
      uploadAssetsStore.updateItem(deviceAssetId, { message: $t('asset_adding_to_album') });
      await addAssetsToAlbum(albumId, [responseData.id], false);
      uploadAssetsStore.updateItem(deviceAssetId, { message: $t('asset_added_to_album') });
    }

    uploadAssetsStore.updateItem(deviceAssetId, {
      state: responseData.status === AssetMediaStatus.Duplicate ? UploadState.DUPLICATED : UploadState.DONE,
      assetId: responseData.id,
      isTrashed: responseData.isTrashed,
    });

    if (responseData.status !== AssetMediaStatus.Duplicate) {
      setTimeout(() => {
        uploadAssetsStore.removeItem(deviceAssetId);
      }, 1000);
    }

    return responseData.id;
  } catch (error) {
    // ignore errors if the user logs out during uploads
    if (!get(user)) {
      return;
    }

    const errorMessage = handleError(error, $t('errors.unable_to_upload_file'));
    uploadAssetsStore.track('error');
    uploadAssetsStore.updateItem(deviceAssetId, { state: UploadState.ERROR, error: errorMessage });
    return;
  }
}
