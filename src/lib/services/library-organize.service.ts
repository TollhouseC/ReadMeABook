/**
 * Component: Library Organize Planner
 * Documentation: documentation/phase3/file-organization.md
 *
 * Plans where each book folder belongs so one author / one series isn't split across
 * folders ("Travis Deverell Shirtaloon/…" vs "Shirtaloon, Travis Deverell/…",
 * "Lucy Score,Claire Kingsley/Bootleg Springs" vs "Claire Kingsley/Bootleg Springs").
 * Pure (no disk access) — the processor validates and performs the moves.
 *
 * Only two things change, never the book's own folder name:
 *   1. Author folder → one spelling per author (ReadMeABook's/Audible's when known).
 *      A series written by several author combinations goes under its lead author
 *      (the person on most of its books), so the series stays together.
 *   2. Series folder → added when missing, and one spelling per series (most common).
 * Alternate-version folders (Graphic Audio, dramatized, first drafts, "{…}") never move.
 */

import path from 'path';
import { substituteTemplate } from '../utils/path-template.util';
import { authorSetKey, parsePersons, seriesKey, sharesPerson, SpellingRegistry } from '../utils/author-identity';

export interface OrganizeBook {
  /** Current absolute book folder */
  folder: string;
  title: string;
  /** Best known author (ReadMeABook record → Audiobookshelf metadata); folder name if unknown */
  author?: string;
  series?: string;
  /** Alternate version (versionLabel) — never moved */
  alternate?: boolean;
}

export interface PlannedMove {
  from: string;
  to: string;
  title: string;
  reason: string;
}

export interface OrganizePlan {
  moves: PlannedMove[];
  /** Books looked at but left alone, with why (only the noteworthy ones) */
  skipped: Array<{ folder: string; title: string; reason: string }>;
  /** Already in place */
  inPlace: number;
}

export interface OrganizeOptions {
  mediaDir: string;
  /** Layout has a series level (template contains {series}) */
  useSeriesFolder: boolean;
  registry: SpellingRegistry;
}

const ALTERNATE_RE = /graphic\s*audio|dramati[sz](?:ed|ation)|full[\s-]*cast|first\s*drafts?|non[\s-]*canon|\{[^}]+\}/i;

const folderName = (value: string) => substituteTemplate('{author}', { author: value, title: '' });

interface Entry {
  book: OrganizeBook;
  parts: string[];
  author: string;
  seriesKey: string | null;
}

class UnionFind {
  private parent: number[];
  constructor(n: number) { this.parent = Array.from({ length: n }, (_, i) => i); }
  find(i: number): number { return this.parent[i] === i ? i : (this.parent[i] = this.find(this.parent[i])); }
  union(a: number, b: number): void { this.parent[this.find(a)] = this.find(b); }
}

/** The person on most of a group's books (ties: listed first more often, then alphabetical). */
function leadPerson(entries: Entry[], registry: SpellingRegistry): string {
  const tally = new Map<string, { count: number; first: number; spelling: string }>();
  for (const e of entries) {
    parsePersons(e.author).forEach((p, i) => {
      const t = tally.get(p.key) ?? { count: 0, first: 0, spelling: p.spelling };
      t.count++;
      if (i === 0) t.first++;
      tally.set(p.key, t);
    });
  }
  const [key, best] = [...tally.entries()].sort((a, b) =>
    b[1].count - a[1].count || b[1].first - a[1].first || a[0].localeCompare(b[0]))[0];
  return registry.person(key, best.spelling);
}

