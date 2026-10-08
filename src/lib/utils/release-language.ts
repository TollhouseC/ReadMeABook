/**
 * Component: Release Language Detection & Filter
 * Documentation: documentation/phase3/ranking-algorithm.md
 *
 * Detects a release's language from indexer metadata (Prowlarr `languages`, when sent)
 * or title markers, and filters results to the configured `release_language`
 * (default English). Unknown language = allowed: most English releases carry no tag.
 *
 * English language names are common words in real titles ("The German Girl",
 * "Russian Doll"), so they only count when bracketed or in a phrase like
 * "German Edition". Native names (deutsch, español), audiobook words (hörbuch,
 * luisterboek) and bracketed codes ([GER], (ITA)) count anywhere. A marker that also
 * appears in the requested book's own title is ignored.
 */

import {
  DEFAULT_RELEASE_LANGUAGE,
  RELEASE_LANGUAGES,
  isRequiredLanguage,
  type ReleaseLanguage,
  type RequiredLanguage,
} from '../constants/release-languages';

export { DEFAULT_RELEASE_LANGUAGE, RELEASE_LANGUAGES, isRequiredLanguage };
export type { ReleaseLanguage, RequiredLanguage };

/** Non-English but unidentified (e.g. CJK/Cyrillic script, shared words like "audiolibro"). */
export type DetectedLanguage = ReleaseLanguage | 'other';

interface LanguageMarkers {
  /** English name — only counts when bracketed or followed by edition/version/audiobook/etc. */
  name: string;
  /** Distinctive words/phrases that count anywhere. */
  words: string[];
  /** Codes that count only when bracketed: [GER], (de). */
  codes: string[];
}

const MARKERS: Record<ReleaseLanguage, LanguageMarkers> = {
  english: { name: 'english', words: [], codes: ['eng', 'en'] },
  german: { name: 'german', words: ['deutsch', 'deutsche', 'hörbuch', 'hoerbuch', 'hörspiel', 'hoerspiel', 'ungekürzt', 'ungekuerzt', 'gekürzt', 'gelesen von'], codes: ['ger', 'deu', 'de'] },
  french: { name: 'french', words: ['français', 'francais', 'livre audio', 'lu par'], codes: ['fr', 'fre', 'fra', 'vf', 'vff'] },
  spanish: { name: 'spanish', words: ['español', 'espanol', 'castellano', 'leído por'], codes: ['es', 'esp', 'spa'] },
  italian: { name: 'italian', words: ['italiano', 'letto da'], codes: ['it', 'ita'] },
  dutch: { name: 'dutch', words: ['nederlands', 'luisterboek', 'voorgelezen door'], codes: ['nl', 'dut', 'nld'] },
  portuguese: { name: 'portuguese', words: ['português', 'portugues', 'audiolivro', 'pt-br'], codes: ['pt', 'por', 'ptbr'] },
  polish: { name: 'polish', words: ['polski', 'czyta'], codes: ['pl', 'pol'] },
  russian: { name: 'russian', words: ['русский', 'аудиокнига'], codes: ['ru', 'rus'] },
  swedish: { name: 'swedish', words: ['svenska', 'ljudbok'], codes: ['sv', 'swe'] },
  danish: { name: 'danish', words: ['dansk', 'lydbog'], codes: ['da', 'dan'] },
  norwegian: { name: 'norwegian', words: ['norsk', 'lydbok'], codes: ['no', 'nor'] },
  finnish: { name: 'finnish', words: ['suomi', 'äänikirja'], codes: ['fi', 'fin'] },
};

/** Words shared by several non-English languages. */
const AMBIGUOUS_FOREIGN_WORDS = ['audiolibro', 'narrado por'];
/** Cyrillic, Greek, Arabic, Hebrew, CJK, Hangul, Thai scripts. */
const NON_LATIN_SCRIPT_RE = /[Ͱ-ϿЀ-ӿ֐-ۿ฀-๿぀-ヿ㐀-鿿가-힯]/;

