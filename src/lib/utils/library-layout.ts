/**
 * Component: Library Layout Guard
 * Documentation: documentation/phase3/file-organization.md
 *
 * Library layout is Author/Series/Title/ (or Author/Title/). Audiobookshelf treats
 * everything under a folder with audio files as ONE book, so a book must never sit
 * inside another book's folder. This happens when a series shares its name with a
 * book stored without a series (e.g. "The Academy" book 1 at Author/The Academy/,
 * then book 2 at Author/The Academy/The Thoroughbreds/).
 *
 * Fixes keep series folders consistent:
 * - Target inside an existing book folder → move that book's own files down into
 *   <folder>/<folder name>/ first (book 1 joins its series folder), then import.
 * - Target folder already holds other books in subfolders → import into
 *   <target>/<folder name>/ instead of loose in the series folder.
 */

import fs from 'fs/promises';
import path from 'path';
import { AUDIO_EXTENSIONS } from '../constants/audio-formats';
import type { RMABLogger } from './logger';

/** Subfolders that are discs/parts of the same book, not separate books. */
const DISC_FOLDER_RE = /^(?:cd|disc|disk|part|pt)\s*[-_.]?\s*\d+$/i;

const isAudio = (name: string) => (AUDIO_EXTENSIONS as readonly string[]).includes(path.extname(name).toLowerCase());

export async function hasAudioFiles(dir: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.some(e => e.isFile() && isAudio(e.name));
  } catch {
    return false;
  }
}

/** Subfolders of `dir` (excluding disc folders) that directly contain audio — i.e. other books. */
async function bookSubfolders(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const result: string[] = [];
    for (const e of entries) {
      if (e.isDirectory() && !DISC_FOLDER_RE.test(e.name) && (await hasAudioFiles(path.join(dir, e.name)))) {
        result.push(path.join(dir, e.name));
      }
    }
    return result;
  } catch {
    return [];
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Move a book folder's own top-level files into <dir>/<dir name>/ (subfolders — other
 * books — stay put). Returns the new folder.
 */
export async function moveBookIntoOwnSubfolder(dir: string, dirMode?: number): Promise<string> {
  let destination = path.join(dir, path.basename(dir));
  if (await exists(destination)) destination = path.join(dir, `${path.basename(dir)} (book)`);
  if (await exists(destination)) throw new Error(`Cannot move book files: ${destination} already exists`);

  await fs.mkdir(destination, { recursive: true, ...(dirMode !== undefined && { mode: dirMode }) });
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isFile()) await fs.rename(path.join(dir, e.name), path.join(destination, e.name));
  }
  return destination;
}

export interface LayoutResolution {
  targetPath: string;
  /** An existing book that was moved into its own subfolder to make room */
  movedExisting?: { from: string; to: string };
}

/** Adjust an import target so it never nests inside, or loosely beside, another book. */
export async function resolveCollisionFreeTarget(
  mediaDir: string,
  targetPath: string,
  options: { dirMode?: number; logger?: RMABLogger } = {}
): Promise<LayoutResolution> {
  const root = path.resolve(mediaDir);
  let resolved = path.resolve(targetPath);
  let movedExisting: LayoutResolution['movedExisting'];

  // 1. An ancestor (below media_dir) is itself a book folder → move that book down
  for (let dir = path.dirname(resolved); dir.startsWith(root) && dir !== root; dir = path.dirname(dir)) {
    if (await hasAudioFiles(dir)) {
      const to = await moveBookIntoOwnSubfolder(dir, options.dirMode);
      movedExisting = { from: dir, to };
      await options.logger?.info(`Library layout: "${dir}" holds a book and would contain the new one — moved its files to "${to}"`);
      break;
    }
  }

  // 2. Target is already a folder of other books (a series folder) → own subfolder
  if (!(await hasAudioFiles(resolved)) && (await bookSubfolders(resolved)).length > 0) {
    const adjusted = path.join(resolved, path.basename(resolved));
    await options.logger?.info(`Library layout: "${resolved}" already holds other books — importing into "${adjusted}"`);
    resolved = adjusted;
  }

  return { targetPath: resolved, movedExisting };
}

export interface NestedBook {
  /** Folder that holds a book's files AND other books' folders */
  outer: string;
  inner: string[];
}

/** Book folders that contain other books (would be merged into one item by Audiobookshelf). */
export async function findNestedBooks(mediaDir: string): Promise<NestedBook[]> {
  const nested: NestedBook[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 8) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (dir !== path.resolve(mediaDir) && entries.some(e => e.isFile() && isAudio(e.name))) {
      const inner = await nestedBooksUnder(dir);
      if (inner.length > 0) nested.push({ outer: dir, inner });
      return; // don't descend into a book folder further
    }
    for (const e of entries) {
      if (e.isDirectory()) await walk(path.join(dir, e.name), depth + 1);
    }
  }

  async function nestedBooksUnder(dir: string): Promise<string[]> {
    const found: string[] = [];
    const stack = [dir];
    while (stack.length) {
      const current = stack.pop()!;
      const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const child = path.join(current, e.name);
        if (DISC_FOLDER_RE.test(e.name)) continue;
        if (await hasAudioFiles(child)) found.push(child);
        else stack.push(child);
      }
    }
    return found;
  }

  await walk(path.resolve(mediaDir), 0);
  return nested;
}
