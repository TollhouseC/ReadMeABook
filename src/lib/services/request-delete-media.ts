/**
 * Component: Request Deletion Service — Media Cleanup
 * Documentation: documentation/admin-features/request-deletion.md
 *
 * Deletes a request's media files and library entry. Only runs when the admin opts
 * into deleting media; a plain "clear request" leaves the library untouched.
 */

import { prisma } from '../db';
import * as fs from 'fs/promises';
import * as path from 'path';
import { RMABLogger } from '../utils/logger';
import { buildAudiobookPath } from '../utils/file-organizer';
import { removeBookFolder, resolveLibraryFolder } from './library-folder';

const logger = RMABLogger.create('RequestDelete');

export interface MediaCleanupTarget {
  audiobook: {
    id: string;
    title: string;
    author: string;
    narrator: string | null;
    audibleAsin: string | null;
    plexGuid: string | null;
    absItemId: string | null;
    /** Folder recorded at import (found first; falls back to the ABS item, then the template) */
    filePath?: string | null;
  };
}

/**
 * Audiobooks: delete the title folder, the Plex/ABS item and plex_library records,
 * and clear the audiobook's availability linkage.
 * Ebooks: delete only ebook files in the title folder.
 * Every step is best-effort. Returns whether any files were deleted.
 */