const NAME_CONTEXT = '(?:edition|version|audiobook|audio\\s*book|audio|dub|dubbed|language|narration)';

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const bounded = (pattern: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${pattern})(?![\\p{L}\\p{N}])`, 'iu');

const COMPILED = (Object.entries(MARKERS) as [ReleaseLanguage, LanguageMarkers][]).map(([language, m]) => ({
  language,
  codes: m.codes,
  patterns: [
    // "[German]", "(English)", "German Edition", "in German"
    bounded(`[\\[(]\\s*${m.name}\\s*[\\])]|${m.name}\\s+${NAME_CONTEXT}|in\\s+${m.name}`),
    ...(m.words.length ? [bounded(m.words.map(escapeRe).join('|'))] : []),
  ],
}));

/**
 * Language codes from brackets that contain nothing but codes: "[GER]", "(ENG/GER)", "[ita]".
 * Two-letter codes must be uppercase so "(It Ends with Us)" or "[Sci-Fi]" don't match.
 */
function bracketedCodes(text: string): Set<string> {
  const codes = new Set<string>();
  for (const [, inner] of text.matchAll(/[[(]([^\])]{1,30})[\])]/g)) {
    const tokens = inner.trim().split(/[\s/,|&+-]+/).filter(Boolean);
    if (tokens.length === 0 || tokens.length > 4) continue;
    const valid = tokens.every(t => /^[A-Z]{2}$/.test(t) || /^[a-z]{3,4}$/i.test(t));
    if (valid) tokens.forEach(t => codes.add(t.toLowerCase()));
  }
  return codes;
}
const AMBIGUOUS_RE = bounded(AMBIGUOUS_FOREIGN_WORDS.map(escapeRe).join('|'));

function fromIndexerLanguages(languages?: unknown[]): DetectedLanguage | null {
  if (!Array.isArray(languages) || languages.length === 0) return null;
  const names = languages
    .map(l => (typeof l === 'string' ? l : (l as { name?: string })?.name))
    .filter((n): n is string => !!n)
    .map(n => n.toLowerCase().trim());
  if (names.length === 0 || names.includes('unknown')) return null;
  if (names.includes('english')) return 'english';
  return (RELEASE_LANGUAGES as readonly string[]).includes(names[0]) ? (names[0] as ReleaseLanguage) : 'other';
}

/**
 * Detected language of a release, or null when nothing indicates one.
 * A release tagged with English plus another language counts as English.
 */
export function detectReleaseLanguage(
  title: string,
  options: { bookTitle?: string; languages?: unknown[] } = {}
): DetectedLanguage | null {
  const fromIndexer = fromIndexerLanguages(options.languages);
  if (fromIndexer) return fromIndexer;

  const bookTitle = options.bookTitle || '';
  const matches = (re: RegExp) => re.test(title) && !re.test(bookTitle);

  const titleCodes = bracketedCodes(title);
  const bookCodes = bracketedCodes(bookTitle);
  const found = COMPILED
    .filter(({ patterns, codes }) =>
      patterns.some(matches) || codes.some(code => titleCodes.has(code) && !bookCodes.has(code)))
    .map(c => c.language);
  if (found.includes('english')) return 'english';
  if (found.length > 0) return found[0];
  if (matches(AMBIGUOUS_RE)) return 'other';
  if (NON_LATIN_SCRIPT_RE.test(title) && !NON_LATIN_SCRIPT_RE.test(bookTitle)) return 'other';
  return null;
}

/** True when a release should be kept for the required language. */
export function matchesRequiredLanguage(
  release: { title: string; languages?: unknown[] },
  required: RequiredLanguage | undefined,
  bookTitle?: string
): boolean {
  if (!required || required === 'any') return true;
  const detected = detectReleaseLanguage(release.title, { bookTitle, languages: release.languages });
  if (detected === null || detected === required) return true;
  // 'other' (unidentified non-English) only rules a release out when English is required
  return detected === 'other' ? required !== 'english' : false;
}

export function filterByLanguage<T extends { title: string; languages?: unknown[] }>(
  results: T[],
  required: RequiredLanguage | undefined,
  bookTitle?: string
): { kept: T[]; removed: T[] } {
  const kept: T[] = [];
  const removed: T[] = [];
  for (const result of results) {
    (matchesRequiredLanguage(result, required, bookTitle) ? kept : removed).push(result);
  }
  return { kept, removed };
}

/** Configured release language (`release_language`), default English. */
export async function getRequiredReleaseLanguage(): Promise<RequiredLanguage> {
  try {
    const { getConfigService } = await import('../services/config.service');
    const value = await getConfigService().get('release_language');
    return isRequiredLanguage(value) ? value : DEFAULT_RELEASE_LANGUAGE;
  } catch {
    return DEFAULT_RELEASE_LANGUAGE;
  }
}
