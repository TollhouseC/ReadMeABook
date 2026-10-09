/**
 * Component: Library Match Check (scoring)
 * Documentation: documentation/features/library-match.md
 *
 * Finds Audiobookshelf items matched to the wrong Audible book (fuzzy matches on old
 * imports) and picks the right one. Pure — the processor does the lookups.
 *
 * Suspect when: no ASIN; the audio length doesn't fit the matched book's Audible runtime;
 * the matched title doesn't fit the book's folder name; or one ASIN is on several
 * different books. Candidates (Audible search on the folder name + author folder) are
 * scored on title, author and length. Only a candidate agreeing on all three is applied.
 * When the folder names one book but the audio is the length of another, the files are
 * wrong (e.g. book 2's audio in book 3's folder) — reported, never re-matched.
 */

import path from 'path';
import { compareTwoStrings } from 'string-similarity';
import type { AudibleAudiobook } from '../integrations/audible.service';
import { parsePersons, sharesPerson } from '../utils/author-identity';

export interface MatchItem {
  /** Audiobookshelf item ID */
  id: string;
  /** Title Audiobookshelf shows (from the current match) */
  title: string;
  author: string;
  asin?: string;
  /** Audio length (seconds) */
  durationSec?: number;
  /** Path inside the library ("Author/Series/Book") */
  relPath: string;
  isFile: boolean;
}

export type SuspectReason = 'no_asin' | 'length' | 'title' | 'shared_asin';

export interface Suspect {
  item: MatchItem;
  reasons: SuspectReason[];
  folderTitle: string;
  folderAuthor: string;
  /** Audible runtime of the current match (minutes) */
  currentMinutes?: number;
}

export type LengthFit = 'ok' | 'close' | 'off' | 'unknown';

export interface ScoredCandidate {
  asin: string;
  title: string;
  author: string;
  minutes?: number;
  titleScore: number;
  authorOk: boolean;
  length: LengthFit;
  score: number;
}

export type MatchDecision =
  | { kind: 'ok' }
  | { kind: 'confident'; candidate: ScoredCandidate }
  | { kind: 'wrong_audio'; namedAs: ScoredCandidate; audioMatches: string }
  | { kind: 'unsure'; why: string; candidates: ScoredCandidate[] };

export const ALTERNATE_RE = /graphic\s*audio|dramati[sz](?:ed|ation)|full[\s-]*cast|first\s*drafts?|non[\s-]*canon|\babridged\b|\{[^}]+\}/i;
const TITLE_SUSPECT_BELOW = 0.6;
const TITLE_CONFIDENT = 0.8;

/** Book title and author folder from the library path. */
export function folderInfo(item: MatchItem): { folderTitle: string; folderAuthor: string } {
  const parts = item.relPath.split(/[\\/]/).filter(Boolean);
  const leaf = parts[parts.length - 1] ?? '';
  return {
    folderTitle: item.isFile ? path.basename(leaf, path.extname(leaf)) : leaf,
    folderAuthor: parts.length > 1 ? parts[0] : '',
  };
}

function normTitle(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[[({][^\])}]*[\])}]/g, ' ')
    .replace(/\bunabridged\b/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/^(?:the|a|an)\s+/, '')
    .trim();
}

/** "The Poppy War 03 - The Burning God" → also "The Burning God" */
function titleVariants(folderTitle: string): string[] {
  const variants = [folderTitle];
  const dash = folderTitle.lastIndexOf(' - ');
  if (dash > 0) variants.push(folderTitle.slice(dash + 3));
  return [...new Set(variants.map(normTitle).filter(Boolean))];
}

/** The part of a folder name to search Audible with. */
export function searchTitle(folderTitle: string): string {
  const dash = folderTitle.lastIndexOf(' - ');
  const base = dash > 0 && /\d/.test(folderTitle.slice(0, dash)) ? folderTitle.slice(dash + 3) : folderTitle;
  return base.replace(/[[({][^\])}]*[\])}]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function titleSimilarity(title: string, folderTitle: string): number {
  const a = normTitle(title);
  if (!a) return 0;
  let best = 0;
  for (const b of titleVariants(folderTitle)) {
    if (a === b) return 1;
    const [short, long] = a.length <= b.length ? [a, b] : [b, a];
    if (short.split(' ').length >= 2 && ` ${long} `.includes(` ${short} `)) best = Math.max(best, 0.9);
    best = Math.max(best, compareTwoStrings(a, b));
  }
  return best;
}