/** Most common existing spelling of the series folder in a group, else the metadata name. */
function seriesFolder(entries: Entry[]): string {
  const counts = new Map<string, number>();
  for (const e of entries) {
    const middle = e.parts.slice(1, -1);
    if (middle.length === 1 && seriesKey(middle[0]) === e.seriesKey) counts.set(middle[0], (counts.get(middle[0]) ?? 0) + 1);
  }
  if (counts.size === 0) {
    for (const e of entries) {
      const name = folderName(e.book.series!);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
}

export function planLibraryOrganize(books: OrganizeBook[], options: OrganizeOptions): OrganizePlan {
  const { mediaDir, useSeriesFolder, registry } = options;
  const plan: OrganizePlan = { moves: [], skipped: [], inPlace: 0 };

  const entries: Entry[] = [];
  for (const book of books) {
    const rel = path.relative(mediaDir, book.folder);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    const parts = rel.split(/[\\/]/).filter(Boolean);
    if (parts.length < 2) {
      plan.skipped.push({ folder: book.folder, title: book.title, reason: 'not inside an author folder' });
      continue;
    }
    if (book.alternate || parts.some(p => ALTERNATE_RE.test(p))) continue; // alternate versions stay put
    const author = book.author?.trim() || parts[0];
    // Metadata naming someone else (e.g. a wrong Audiobookshelf match) → don't trust it
    if (!sharesPerson(author, parts[0])) {
      plan.skipped.push({ folder: book.folder, title: book.title, reason: `metadata author "${author}" doesn't match folder "${parts[0]}" — check its match` });
      continue;
    }
    const sk = useSeriesFolder && book.series?.trim() ? seriesKey(book.series) : '';
    entries.push({ book, parts, author, seriesKey: sk || null });
  }

  // Series groups: same series name, connected by a shared author (Halo by different authors stays separate)
  const uf = new UnionFind(entries.length);
  const bySeries = new Map<string, number[]>();
  entries.forEach((e, i) => { if (e.seriesKey) bySeries.set(e.seriesKey, [...(bySeries.get(e.seriesKey) ?? []), i]); });
  for (const members of bySeries.values()) {
    for (let a = 0; a < members.length; a++) {
      for (let b = a + 1; b < members.length; b++) {
        if (sharesPerson(entries[members[a]].author, entries[members[b]].author)) uf.union(members[a], members[b]);
      }
    }
  }
  const groups = new Map<number, Entry[]>();
  entries.forEach((e, i) => { if (e.seriesKey) groups.set(uf.find(i), [...(groups.get(uf.find(i)) ?? []), e]); });

  const authorFolderFor = new Map<Entry, string>();
  const seriesFolderFor = new Map<Entry, string>();
  for (const group of groups.values()) {
    const mixedAuthors = new Set(group.map(e => authorSetKey(e.author))).size > 1;
    const lead = mixedAuthors ? folderName(leadPerson(group, registry)) : null;
    const series = seriesFolder(group);
    for (const e of group) {
      if (lead) authorFolderFor.set(e, lead);
      seriesFolderFor.set(e, series);
    }
  }

  const targets = new Map<string, string>();
  for (const e of entries) {
    const [current, ...rest] = e.parts;
    const leaf = rest[rest.length - 1];
    let middle = rest.slice(0, -1);
    const author = authorFolderFor.get(e) ?? folderName(registry.authorSet(e.author));
    const series = seriesFolderFor.get(e);
    if (series && (middle.length === 0 || (middle.length === 1 && seriesKey(middle[0]) === e.seriesKey))) middle = [series];

    const to = path.join(mediaDir, author, ...middle, leaf);
    if (path.resolve(to) === path.resolve(e.book.folder)) {
      plan.inPlace++;
      continue;
    }
    const relTo = path.relative(e.book.folder, to);
    if (!relTo.startsWith('..') || !path.relative(to, e.book.folder).startsWith('..')) {
      plan.skipped.push({ folder: e.book.folder, title: e.book.title, reason: `target "${to}" would nest it inside itself` });
      continue;
    }
    const taken = targets.get(path.resolve(to));
    if (taken) {
      plan.skipped.push({ folder: e.book.folder, title: e.book.title, reason: `"${taken}" already moves to "${to}"` });
      continue;
    }
    targets.set(path.resolve(to), e.book.folder);

    const reasons: string[] = [];
    if (author !== current) reasons.push(`author folder "${current}" → "${author}"`);
    const oldMiddle = rest.slice(0, -1);
    if (middle.join('/') !== oldMiddle.join('/')) {
      reasons.push(oldMiddle.length === 0 ? `add series folder "${middle.join('/')}"` : `series folder "${oldMiddle.join('/')}" → "${middle.join('/')}"`);
    }
    plan.moves.push({ from: e.book.folder, to, title: e.book.title, reason: reasons.join(', ') });
  }
  return plan;
}
