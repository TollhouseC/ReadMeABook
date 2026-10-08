/**
 * Component: Audiobookshelf Chapter Sync
 * Documentation: documentation/features/chapter-merging.md
 *
 * Audiobookshelf keeps its own chapter list per book (in its database and, with "Store
 * metadata with item", in metadata.json — which wins over the audio file on rescan).
 * After ReadMeABook rewrites a file's chapters, push the file's chapters to ABS through
 * its API so the change shows up immediately, without a rescan.
 */

import type { RMABLogger } from '../utils/logger';
import { probeEmbeddedChapters, type ChapterMarker } from '../utils/chapter-list';

export async function isAudiobookshelfBackend(): Promise<boolean> {
  try {
    const { getConfigService } = await import('./config.service');
    return (await getConfigService().getBackendMode()) === 'audiobookshelf';
  } catch {
    return false;
  }
}

/** Chapter count Audiobookshelf currently shows for an item (null if unknown). */
export async function getABSChapterCount(itemId: string): Promise<number | null> {
  const { getABSItem } = await import('./audiobookshelf/api');
  const item = await getABSItem(itemId);
  return Array.isArray(item?.media?.chapters) ? item.media.chapters.length : null;
}

/** Replace an item's chapters in Audiobookshelf (POST /api/items/:id/chapters). */
export async function pushChaptersToABS(itemId: string, chapters: ChapterMarker[]): Promise<void> {
  const { absRequest } = await import('./audiobookshelf/api');
  await absRequest(`/items/${itemId}/chapters`, {
    method: 'POST',
    body: {
      chapters: chapters.map((c, id) => ({ id, start: c.startMs / 1000, end: c.endMs / 1000, title: c.title })),
    },
  });
}

/**
 * Read the chapters embedded in `filePath` and push them to the ABS item.
 * Best-effort: returns false (and logs) instead of throwing.
 */
export async function syncFileChaptersToABS(itemId: string, filePath: string, logger?: RMABLogger): Promise<boolean> {
  try {
    const chapters = await probeEmbeddedChapters(filePath);
    if (chapters.length === 0) return false;
    await pushChaptersToABS(itemId, chapters);
    await logger?.info(`Sent ${chapters.length} chapters to Audiobookshelf`);
    return true;
  } catch (error) {
    await logger?.warn(`Could not update chapters in Audiobookshelf: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
