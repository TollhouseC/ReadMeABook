/**
 * Component: Series Book Number Guard
 * Documentation: documentation/phase3/ranking-algorithm.md
 *
 * Detects which book of a series a release title names ("Book 4", "#4", "Vol. 4",
 * "(The Sun Eater, 2)", "He Who Fights with Monsters 4 …") so automatic search never grabs
 * a different book of the same series. Every HWFwM title ends in "A LitRPG Adventure", so
 * book 1's request picked the Book 4 release.
 *
 * - Titles without a book number pass.
 * - Ranges ("Books 1-7") pass when they include the requested book.
 * - Numbers that are part of the requested book's own title ("Binding 13", "Catch-22") are ignored.
 * - "Part 1/2" is never read as a book number (Audible sells some books in parts).
 */

export interface SeriesBookRef {
  /** Requested book title */
  title: string;
  series?: string | null;
  /** Audible series position ("1", "1.5", "Book 1") */
  seriesPart?: string | null;
}

export interface SeriesNumbers {
  numbers: number[];
  ranges: Array<[number, number]>;
}

const NUM = '(\\d{1,3}(?:\\.\\d+)?)(?![\\d])';
const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6,
  seventh: 7, eighth: 8, ninth: 9, tenth: 10,
};
const KEYWORD = '(?:books?|bk|vols?|volumes?|tome|band)';

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Lowercase; scene-style separators ("He.Who.Fights_Book.4") become spaces, decimals ("1.5") stay. */
function clean(text: string): string {
  return text.toLowerCase().replace(/_/g, ' ').replace(/(?<!\d)\.|\.(?!\d)/g, ' ');
}

function seriesPattern(series: string): RegExp | null {
  const words = clean(series).replace(/^the\s+/, '').split(/[^\p{L}\p{N}']+/u).filter(Boolean);
  if (words.length === 0) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}])${words.map(escapeRe).join("[\\s\\W_]+")}[\\s\\W_]+(?:${KEYWORD}[\\s\\W_]*|#\\s*)?${NUM}`, 'giu');
}

/** Book numbers a release title names. */
export function detectSeriesNumbers(title: string, series?: string | null): SeriesNumbers {
  const text = clean(title);
  const numbers: number[] = [];
  const ranges: Array<[number, number]> = [];

  const rangeRe = new RegExp(`(?:${KEYWORD}|#)\\s*${NUM}\\s*(?:-|–|to|thru|through|&)\\s*#?\\s*${NUM}`, 'gi');
  let withoutRanges = text;
  for (const m of text.matchAll(rangeRe)) {
    const a = parseFloat(m[1]);
    const b = parseFloat(m[2]);
    ranges.push([Math.min(a, b), Math.max(a, b)]);
    withoutRanges = withoutRanges.replace(m[0], ' ');
  }

  const patterns = [
    new RegExp(`(?<![\\p{L}])${KEYWORD}\\s*#?\\s*${NUM}`, 'giu'),
    new RegExp(`#\\s*${NUM}`, 'g'),
  ];
  const sp = series ? seriesPattern(series) : null;
  if (sp) patterns.push(sp);
  for (const re of patterns) {
    for (const m of withoutRanges.matchAll(re)) numbers.push(parseFloat(m[1]));
  }

  const wordRe = new RegExp(`(?<![\\p{L}])${KEYWORD}\\s+(${Object.keys(WORD_NUMBERS).join('|')})(?![\\p{L}])`, 'giu');
  for (const m of withoutRanges.matchAll(wordRe)) numbers.push(WORD_NUMBERS[m[1].toLowerCase()]);

  return { numbers: [...new Set(numbers)], ranges };
}

/** "1", "Book 1", "01", "1.5" → number; null when there's no usable position. */
export function parseSeriesPart(seriesPart?: string | null): number | null {
  if (!seriesPart || /\d\s*[-–]\s*\d/.test(seriesPart)) return null;
  const m = seriesPart.match(/\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

const same = (a: number, b: number) => Math.abs(a - b) < 0.001;

/**
 * The other book numbers a release names when it is a different book of the requested series;
 * null when it names the requested book, names no number, or the request has no position.
 */
export function wrongSeriesBook(releaseTitle: string, ref: SeriesBookRef): number[] | null {
  const part = parseSeriesPart(ref.seriesPart);
  if (part === null) return null;

  const { numbers, ranges } = detectSeriesNumbers(releaseTitle, ref.series);
  if (numbers.some(n => same(n, part)) || ranges.some(([a, b]) => part >= a && part <= b)) return null;

  const ownNumbers = (ref.title.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
  const others = numbers.filter(n => !ownNumbers.some(o => same(o, n)));
  if (others.length === 0 && ranges.length === 0) return null;
  return others.length > 0 ? others : ranges.map(([a]) => a);
}

/** Split results into those that may be the requested book and those naming another book. */
export function filterWrongSeriesBook<T extends { title: string }>(
  results: T[],
  ref: SeriesBookRef
): { kept: T[]; removed: Array<{ result: T; numbers: number[] }> } {
  const kept: T[] = [];
  const removed: Array<{ result: T; numbers: number[] }> = [];
  for (const result of results) {
    const numbers = wrongSeriesBook(result.title, ref);
    if (numbers) removed.push({ result, numbers });
    else kept.push(result);
  }
  return { kept, removed };
}
