/**
 * Component: Pack Ranking (series / author packs)
 * Documentation: documentation/features/series-packs.md
 *
 * Pre-filters and ranks search results that look like multi-book packs. This is a
 * cheap first pass on titles only; every candidate is then verified against its real
 * file list (pack-matcher.ts) before anything is downloaded.
 *
 * Hard requirements:
 *   - audio (not ebook formats), >= 100 MB
 *   - the author's surname plus first name or first initial
 *   - series pack: every distinctive word of the series name, plus a pack signal
 *     ("complete", "collection", "box set", "omnibus", "trilogy", "books 1-7", "1-7",
 *     "all 7", "7 books") — or, when the book's length is known, a size of at least
 *     2.5x one book
 *   - author pack: a collection signal and >= 500 MB, without the series name
 */

import type { TorrentResult } from './ranking-algorithm';
import { tokenize } from './pack-matcher';

export type PackType = 'series' | 'author';

export interface PackCandidate {
  result: TorrentResult;
  packType: PackType;
  score: number;
  reasons: string[];
}

export interface PackRankingInput {
  seriesName: string;
  author: string;
  /** Length of the requested book, used to spot unlabelled packs by size */
  bookDurationMinutes?: number;
}

const MB = 1024 * 1024;
const MIN_PACK_BYTES = 100 * MB;
const MIN_AUTHOR_PACK_BYTES = 500 * MB;

/** Rough audiobook bitrate for size estimates (64 kbps ≈ 0.47 MB/min). */
const BYTES_PER_MINUTE = 0.47 * MB;

const SERIES_PACK_SIGNAL_RE =
  /\b(complete|collection|box\s*set|boxset|omnibus|anthology|trilogy|quartet|quintet|books?\s*\d+\s*(?:-|–|to|thru|through)\s*\d+|vol(?:ume)?s?\s*\d+\s*(?:-|–)\s*\d+|\d+\s*(?:-|–)\s*\d+|all\s+\d+|\d+\s+books)\b/i;

const AUTHOR_PACK_SIGNAL_RE =
  /\b(complete|collection|works|bibliography|library|omnibus|box\s*set|boxset|anthology|mega\s*pack|megapack|\d+\s+(?:audio\s*)?books|audiobooks)\b/i;

const EBOOK_RE = /\b(epub|mobi|azw3?|pdf|ebooks?|kindle)\b/i;

const GENERIC_SERIES_WORDS = new Set(['the', 'a', 'an', 'of', 'and', 'series', 'saga', 'trilogy', 'cycle', 'chronicles', 'books']);

function distinctiveSeriesTokens(seriesName: string): string[] {
  const tokens = tokenize(seriesName);
  const distinctive = tokens.filter(t => !GENERIC_SERIES_WORDS.has(t));
  return distinctive.length > 0 ? distinctive : tokens;
}

/** Surname plus first name or first initial ("Brandon Sanderson", "B. Sanderson", "Sanderson, Brandon"). */
export function hasAuthor(title: string, author: string): boolean {
  const primary = (author || '').split(/,|&|\band\b/i)[0];
  const authorTokens = tokenize(primary).filter(t => t.length > 1 || /^[a-z]$/.test(t));
  if (authorTokens.length === 0) return false;
  const titleTokens = new Set(tokenize(title));

  const surname = authorTokens[authorTokens.length - 1];
  if (!titleTokens.has(surname)) return false;
  if (authorTokens.length === 1) return true;

  const first = authorTokens[0];
  return titleTokens.has(first) || titleTokens.has(first[0]);
}

function hasAllTokens(title: string, tokens: string[]): boolean {
  const titleTokens = new Set(tokenize(title));
  return tokens.length > 0 && tokens.every(t => titleTokens.has(t));
}

/** Title with the series words removed, so a series named "... Trilogy" isn't its own signal. */
function withoutWords(title: string, words: string[]): string {
  let out = title.toLowerCase();
  for (const w of words) out = out.replace(new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), ' ');
  return out;
}

function baseScore(result: TorrentResult): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;

  const seeders = result.seeders ?? 0;
  score += Math.min(30, Math.log2(seeders + 1) * 6);
  reasons.push(`${seeders} seeders`);

  if (/\bcomplete\b/i.test(result.title)) { score += 10; reasons.push('complete'); }
  if (result.format === 'M4B' || /\bm4b\b/i.test(result.title)) { score += 5; reasons.push('m4b'); }
  if (result.flags?.some(f => /freeleech/i.test(f))) { score += 3; reasons.push('freeleech'); }

  return { score, reasons };
}

/**
 * Keep results that look like packs for this series/author, ranked best first.
 * Series packs rank above author packs.
 */
export function rankPackResults(results: TorrentResult[], input: PackRankingInput): PackCandidate[] {
  const seriesTokens = distinctiveSeriesTokens(input.seriesName);
  const expectedBookBytes = input.bookDurationMinutes ? input.bookDurationMinutes * BYTES_PER_MINUTE : undefined;
  const candidates: PackCandidate[] = [];

  for (const result of results) {
    const title = result.title || '';
    if (result.size < MIN_PACK_BYTES) continue;
    if (EBOOK_RE.test(title)) continue;
    if (!hasAuthor(title, input.author)) continue;

    const { score, reasons } = baseScore(result);

    if (hasAllTokens(title, seriesTokens)) {
      // Strip every series-name word (incl. "Trilogy"/"Saga") so "The Broken Earth
      // Trilogy Book 1" isn't mistaken for a pack; unlabelled packs are caught by size
      const signal = SERIES_PACK_SIGNAL_RE.exec(withoutWords(title, tokenize(input.seriesName)));
      const bigEnough = expectedBookBytes !== undefined && result.size >= expectedBookBytes * 2.5;
      if (!signal && !bigEnough) continue;

      candidates.push({
        result,
        packType: 'series',
        score: score + 20,
        reasons: ['series pack', signal ? `signal "${signal[0]}"` : 'size >= 2.5x one book', ...reasons],
      });
      continue;
    }

    const authorSignal = AUTHOR_PACK_SIGNAL_RE.exec(title);
    if (authorSignal && result.size >= MIN_AUTHOR_PACK_BYTES) {
      candidates.push({
        result,
        packType: 'author',
        score,
        reasons: ['author pack', `signal "${authorSignal[0]}"`, ...reasons],
      });
    }
  }

  return candidates.sort((a, b) =>
    a.packType !== b.packType ? (a.packType === 'series' ? -1 : 1) : b.score - a.score
  );
}
