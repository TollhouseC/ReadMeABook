/**
 * Component: Series Book Number Guard Tests
 * Documentation: documentation/phase3/ranking-algorithm.md
 */

import { describe, expect, it } from 'vitest';
import { detectSeriesNumbers, filterWrongSeriesBook, parseSeriesPart, wrongSeriesBook } from '@/lib/utils/series-number';

const HWFWM = 'He Who Fights with Monsters';

describe('detectSeriesNumbers', () => {
  it('reads book numbers from common release formats', () => {
    expect(detectSeriesNumbers('Some Series Book 4 - Title').numbers).toEqual([4]);
    expect(detectSeriesNumbers('Title (Series #4.5)').numbers).toEqual([4.5]);
    expect(detectSeriesNumbers('Title Vol. 3 [M4B]').numbers).toEqual([3]);
    expect(detectSeriesNumbers('Title, Book Four').numbers).toEqual([4]);
    expect(detectSeriesNumbers('Empire of Silence (The Sun Eater, 1) [M4B] [128 Kbps]', 'Sun Eater').numbers).toEqual([1]);
    expect(detectSeriesNumbers('Christopher Ruocchio - Sun Eater 05 - Ashes of Man', 'The Sun Eater').numbers).toEqual([5]);
    expect(detectSeriesNumbers('He.Who.Fights.With.Monsters.Book.4.M4B').numbers).toEqual([4]);
  });

  it('reads ranges', () => {
    expect(detectSeriesNumbers('The Sun Eater Series Books 1-7 [M4B]').ranges).toEqual([[1, 7]]);
  });

  it('ignores bitrates, years, sizes, parts and audiobook words', () => {
    expect(detectSeriesNumbers('Sun Eater 2019 [64 Kbps] Part 2 Audiobook 1080', 'Sun Eater')).toEqual({ numbers: [], ranges: [] });
  });
});

describe('parseSeriesPart', () => {
  it('parses Audible positions', () => {
    expect(parseSeriesPart('1')).toBe(1);
    expect(parseSeriesPart('Book 2')).toBe(2);
    expect(parseSeriesPart('4.5')).toBe(4.5);
    expect(parseSeriesPart('1-3')).toBeNull();
    expect(parseSeriesPart(null)).toBeNull();
  });
});

describe('wrongSeriesBook', () => {
  const book1 = { title: `${HWFWM}: A LitRPG Adventure`, series: HWFWM, seriesPart: '1' };

  it('rejects the Book 4 release for a book 1 request (HWFwM)', () => {
    expect(wrongSeriesBook(
      `Shirtaloon, Travis Deverell - ${HWFWM} 4 A LitRPG Adventure (${HWFWM}, Book 4)`, book1
    )).toEqual([4]);
  });

  it('accepts the right book and releases without a number', () => {
    expect(wrongSeriesBook(`${HWFWM} (${HWFWM}, Book 1) - Shirtaloon`, book1)).toBeNull();
    expect(wrongSeriesBook(`${HWFWM} A LitRPG Adventure - Shirtaloon [M4B]`, book1)).toBeNull();
  });

  it('accepts a range that includes the book and rejects one that does not', () => {
    expect(wrongSeriesBook('Mistborn Books 1-3', { title: 'Mistborn', series: 'Mistborn', seriesPart: '2' })).toBeNull();
    expect(wrongSeriesBook('Mistborn Books 1-3', { title: 'The Lost Metal', series: 'Mistborn', seriesPart: '7' })).toEqual([1]);
  });

  it('ignores numbers that belong to the requested title', () => {
    expect(wrongSeriesBook('Binding 13 (Boys of Tommen #1)', { title: 'Binding 13', series: 'Boys of Tommen', seriesPart: '1' })).toBeNull();
    expect(wrongSeriesBook(`${HWFWM} 10 - Shirtaloon`, { title: `${HWFWM} 10`, series: HWFWM, seriesPart: '10' })).toBeNull();
    expect(wrongSeriesBook(`${HWFWM} 1 - Shirtaloon`, { title: `${HWFWM} 10`, series: HWFWM, seriesPart: '10' })).toEqual([1]);
  });

  it('never rejects when the request has no series position', () => {
    expect(wrongSeriesBook('Catch-22 Book 2', { title: 'Catch-22' })).toBeNull();
    expect(wrongSeriesBook('1984 (Book 1)', { title: '1984', seriesPart: null })).toBeNull();
  });

  it('filters a result list', () => {
    const { kept, removed } = filterWrongSeriesBook(
      [{ title: `${HWFWM} Book 4` }, { title: `${HWFWM} Book 1` }, { title: `${HWFWM} [M4B]` }],
      book1
    );
    expect(kept.map(r => r.title)).toEqual([`${HWFWM} Book 1`, `${HWFWM} [M4B]`]);
    expect(removed).toEqual([{ result: { title: `${HWFWM} Book 4` }, numbers: [4] }]);
  });
});
