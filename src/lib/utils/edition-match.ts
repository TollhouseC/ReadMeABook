/**
 * Component: Other-Edition Library Match
 * Documentation: documentation/integrations/audible.md
 *
 * Library availability is matched by ASIN, but Audible re-issues books under new ASINs
 * (Age of Myth: library B0161R0XBQ, 2016 Recorded Books; search B0DNLG5BW7, 2025 Audible
 * Studios). When a result's ASIN isn't in the library, this finds a library item with the
 * same title and a shared author — never across version types, so owning the standard
 * narration doesn't make a dramatized / full-cast / Graphic Audio / abridged edition count.
 */

import { prisma } from '../db';
import { sharesPerson } from './author-identity';

export interface LibraryEdition {
  asin: string | null;
  plexGuid: string;
  title: string;
  author: string;
}

const VERSION_PATTERNS: Array<[string, RegExp]> = [
  ['dramatized', /dramati[sz](?:ed|ation)/i],
  ['full cast', /full[\s-]*cast/i],
  ['graphic audio', /graphic\s*audio/i],
  ['abridged', /(?<!un)abridged/i],
];

/** Version type from a title ("[Dramatized Adaptation]" → dramatized); '' for a standard edition. */
export function versionType(title: string): string {
  return VERSION_PATTERNS.filter(([, re]) => re.test(title)).map(([name]) => name).join('+');
}

/** Title compared across editions: case, accents, punctuation, brackets, "Unabridged", leading article ignored. */
export function editionKey(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[[({][^\])}]*[\])}]/g, ' ')
    .replace(/\bunabridged\b/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/^(?:the|a|an)\s+/, '')
    .trim();
}

const CACHE_MS = 60_000;
let cache: { at: number; index: Map<string, LibraryEdition[]> } | null = null;

async function libraryIndex(): Promise<Map<string, LibraryEdition[]>> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.index;
  const rows = await prisma.plexLibrary.findMany({ select: { asin: true, plexGuid: true, title: true, author: true } });
  const index = new Map<string, LibraryEdition[]>();
  for (const row of rows ?? []) {
    const key = editionKey(row.title || '');
    if (!key) continue;
    index.set(key, [...(index.get(key) ?? []), { asin: row.asin, plexGuid: row.plexGuid, title: row.title, author: row.author || '' }]);
  }
  cache = { at: Date.now(), index };
  return index;
}

/** For tests */
export function clearEditionCache(): void {
  cache = null;
}

/** A library item that is another edition of this book, or null. */
export async function findOwnedEdition(book: { asin: string; title: string; author: string }): Promise<LibraryEdition | null> {
  const key = editionKey(book.title || '');
  if (!key || !book.author) return null;
  const candidates = (await libraryIndex()).get(key) ?? [];
  const version = versionType(book.title);
  return candidates.find(c =>
    c.asin?.toLowerCase() !== book.asin.toLowerCase()
    && versionType(c.title) === version
    && sharesPerson(c.author, book.author)) ?? null;
}
