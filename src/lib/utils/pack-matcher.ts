/**
 * Component: Pack Matcher (series / author packs)
 * Documentation: documentation/features/series-packs.md
 *
 * Maps the files of a multi-book torrent (a series or author pack) to the books of
 * a series. Pure — works on the torrent's file list, before anything is downloaded.
 *
 * For each audio file, every path component (file name, then each parent folder up
 * to — but not including — the torrent's root folder) is a candidate name. Each
 * candidate is compared to each series book with fuzzy title matching:
 *   - case, punctuation, diacritics, "&"/"and", apostrophes ignored
 *   - articles and filler words ignored ("the", "a", "of", ...), so a folder without
 *     "The" still matches
 *   - number words / roman numerals / leading zeros normalized ("One", "II", "01")
 *   - small typos tolerated on long words (one edit), plurals tolerated
 *   - folders that drop the series prefix still match ("01 - The Final Empire" →
 *     "Mistborn: The Final Empire")
 * A title match needs >= 80% of the title's words. Title matches always beat
 * position matches. Series packs may also match by explicit position ("Mistborn 05",
 * "Book 5") — never by a bare number, which could be a chapter or track. Author packs
 * are title-only (positions repeat across an author's series).
 */

import { AUDIO_EXTENSIONS } from '../constants/audio-formats';
import { stripVersionMarkers } from './book-versions';

export interface PackSeriesBook {
  asin: string;
  title: string;
  /** Series position, e.g. "1", "2.5" */
  position?: string;
}

export interface PackFile {
  /** Path as reported by the torrent client, including the root folder if any */
  name: string;
  size: number;
  /** Torrent file index (for setting file priorities) */
  index: number;
}

export interface PackBookMatch {
  asin: string;
  title: string;
  position?: string;
  /** Audio files belonging to this book */
  files: PackFile[];
  /** File paths relative to the torrent's content root — pass as organize selectedFiles */
  relativePaths: string[];
  totalSize: number;
  matchedBy: 'title' | 'position';
}

export interface PackMatchResult {
  matches: PackBookMatch[];
  /** Audio files that matched no series book (not downloaded, not imported) */
  unmatchedAudioFiles: PackFile[];
  /** Root folder shared by every file (stripped from relativePaths), if any */
  rootFolder: string | null;
}

export interface PackMatchOptions {
  mode: 'series' | 'author';
  seriesName?: string;
}

/** Minimum share of a title's words that must appear in a candidate name. */
export const TITLE_MATCH_THRESHOLD = 0.8;

/** A matched book smaller than this is almost certainly not an audiobook (sample, intro). */
const MIN_BOOK_BYTES = 10 * 1024 * 1024;

const STOPWORDS = new Set(['the', 'a', 'an', 'and', 'of', 'to', 'in', 'on', 'by', 'for']);

/** Words that carry no identity on their own (series/book scaffolding, audio noise). */
const GENERIC_WORDS = new Set([
  'book', 'books', 'volume', 'vol', 'part', 'pt', 'series', 'saga', 'novel', 'novella',
  'audiobook', 'audio', 'unabridged', 'abridged', 'edition', 'complete', 'collection',
  'chapter', 'chap', 'ch', 'disc', 'disk', 'cd', 'track', 'mp3', 'm4b', 'm4a', 'flac', 'kbps',
]);

/** Numbers after these words are chapters/tracks/discs — never a series position. */
const NON_POSITION_PREFIX_RE = /\b(?:chapter|chap|ch|track|trk|disc|disk|cd|part|pt)\s*\.?\s*$/;

const NUMBER_WORDS: Record<string, string> = {
  one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
  ten: '10', eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15',
  sixteen: '16', seventeen: '17', eighteen: '18', nineteen: '19', twenty: '20',
  first: '1', second: '2', third: '3', fourth: '4', fifth: '5', sixth: '6', seventh: '7', eighth: '8', ninth: '9', tenth: '10',
};

// Multi-letter roman numerals only — single "i"/"v"/"x" are too ambiguous
const ROMAN_NUMERALS: Record<string, string> = {
  ii: '2', iii: '3', iv: '4', vi: '6', vii: '7', viii: '8', ix: '9', xi: '11', xii: '12',
  xiii: '13', xiv: '14', xv: '15', xvi: '16', xvii: '17', xviii: '18', xix: '19', xx: '20',
};

