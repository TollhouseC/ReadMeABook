/**
 * Component: Release Date Parser Tests
 * Documentation: documentation/features/watched-lists.md
 */

import { describe, expect, it } from 'vitest';
import { parseLegacyReleaseDate } from '@/lib/utils/parse-release-date';

describe('parseLegacyReleaseDate', () => {
  it('parses unambiguous legacy dates in either order', () => {
    expect(parseLegacyReleaseDate('Release date: 10-14-26')).toBe('2026-10-14'); // MM-DD-YY
    expect(parseLegacyReleaseDate('Release date: 14-10-26')).toBe('2026-10-14'); // DD-MM-YY
    expect(parseLegacyReleaseDate('Erscheinungsdatum: 25.12.2026')).toBe('2026-12-25');
    expect(parseLegacyReleaseDate('2026-03-05')).toBe('2026-03-05');
    expect(parseLegacyReleaseDate('Release date: 03-03-27')).toBe('2027-03-03');
  });

  it('refuses to guess ambiguous or missing dates', () => {
    expect(parseLegacyReleaseDate('Release date: 03-04-27')).toBeUndefined();
    expect(parseLegacyReleaseDate('')).toBeUndefined();
    expect(parseLegacyReleaseDate(undefined)).toBeUndefined();
  });
});
