/**
 * Component: Book Version Detection Utility
 * Documentation: documentation/features/watched-lists.md
 *
 * Groups different *versions* of the same book — e.g. the standard narration and a
 * dramatized adaptation, a full-cast production, an abridged cut, or a second
 * narrator's recording. This is coarser than deduplicate-audiobooks.ts, which only
 * collapses re-listings of the *same recording* (same narrator + duration).
 *
 * Work key: title with version markers stripped (in brackets or as a subtitle) but
 * the real subtitle kept, plus the primary author. So "Mistborn: The Final Empire"
 * and "Mistborn: The Final Empire (Dramatized Adaptation)" share a key, while
 * "Halo: The Fall of Reach" and "Halo: Ghosts of Onyx" do not.
 */

import type { AudibleAudiobook } from '../integrations/audible.service';

/** Words that mark a bracketed segment or subtitle as a version label, not part of the title. */
const VERSION_KEYWORD_RE =
  /dramati[sz](?:ed|ation)|full[\s-]*cast|\b(?:un)?abridged\b|\bedition\b|\bversion\b|audio[\s-]*drama|radio[\s-]*drama|graphic\s*audio/i;

/** Trailing descriptors like "A Novel" that some listings add and others omit. */
const TRAILING_DESCRIPTOR_RE = /\s*[-:,]?\s+a\s+(novel|memoir|thriller|mystery|romance|story|tale|novella)\s*$/i;

/** Subtitle separators: colon, or a spaced hyphen/en dash/em dash. */
const SUBTITLE_SPLIT_RE = /\s*:\s+|\s+[-–—]\s+/;

/** Versions that are intrinsically non-standard, in priority order. */
const ALTERNATE_MARKERS: { re: RegExp; label: string }[] = [
  { re: /dramati[sz](?:ed|ation)|audio[\s-]*drama|radio[\s-]*drama|graphic\s*audio/i, label: 'Dramatized Adaptation' },
  { re: /full[\s-]*cast/i, label: 'Full Cast' },
  { re: /\babridged\b/i, label: 'Abridged' }, // \b keeps "unabridged" from matching
];

type VersionInput = Pick<AudibleAudiobook, 'title' | 'author'> & Partial<Pick<AudibleAudiobook, 'narrator' | 'rating'>>;

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Primary author: the first name in a list like "A, B" / "A & B" / "A and B". */
function primaryAuthor(author: string): string {
  return normalizeText((author || '').split(/,|&|\band\b/i)[0] || '');
}

/**
 * Title with version markers removed: bracketed segments and subtitles that contain
 * a version keyword are dropped; a real subtitle is kept.
 */
export function stripVersionMarkers(title: string): string {
  let t = (title || '').replace(/[([][^)\]]*[)\]]/g, segment =>
    VERSION_KEYWORD_RE.test(segment) ? ' ' : segment
  );
  t = t.replace(TRAILING_DESCRIPTOR_RE, '');

  const parts = t.split(SUBTITLE_SPLIT_RE);
  const kept = [parts[0], ...parts.slice(1).filter(part => !VERSION_KEYWORD_RE.test(part))];
  return kept.join(': ').replace(/\s+/g, ' ').trim();
}

/** Key identifying the *work* (same book regardless of version). */
export function getWorkKey(book: Pick<VersionInput, 'title' | 'author'>): string {
  return `${normalizeText(stripVersionMarkers(book.title))}|${primaryAuthor(book.author)}`;
}

/**
 * Label for intrinsically non-standard versions ("Dramatized Adaptation", "Full Cast",
 * "Abridged"), from the title or — for full-cast productions — the narrator field.
 * Returns null for a standard narration.
 */
export function detectVersionMarker(book: Pick<VersionInput, 'title' | 'narrator'>): string | null {
  for (const marker of ALTERNATE_MARKERS) {
    if (marker.re.test(book.title || '')) return marker.label;
  }
  if (/full[\s-]*cast/i.test(book.narrator || '')) return 'Full Cast';
  return null;
}

export function isStandardVersion(book: Pick<VersionInput, 'title' | 'narrator'>): boolean {
  return detectVersionMarker(book) === null;
}

/**
 * Preferred version of a work: a standard narration first, then the highest rating,
 * then listing order.
 */
export function pickPreferredVersion<T extends VersionInput>(versions: T[]): T {
  return versions
    .map((book, index) => ({ book, index }))
    .sort((a, b) => {
      const standardDiff = Number(isStandardVersion(b.book)) - Number(isStandardVersion(a.book));
      if (standardDiff !== 0) return standardDiff;
      const ratingDiff = (b.book.rating ?? -1) - (a.book.rating ?? -1);
      if (ratingDiff !== 0) return ratingDiff;
      return a.index - b.index;
    })[0].book;
}

/**
 * Label distinguishing an alternate version from the preferred one: its intrinsic
 * marker if any, else its narrator, else a generic label.
 */
export function versionLabelFor(book: VersionInput, preferred: VersionInput): string {
  const marker = detectVersionMarker(book);
  if (marker) return marker;

  const narrator = (book.narrator || '').split(',')[0].trim();
  if (narrator && normalizeText(book.narrator || '') !== normalizeText(preferred.narrator || '')) {
    return `Narrated by ${narrator}`;
  }
  return 'Alternate Version';
}

/**
 * Apply an alternate-version label to import metadata so the library shows the
 * version as its own series and it can't share a folder with the main version:
 * - series → "Series (Label)"
 * - title  → "Title (Label)", unless the title already contains the label
 *   (e.g. "... (Dramatized Adaptation)")
 * Returns the metadata unchanged when there's no label.
 */
export function applyVersionLabel<T extends { title: string; series?: string }>(
  metadata: T,
  versionLabel?: string | null
): T {
  const label = versionLabel?.trim();
  if (!label) return metadata;

  const titleHasLabel = metadata.title.toLowerCase().includes(label.toLowerCase());
  return {
    ...metadata,
    title: titleHasLabel ? metadata.title : `${metadata.title} (${label})`,
    series: metadata.series ? `${metadata.series} (${label})` : metadata.series,
  };
}

/** Group books by work key, preserving first-appearance order. */
export function groupByWork<T extends VersionInput>(books: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const book of books) {
    const key = getWorkKey(book);
    const group = groups.get(key);
    if (group) group.push(book);
    else groups.set(key, [book]);
  }
  return groups;
}