const AUDIO_EXTENSION_SET = new Set<string>(AUDIO_EXTENSIONS);

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/** Fuzzy-normalized tokens of a name. */
export function tokenize(text: string): string[] {
  return (text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/['’‘`]/g, '') // "Sorcerer's" → "sorcerers"
    .replace(/&/g, ' and ')
    .replace(/([a-z])(\d)/g, '$1 $2') // "book05" → "book 05"
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/[^a-z0-9.]+/g, ' ')
    .replace(/(?<!\d)\.|\.(?!\d)/g, ' ') // keep decimals like 2.5, drop other dots
    .split(/\s+/)
    .filter(Boolean)
    .map(token => {
      if (NUMBER_WORDS[token]) return NUMBER_WORDS[token];
      if (ROMAN_NUMERALS[token]) return ROMAN_NUMERALS[token];
      if (/^\d+(\.\d+)?$/.test(token)) return String(Number(token)); // "05" → "5", "2.50" → "2.5"
      return token;
    });
}

function contentTokens(text: string): string[] {
  return tokenize(text).filter(t => !STOPWORDS.has(t));
}

function editDistanceAtMostOne(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const numeric = /^\d/.test(a) || /^\d/.test(b);
  if (numeric) return false; // numbers must match exactly
  if (a + 's' === b || b + 's' === a) return true; // plural
  return a.length >= 6 && b.length >= 6 && editDistanceAtMostOne(a, b);
}

// ---------------------------------------------------------------------------
// Title matching
// ---------------------------------------------------------------------------

interface TitleVariant {
  tokens: string[];
}

/**
 * Title variants a folder might use: the full title, the part after the series
 * prefix ("Mistborn: The Final Empire" → "Final Empire"), and the title minus the
 * series name. Variants made only of series/generic words are dropped (they'd match
 * every book), unless that's all the title has (a book named after its series).
 */
function titleVariants(title: string, seriesTokens: Set<string>): TitleVariant[] {
  const base = stripVersionMarkers(title);
  const parts = base.split(/\s*:\s+|\s+[-–—]\s+/);

  const candidates: string[][] = [contentTokens(base)];
  if (parts.length > 1) {
    candidates.push(contentTokens(parts.slice(1).join(' ')));
    candidates.push(contentTokens(parts[0]));
  }
  candidates.push(contentTokens(base).filter(t => !seriesTokens.has(t)));

  const isDistinctive = (tokens: string[]) =>
    tokens.some(t => !seriesTokens.has(t) && !GENERIC_WORDS.has(t) && !/^\d/.test(t));

  const seen = new Set<string>();
  const variants: TitleVariant[] = [];
  for (const tokens of candidates) {
    const key = tokens.join(' ');
    if (!tokens.length || seen.has(key) || !isDistinctive(tokens)) continue;
    seen.add(key);
    variants.push({ tokens });
  }

  // Book titled after its series (e.g. "Dune" in the Dune series): keep the full title
  if (variants.length === 0 && candidates[0].length > 0) {
    variants.push({ tokens: candidates[0] });
  }
  return variants;
}

interface TitleScore {
  coverage: number;
  matchedTokens: number;
}

function scoreTitle(candidateTokens: string[], variants: TitleVariant[]): TitleScore {
  let best: TitleScore = { coverage: 0, matchedTokens: 0 };
  for (const variant of variants) {
    const matched = variant.tokens.filter(vt => candidateTokens.some(ct => tokensMatch(vt, ct))).length;
    const coverage = matched / variant.tokens.length;
    if (coverage > best.coverage || (coverage === best.coverage && matched > best.matchedTokens)) {
      best = { coverage, matchedTokens: matched };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Position matching
// ---------------------------------------------------------------------------

/**
 * Explicit series positions in a name: "Book 5", "Vol. 5", "#5", "No 5", or a leading
 * number ("05 - Title", "5. Title"). Numbers after chapter/track/disc/part are ignored.
 * `keyword` is true when a book/vol/# marker was present.
 */
function extractPositions(name: string): { positions: Set<string>; hasKeyword: boolean } {
  const lower = name.toLowerCase();
  const positions = new Set<string>();
  let hasKeyword = false;

  for (const m of lower.matchAll(/\b(?:book|bk|volume|vol|no|number|episode|ep)\s*\.?\s*#?\s*(\d+(?:\.\d+)?)|#\s*(\d+(?:\.\d+)?)/g)) {
    positions.add(String(Number(m[1] ?? m[2])));
    hasKeyword = true;
  }

  const leading = lower.match(/^\s*[[(]?\s*(\d{1,3}(?:\.\d+)?)\s*[\])]?\s*(?:[-._)]|\s)/);
  if (leading && !NON_POSITION_PREFIX_RE.test(lower.slice(0, leading.index ?? 0))) {
    positions.add(String(Number(leading[1])));
  }

  // "Mistborn 05" style: a number right after the series words, handled by caller via
  // hasSeriesName + trailing number
  const trailing = lower.match(/(?:^|\s)(\d{1,3}(?:\.\d+)?)\s*$/);
  if (trailing) {
    const before = lower.slice(0, trailing.index ?? 0);
    if (!NON_POSITION_PREFIX_RE.test(before)) positions.add(String(Number(trailing[1])));
  }

  return { positions, hasKeyword };
}

// ---------------------------------------------------------------------------
// Main matcher
// ---------------------------------------------------------------------------

interface CandidateMatch {
  book: PackSeriesBook;
  kind: 'title' | 'position';
  coverage: number;
  matchedTokens: number;
  depth: number; // 0 = file name, 1 = parent folder, ...
}

function isAudio(name: string): boolean {
  const dot = name.lastIndexOf('.');
  return dot >= 0 && AUDIO_EXTENSION_SET.has(name.slice(dot).toLowerCase());
}

function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

function betterMatch(a: CandidateMatch | null, b: CandidateMatch): boolean {
  if (!a) return true;
  if (a.kind !== b.kind) return b.kind === 'title'; // title beats position
  if (b.coverage !== a.coverage) return b.coverage > a.coverage;
  if (b.matchedTokens !== a.matchedTokens) return b.matchedTokens > a.matchedTokens; // more specific
  return b.depth < a.depth; // nearer component wins
}

/**
 * Match a torrent's files to the books of a series.
 */
export function matchPackFiles(
  files: PackFile[],
  books: PackSeriesBook[],
  options: PackMatchOptions
): PackMatchResult {
  const seriesTokens = new Set(contentTokens(options.seriesName || ''));
  const bookVariants = books.map(book => ({ book, variants: titleVariants(book.title, seriesTokens) }));

  const splitPaths = files.map(f => f.name.replace(/\\/g, '/').split('/').filter(Boolean));
  const firstComponents = new Set(splitPaths.map(parts => (parts.length > 1 ? parts[0] : null)));
  const rootFolder = firstComponents.size === 1 && !firstComponents.has(null)
    ? [...firstComponents][0]
    : null;

  const byAsin = new Map<string, PackBookMatch>();
  const unmatchedAudioFiles: PackFile[] = [];

  files.forEach((file, i) => {
    if (!isAudio(file.name)) return;

    const parts = rootFolder ? splitPaths[i].slice(1) : splitPaths[i];
    // Candidates: file name (depth 0), then each parent folder, nearest first
    const candidates = parts
      .map((part, idx) => (idx === parts.length - 1 ? stripExtension(part) : part))
      .reverse();

    let best: CandidateMatch | null = null;

    candidates.forEach((candidate, depth) => {
      const candidateTokens = tokenize(candidate);
      const hasSeriesName = seriesTokens.size > 0 &&
        [...seriesTokens].every(st => candidateTokens.some(ct => tokensMatch(st, ct)));
      const { positions, hasKeyword } = extractPositions(candidate);

      for (const { book, variants } of bookVariants) {
        const { coverage, matchedTokens } = scoreTitle(candidateTokens, variants);

        if (coverage >= TITLE_MATCH_THRESHOLD) {
          const match: CandidateMatch = { book, kind: 'title', coverage, matchedTokens, depth };
          if (betterMatch(best, match)) best = match;
          continue;
        }

        // Position-only: series packs only, and only with an explicit marker — the
        // series name ("Mistborn 05") or a book keyword ("Book 5") — never a bare number
        if (
          options.mode === 'series' &&
          book.position &&
          positions.has(String(Number(book.position))) &&
          (hasSeriesName || hasKeyword)
        ) {
          const match: CandidateMatch = { book, kind: 'position', coverage, matchedTokens, depth };
          if (betterMatch(best, match)) best = match;
        }
      }
    });

    if (!best) {
      unmatchedAudioFiles.push(file);
      return;
    }

    const chosen: CandidateMatch = best;
    const entry = byAsin.get(chosen.book.asin) ?? {
      asin: chosen.book.asin,
      title: chosen.book.title,
      position: chosen.book.position,
      files: [],
      relativePaths: [],
      totalSize: 0,
      matchedBy: chosen.kind,
    };
    entry.files.push(file);
    entry.relativePaths.push(parts.join('/'));
    entry.totalSize += file.size;
    if (chosen.kind === 'title') entry.matchedBy = 'title';
    byAsin.set(chosen.book.asin, entry);
  });

  // Drop implausibly small "books" (samples, intros) back to unmatched
  const matches: PackBookMatch[] = [];
  for (const match of byAsin.values()) {
    if (match.totalSize < MIN_BOOK_BYTES) {
      unmatchedAudioFiles.push(...match.files);
    } else {
      matches.push(match);
    }
  }

  return { matches, unmatchedAudioFiles, rootFolder };
}
