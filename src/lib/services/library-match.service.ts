/**
 * Component: Library Match Check (scoring)
 * Documentation: documentation/features/library-match.md
 *
 * Finds Audiobookshelf items matched to the wrong Audible book (fuzzy matches on old
 * imports) and picks the right one. Pure — the processor does the lookups.
 *
 * Suspect when: no ASIN; the audio length doesn't fit the matched book's Audible runtime;
 * the matched title doesn't fit the book's folder name; or one ASIN is on several
 * different books. Candidates = Audible search results + the current match, limited to
 * the release language and without summaries/adaptations (unless the audio fits one
 * exactly). Books have several editions (narrations, abridged, re-recordings), so:
 *   - an edition of the folder's book whose length fits → re-match to it
 *   - right book, no edition fits but the length is close (±30–40%) → fine, another edition
 *   - right book, audio far shorter / longer → incomplete file / duplicate copies
 *   - folder names one book but the audio is exactly another's length → wrong audio
 */

import path from 'path';
import { compareTwoStrings } from 'string-similarity';
import type { AudibleAudiobook } from '../integrations/audible.service';
import { parsePersons, sharesPerson } from '../utils/author-identity';
import { matchesRequiredLanguage, type RequiredLanguage } from '../utils/release-language';

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
  /** Audible details of the current match */
  current?: AudibleAudiobook;
}

export type LengthFit = 'ok' | 'close' | 'off' | 'unknown';

export interface ScoredCandidate {
  asin: string;
  title: string;
  author: string;
  minutes?: number;
  language?: string;
  titleScore: number;
  authorOk: boolean;
  length: LengthFit;
  score: number;
}

export type MatchDecision =
  | { kind: 'ok' }
  | { kind: 'edition'; current: ScoredCandidate }
  | { kind: 'confident'; candidate: ScoredCandidate; why: string }
  | { kind: 'too_short' | 'too_long'; book: ScoredCandidate; ratio: number }
  | { kind: 'wrong_audio'; namedAs: ScoredCandidate; audioMatches: string }
  | { kind: 'unsure'; why: string; candidates: ScoredCandidate[] }
  | { kind: 'not_found'; candidates: ScoredCandidate[] };

