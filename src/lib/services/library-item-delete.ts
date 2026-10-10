/**
 * Component: Library Item Delete (books never requested in ReadMeABook)
 * Documentation: documentation/backend/services/reported-issues.md
 *
 * Issue Replace for a book added to the library outside ReadMeABook: deletes the book's
 * folder (or records it as a leftover for the Health Report), its Audiobookshelf/Plex item
 * and its plex_library rows.
 */

import { prisma } from '@/lib/db';
import { RMABLogger } from '@/lib/utils/logger';

const logger = RMABLogger.create('ReportedIssue');

/**
 * Delete audiobook content from library backend directly (no RMAB request).
 * Used when a book was added to Plex/ABS outside of RMAB.
 */
export async function deleteFromLibrary(audiobook: {
  id: string;
  title: string;
  author: string;
  audibleAsin: string | null;
  plexGuid: string | null;
  absItemId: string | null;
  narrator?: string | null;
  filePath?: string | null;
  year?: number | null;
  series?: string | null;
  seriesPart?: string | null;
}) {
  const { getConfigService } = await import('./config.service');
  const configService = getConfigService();
  const backendMode = await configService.getBackendMode();

  // Delete the book's files first (before its Audiobookshelf item, whose path locates them).
  // Not found / not safe to delete → recorded for the Health Report, the replacement still downloads
  const mediaDir = (await configService.get('media_dir')) || '/media/audiobooks';
  const template = (await configService.get('audiobook_path_template')) || '{author}/{title} {asin}';
  const { deleteOldCopy } = await import('./library-leftovers');
  const { kept } = await deleteOldCopy({ ...audiobook, year: audiobook.year ?? undefined }, mediaDir, template, 'replace', logger);

  // Delete from library backend API (kept while its files are still on disk, so the leftover stays visible)
  if (backendMode === 'audiobookshelf' && kept) {
    logger.warn(`Keeping the Audiobookshelf item of "${audiobook.title}" — its files were not deleted`);
  } else if (backendMode === 'audiobookshelf') {
    // absItemId may be null if the book was added outside RMAB.
    // Fall back to looking up the ABS item ID from plex_library by ASIN
    // (plexGuid stores the ABS item ID when using ABS backend).
    let itemId = audiobook.absItemId;
    if (!itemId && audiobook.audibleAsin) {
      const libraryRecord = await prisma.plexLibrary.findFirst({
        where: {
          OR: [
            { asin: audiobook.audibleAsin },
            { plexGuid: { contains: audiobook.audibleAsin } },
          ],
        },
        select: { plexGuid: true },
      });
      itemId = libraryRecord?.plexGuid ?? null;
    }

    if (itemId) {
      try {
        const { deleteABSItem } = await import('./audiobookshelf/api');
        await deleteABSItem(itemId);
        logger.info(`Deleted ABS item ${itemId} for "${audiobook.title}"`);
      } catch (error) {
        logger.error(`Failed to delete ABS item ${itemId}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } else {
      logger.warn(`No ABS item ID found for "${audiobook.title}" (ASIN: ${audiobook.audibleAsin}) — skipping ABS deletion`);
    }
  } else if (backendMode === 'plex' && audiobook.plexGuid) {
    try {
      const plexLibraryRecord = await prisma.plexLibrary.findUnique({
        where: { plexGuid: audiobook.plexGuid },
        select: { plexRatingKey: true },
      });

      if (plexLibraryRecord?.plexRatingKey) {
        const plexServerUrl = (await configService.get('plex_url')) || '';
        const plexToken = (await configService.get('plex_token')) || '';

        if (plexServerUrl && plexToken) {
          const { getPlexService } = await import('../integrations/plex.service');
          const plexService = getPlexService();
          await plexService.deleteItem(plexServerUrl, plexToken, plexLibraryRecord.plexRatingKey);
          logger.info(`Deleted Plex item ${plexLibraryRecord.plexRatingKey} for "${audiobook.title}"`);
        }
      }
    } catch (error) {
      logger.error(`Failed to delete Plex item for "${audiobook.title}"`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Delete plex_library records by ASIN
  if (audiobook.audibleAsin) {
    try {
      const result = await prisma.plexLibrary.deleteMany({
        where: {
          OR: [
            { asin: audiobook.audibleAsin },
            { plexGuid: { contains: audiobook.audibleAsin } },
          ],
        },
      });
      if (result.count > 0) {
        logger.info(`Deleted ${result.count} plex_library record(s) by ASIN "${audiobook.audibleAsin}"`);
      }
    } catch (error) {
      logger.error(`Failed to delete plex_library records for ASIN "${audiobook.audibleAsin}"`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