export async function deleteRequestMedia(
  requestId: string,
  request: MediaCleanupTarget,
  isEbook: boolean
): Promise<boolean> {
  // 3. Delete media files
  // For audiobooks: delete entire title folder
  // For ebooks: delete only ebook files (leave audiobook files intact)
  let filesDeleted = false;
  try {
    const { getConfigService } = await import('./config.service');
    const configService = getConfigService();
    const mediaDir = (await configService.get('media_dir')) || '/media/audiobooks';
    // Use ebook-specific template for ebook requests, with fallback to audiobook template
    const audiobookTemplate = (await configService.get('audiobook_path_template')) || '{author}/{title} {asin}';
    const template = isEbook
      ? (await configService.get('ebook_path_template')) || audiobookTemplate
      : audiobookTemplate;

    // Fetch year from audible cache if ASIN is available
    let year: number | undefined;
    if (request.audiobook.audibleAsin) {
      const audibleCache = await prisma.audibleCache.findUnique({
        where: { asin: request.audiobook.audibleAsin },
        select: { releaseDate: true },
      });
      if (audibleCache?.releaseDate) {
        year = new Date(audibleCache.releaseDate).getFullYear();
      }
    }

    // Audiobooks: the book's actual folder (recorded path → Audiobookshelf item → template),
    // removed only if it's a single book's folder
    if (!isEbook) {
      const folder = await resolveLibraryFolder({ ...request.audiobook, year }, mediaDir, template, logger);
      if (!folder) {
        logger.info(`Media folder not found for "${request.audiobook.title}"`);
        filesDeleted = false;
      } else {
        await removeBookFolder(folder, mediaDir, logger);
        filesDeleted = true;
      }
    } else {
      // Ebooks: only the ebook files in the template folder, audiobook files stay
      const titleFolderPath = buildAudiobookPath(
        mediaDir,
        template,
        {
          author: request.audiobook.author,
          title: request.audiobook.title,
          narrator: request.audiobook.narrator || undefined,
          asin: request.audiobook.audibleAsin || undefined,
          year,
        }
      );

      try {
        await fs.access(titleFolderPath);
        const ebookExtensions = ['.epub', '.pdf', '.mobi', '.azw', '.azw3', '.fb2', '.cbz', '.cbr'];
        const files = await fs.readdir(titleFolderPath);

        let deletedCount = 0;
        for (const file of files) {
          const ext = path.extname(file).toLowerCase();
          if (ebookExtensions.includes(ext)) {
            const filePath = path.join(titleFolderPath, file);
            await fs.unlink(filePath);
            logger.info(`Deleted ebook file: ${file}`);
            deletedCount++;
          }
        }

        filesDeleted = deletedCount > 0;
        logger.info(`Deleted ${deletedCount} ebook file(s) from: ${titleFolderPath}`);
      } catch {
        // Folder doesn't exist - that's okay
        logger.info(`Media directory not found: ${titleFolderPath}`);
        filesDeleted = false;
      }
    }
  } catch (error) {
    logger.error(
      `Error deleting media files for request ${requestId}`,
      { error: error instanceof Error ? error.message : String(error) }
    );
    // Continue with soft delete even if file deletion fails
  }

  // 4. Delete from plex_library table and clear audiobook availability
  // Skip for ebooks - audiobook files and library entry should remain intact
  // This ensures the book immediately shows as NOT available when searching
  if (!isEbook) {
    try {
      const { getConfigService } = await import('./config.service');
      const configService = getConfigService();
      const backendMode = await configService.getBackendMode();

      // Delete from library backend (ABS or Plex)
      if (backendMode === 'audiobookshelf' && request.audiobook.absItemId) {
        // Audiobookshelf: delete the library item from ABS
        try {
          const { deleteABSItem } = await import('../services/audiobookshelf/api');
          await deleteABSItem(request.audiobook.absItemId);
          logger.info(
            `Deleted Audiobookshelf library item ${request.audiobook.absItemId} for "${request.audiobook.title}"`
          );
        } catch (absError) {
          logger.error(
            `Error deleting Audiobookshelf library item ${request.audiobook.absItemId}`,
            { error: absError instanceof Error ? absError.message : String(absError) }
          );
          // Continue with deletion even if ABS deletion fails
        }
      } else if (backendMode === 'plex' && request.audiobook.plexGuid) {
        // Plex: delete the library item from Plex by ratingKey
        try {
          // Query plex_library table to get the ratingKey
          const plexLibraryRecord = await prisma.plexLibrary.findUnique({
            where: { plexGuid: request.audiobook.plexGuid },
            select: { plexRatingKey: true },
          });

          if (plexLibraryRecord && plexLibraryRecord.plexRatingKey) {
            const ratingKey = plexLibraryRecord.plexRatingKey;

            // Get Plex config
            const plexServerUrl = (await configService.get('plex_url')) || '';
            const plexToken = (await configService.get('plex_token')) || '';

            if (plexServerUrl && plexToken) {
              const { getPlexService } = await import('../integrations/plex.service');
              const plexService = getPlexService();
              await plexService.deleteItem(plexServerUrl, plexToken, ratingKey);
              logger.info(
                `Deleted Plex library item ${ratingKey} (plexGuid: ${request.audiobook.plexGuid}) for "${request.audiobook.title}"`
              );
            } else {
              logger.warn('Plex server URL or token not configured, skipping Plex library deletion');
            }
          } else {
            logger.warn(
              `No plexRatingKey found in plex_library for plexGuid: ${request.audiobook.plexGuid}`
            );
          }
        } catch (plexError) {
          logger.error(
            `Error deleting Plex library item (plexGuid: ${request.audiobook.plexGuid})`,
            { error: plexError instanceof Error ? plexError.message : String(plexError) }
          );
          // Continue with deletion even if Plex deletion fails
        }
      }

      // Delete plex_library records to ensure book shows as NOT available
      // Uses ASIN-based matching (same as availability check) for consistency
      try {
        let deletedCount = 0;

        // Primary method: Delete by ASIN (matches availability check logic exactly)
        // This ensures the same record found during availability check gets deleted
        if (request.audiobook.audibleAsin) {
          const asinDeleteResult = await prisma.plexLibrary.deleteMany({
            where: {
              OR: [
                { asin: request.audiobook.audibleAsin },
                { plexGuid: { contains: request.audiobook.audibleAsin } },
              ],
            },
          });
          deletedCount = asinDeleteResult.count;

          if (deletedCount > 0) {
            logger.info(
              `Deleted ${deletedCount} plex_library record(s) by ASIN "${request.audiobook.audibleAsin}" for "${request.audiobook.title}"`
            );
          }
        }

        // Fallback: Delete by exact title/author match (for legacy records without ASIN)
        // Only used if ASIN deletion didn't find any records
        if (deletedCount === 0) {
          const matchingLibraryRecords = await prisma.plexLibrary.findMany({
            where: {
              title: {
                equals: request.audiobook.title,
                mode: 'insensitive',
              },
              author: {
                equals: request.audiobook.author,
                mode: 'insensitive',
              },
            },
          });

          if (matchingLibraryRecords.length > 0) {
            const deletePromises = matchingLibraryRecords.map((record) =>
              prisma.plexLibrary.delete({ where: { id: record.id } })
            );
            await Promise.all(deletePromises);
            deletedCount = matchingLibraryRecords.length;

            logger.info(
              `Deleted ${deletedCount} plex_library record(s) by title/author for "${request.audiobook.title}"`
            );
          } else {
            logger.info(
              `No plex_library records found for "${request.audiobook.title}" (ASIN: ${request.audiobook.audibleAsin || 'none'})`
            );
          }
        }
      } catch (libError) {
        logger.error(
          `Error deleting plex_library records`,
          { error: libError instanceof Error ? libError.message : String(libError) }
        );
        // Continue with deletion even if library cleanup fails
      }

      // Clear audiobook record linkage
      const updateData: any = {
        status: 'requested', // Reset to requested state
        updatedAt: new Date(),
      };

      // Clear library linkage based on backend mode
      if (backendMode === 'audiobookshelf') {
        updateData.absItemId = null;
      } else {
        updateData.plexGuid = null;
      }

      await prisma.audiobook.update({
        where: { id: request.audiobook.id },
        data: updateData,
      });

      logger.info(
        `Cleared availability status for audiobook ${request.audiobook.id}`
      );
    } catch (error) {
      logger.error(
        `Error clearing audiobook status`,
        { error: error instanceof Error ? error.message : String(error) }
      );
      // Continue with deletion even if this fails
    }
  } else {
    logger.info(`Skipping backend library deletion for ebook request ${requestId}`);
  }

  return filesDeleted;
}
