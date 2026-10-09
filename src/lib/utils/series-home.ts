/**
 * Component: Series Home (import placement)
 * Documentation: documentation/phase3/file-organization.md
 *
 * At import, put a book next to the rest of its series / author even when Audible spells
 * the author differently ("William H. Gass" vs folder "William Gass") or lists another
 * author combination ("Claire Kingsley, Lucy Score" for a series kept under "Lucy Score/").
 * Same rules as the Library Organize job, so imports and the job agree.
 */

import fs from 'fs/promises';
import path from 'path';
import { authorSetKey, seriesKey, sharesPerson } from './author-identity';

export interface LibraryHome {
  /** Existing author folder name to use for {author} */
  author: string;
  /** Existing series folder name to use for {series}, when the series already has one */
  series?: string;
}

async function subfolders(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return Array.isArray(entries) ? entries.filter(e => e.isDirectory()).map(e => e.name) : [];
  } catch {
    return [];
  }
}

/**
 * Existing author (and series) folder this book belongs in, or null to use the metadata as-is.
 * 1. A folder of an author on this book that already holds the series (most books wins).
 * 2. A folder for exactly these authors, spelled differently.
 */
export async function findLibraryHome(mediaDir: string, author: string, series?: string): Promise<LibraryHome | null> {
  if (!author?.trim()) return null;
  const authorDirs = (await subfolders(mediaDir)).filter(dir => sharesPerson(dir, author));
  if (authorDirs.length === 0) return null;

  const key = series?.trim() ? seriesKey(series) : '';
  if (key) {
    let best: { author: string; series: string; books: number } | null = null;
    for (const dir of authorDirs) {
      for (const sub of await subfolders(path.join(mediaDir, dir))) {
        if (seriesKey(sub) !== key) continue;
        const books = (await subfolders(path.join(mediaDir, dir, sub))).length;
        if (!best || books > best.books) best = { author: dir, series: sub, books };
      }
    }
    if (best) return { author: best.author, series: best.series };
  }

  const sameAuthors = authorDirs.filter(dir => authorSetKey(dir) === authorSetKey(author));
  if (sameAuthors.length === 0 || sameAuthors.includes(author.trim())) return null;
  // Prefer the "A, B" spelling over "A,B"
  const pick = [...sameAuthors].sort((a, b) => Number(/,\S/.test(a)) - Number(/,\S/.test(b)) || a.localeCompare(b))[0];
  return { author: pick };
}
