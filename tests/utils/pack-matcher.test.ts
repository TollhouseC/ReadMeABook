/**
 * Component: Pack Matcher Tests
 * Documentation: documentation/features/series-packs.md
 */

import { describe, expect, it } from 'vitest';
import { matchPackFiles, tokenize, type PackFile, type PackSeriesBook } from '@/lib/utils/pack-matcher';

const MB = 1024 * 1024;
let nextIndex = 0;
const file = (name: string, size = 60 * MB): PackFile => ({ name, size, index: nextIndex++ });

const MISTBORN: PackSeriesBook[] = [
  { asin: 'B01', title: 'Mistborn: The Final Empire', position: '1' },
  { asin: 'B02', title: 'The Well of Ascension', position: '2' },
  { asin: 'B03', title: 'The Hero of Ages', position: '3' },
  { asin: 'B04', title: 'The Alloy of Law', position: '4' },
];

function byAsin(result: ReturnType<typeof matchPackFiles>) {
  return Object.fromEntries(result.matches.map(m => [m.asin, m]));
}

describe('tokenize', () => {
  it('normalizes case, punctuation, apostrophes, ampersands, numbers and diacritics', () => {
    expect(tokenize("The Sorcerer's Stone & More")).toEqual(['the', 'sorcerers', 'stone', 'and', 'more']);
    expect(tokenize('Book05 - Vol. II')).toEqual(['book', '5', 'vol', '2']);
    expect(tokenize('Book Three, Part 2.5')).toEqual(['book', '3', 'part', '2.5']);
    expect(tokenize('Café Érudit')).toEqual(['cafe', 'erudit']);
  });
});

