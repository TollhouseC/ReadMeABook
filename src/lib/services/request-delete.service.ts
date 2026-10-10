/**
 * Component: Request Deletion Service
 * Documentation: documentation/admin-features/request-deletion.md
 *
 * Handles soft deletion of requests with intelligent torrent/file cleanup
 */

import { prisma } from '../db';
import { RMABLogger } from '../utils/logger';
import { deleteRequestMedia } from './request-delete-media';
import { CLIENT_PROTOCOL_MAP, DownloadClientType } from '../interfaces/download-client.interface';

const logger = RMABLogger.create('RequestDelete');

export interface DeleteRequestResult {
  success: boolean;
  message: string;
  filesDeleted: boolean;
  torrentsRemoved: number;
  torrentsKeptSeeding: number;
  torrentsKeptUnlimited: number;
  error?: string;
}

/**
 * Soft delete a request with intelligent cleanup of media files and torrents
 *
 * Logic (audiobook requests):
 * 1. Check if request exists and is not already deleted
 * 2. For each download:
 *    - If unlimited seeding (0): Log and keep seeding, no monitoring
 *    - If incomplete download: Delete torrent + files
 *    - If seeding requirement met: Delete torrent + files
 *    - If still seeding: Keep in qBittorrent for cleanup job
 * 3. Delete media files (title folder only)          ┐ only when deleteMedia
 * 4. Delete from backend library (Plex/ABS)          │ (default true; admin UI
 * 5. Clear audiobook availability linkage            ┘ defaults to false)
 * 6. Soft delete request (set deletedAt, deletedBy)
 *
 * Logic (ebook requests):
 * 1. Check if request exists and is not already deleted
 * 2. Delete ebook files only (leave audiobook files intact)
 * 3. Soft delete request (set deletedAt, deletedBy)
 * Note: No backend library deletion or audiobook linkage clearing for ebooks
 */
export interface DeleteRequestOptions {
  /** Delete media files + library entry (default true). False clears only the request. */
  deleteMedia?: boolean;
}

