/**
 * Component: Library Skip List
 * Documentation: documentation/backend/services/jobs.md
 *
 * Books the admin checked and decided to keep, left out of the library report jobs so the
 * monthly Health Report only shows new problems. Pasted as one text file in Settings →
 * Library (config key `library_skip_list`), one book per line:
 *   <folder as the report prints it, or asin:B0XXXX> | <checks: match,chapters,merge or all> | <note>
 * `#` starts a comment. A folder moved later (Library Organize) no longer matches, so the
 * book is reported again — the safe default.
 */

import path from 'path';
import { prisma } from '../db';

export const SKIP_LIST_KEY = 'library_skip_list';
export const SKIP_CHECKS = ['match', 'chapters', 'merge'] as const;
export type SkipCheck = (typeof SKIP_CHECKS)[number];

export interface SkipEntry {
  /** Normalised folder (relative to the library) or null for an ASIN entry */
  folder: string | null;
  asin: string | null;
  checks: Set<SkipCheck>;
  note: string;
  line: number;
}

export interface ParsedSkipList {
  entries: SkipEntry[];
  errors: string[];
}

/** "/Author/Series/Book/" and "Author\Series\Book" → "author/series/book" */
const normFolder = (p: string) => p.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/').toLowerCase();

export function parseSkipList(text: string): ParsedSkipList {
  const entries: SkipEntry[] = [];
  const errors: string[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const [target = '', checksText = '', ...noteParts] = line.split('|').map(s => s.trim());
    if (!target) {
      errors.push(`Line ${i + 1}: no folder or asin:`);
      return;
    }
    const words = checksText.toLowerCase().split(/[\s,]+/).filter(Boolean);
    const unknown = words.filter(w => w !== 'all' && !(SKIP_CHECKS as readonly string[]).includes(w));
    if (words.length === 0 || unknown.length > 0) {
      errors.push(`Line ${i + 1}: checks must be ${SKIP_CHECKS.join(', ')} or all${unknown.length ? ` (got "${unknown.join(', ')}")` : ''}`);
      return;
    }
    const asinMatch = target.match(/^asin:\s*([A-Z0-9]{10})$/i);
    entries.push({
      folder: asinMatch ? null : normFolder(target),
      asin: asinMatch ? asinMatch[1].toUpperCase() : null,
      checks: new Set(words.includes('all') ? SKIP_CHECKS : (words as SkipCheck[])),
      note: noteParts.join('|').trim(),
      line: i + 1,
    });
  });
  return { entries, errors };
}

export async function loadSkipListText(): Promise<string> {
  try {
    const row = await prisma.configuration.findUnique({ where: { key: SKIP_LIST_KEY } });
    return row?.value ?? '';
  } catch {
    return '';
  }
}

export async function saveSkipListText(text: string): Promise<ParsedSkipList> {
  const parsed = parseSkipList(text);
  await prisma.configuration.upsert({
    where: { key: SKIP_LIST_KEY },
    create: { key: SKIP_LIST_KEY, value: text, category: 'system', description: 'Books left out of the library report jobs (Settings → Library → Skip List)' },
    update: { value: text },
  });
  return parsed;
}

export interface SkipMatcher {
  /** The entry skipping this book for the check, if any */
  match(book: { relPath?: string | null; asin?: string | null }, check: SkipCheck): SkipEntry | null;
  size: number;
}

export function buildMatcher(entries: SkipEntry[]): SkipMatcher {
  return {
    size: entries.length,
    match(book, check) {
      const folder = book.relPath ? normFolder(book.relPath) : null;
      const asin = book.asin?.toUpperCase() ?? null;
      return entries.find(e => e.checks.has(check) && ((e.folder && e.folder === folder) || (e.asin && e.asin === asin))) ?? null;
    },
  };
}

export async function loadSkipMatcher(): Promise<SkipMatcher> {
  return buildMatcher(parseSkipList(await loadSkipListText()).entries);
}

/** A local book path → folder relative to the library (as the reports print it). */
export function relativeFolder(localPath: string | null | undefined, mediaDir: string): string | null {
  if (!localPath) return null;
  const rel = path.relative(mediaDir, localPath).split(path.sep).join('/');
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : null;
}

/** Skip-list identity of a library-job candidate (book folder, or the folder of a single file). */
export const candidateSkipInfo = (mediaDir: string) =>
  (c: { folder?: string; file?: string; asin?: string | null; title: string }) => ({
    relPath: relativeFolder(c.folder ?? (c.file ? path.dirname(c.file) : null), mediaDir),
    asin: c.asin,
    title: c.title,
  });

/**
 * Drop the books the skip list covers for this check; logs one line naming them.
 * Never throws — a broken list just skips nothing.
 */
export async function applySkipList<T>(
  books: T[],
  check: SkipCheck,
  describe: (book: T) => { relPath?: string | null; asin?: string | null; title: string },
  logger: { info: (msg: string) => unknown }
): Promise<{ kept: T[]; skipped: number }> {
  let matcher: SkipMatcher;
  try {
    matcher = await loadSkipMatcher();
  } catch {
    return { kept: books, skipped: 0 };
  }
  if (matcher.size === 0) return { kept: books, skipped: 0 };
  const kept: T[] = [];
  const names: string[] = [];
  for (const book of books) {
    const info = describe(book);
    if (matcher.match(info, check)) names.push(info.title);
    else kept.push(book);
  }
  if (names.length > 0) {
    await logger.info(`Skipped by your list (${names.length}): ${names.slice(0, 25).join(', ')}${names.length > 25 ? ', …' : ''}`);
  }
  return { kept, skipped: names.length };
}