describe('matchPackFiles — series packs', () => {
  it('matches numbered book folders that drop the series prefix and "The"', () => {
    const result = matchPackFiles([
      file('Mistborn Complete Series/01 - Final Empire/01 - Chapter 1.mp3'),
      file('Mistborn Complete Series/01 - Final Empire/02 - Chapter 2.mp3'),
      file('Mistborn Complete Series/02 - Well of Ascension/01.mp3'),
      file('Mistborn Complete Series/03 - Hero of Ages/01.mp3'),
      file('Mistborn Complete Series/cover.jpg', 1 * MB),
    ], MISTBORN, { mode: 'series', seriesName: 'Mistborn' });

    const m = byAsin(result);
    expect(result.rootFolder).toBe('Mistborn Complete Series');
    expect(m.B01.relativePaths).toEqual(['01 - Final Empire/01 - Chapter 1.mp3', '01 - Final Empire/02 - Chapter 2.mp3']);
    expect(m.B02.relativePaths).toEqual(['02 - Well of Ascension/01.mp3']);
    expect(m.B03.matchedBy).toBe('title');
    expect(m.B04).toBeUndefined(); // not in the pack
  });

  it('assigns chapter files to their folder\'s book, not to book 1 by chapter number', () => {
    const result = matchPackFiles([
      file('Pack/Book 3 - The Hero of Ages/01 Chapter 1.mp3'),
      file('Pack/Book 3 - The Hero of Ages/02 Chapter 2.mp3'),
    ], MISTBORN, { mode: 'series', seriesName: 'Mistborn' });

    expect(Object.keys(byAsin(result))).toEqual(['B03']);
  });

  it('walks past disc subfolders to the book folder', () => {
    const result = matchPackFiles([
      file('Pack/The Well of Ascension/Disc 1/Track 01.mp3'),
      file('Pack/The Well of Ascension/Disc 2/Track 01.mp3'),
    ], MISTBORN, { mode: 'series', seriesName: 'Mistborn' });

    expect(byAsin(result).B02.files).toHaveLength(2);
  });

  it('matches single-file books by file name', () => {
    const result = matchPackFiles([
      file('Mistborn Era 1/Mistborn 1 - The Final Empire.m4b', 500 * MB),
      file('Mistborn Era 1/Mistborn 2 - The Well of Ascension.m4b', 500 * MB),
    ], MISTBORN, { mode: 'series', seriesName: 'Mistborn' });

    expect(Object.keys(byAsin(result)).sort()).toEqual(['B01', 'B02']);
  });

  it('matches by explicit position with the series name or a book keyword', () => {
    const result = matchPackFiles([
      file('Pack/Mistborn 04/part1.mp3'),
      file('Pack/Book 3/part1.mp3'),
    ], MISTBORN, { mode: 'series', seriesName: 'Mistborn' });

    const m = byAsin(result);
    expect(m.B04.matchedBy).toBe('position');
    expect(m.B03.matchedBy).toBe('position');
  });

  it('never matches a bare number (could be a chapter, track, or year)', () => {
    const result = matchPackFiles([
      file('Pack/02/01.mp3'),
      file('Pack/Chapter 03/01.mp3'),
    ], MISTBORN, { mode: 'series', seriesName: 'Mistborn' });

    expect(result.matches).toHaveLength(0);
    expect(result.unmatchedAudioFiles).toHaveLength(2);
  });

  it('prefers a title match over a position match', () => {
    // "Book 1" position points at book 1, but the title is book 2's
    const result = matchPackFiles([
      file('Pack/Book 1 - The Well of Ascension/01.mp3'),
    ], MISTBORN, { mode: 'series', seriesName: 'Mistborn' });

    expect(Object.keys(byAsin(result))).toEqual(['B02']);
  });

  it('tolerates typos, roman numerals, "&"/"and" and possessives', () => {
    const books: PackSeriesBook[] = [
      { asin: 'H1', title: "Harry Potter and the Sorcerer's Stone", position: '1' },
      { asin: 'S2', title: 'Shadows & Bone Part Two', position: '2' },
      { asin: 'W3', title: 'The Well of Ascension', position: '3' },
    ];
    const result = matchPackFiles([
      file('Pack/Harry Potter 1 - Sorcerers Stone/01.mp3'),
      file('Pack/Shadows and Bone Part II/01.mp3'),
      file('Pack/Well of Accension/01.mp3'), // one-letter typo
    ], books, { mode: 'series', seriesName: 'Mixed' });

    expect(Object.keys(byAsin(result)).sort()).toEqual(['H1', 'S2', 'W3']);
  });

  it('handles a book titled after its series without swallowing the sequels', () => {
    const dune: PackSeriesBook[] = [
      { asin: 'D1', title: 'Dune', position: '1' },
      { asin: 'D2', title: 'Dune Messiah', position: '2' },
      { asin: 'D3', title: 'Children of Dune', position: '3' },
    ];
    const result = matchPackFiles([
      file('Dune Chronicles/01 Dune/a.mp3'),
      file('Dune Chronicles/02 Dune Messiah/a.mp3'),
      file('Dune Chronicles/03 Children of Dune/a.mp3'),
    ], dune, { mode: 'series', seriesName: 'Dune' });

    const m = byAsin(result);
    expect(m.D1.relativePaths).toEqual(['01 Dune/a.mp3']);
    expect(m.D2.relativePaths).toEqual(['02 Dune Messiah/a.mp3']);
    expect(m.D3.relativePaths).toEqual(['03 Children of Dune/a.mp3']);
  });

  it('keeps books that share a series prefix apart by subtitle', () => {
    const halo: PackSeriesBook[] = [
      { asin: 'H1', title: 'Halo: The Fall of Reach', position: '1' },
      { asin: 'H3', title: 'Halo: Ghosts of Onyx', position: '3' },
    ];
    const result = matchPackFiles([
      file('Halo Collection/Halo - Ghosts of Onyx/01.mp3'),
      file('Halo Collection/Halo - The Fall of Reach/01.mp3'),
    ], halo, { mode: 'series', seriesName: 'Halo' });

    const m = byAsin(result);
    expect(m.H1.relativePaths).toEqual(['Halo - The Fall of Reach/01.mp3']);
    expect(m.H3.relativePaths).toEqual(['Halo - Ghosts of Onyx/01.mp3']);
  });

  it('drops implausibly small matches (samples, intros)', () => {
    const result = matchPackFiles([
      file('Pack/The Hero of Ages - Sample.mp3', 2 * MB),
    ], MISTBORN, { mode: 'series', seriesName: 'Mistborn' });

    expect(result.matches).toHaveLength(0);
    expect(result.unmatchedAudioFiles).toHaveLength(1);
  });

  it('works without a shared root folder', () => {
    const result = matchPackFiles([
      file('01 - Final Empire/a.mp3'),
      file('02 - Well of Ascension/a.mp3'),
    ], MISTBORN, { mode: 'series', seriesName: 'Mistborn' });

    expect(result.rootFolder).toBeNull();
    expect(byAsin(result).B01.relativePaths).toEqual(['01 - Final Empire/a.mp3']);
  });
});

describe('matchPackFiles — author packs', () => {
  const authorPack = [
    file('Brandon Sanderson Collection/Mistborn 1 - The Final Empire/a.mp3'),
    file('Brandon Sanderson Collection/Mistborn 2 - The Well of Ascension/a.mp3'),
    file('Brandon Sanderson Collection/Elantris/a.mp3'),
    file('Brandon Sanderson Collection/Stormlight 01 - The Way of Kings/a.mp3'),
    file('Brandon Sanderson Collection/Stormlight 02 - Words of Radiance/a.mp3'),
  ];

  it('only matches books from the requested series', () => {
    const result = matchPackFiles(authorPack, MISTBORN, { mode: 'author', seriesName: 'Mistborn' });

    expect(Object.keys(byAsin(result)).sort()).toEqual(['B01', 'B02']);
    expect(result.unmatchedAudioFiles.map(f => f.name)).toEqual([
      'Brandon Sanderson Collection/Elantris/a.mp3',
      'Brandon Sanderson Collection/Stormlight 01 - The Way of Kings/a.mp3',
      'Brandon Sanderson Collection/Stormlight 02 - Words of Radiance/a.mp3',
    ]);
  });

  it('never matches by position alone (positions repeat across an author\'s series)', () => {
    const result = matchPackFiles([
      file('Collection/Book 2/a.mp3'),
      file('Collection/Mistborn 03/a.mp3'),
    ], MISTBORN, { mode: 'author', seriesName: 'Mistborn' });

    expect(result.matches).toHaveLength(0);
  });
});
