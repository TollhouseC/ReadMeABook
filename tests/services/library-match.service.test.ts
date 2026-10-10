/**
 * Component: Library Match Check Scoring Tests
 * Documentation: documentation/features/library-match.md
 */

import { describe, expect, it } from 'vitest';
import type { AudibleAudiobook } from '@/lib/integrations/audible.service';
import {
  analyzeChapters, decideMatch, findSuspects, folderInfo, isDoubleOrHalf, lengthFit, scoreCandidates, searchTitle, titleSimilarity,
  type MatchItem, type Suspect,
} from '@/lib/services/library-match.service';

const H = 3600;
const item = (over: Partial<MatchItem>): MatchItem => ({ id: 'li', title: '', author: '', relPath: '', isFile: false, ...over });
const book = (asin: string, title: string, author: string, minutes?: number, language = 'english'): AudibleAudiobook =>
  ({ asin, title, author, durationMinutes: minutes, language });

function suspectFor(it: MatchItem, current?: AudibleAudiobook): Suspect {
  const { folderTitle, folderAuthor } = folderInfo(it);
  return { item: it, reasons: ['length'], folderTitle, folderAuthor, current };
}
const decide = (s: Suspect, results: AudibleAudiobook[]) => decideMatch(s, scoreCandidates(s, results));

describe('title and length helpers', () => {
  it('matches titles despite punctuation, series prefixes and subtitles', () => {
    expect(titleSimilarity('He Who Fights with Monsters 11: A LitRPG Adventure', 'He Who Fights with Monsters 11 A LitRPG Adventure')).toBe(1);
    expect(titleSimilarity('The Burning God', 'The Poppy War 03 - The Burning God')).toBe(1);
    expect(titleSimilarity('The Churn: An Expanse Novella', 'The Churn')).toBe(1);
    expect(titleSimilarity('Wild Cards I', 'Wild Cards 27 - Knaves over Queens')).toBeLessThan(0.6);
    expect(searchTitle('The Poppy War 03 - The Burning God')).toBe('The Burning God');
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
    const products = new Map([
      ['b0dr', book('B0DR', 'The Dragon Republic', 'R. F. Kuang', 1427)],
      ['b0hw11', book('B0HW11', 'He Who Fights with Monsters 11', 'Shirtaloon', 1579)],
      ['b0er', book('B0ER', 'Equal Rites', 'Terry Pratchett', 450)],
    ]);
    const suspects = findSuspects([
      item({ id: 'p2', title: 'The Dragon Republic', asin: 'B0DR', durationSec: 23.78 * H, relPath: 'R. F. Kuang/The Poppy War/The Poppy War 02 - The Dragon Republic' }),
      item({ id: 'p3', title: 'The Dragon Republic', asin: 'B0DR', durationSec: 23.78 * H, relPath: 'R. F. Kuang/The Poppy War/The Poppy War 03 - The Burning God' }),
      item({ id: 'hw11', title: 'He Who Fights with Monsters 11: A LitRPG Adventure', asin: 'B0HW11', durationSec: 26.33 * H, relPath: 'Shirtaloon/HWFwM/He Who Fights with Monsters 11 A LitRPG Adventure' }),
      item({ id: 'er', title: 'Equal Rites', asin: 'B0ER', durationSec: 4.43 * H, relPath: 'Terry Pratchett/Discworld/The Last Hero' }),
      item({ id: 'none', title: 'Mystery', relPath: 'Someone/Mystery' }),
      item({ id: 'ga', title: 'The Well of Ascension', asin: 'B0WOA', durationSec: 21 * H, relPath: 'Brandon Sanderson/Mistborn {Graphic Audio}/The Well of Ascension' }),
    ], products);

    const byId = Object.fromEntries(suspects.map(s => [s.item.id, s.reasons]));
    expect(byId.p2).toEqual(['shared_asin']);
    expect(byId.p3).toEqual(['title', 'shared_asin']);
    expect(byId.hw11).toBeUndefined();
    expect(byId.er).toEqual(['length', 'title']);
    expect(byId.none).toEqual(['no_asin']);
    expect(byId.ga).toBeUndefined();
  });
});

