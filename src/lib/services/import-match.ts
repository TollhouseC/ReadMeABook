/**
 * Component: Import Edition Match (Audiobookshelf)
 * Documentation: documentation/phase3/file-organization.md
 *
 * ReadMeABook tags the ASIN into imported files, so the new Audiobookshelf item already has
 * an ASIN and the scan's own matching (items without an ASIN only) never runs — the item
 * keeps whatever title/cover/series Audiobookshelf read from the tags. After each library
 * check, books that became available in the last few days are matched once to the requested
 * edition (ASIN, overrideDetails + overrideCover), verified, and marked `absMatchedAt`; a
 * failed match is retried on the next check. The item is picked by the folder ReadMeABook
 * imported into, so an old copy with the same ASIN is never the one matched.
 */

import path from 'path';
import { prisma } from '../db';
import type { RMABLogger } from '../utils/logger';

type Log = Pick<RMABLogger, 'info' | 'warn'>;

/** Only recent imports — older books may carry manual Audiobookshelf edits */
export const IMPORT_MATCH_WINDOW_DAYS = 3;

const toRel = (filePath: string, mediaDir: string): string | null => {
  const rel = path.relative(mediaDir, filePath).split(path.sep).join('/');
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : null;
};

/** The Audiobookshelf item in the folder ReadMeABook imported into (null: not scanned yet). */
async function itemForImport(
  book: { absItemId: string | null; filePath: string | null },
  mediaDir: string,
  libraryItems: () => Promise<Array<{ id: string; relPath: string }>>
): Promise<string | null> {
  const rel = book.filePath ? toRel(book.filePath, mediaDir) : null;
  if (!rel) return book.absItemId;
  const { getABSItem } = await import('./audiobookshelf/api');
  if (book.absItemId) {
    const item = await getABSItem(book.absItemId).catch(() => null);
    if (item?.relPath === rel) return book.absItemId;
  }
  return (await libraryItems()).find(i => i.relPath === rel)?.id ?? null;
}

export async function matchImportsToRequestedEdition(logger: Log): Promise<{ matched: number; failed: number; waiting: number }> {
  const counts = { matched: 0, failed: 0, waiting: 0 };
  const since = new Date(Date.now() - IMPORT_MATCH_WINDOW_DAYS * 86_400_000);
  const books = await prisma.audiobook.findMany({
    where: {
      absMatchedAt: null,
      absItemId: { not: null },
      audibleAsin: { not: null },
      completedAt: { gte: since },
      requests: { some: { type: 'audiobook', status: 'available', deletedAt: null } },
    },
    select: { id: true, title: true, audibleAsin: true, absItemId: true, filePath: true },
  });
  if (!books?.length) return counts;

  const { getConfigService } = await import('./config.service');
  const config = getConfigService();
  const mediaDir = (await config.get('media_dir')) || '/media/audiobooks';
  const libraryId = await config.get('audiobookshelf.library_id');
  const { getABSLibraryItems, triggerABSItemMatch } = await import('./audiobookshelf/api');
  let cached: Array<{ id: string; relPath: string }> | null = null;
  const libraryItems = async () =>
    (cached ??= libraryId ? ((await getABSLibraryItems(libraryId)) || []).map((r: any) => ({ id: r.id, relPath: r.relPath || '' })) : []);

  for (const book of books) {
    const asin = book.audibleAsin!;
    try {
      const itemId = await itemForImport(book, mediaDir, libraryItems);
      if (!itemId) {
        counts.waiting++;
        continue;
      }
      const res = await triggerABSItemMatch(itemId, asin, { overrideDetails: true, overrideCover: true, throwOnError: true });
      if (res && (!res.asin || res.asin.toLowerCase() === asin.toLowerCase())) {
        await prisma.audiobook.update({ where: { id: book.id }, data: { absMatchedAt: new Date(), absItemId: itemId } });
        counts.matched++;
        await logger.info(`Matched "${book.title}" in Audiobookshelf to the requested edition (${asin})${res.updated ? '' : ' — already up to date'}`);
      } else {
        counts.failed++;
        await logger.warn(`Audiobookshelf didn't match "${book.title}" to ${asin}${res?.asin ? ` (the item has ASIN ${res.asin})` : ''} — retrying on the next check`);
      }
    } catch (error) {
      counts.failed++;
      await logger.warn(`Could not match "${book.title}" to ${asin} in Audiobookshelf: ${error instanceof Error ? error.message : String(error)} — retrying on the next check`);
    }
  }
  return counts;
}
