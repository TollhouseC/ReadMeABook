/**
 * Component: Library Match Check Scoring Tests
 * Documentation: documentation/features/library-match.md
 */

import { describe, expect, it } from 'vitest';
import {
  decideMatch, findSuspects, lengthFit, scoreCandidates, searchTitle, titleSimilarity, type MatchItem, type Suspect,
} from '@/lib/services/library-match.service';

const item = (over: Partial<MatchItem>): MatchItem => ({ id: 'li', title: '', author: '', relPath: '', isFile: false, ...over });
const H = 3600;

const poppy2 = item({ id: 'p2', title: 'The Dragon Republic', author: 'R. F. Kuang', asin: 'B0DR', durationSec: 23.78 * H, relPath: 'R. F. Kuang/The Poppy War/The Poppy War 02 - The Dragon Republic' });
const poppy3 = item({ id: 'p3', title: 'The Dragon Republic', author: 'R. F. Kuang', asin: 'B0DR', durationSec: 23.78 * H, relPath: 'R. F. Kuang/The Poppy War/The Poppy War 03 - The Burning God' });

describe('title and length helpers', () => {
  it('matches titles despite punctuation, series prefixes and subtitles', () => {
    expect(titleSimilarity('He Who Fights with Monsters 11: A LitRPG Adventure', 'He Who Fights with Monsters 11 A LitRPG Adventure')).toBe(1);
    expect(titleSimilarity('The Burning God', 'The Poppy War 03 - The Burning God')).toBe(1);
    expect(titleSimilarity('Halo: The Thursday War', 'Halo The Thursday War')).toBe(1);
    expect(titleSimilarity('Wild Cards I', 'Wild Cards 27 - Knaves over Queens')).toBeLessThan(0.6);
    expect(searchTitle('The Poppy War 03 - The Burning God')).toBe('The Burning God');
    expect(searchTitle('Elin Hilderbrand - Golden Girl [Unabridged]')).toBe('Elin Hilderbrand - Golden Girl');
  });

  it('grades lengths', () => {
    expect(lengthFit(600 * 60, 603)).toBe('ok');
    expect(lengthFit(600 * 60, 625)).toBe('close');
    expect(lengthFit(600 * 60, 700)).toBe('off');
    expect(lengthFit(undefined, 600)).toBe('unknown');
  });
});

describe('findSuspects', () => {
  it('flags wrong titles, shared ASINs, bad lengths and missing ASINs — not good matches or alternates', () => {
    const runtimes = new Map([['b0dr', 1427], ['b0hw11', 1579], ['b0wci', 1140], ['b0er', 450]]);
    const suspects = findSuspects([
      poppy2,
      poppy3,
      item({ id: 'hw11', title: 'He Who Fights with Monsters 11: A LitRPG Adventure', asin: 'B0HW11', durationSec: 26.33 * H, relPath: 'Travis Deverell Shirtaloon/He Who Fights with Monsters/He Who Fights with Monsters 11 A LitRPG Adventure' }),
      item({ id: 'er', title: 'Equal Rites', asin: 'B0ER', durationSec: 4.43 * H, relPath: 'Terry Pratchett/Discworld/The Last Hero' }),
      item({ id: 'none', title: 'Mystery', relPath: 'Someone/Mystery' }),
      item({ id: 'ga', title: 'The Well of Ascension', asin: 'B0WOA', durationSec: 21 * H, relPath: 'Brandon Sanderson/Mistborn {Graphic Audio}/The Well of Ascension' }),
    ], runtimes);

    const byId = Object.fromEntries(suspects.map(s => [s.item.id, s.reasons]));
    expect(byId.p2).toEqual(['shared_asin']);
    expect(byId.p3).toEqual(['title', 'shared_asin']);
    expect(byId.hw11).toBeUndefined();
    expect(byId.er).toEqual(['length', 'title']);
    expect(byId.none).toEqual(['no_asin']);
    expect(byId.ga).toBeUndefined();
  });
});

describe('decideMatch', () => {
  const suspectFor = (it: MatchItem, currentMinutes?: number): Suspect => {
    const parts = it.relPath.split('/');
    return { item: it, reasons: ['title'], folderTitle: parts[parts.length - 1], folderAuthor: parts[0], currentMinutes };
  };

  it('re-matches when title, author and length agree (Equal Rites folder matched to The Last Hero)', () => {
    const lastHero = item({ id: 'lh', title: 'Equal Rites', author: 'Terry Pratchett', asin: 'B0ER', durationSec: 4.43 * H, relPath: 'Terry Pratchett/Discworld/The Last Hero' });
    const s = suspectFor(lastHero, 450);
    const decision = decideMatch(s, scoreCandidates(s, [
      { asin: 'B0ER', title: 'Equal Rites', author: 'Terry Pratchett', durationMinutes: 450 },
      { asin: 'B0LH', title: 'The Last Hero', author: 'Terry Pratchett', durationMinutes: 266 },
    ]));
    expect(decision).toMatchObject({ kind: 'confident', candidate: { asin: 'B0LH' } });
  });

  it('says the match is fine when the current ASIN is the right one', () => {
    const s = suspectFor(poppy2, 1427);
    expect(decideMatch(s, scoreCandidates(s, [{ asin: 'B0DR', title: 'The Dragon Republic', author: 'R. F. Kuang', durationMinutes: 1427 }])))
      .toEqual({ kind: 'ok' });
  });

  it('reports wrong audio instead of re-matching (Poppy War 03 holds book 2)', () => {
    const s = suspectFor(poppy3, 1427);
    const decision = decideMatch(s, scoreCandidates(s, [
      { asin: 'B0BG', title: 'The Burning God', author: 'R. F. Kuang', durationMinutes: 1240 },
    ]));
    expect(decision).toMatchObject({ kind: 'wrong_audio', namedAs: { asin: 'B0BG' }, audioMatches: 'The Dragon Republic' });
  });

  it('reports wrong audio when another book by the author has the audio length (HWFwM 1 holds book 4)', () => {
    const hw1 = item({ id: 'hw1', title: '', author: '', durationSec: 22.34 * H, relPath: 'Shirtaloon, Travis Deverell/He Who Fights with Monsters/He Who Fights with Monsters A LitRPG Adventure' });
    const s = suspectFor(hw1);
    const decision = decideMatch(s, scoreCandidates(s, [
      { asin: 'B1', title: 'He Who Fights with Monsters: A LitRPG Adventure', author: 'Shirtaloon, Travis Deverell', durationMinutes: 1736 },
      { asin: 'B4', title: 'He Who Fights with Monsters 4', author: 'Shirtaloon, Travis Deverell', durationMinutes: 1340 },
    ]));
    expect(decision).toMatchObject({ kind: 'wrong_audio', audioMatches: 'He Who Fights with Monsters 4' });
  });

  it('is unsure without a title + author match, listing candidates', () => {
    const s = suspectFor(item({ id: 'x', durationSec: 10 * H, relPath: 'Someone/Obscure Book' }));
    const decision = decideMatch(s, scoreCandidates(s, [{ asin: 'B9', title: 'Different Book', author: 'Other Person', durationMinutes: 600 }]));
    expect(decision).toMatchObject({ kind: 'unsure', candidates: [{ asin: 'B9' }] });
  });
});