export const ALTERNATE_RE = /graphic\s*audio|dramati[sz](?:ed|ation)|full[\s-]*cast|first\s*drafts?|non[\s-]*canon|\babridged\b|\{[^}]+\}/i;
/** Editions that aren't the book itself — only accepted when the folder says so or the audio fits exactly */
const NOT_THE_BOOK_RE = /\b(?:summary|summaries|guide|study|workbook|podcast|analysis|companion|adapted|illustrated|retold|abridged|dramati[sz](?:ed|ation)|full[\s-]*cast|graphic\s*audio|radio\s*(?:drama|play))\b/i;
const TRANSLATION_RE = /translator|übersetzer|traduct|tradutt|vertaler/i;
const TITLE_SUSPECT_BELOW = 0.6;
const TITLE_CONFIDENT = 0.8;
/** Audio vs a book's runtime: inside → another edition; outside → broken/duplicated file */
const EDITION_RATIO = { min: 0.7, max: 1.43 };
const TOO_SHORT_RATIO = 0.55;
const TOO_LONG_RATIO = 1.8;

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
  // Also the main title without a subtitle: "The Churn: An Expanse Novella" → "The Churn"
  const own = [...new Set([normTitle(title), normTitle(title.split(/[:(]/)[0])].filter(Boolean))];
  let best = 0;
  for (const a of own) {
    for (const b of titleVariants(folderTitle)) {
      if (a === b) return 1;
      const [short, long] = a.length <= b.length ? [a, b] : [b, a];
      if (short.split(' ').length >= 2 && ` ${long} `.includes(` ${short} `)) best = Math.max(best, 0.9);
      best = Math.max(best, compareTwoStrings(a, b));
    }
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

/** Same recording: within max(2 min, 0.5%). */
const exactLength = (durationSec: number | undefined, minutes: number | undefined) =>
  !!durationSec && !!minutes && Math.abs(durationSec / 60 - minutes) <= Math.max(2, minutes * 0.005);

/** Items whose match looks wrong. `products`: lowercase ASIN → Audible details of the current match. */
export function findSuspects(items: MatchItem[], products: Map<string, AudibleAudiobook>): Suspect[] {
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
    const current = item.asin ? products.get(item.asin.toLowerCase()) : undefined;
    if (!item.asin) reasons.push('no_asin');
    else {
      if (lengthFit(item.durationSec, current?.durationMinutes) === 'off') reasons.push('length');
      if (titleSimilarity(item.title, folderTitle) < TITLE_SUSPECT_BELOW) reasons.push('title');
      if ((byAsin.get(item.asin.toLowerCase())?.size ?? 0) > 1) reasons.push('shared_asin');
    }
    if (reasons.length > 0) suspects.push({ item, reasons, folderTitle, folderAuthor, current });
  }
  return suspects;
}

function inLanguage(r: AudibleAudiobook, language: RequiredLanguage, folderTitle: string): boolean {
  if (language === 'any') return true;
  if (TRANSLATION_RE.test(r.author)) return false;
  if (r.language) return r.language.toLowerCase() === language;
  return matchesRequiredLanguage({ title: r.title }, language, folderTitle);
}

/** Scored candidates (search results + the current match), in the release language, real editions only. */
export function scoreCandidates(suspect: Suspect, results: AudibleAudiobook[], language: RequiredLanguage = 'english'): ScoredCandidate[] {
  const all = suspect.current && !results.some(r => r.asin === suspect.current!.asin) ? [suspect.current, ...results] : results;
  const folderIsSpecial = NOT_THE_BOOK_RE.test(suspect.folderTitle);
  return all
    .filter(r => r.asin && inLanguage(r, language, suspect.folderTitle))
    .filter(r => folderIsSpecial || !NOT_THE_BOOK_RE.test(r.title) || exactLength(suspect.item.durationSec, r.durationMinutes))
    .map(r => {
      const titleScore = titleSimilarity(r.title, suspect.folderTitle);
      const authorOk = !!suspect.folderAuthor && sharesPerson(r.author, suspect.folderAuthor);
      const length = lengthFit(suspect.item.durationSec, r.durationMinutes);
      const score = titleScore * 2 + (authorOk ? 1 : 0) + (length === 'ok' ? 1.5 : length === 'close' ? 0.5 : 0);
      return { asin: r.asin, title: r.title, author: r.author, minutes: r.durationMinutes, language: r.language, titleScore, authorOk, length, score };
    })
    .sort((a, b) => b.score - a.score);
}

export function decideMatch(suspect: Suspect, candidates: ScoredCandidate[], language: RequiredLanguage = 'english'): MatchDecision {
  const sec = suspect.item.durationSec;
  const currentAsin = suspect.item.asin?.toLowerCase();
  const audioMin = sec ? sec / 60 : undefined;
  const closeness = (c: ScoredCandidate) => (audioMin && c.minutes ? Math.abs(audioMin - c.minutes) / c.minutes : 1);

  // Editions of the folder's book, best length fit first
  const named = candidates.filter(c => c.titleScore >= TITLE_CONFIDENT && c.authorOk).sort((a, b) => closeness(a) - closeness(b));
  const current = candidates.find(c => c.asin.toLowerCase() === currentAsin);
  const currentNamed = current && named.includes(current) ? current : undefined;
  const currentForeign = !!suspect.current && !inLanguage(suspect.current, language, suspect.folderTitle);

  const fitting = named.find(c => c.length === 'ok');
  if (fitting) {
    if (fitting === currentNamed) return { kind: 'ok' };
    const why = currentForeign ? 'current match is another-language edition'
      : currentNamed ? 'an edition whose length fits the audio'
      : 'the folder\'s book (current match is a different book)';
    return { kind: 'confident', candidate: fitting, why };
  }

  // Wrong audio: the audio is exactly another book's length — unless it also fits an
  // edition range of the folder's own book (a coincidence with a sibling, e.g. Alcatraz/Bastille)
  if (named.length > 0) {
    const twin = candidates.find(c => c.authorOk && !named.includes(c) && exactLength(sec, c.minutes));
    if (twin) {
      const ownRatio = audioMin && named[0].minutes ? audioMin / named[0].minutes : 0;
      // Audiobookshelf itself thinks it's the other book → trust the wrong-audio verdict
      const absAgrees = twin.asin.toLowerCase() === currentAsin || titleSimilarity(suspect.item.title, suspect.folderTitle) < TITLE_SUSPECT_BELOW;
      if (!absAgrees && ownRatio >= EDITION_RATIO.min && ownRatio <= EDITION_RATIO.max) {
        return { kind: 'unsure', why: `the audio fits an edition of "${named[0].title}" but is exactly the length of "${twin.title}" — another edition, or the wrong book?`, candidates: [named[0], twin] };
      }
      return { kind: 'wrong_audio', namedAs: named[0], audioMatches: twin.title };
    }
    if (current && !currentNamed && exactLength(sec, current.minutes) && titleSimilarity(suspect.item.title, suspect.folderTitle) < TITLE_SUSPECT_BELOW) {
      return { kind: 'wrong_audio', namedAs: named[0], audioMatches: current.title };
    }
  }

  const book = currentNamed && !currentForeign ? currentNamed : named[0];
  if (!book) return { kind: 'not_found', candidates: candidates.slice(0, 3) };
  if (currentForeign) return { kind: 'confident', candidate: book, why: 'current match is another-language edition' };
  const needsRematch = book !== currentNamed;
  if (!audioMin || !book.minutes) {
    return needsRematch ? { kind: 'confident', candidate: book, why: 'the folder\'s book (audio length unknown)' } : { kind: 'ok' };
  }

  const ratio = audioMin / book.minutes;
  if (ratio <= TOO_SHORT_RATIO) return { kind: 'too_short', book, ratio };
  if (ratio >= TOO_LONG_RATIO) return { kind: 'too_long', book, ratio };
  if (ratio >= EDITION_RATIO.min && ratio <= EDITION_RATIO.max) {
    return needsRematch
      ? { kind: 'confident', candidate: book, why: currentForeign ? 'current match is another-language edition' : 'the folder\'s book, closest edition' }
      : { kind: 'edition', current: book };
  }
  return { kind: 'unsure', why: `"${book.title}" fits the folder name but the audio is ${Math.round(ratio * 100)}% of its length`, candidates: named.slice(0, 3) };
}

/** Exactly double / half (±4%) — a bad length header, a broken file or doubled content. */
export const isDoubleOrHalf = (ratio: number) => Math.abs(ratio - 2) <= 0.08 || Math.abs(ratio - 0.5) <= 0.02;

export interface ChapterMark {
  title: string;
  startMs: number;
  endMs: number;
}

export type ChapterPattern =
  | { kind: 'books'; parts: Array<{ title: string; startMs: number }> }
  | { kind: 'repeat'; atMs: number; title: string };

const chapterNumber = (title: string): number | null => {
  const m = title.match(/(\d+)\s*$/);
  return m ? parseInt(m[1], 10) : null;
};

/**
 * What an over-long file's chapters say: a few very long chapters = several books in one file
 * (a box set); numbering that starts over = the same book twice.
 */
export function analyzeChapters(chapters: ChapterMark[], bookMinutes: number): ChapterPattern | null {
  if (chapters.length >= 2 && chapters.length <= 12) {
    const shortest = Math.min(...chapters.map(c => c.endMs - c.startMs));
    if (shortest >= bookMinutes * 60_000 * 0.5) return { kind: 'books', parts: chapters.map(c => ({ title: c.title, startMs: c.startMs })) };
  }
  for (let i = 2; i < chapters.length; i++) {
    const prev = chapterNumber(chapters[i - 1].title);
    const cur = chapterNumber(chapters[i].title);
    const titleRepeats = chapters[i].title === chapters[0].title;
    if (titleRepeats || (prev !== null && cur !== null && cur <= 1 && prev >= 5)) {
      return { kind: 'repeat', atMs: chapters[i].startMs, title: chapters[i].title };
    }
  }
  return null;
}

export const formatClock = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/** First author's name, for the Audible search query. */
export function searchAuthor(folderAuthor: string): string {
  return parsePersons(folderAuthor)[0]?.spelling ?? folderAuthor;
}

export const formatMinutes = (minutes?: number) =>
  minutes ? `${Math.floor(minutes / 60)}h ${Math.round(minutes % 60)}m` : '?';