export function lengthFit(durationSec: number | undefined, minutes: number | undefined): LengthFit {
  if (!durationSec || !minutes) return 'unknown';
  const diff = Math.abs(durationSec / 60 - minutes);
  if (diff <= Math.max(5, minutes * 0.03)) return 'ok';
  if (diff > Math.max(10, minutes * 0.05)) return 'off';
  return 'close';
}

/** Items whose match looks wrong. `runtimes`: lowercase ASIN → Audible minutes. */
export function findSuspects(items: MatchItem[], runtimes: Map<string, number>): Suspect[] {
  const usable = items.filter(item => !ALTERNATE_RE.test(item.relPath));

  const byAsin = new Map<string, Set<string>>();
  for (const item of usable) {
    if (!item.asin) continue;
    const key = item.asin.toLowerCase();
    byAsin.set(key, (byAsin.get(key) ?? new Set()).add(titleVariants(folderInfo(item).folderTitle).pop() ?? ''));
  }

  const suspects: Suspect[] = [];
  for (const item of usable) {
    const { folderTitle, folderAuthor } = folderInfo(item);
    const reasons: SuspectReason[] = [];
    const currentMinutes = item.asin ? runtimes.get(item.asin.toLowerCase()) : undefined;
    if (!item.asin) reasons.push('no_asin');
    else {
      if (lengthFit(item.durationSec, currentMinutes) === 'off') reasons.push('length');
      if (titleSimilarity(item.title, folderTitle) < TITLE_SUSPECT_BELOW) reasons.push('title');
      if ((byAsin.get(item.asin.toLowerCase())?.size ?? 0) > 1) reasons.push('shared_asin');
    }
    if (reasons.length > 0) suspects.push({ item, reasons, folderTitle, folderAuthor, currentMinutes });
  }
  return suspects;
}

export function scoreCandidates(suspect: Suspect, results: AudibleAudiobook[]): ScoredCandidate[] {
  return results
    .filter(r => r.asin)
    .map(r => {
      const titleScore = titleSimilarity(r.title, suspect.folderTitle);
      const authorOk = !!suspect.folderAuthor && sharesPerson(r.author, suspect.folderAuthor);
      const length = lengthFit(suspect.item.durationSec, r.durationMinutes);
      const score = titleScore * 2 + (authorOk ? 1 : 0) + (length === 'ok' ? 1.5 : length === 'close' ? 0.5 : 0);
      return { asin: r.asin, title: r.title, author: r.author, minutes: r.durationMinutes, titleScore, authorOk, length, score };
    })
    .sort((a, b) => b.score - a.score);
}

export function decideMatch(suspect: Suspect, candidates: ScoredCandidate[]): MatchDecision {
  const current = suspect.item.asin?.toLowerCase();
  const named = candidates.find(c => c.titleScore >= TITLE_CONFIDENT && c.authorOk);

  if (named?.length === 'ok') {
    return named.asin.toLowerCase() === current ? { kind: 'ok' } : { kind: 'confident', candidate: named };
  }

  if (named) {
    // The folder names this book but the audio is another book's length
    const twin = candidates.find(c => c.authorOk && c.length === 'ok' && c.asin !== named.asin);
    if (twin) return { kind: 'wrong_audio', namedAs: named, audioMatches: twin.title };
    const currentFits = lengthFit(suspect.item.durationSec, suspect.currentMinutes) === 'ok';
    if (current && current !== named.asin.toLowerCase() && currentFits && titleSimilarity(suspect.item.title, suspect.folderTitle) < TITLE_SUSPECT_BELOW) {
      return { kind: 'wrong_audio', namedAs: named, audioMatches: suspect.item.title };
    }
    return { kind: 'unsure', why: `"${named.title}" fits the folder name but not the audio length (another edition?)`, candidates: candidates.slice(0, 3) };
  }

  return { kind: 'unsure', why: 'no Audible result fits the folder name and author', candidates: candidates.slice(0, 3) };
}

/** First author's name, for the Audible search query. */
export function searchAuthor(folderAuthor: string): string {
  return parsePersons(folderAuthor)[0]?.spelling ?? folderAuthor;
}

export const formatMinutes = (minutes?: number) =>
  minutes ? `${Math.floor(minutes / 60)}h ${Math.round(minutes % 60)}m` : '?';