describe('decideMatch — editions', () => {
  it('treats the right book in another narration as fine (Discworld re-recordings)', () => {
    const mort = book('B09LZ58X8G', 'Mort', 'Terry Pratchett', 477);
    const s = suspectFor(item({ title: 'Mort', asin: 'B09LZ58X8G', durationSec: 439 * 60, relPath: 'Terry Pratchett/Discworld/Mort' }), mort);
    expect(decide(s, [mort, book('B0032N4ZUI', 'Mort', 'Terry Pratchett', 182)])).toMatchObject({ kind: 'edition' });
  });

  it('re-matches to the edition whose length fits (Timeline)', () => {
    const abridged = book('B002V5IUMM', 'Timeline', 'Michael Crichton', 360);
    const s = suspectFor(item({ title: 'Timeline', asin: 'B002V5IUMM', durationSec: 912 * 60, relPath: 'Michael Crichton/Timeline' }), abridged);
    expect(decide(s, [book('B002VA96S4', 'Timeline', 'Michael Crichton', 904), abridged]))
      .toMatchObject({ kind: 'confident', candidate: { asin: 'B002VA96S4' }, why: 'an edition whose length fits the audio' });
  });

  it('ignores other-language editions and translations (Cibola Burn, Binding 13)', () => {
    const cibola = book('B00WNIDATK', 'Cibola Burn', 'James S. A. Corey', 1207);
    const s = suspectFor(item({ title: 'Cibola Burn', asin: 'B00WNIDATK', durationSec: 1284 * 60, relPath: 'James S. A. Corey/The Expanse/Cibola Burn' }), cibola);
    expect(decide(s, [cibola, book('B0DE', 'Cibola brennt', 'James S. A. Corey', 1284, 'german')])).toMatchObject({ kind: 'edition' });

    const binding = suspectFor(item({ title: 'Binding 13', asin: 'B07LBMZL88', durationSec: 1552 * 60, relPath: 'Chloe Walsh/Boys of Tommen/Binding 13' }));
    const decision = decide(binding, [book('B0CYCHRT3M', 'Boys of Tommen 1: Binding 13', 'Chloe Walsh, Gerda M. Pum - translator', 1588)]);
    expect(decision.kind).not.toBe('confident');
  });

  it('re-matches a foreign-language current match to the English edition (Howling Dark)', () => {
    const italian = book('B0GR5XY62Z', "Howling Dark - L'ululato dell'oscurità", 'Christopher Ruocchio', 2313, 'italian');
    const s = suspectFor(item({ title: 'Howling Dark', asin: 'B0GR5XY62Z', durationSec: 3368 * 60, relPath: 'Christopher Ruocchio/Sun Eater/Howling Dark' }), italian);
    expect(decide(s, [book('1501991558', 'Howling Dark', 'Christopher Ruocchio', 1683), italian]))
      .toMatchObject({ kind: 'confident', candidate: { asin: '1501991558' }, why: 'current match is another-language edition' });
  });

  it('skips adaptations and summaries unless the audio fits them exactly', () => {
    const current = book('B08VWTH5HY', 'Poirot Investigates', 'Agatha Christie', 300);
    const s = suspectFor(item({ title: 'Poirot Investigates', asin: 'B08VWTH5HY', durationSec: 341 * 60, relPath: 'Agatha Christie/A Hercule Poirot Mystery/Poirot Investigates' }), current);
    expect(decide(s, [book('B0HL6QM7R3', 'Poirot Investigates: (Illustrated) & Adapted for Modern Readers', 'Agatha Christie', 333), current]))
      .toMatchObject({ kind: 'edition' });

    const donlea = suspectFor(item({ title: 'Long Time Gone', asin: 'B0CQZ22HLQ', durationSec: 448 * 60, relPath: 'Charlie Donlea/Long Time Gone' }), book('B0CQZ22HLQ', 'Long Time Gone', 'Charlie Donlea', 600));
    expect(decide(donlea, [book('B0FK72YNW8', 'Long Time Gone (Dramatized Adaptation)', 'Charlie Donlea', 447)])).toMatchObject({ kind: 'confident' });
  });

  it('matches authors listed with roles ("- editor")', () => {
    const wc1 = book('B005ZUHPP8', 'Wild Cards I', 'George R. R. Martin - editor', 1139);
    const s = suspectFor(item({ title: 'Wild Cards I', asin: 'B005ZUHPP8', durationSec: 1140 * 60, relPath: 'George R. R. Martin/Wild Cards/Wild Cards I' }), wc1);
    expect(decide(s, [wc1])).toEqual({ kind: 'ok' });
  });
});

