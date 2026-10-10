/**
 * Component: Library Leftovers (old copies Replace / delete-with-media couldn't remove)
 * Documentation: documentation/backend/services/reported-issues.md
 *
 * When Replace (or a request delete with media) can't find or safely delete the old copy,
 * the download still goes ahead; the old copy is recorded here (config key
 * `library_leftovers`) and listed by the Library Health Report until it is gone. On
 * Audiobookshelf an entry clears itself once no library item other than the new import
 * matches it (same item id, or same title with the same/no ASIN); on Plex entries are
 * listed for 90 days.
 */

import path from 'path';
import { prisma } from '../db';
import type { RMABLogger } from '../utils/logger';
import { absItemIdsForAsin, removeBookFolder, resolveLibraryFolder, templateFolder, type LibraryBook } from './library-folder';

type Log = Pick<RMABLogger, 'info' | 'warn'>;

export const LEFTOVERS_KEY = 'library_leftovers';
const PLEX_KEEP_DAYS = 90;

export interface Leftover {
  audiobookId: string;
  title: string;
  author: string;
  asin?: string | null;
  /** Audiobookshelf items that held the old copy, when known */
  itemIds: string[];
  /** Why it wasn't deleted ("no folder found — looked at …", "refused: …") */
  reason: string;
  source: 'replace' | 'delete';
  recordedAt: string;
}

