/**
 * Component: Release Language Constants
 * Documentation: documentation/phase3/ranking-algorithm.md
 *
 * Shared by the release-language filter (server) and the Indexers settings UI (client).
 */

export const RELEASE_LANGUAGES = [
  'english', 'german', 'french', 'spanish', 'italian', 'dutch', 'portuguese',
  'polish', 'russian', 'swedish', 'danish', 'norwegian', 'finnish',
] as const;

export type ReleaseLanguage = (typeof RELEASE_LANGUAGES)[number];
export type RequiredLanguage = ReleaseLanguage | 'any';

export const DEFAULT_RELEASE_LANGUAGE: RequiredLanguage = 'english';

export function isRequiredLanguage(value: unknown): value is RequiredLanguage {
  return value === 'any' || (RELEASE_LANGUAGES as readonly string[]).includes(value as string);
}
