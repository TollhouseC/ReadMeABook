/**
 * Component: Author Identity
 * Documentation: documentation/phase3/file-organization.md
 *
 * Decides when two author strings / folder names are the same people, so one author
 * doesn't end up split across folders:
 *   "Shirtaloon, Travis Deverell" = "Travis Deverell Shirtaloon"   (Last, First)
 *   "Lucy Score,Claire Kingsley"  = "Claire Kingsley, Lucy Score"  (order, comma spacing)
 *   "William H. Gass"             = "William Gass"                 (initials)
 * A person is identified by the set of their name words (lowercase, accents and
 * punctuation removed, single-letter initials dropped).
 */

export interface Person {
  /** Sorted name words — equal keys = same person */
  key: string;
  /** As written */
  spelling: string;
}

const PERSON_SPLIT = /\s*(?:;|&|\band\b|,)\s*/i;

function nameWords(name: string): string[] {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.'’]/g, ' ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(w => w.length > 1);
}

const keyOf = (words: string[]) => [...new Set(words)].sort().join(' ');

/**
 * People in an author string. "Last, First" (two comma parts, the first a single word)
 * is one person; otherwise commas, "&", "and" and ";" separate people.
 */
export function parsePersons(author: string): Person[] {
  // Audible roles: "George R. R. Martin - editor", "Pedro Jorge Romero - translator"
  const text = (author || '').replace(/\s+[-–]\s+[^,;&]*/g, '').trim();
  if (!text) return [];
  const parts = text.split(PERSON_SPLIT).map(p => p.trim()).filter(Boolean);
  const commaParts = text.split(',').map(p => p.trim()).filter(Boolean);
  if (commaParts.length === 2 && !/[;&]|\band\b/i.test(text) && nameWords(commaParts[0]).length === 1) {
    return [{ key: keyOf(nameWords(text)), spelling: text }];
  }
  return parts
    .map(spelling => ({ key: keyOf(nameWords(spelling)), spelling }))
    .filter(p => p.key.length > 0);
}

/** Key for a whole author string: the same set of people in any order and spelling. */
export function authorSetKey(author: string): string {
  return [...new Set(parsePersons(author).map(p => p.key))].sort().join(' | ');
}

/** Do two author strings share at least one person? */
export function sharesPerson(a: string, b: string): boolean {
  const keys = new Set(parsePersons(a).map(p => p.key));
  return parsePersons(b).some(p => keys.has(p.key));
}

/** Series names compared loosely: "The Sun Eater" = "Sun Eater" = "sun-eater". */
export function seriesKey(series: string): string {
  return nameWords(series.replace(/^\s*the\s+/i, '')).join(' ');
}

/**
 * Picks one spelling per person / author set. ReadMeABook's own records (Audible) win, so
 * the library matches what new imports produce; otherwise the most common spelling.
 */
export class SpellingRegistry {
  private persons = new Map<string, Map<string, number>>();
  private sets = new Map<string, Map<string, number>>();

  add(author: string | null | undefined, weight = 1): void {
    if (!author?.trim()) return;
    const bump = (map: Map<string, Map<string, number>>, key: string, spelling: string) => {
      const counts = map.get(key) ?? new Map<string, number>();
      counts.set(spelling, (counts.get(spelling) ?? 0) + weight);
      map.set(key, counts);
    };
    for (const p of parsePersons(author)) bump(this.persons, p.key, p.spelling);
    bump(this.sets, authorSetKey(author), author.trim());
  }

  private static best(counts?: Map<string, number>): string | undefined {
    if (!counts) return undefined;
    // Highest weight; ties → the spelling with ", " separators, then alphabetical
    return [...counts.entries()].sort((a, b) =>
      b[1] - a[1] || Number(/,\S/.test(a[0])) - Number(/,\S/.test(b[0])) || a[0].localeCompare(b[0]))[0][0];
  }

  person(key: string, fallback: string): string {
    return SpellingRegistry.best(this.persons.get(key)) ?? fallback;
  }

  /** Canonical spelling of a whole author string (keeps its people, normalises spelling/order). */
  authorSet(author: string): string {
    const known = SpellingRegistry.best(this.sets.get(authorSetKey(author)));
    if (known && !/,\S/.test(known)) return known;
    return parsePersons(known ?? author).map(p => this.person(p.key, p.spelling)).join(', ');
  }
}