describe('decideMatch — broken files and wrong books', () => {
  it('flags far too short and far too long audio', () => {
    const kaigen = book('B08GGD1BH1', 'The Sword of Kaigen: A Theonite War Story', 'M. L. Wang', 1464);
    expect(decide(suspectFor(item({ asin: 'B08GGD1BH1', durationSec: 12 * 60, relPath: 'M. L. Wang/The Sword of Kaigen A Theonite War Story' }), kaigen), [kaigen]))
      .toMatchObject({ kind: 'too_short' });
    const hobbit = book('B0030EJV3U', 'The Hobbit', 'J. R. R. Tolkien', 664);
    expect(decide(suspectFor(item({ asin: 'B0030EJV3U', durationSec: 1283 * 60, relPath: 'J. R. R. Tolkien/The Lord of the Rings/The Hobbit' }), hobbit), [hobbit]))
      .toMatchObject({ kind: 'too_long' });
  });

  it('reports wrong audio when the audio is exactly the current (other) book (Poppy War 03 holds book 2)', () => {
    const dr = book('B0DR', 'The Dragon Republic', 'R. F. Kuang', 1427);
    const s = suspectFor(item({ title: 'The Dragon Republic', asin: 'B0DR', durationSec: 1427.3 * 60, relPath: 'R. F. Kuang/The Poppy War/The Poppy War 03 - The Burning God' }), dr);
    expect(decide(s, [book('B0BG', 'The Burning God', 'R. F. Kuang', 1240), dr]))
      .toMatchObject({ kind: 'wrong_audio', namedAs: { asin: 'B0BG' }, audioMatches: 'The Dragon Republic' });
  });

  it('does not call similar lengths of sibling books wrong audio (Sourcery vs The Light Fantastic)', () => {
    const sourcery = book('B09LZ1JBL7', 'Sourcery', 'Terry Pratchett', 540);
    const s = suspectFor(item({ title: 'Sourcery', asin: 'B09LZ1JBL7', durationSec: 475 * 60, relPath: 'Terry Pratchett/Discworld/Sourcery' }), sourcery);
    expect(decide(s, [sourcery, book('B09LZ5HZGC', 'The Light Fantastic', 'Terry Pratchett', 462)])).toMatchObject({ kind: 'edition' });
  });

  it('re-matches a book with no ASIN to the folder\'s book', () => {
    const s = suspectFor(item({ title: 'Love, Theoretically', relPath: 'Ali Hazelwood/Love, Theoretically' }));
    expect(decide(s, [book('B0BJLCYHHR', 'Love, Theoretically', 'Ali Hazelwood', 753), book('B0DJ', 'Love, theoretically (French Edition)', 'Ali Hazelwood', 619, 'french')]))
      .toMatchObject({ kind: 'confident', candidate: { asin: 'B0BJLCYHHR' } });
  });

  it('asks for a check instead of crying wrong audio when the length also fits an edition (Alcatraz vs Bastille)', () => {
    const alcatraz = book('B005GGGC3M', 'Alcatraz versus the Evil Librarians', 'Brandon Sanderson', 415);
    const s = suspectFor(item({ title: 'Alcatraz versus the Evil Librarians', asin: 'B005GGGC3M', durationSec: 292.4 * 60, relPath: 'Brandon Sanderson/Alcatraz versus the Evil Librarians/Alcatraz versus the Evil Librarians' }), alcatraz);
    const decision = decide(s, [alcatraz, book('B0BAST', 'Bastille vs. the Evil Librarians', 'Brandon Sanderson', 292)]);
    expect(decision).toMatchObject({ kind: 'unsure' });
    expect((decision as { why: string }).why).toContain('exactly the length of "Bastille vs. the Evil Librarians"');
  });

  it('reports books not on Audible', () => {
    const s = suspectFor(item({ title: 'The Girl of Hrusch Avenue', durationSec: 51 * 60, relPath: 'Brian McClellan/The Powder Mage Trilogy/The Girl of Hrusch Avenue' }));
    expect(decide(s, [book('B1', 'Promise of Blood', 'Brian McClellan', 900)])).toMatchObject({ kind: 'not_found' });
  });
});

describe('analyzeChapters / isDoubleOrHalf', () => {
  const ch = (title: string, startH: number, endH: number) => ({ title, startMs: startH * 3_600_000, endMs: endH * 3_600_000 });

  it('spots a box set saved under one title (Where It All Began)', () => {
    const pattern = analyzeChapters([
      ch('Holding on to Chaos', 0, 11.77), ch('The Fine Art of Faking It', 11.77, 23.98),
      ch('The Mistletoe Kisser', 23.98, 33.45), ch('Where It All Began', 33.45, 40.62),
    ], 429);
    expect(pattern).toMatchObject({ kind: 'books', parts: [{ title: 'Holding on to Chaos' }, { title: 'The Fine Art of Faking It' }, { title: 'The Mistletoe Kisser' }, { title: 'Where It All Began' }] });
  });

  it('spots the book twice when chapter numbering starts over (The Magos)', () => {
    const first = Array.from({ length: 48 }, (_, i) => ch(`Chapter ${String(i + 1).padStart(2, '0')}`, i * 0.42, (i + 1) * 0.42));
    const second = Array.from({ length: 47 }, (_, i) => ch(String(i + 1).padStart(3, '0'), 20.08 + i * 0.42, 20.08 + (i + 1) * 0.42));
    expect(analyzeChapters([...first, ...second], 1204)).toEqual({ kind: 'repeat', atMs: 20.08 * 3_600_000, title: '001' });
  });

  it('finds nothing in a normal chapter list', () => {
    expect(analyzeChapters(Array.from({ length: 30 }, (_, i) => ch(`Chapter ${i + 1}`, i * 0.5, (i + 1) * 0.5)), 900)).toBeNull();
  });

  it('recognises exactly double or half', () => {
    expect(isDoubleOrHalf(2.0)).toBe(true);
    expect(isDoubleOrHalf(0.5)).toBe(true);
    expect(isDoubleOrHalf(3.4)).toBe(false);
    expect(isDoubleOrHalf(0.33)).toBe(false);
  });
});
