/**
 * Component: Pack Ranking Tests
 * Documentation: documentation/features/series-packs.md
 */

import { describe, expect, it } from 'vitest';
import { hasAuthor, rankPackResults } from '@/lib/utils/pack-ranking';
import type { TorrentResult } from '@/lib/utils/ranking-algorithm';

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

const result = (title: string, size = 5 * GB, seeders = 10): TorrentResult => ({
  indexer: 'ABB', title, size, seeders, publishDate: new Date(), downloadUrl: `http://x/${title}`, guid: title,
});

const INPUT = { seriesName: 'Mistborn', author: 'Brandon Sanderson' };

describe('hasAuthor', () => {
  it('accepts surname with first name or initial, in any order', () => {
    expect(hasAuthor('Brandon Sanderson - Mistborn', 'Brandon Sanderson')).toBe(true);
    expect(hasAuthor('Sanderson, Brandon - Mistborn', 'Brandon Sanderson')).toBe(true);
    expect(hasAuthor('B. Sanderson - Mistborn', 'Brandon Sanderson')).toBe(true);
  });

  it('rejects surname alone (common surnames appear in other titles)', () => {
    expect(hasAuthor('The King Collection', 'Stephen King')).toBe(false);
    expect(hasAuthor('Mistborn by Sanderson', 'Brandon Sanderson')).toBe(false);
  });
});

describe('rankPackResults', () => {
  it('keeps labelled series packs and ranks them above author packs', () => {
    const ranked = rankPackResults([
      result('Brandon Sanderson - Complete Audiobook Collection', 40 * GB),
      result('Brandon Sanderson - Mistborn Complete Series (Books 1-7) [M4B]'),
      result('Brandon Sanderson - Mistborn Trilogy'),
    ], INPUT);

    expect(ranked.map(c => [c.packType, c.result.title])).toEqual([
      ['series', 'Brandon Sanderson - Mistborn Complete Series (Books 1-7) [M4B]'],
      ['series', 'Brandon Sanderson - Mistborn Trilogy'],
      ['author', 'Brandon Sanderson - Complete Audiobook Collection'],
    ]);
  });

  it('rejects single-book releases of the series', () => {
    const ranked = rankPackResults([
      result('Brandon Sanderson - Mistborn Book 3 - The Hero of Ages', 700 * MB),
      result('Mistborn: The Final Empire - Brandon Sanderson [Unabridged]', 800 * MB),
    ], INPUT);

    expect(ranked).toHaveLength(0);
  });

  it('accepts an unlabelled release when it is far bigger than one book', () => {
    const ranked = rankPackResults(
      [result('Brandon Sanderson - Mistborn', 6 * GB)],
      { ...INPUT, bookDurationMinutes: 1500 } // ~0.7 GB for one book
    );

    expect(ranked).toHaveLength(1);
    expect(ranked[0].reasons).toContain('size >= 2.5x one book');
  });

  it('requires the author', () => {
    expect(rankPackResults([result('Mistborn Complete Series 1-7')], INPUT)).toHaveLength(0);
  });

  it('skips ebook packs and tiny results', () => {
    const ranked = rankPackResults([
      result('Brandon Sanderson - Mistborn Complete Series EPUB', 50 * MB),
      result('Brandon Sanderson - Mistborn Complete Series [epub mobi]', 2 * GB),
      result('Brandon Sanderson - Mistborn Complete', 50 * MB),
    ], INPUT);

    expect(ranked).toHaveLength(0);
  });

  it('does not treat the series name as its own pack signal', () => {
    const ranked = rankPackResults(
      [result('Brandon Sanderson - The Stormlight Archive Trilogy', 2 * GB)],
      { seriesName: 'Trilogy of Stormlight', author: 'Brandon Sanderson' }
    );
    // "trilogy" is part of the series name → not a signal; no other signal, no size info
    expect(ranked).toHaveLength(0);
  });

  it('needs a collection signal and real size for author packs', () => {
    const ranked = rankPackResults([
      result('Brandon Sanderson - Elantris', 800 * MB),
      result('Brandon Sanderson - Collection', 300 * MB),
      result('Brandon Sanderson - 25 Audiobooks', 30 * GB),
    ], INPUT);

    expect(ranked.map(c => c.result.title)).toEqual(['Brandon Sanderson - 25 Audiobooks']);
  });
});

describe('rankPackResults — release language', () => {
  it('drops packs tagged with another language', () => {
    const ranked = rankPackResults([
      result('Brandon Sanderson - Mistborn Complete Series (Hörbuch) [GER]'),
      result('Brandon Sanderson - Mistborn Complete Series [M4B]'),
    ], { ...INPUT, requiredLanguage: 'english' });
    expect(ranked.map(c => c.result.title)).toEqual(['Brandon Sanderson - Mistborn Complete Series [M4B]']);
  });
});