export async function listLeftovers(): Promise<Leftover[]> {
  try {
    const row = await prisma.configuration.findUnique({ where: { key: LEFTOVERS_KEY } });
    const list = row?.value ? JSON.parse(row.value) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function saveLeftovers(list: Leftover[]): Promise<void> {
  const value = JSON.stringify(list);
  await prisma.configuration.upsert({
    where: { key: LEFTOVERS_KEY },
    create: { key: LEFTOVERS_KEY, value, category: 'system', description: 'Old book copies Replace/delete could not remove (Library Health Report lists them)' },
    update: { value },
  });
}

/** Remember an old copy that wasn't deleted (one entry per book; never throws). */
export async function recordLeftover(entry: Omit<Leftover, 'recordedAt'>, logger?: Log): Promise<void> {
  try {
    const list = (await listLeftovers()).filter(l => l.audiobookId !== entry.audiobookId);
    list.push({ ...entry, itemIds: [...new Set(entry.itemIds.filter(Boolean))], recordedAt: new Date().toISOString() });
    await saveLeftovers(list);
    await logger?.warn(`Old copy of "${entry.title}" not deleted (${entry.reason}) — the download goes ahead; the Library Health Report will list it for cleanup`);
  } catch {
    // reporting only — never block the delete/replace
  }
}

/**
 * Delete a book's old copy (folder lookup + safe removal); when it can't be found or safely
 * deleted, record it for the Health Report instead of failing. `deleted`: the folder removed;
 * `kept`: a folder was found but refused (still on disk — keep its library item).
 */
export async function deleteOldCopy(
  book: LibraryBook & { id: string },
  mediaDir: string,
  template: string,
  source: Leftover['source'],
  logger?: Log
): Promise<{ deleted: string | null; kept: boolean }> {
  const itemIds = [book.absItemId || '', ...(await absItemIdsForAsin(book.audibleAsin))];
  let reason: string;
  let kept = false;
  try {
    const folder = await resolveLibraryFolder(book, mediaDir, template, logger);
    if (folder) {
      kept = true;
      await removeBookFolder(folder, mediaDir, logger);
      return { deleted: folder, kept: false };
    }
    const looked = [book.filePath && `recorded path ${book.filePath}`, itemIds.some(Boolean) && 'Audiobookshelf item', `template ${templateFolder(book, mediaDir, template)}`];
    reason = `no folder found — looked at ${looked.filter(Boolean).join(', ')}`;
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  await recordLeftover({ audiobookId: book.id, title: book.title, author: book.author, asin: book.audibleAsin, itemIds, reason, source }, logger);
  return { deleted: null, kept };
}

/** "Thrawn (Star Wars)" / "Thrawn" → "thrawn" */
export const titleKey = (s: string) => s.toLowerCase().replace(/\([^)]*\)|\[[^\]]*\]/g, '').replace(/[^a-z0-9]+/g, '');

interface LibraryItem { id: string; title: string; asin?: string; relPath: string }

/** Library items that still look like the old copy (the new import excluded). */
export function remainingCopies(
  leftover: Leftover,
  items: LibraryItem[],
  current: { absItemId?: string | null; relPath?: string | null }
): LibraryItem[] {
  const key = titleKey(leftover.title);
  const asin = leftover.asin?.toLowerCase();
  return items.filter(item => {
    if (current.relPath ? item.relPath === current.relPath : item.id === current.absItemId) return false;
    if (leftover.itemIds.includes(item.id)) return true;
    const sameTitle = !!key && (titleKey(item.title) === key || titleKey(path.basename(item.relPath)) === key);
    return sameTitle && (!item.asin || !asin || item.asin.toLowerCase() === asin);
  });
}

/**
 * Health Report section: list every old copy still in the library, drop the entries that
 * are cleaned up. Returns counts for the summary.
 */
export async function checkLeftovers(logger: Log): Promise<{ leftovers: number; cleaned: number }> {
  const list = await listLeftovers();
  if (list.length === 0) {
    await logger.info('No old copies left behind by Replace / delete');
    return { leftovers: 0, cleaned: 0 };
  }

  const { getConfigService } = await import('./config.service');
  const config = getConfigService();
  const mediaDir = (await config.get('media_dir')) || '/media/audiobooks';
  const onABS = (await config.getBackendMode()) === 'audiobookshelf';
  const libraryId = onABS ? await config.get('audiobookshelf.library_id') : null;

  let items: LibraryItem[] | null = null;
  if (libraryId) {
    const { getABSLibraryItems } = await import('./audiobookshelf/api');
    items = ((await getABSLibraryItems(libraryId)) || []).map((raw: any) => ({
      id: raw.id,
      title: raw.media?.metadata?.title || '',
      asin: raw.media?.metadata?.asin || undefined,
      relPath: raw.relPath || raw.path || '',
    }));
  }

  const keep: Leftover[] = [];
  let cleaned = 0;
  for (const leftover of list) {
    const when = leftover.recordedAt.slice(0, 10);
    const label = `"${leftover.title}" by ${leftover.author}${leftover.asin ? ` (${leftover.asin})` : ''} — ${leftover.source} on ${when}`;
    if (items) {
      const book = await prisma.audiobook.findUnique({ where: { id: leftover.audiobookId }, select: { absItemId: true, filePath: true } }).catch(() => null);
      const relPath = book?.filePath ? path.relative(mediaDir, book.filePath).split(path.sep).join('/') : null;
      const copies = remainingCopies(leftover, items, { absItemId: book?.absItemId, relPath: relPath && !relPath.startsWith('..') ? relPath : null });
      if (copies.length === 0) {
        cleaned++;
        await logger.info(`Cleaned up: ${label}`);
        continue;
      }
      for (const copy of copies) {
        await logger.warn(`Old copy left behind: ${label}: "${path.posix.join(mediaDir, copy.relPath)}" (Audiobookshelf item ${copy.id}; ${leftover.reason}) — delete that folder, then remove the item in Audiobookshelf (files already gone)`);
      }
    } else {
      const age = (Date.now() - Date.parse(leftover.recordedAt)) / 86_400_000;
      if (age > PLEX_KEEP_DAYS) {
        cleaned++;
        continue;
      }
      await logger.warn(`Old copy may be left behind: ${label} (${leftover.reason}) — check the library for a second copy`);
    }
    keep.push(leftover);
  }

  if (cleaned > 0) await saveLeftovers(keep);
  return { leftovers: keep.length, cleaned };
}
