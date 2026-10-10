/**
 * Component: Library Folder Lookup & Removal
 * Documentation: documentation/backend/services/reported-issues.md
 *
 * Finds a book's folder for deletion (request delete with media, issue Replace) and removes
 * it safely. Lookup order: the path ReadMeABook recorded → the Audiobookshelf item's place in
 * the library (media_dir + item relPath — works for books never requested in ReadMeABook and
 * folders moved since import) → Audiobookshelf items with the book's exact ASIN (the linked
 * item id is missing or stale after a move) → the path template (series included). Removal
 * refuses anything that isn't a single book's folder inside media_dir (author/series folders,
 * folders holding other books).
 */

import * as fs from 'fs/promises';
import path from 'path';
import { AUDIO_EXTENSIONS } from '../constants/audio-formats';
import { buildAudiobookPath } from '../utils/file-organizer';
import type { RMABLogger } from '../utils/logger';

type Log = Pick<RMABLogger, 'info' | 'warn'>;

export interface LibraryBook {
  title: string;
  author: string;
  narrator?: string | null;
  audibleAsin?: string | null;
  filePath?: string | null;
  absItemId?: string | null;
  year?: number;
  series?: string | null;
  seriesPart?: string | null;
}

const DISC_FOLDER_RE = /^(?:cd|disc|disk|part|pt)\s*[-_.]?\s*\d+$/i;
const isAudio = (name: string) => (AUDIO_EXTENSIONS as readonly string[]).includes(path.extname(name).toLowerCase());

/** Path inside media_dir, at least Author/Book deep. */
function bookDepthInside(dir: string, mediaDir: string): boolean {
  const rel = path.relative(mediaDir, dir);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel) && rel.split(/[\\/]/).filter(Boolean).length >= 2;
}

async function exists(dir: string): Promise<boolean> {
  try {
    await fs.access(dir);
    return true;
  } catch {
    return false;
  }
}

/**
 * Audiobookshelf item ids whose ASIN is exactly the book's (plex_library holds the ABS item id
 * in plexGuid). Exact ASIN only — never another edition, since this feeds deletion.
 */
export async function absItemIdsForAsin(asin: string | null | undefined): Promise<string[]> {
  if (!asin) return [];
  try {
    const { getConfigService } = await import('./config.service');
    if ((await getConfigService().getBackendMode()) !== 'audiobookshelf') return [];
    const { prisma } = await import('../db');
    const rows = await prisma.plexLibrary.findMany({ where: { asin: { equals: asin, mode: 'insensitive' } }, select: { plexGuid: true } });
    return (rows ?? []).map(r => r.plexGuid);
  } catch {
    return [];
  }
}

async function absItemFolder(itemId: string, mediaDir: string, logger?: Log): Promise<string | null> {
  try {
    const { getABSItem } = await import('./audiobookshelf/api');
    const item = await getABSItem(itemId);
    return item?.relPath && !item.isFile ? path.join(mediaDir, item.relPath) : null;
  } catch (error) {
    await logger?.warn(`Could not read Audiobookshelf item ${itemId}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** Where the path template puts the book (series included). */
export function templateFolder(book: LibraryBook, mediaDir: string, template: string): string {
  return buildAudiobookPath(mediaDir, template, {
    author: book.author,
    title: book.title,
    narrator: book.narrator || undefined,
    asin: book.audibleAsin || undefined,
    year: book.year,
    series: book.series || undefined,
    seriesPart: book.seriesPart || undefined,
  });
}

/** The book's folder, or null when none of the sources points at an existing folder. */
export async function resolveLibraryFolder(book: LibraryBook, mediaDir: string, template: string, logger?: Log): Promise<string | null> {
  const found = async (source: string, dir: string | null) => {
    if (!dir || !bookDepthInside(dir, mediaDir) || !(await exists(dir))) return false;
    await logger?.info(`Book folder (${source}): ${dir}`);
    return true;
  };

  if (book.filePath) {
    const recorded = isAudio(book.filePath) ? path.dirname(book.filePath) : book.filePath;
    if (await found('recorded path', recorded)) return recorded;
  }

  if (book.absItemId) {
    const dir = await absItemFolder(book.absItemId, mediaDir, logger);
    if (await found('Audiobookshelf item', dir)) return dir;
  }

  // Linked item missing or stale (e.g. a new item id after the folder was moved) — same ASIN
  for (const itemId of await absItemIdsForAsin(book.audibleAsin)) {
    if (itemId === book.absItemId) continue;
    const dir = await absItemFolder(itemId, mediaDir, logger);
    if (await found(`Audiobookshelf item with ASIN ${book.audibleAsin}`, dir)) return dir;
  }

  const templated = templateFolder(book, mediaDir, template);
  if (await found('path template', templated)) return templated;
  return null;
}

/** Subfolders (other than CD1/Disc 2…) that contain audio — i.e. other books. */
async function nestedBooks(folder: string): Promise<string[]> {
  let entries: Array<{ name: string; isDirectory(): boolean }> = [];
  try {
    entries = (await fs.readdir(folder, { withFileTypes: true })) ?? [];
  } catch {
    return [];
  }
  const nested: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || DISC_FOLDER_RE.test(e.name)) continue;
    const inner = await fs.readdir(path.join(folder, e.name)).catch(() => [] as string[]);
    if ((inner ?? []).some(isAudio)) nested.push(e.name);
  }
  return nested;
}

/**
 * Delete a single book's folder. Throws (deleting nothing) when the folder is outside
 * media_dir, is an author-level folder, or contains other books' folders.
 */
export async function removeBookFolder(folder: string, mediaDir: string, logger?: Log): Promise<void> {
  if (!bookDepthInside(folder, mediaDir)) throw new Error(`Refusing to delete "${folder}": not a book folder inside ${mediaDir}`);
  const nested = await nestedBooks(folder);
  if (nested.length > 0) throw new Error(`Refusing to delete "${folder}": it contains other books (${nested.join(', ')})`);
  await fs.rm(folder, { recursive: true, force: true });
  await logger?.info(`Deleted book folder: ${folder}`);
}