export async function deleteRequest(
  requestId: string,
  adminUserId: string,
  { deleteMedia = true }: DeleteRequestOptions = {}
): Promise<DeleteRequestResult> {
  try {
    // 1. Find request (only active, non-deleted)
    const request = await prisma.request.findFirst({
      where: {
        id: requestId,
        deletedAt: null,
      },
      include: {
        audiobook: {
          select: {
            id: true,
            title: true,
            author: true,
            narrator: true,
            audibleAsin: true,
            plexGuid: true,
            absItemId: true,
            fileFormat: true,
            filePath: true,
          },
        },
        downloadHistory: {
          where: {
            selected: true,
          },
          orderBy: {
            createdAt: 'desc',
          },
          take: 1,
        },
      },
    });

    // Determine request type (default to audiobook for backward compatibility)
    const requestType = (request as any)?.type || 'audiobook';
    const isEbook = requestType === 'ebook';

    if (!request) {
      return {
        success: false,
        message: 'Request not found or already deleted',
        filesDeleted: false,
        torrentsRemoved: 0,
        torrentsKeptSeeding: 0,
        torrentsKeptUnlimited: 0,
        error: 'NotFound',
      };
    }

    let torrentsRemoved = 0;
    let torrentsKeptSeeding = 0;
    let torrentsKeptUnlimited = 0;

    // 2. Handle downloads & seeding (skip for ebooks - they use direct HTTP downloads)
    const downloadHistory = request.downloadHistory[0];
    const skipTorrentHandling = isEbook; // Ebooks use direct downloads, not torrents/NZBs

    if (!skipTorrentHandling && downloadHistory && downloadHistory.indexerName) {
      try {
        // Get indexer seeding configuration
        const { getConfigService } = await import('./config.service');
        const configService = getConfigService();
        const indexersConfigStr = await configService.get('prowlarr_indexers');

        let seedingConfig: any = null;
        if (indexersConfigStr) {
          const indexersConfig = JSON.parse(indexersConfigStr);
          seedingConfig = indexersConfig.find(
            (idx: any) => idx.name === downloadHistory.indexerName
          );
        }

        // Handle download cleanup via unified interface
        const clientId = downloadHistory.downloadClientId || downloadHistory.torrentHash || downloadHistory.nzbId;
        const clientType = downloadHistory.downloadClient || 'qbittorrent';

        if (clientId && clientType !== 'direct') {
          const { getDownloadClientManager } = await import('./download-client-manager.service');
          const manager = getDownloadClientManager(configService);
          const protocol = CLIENT_PROTOCOL_MAP[clientType as DownloadClientType] || 'torrent';
          const client = await manager.getClientServiceForProtocol(protocol as 'torrent' | 'usenet');

          if (client) {
            // Get download info to check seeding status
            let downloadInfo;
            try {
              downloadInfo = await client.getDownload(clientId);
            } catch (error) {
              logger.info(`Download ${clientId} not found in ${clientType}, skipping`);
            }

            if (downloadInfo) {
              const isUnlimitedSeeding = !seedingConfig || seedingConfig.seedingTimeMinutes === 0;
              const isCompleted = downloadHistory.downloadStatus === 'completed';

              if (client.protocol === 'usenet') {
                // Usenet - no seeding concept, delete immediately
                try {
                  await client.deleteDownload(clientId, true);
                  logger.info(`Deleted download ${clientId} from ${client.clientType}`);
                  torrentsRemoved++;
                } catch (error) {
                  logger.info(`Download ${clientId} not found in ${client.clientType}, skipping`);
                }
              } else if (isUnlimitedSeeding) {
                // Unlimited seeding - keep in client, stop monitoring
                logger.info(
                  `Keeping download ${downloadInfo.name} for unlimited seeding (indexer: ${downloadHistory.indexerName})`
                );
                torrentsKeptUnlimited++;
              } else if (!isCompleted) {
                // Download not completed - delete immediately
                logger.info(`Deleting incomplete download: ${downloadInfo.name}`);
                await client.deleteDownload(clientId, true);
                torrentsRemoved++;
              } else {
                // Check if seeding requirement is met
                const seedingTimeSeconds = seedingConfig.seedingTimeMinutes * 60;
                const actualSeedingTime = downloadInfo.seedingTime || 0;
                const hasMetRequirement = actualSeedingTime >= seedingTimeSeconds;

                if (hasMetRequirement) {
                  logger.info(
                    `Deleting download ${downloadInfo.name} (seeding complete: ${Math.floor(
                      actualSeedingTime / 60
                    )}/${seedingConfig.seedingTimeMinutes} minutes)`
                  );
                  await client.deleteDownload(clientId, true);
                  torrentsRemoved++;
                } else {
                  const remainingMinutes = Math.ceil((seedingTimeSeconds - actualSeedingTime) / 60);
                  logger.info(
                    `Keeping download ${downloadInfo.name} for ${remainingMinutes} more minutes of seeding`
                  );
                  torrentsKeptSeeding++;
                }
              }
            }
          }
        }
      } catch (error) {
        logger.error(
          `Error handling download for request ${requestId}`,
          { error: error instanceof Error ? error.message : String(error) }
        );
        // Continue with deletion even if download handling fails
      }
    }

    // 3-4. Media files + library entry — only when the admin opted to delete media
    let filesDeleted = false;
    if (deleteMedia) {
      filesDeleted = await deleteRequestMedia(requestId, request, isEbook);
    } else {
      logger.info(`Keeping media files and library entry for request ${requestId} (request-only delete)`);
    }

    // 5. Delete child requests (ebook requests linked to this audiobook request)
    if (!isEbook) {
      try {
        const childRequests = await prisma.request.findMany({
          where: {
            parentRequestId: requestId,
            deletedAt: null,
          },
          select: {
            id: true,
            type: true,
          },
        });

        if (childRequests.length > 0) {
          logger.info(`Found ${childRequests.length} child request(s) to delete`);

          // Soft delete all child requests
          await prisma.request.updateMany({
            where: {
              parentRequestId: requestId,
              deletedAt: null,
            },
            data: {
              deletedAt: new Date(),
              deletedBy: adminUserId,
            },
          });

          logger.info(`Soft-deleted ${childRequests.length} child request(s)`);
        }
      } catch (error) {
        logger.error(
          `Error deleting child requests for ${requestId}`,
          { error: error instanceof Error ? error.message : String(error) }
        );
        // Continue with parent deletion even if child deletion fails
      }
    }

    // 6. Soft delete request
    await prisma.request.update({
      where: { id: requestId },
      data: {
        deletedAt: new Date(),
        deletedBy: adminUserId,
      },
    });

    logger.info(
      `Request ${requestId} soft-deleted by admin ${adminUserId}`
    );

    return {
      success: true,
      message: 'Request deleted successfully',
      filesDeleted,
      torrentsRemoved,
      torrentsKeptSeeding,
      torrentsKeptUnlimited,
    };
  } catch (error) {
    logger.error(
      `Failed to delete request ${requestId}`,
      { error: error instanceof Error ? error.message : String(error) }
    );

    return {
      success: false,
      message: 'Failed to delete request',
      filesDeleted: false,
      torrentsRemoved: 0,
      torrentsKeptSeeding: 0,
      torrentsKeptUnlimited: 0,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
