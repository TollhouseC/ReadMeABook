/**
 * Component: Library Organize Planner Tests
 * Documentation: documentation/phase3/file-organization.md
 */

import path from 'path';
import { describe, expect, it } from 'vitest';
import { SpellingRegistry } from '@/lib/utils/author-identity';
import { planLibraryOrganize, type OrganizeBook } from '@/lib/services/library-organize.service';

const LIB = path.resolve('/lib');
const at = (...parts: string[]) => path.join(LIB, ...parts);

function plan(books: OrganizeBook[], rmabAuthors: string[] = [], useSeriesFolder = true) {
  const registry = new SpellingRegistry();
  for (const a of rmabAuthors) registry.add(a, 3);
  for (const b of books) {
    registry.add(b.author);
    registry.add(path.relative(LIB, b.folder).split(/[\\/]/)[0]);
  }
  return planLibraryOrganize(books, { mediaDir: LIB, useSeriesFolder, registry });
}

const HW = 'He Who Fights with Monsters';
const BS = 'Bootleg Springs';

describe('planLibraryOrganize', () => {
  it('moves a split author back to ReadMeABook\'s spelling (HWFwM)', () => {
    const result = plan([
      { folder: at('Shirtaloon, Travis Deverell', HW, `${HW} 1`), title: `${HW} 1`, author: 'Shirtaloon, Travis Deverell', series: HW },
      { folder: at('Travis Deverell Shirtaloon', HW, `${HW} 2`), title: `${HW} 2`, author: 'Shirtaloon, Travis Deverell', series: HW },
      { folder: at('Travis Deverell Shirtaloon', HW, `${HW} 3`), title: `${HW} 3`, author: 'Travis Deverell Shirtaloon', series: HW },
    ], ['Shirtaloon, Travis Deverell']);

    expect(result.inPlace).toBe(1);
    expect(result.moves.map(m => m.to)).toEqual([
      at('Shirtaloon, Travis Deverell', HW, `${HW} 2`),
      at('Shirtaloon, Travis Deverell', HW, `${HW} 3`),
    ]);
    expect(result.moves[0].reason).toContain('author folder "Travis Deverell Shirtaloon" → "Shirtaloon, Travis Deverell"');
  });

  it('keeps a co-written series together under its lead author (Bootleg Springs)', () => {
    const result = plan([
      { folder: at('Claire Kingsley,Lucy Score', BS, 'Sidecar Crush'), title: 'Sidecar Crush', author: 'Claire Kingsley', series: BS },
      { folder: at('Lucy Score,Claire Kingsley', BS, 'Moonshine Kiss'), title: 'Moonshine Kiss', author: 'Lucy Score', series: BS },
      { folder: at('Lucy Score,Claire Kingsley', BS, 'Whiskey Chaser'), title: 'Whiskey Chaser', author: 'Lucy Score', series: BS },
      { folder: at('Lucy Score,Claire Kingsley', BS, 'Bourbon Bliss'), title: 'Bourbon Bliss', author: 'Claire Kingsley, Lucy Score', series: BS },
      { folder: at('Claire Kingsley,Lucy Score', BS, 'Gin Fling'), title: 'Gin Fling', author: 'Lucy Score, Claire Kingsley', series: BS },
      { folder: at('Lucy Score', 'Blue Moon', 'No More Secrets'), title: 'No More Secrets', author: 'Lucy Score', series: 'Blue Moon' },
    ], ['Lucy Score', 'Claire Kingsley', 'Claire Kingsley, Lucy Score']);

    expect(result.moves.map(m => m.to).sort()).toEqual(
      ['Bourbon Bliss', 'Gin Fling', 'Moonshine Kiss', 'Sidecar Crush', 'Whiskey Chaser'].map(t => at('Lucy Score', BS, t))
    );
    expect(result.inPlace).toBe(1); // Blue Moon untouched
  });

  it('never merges a series written by unrelated authors (Halo)', () => {
    const result = plan([
      { folder: at('Greg Bear', 'Halo', 'Halo Primordium'), title: 'Halo Primordium', author: 'Greg Bear', series: 'Halo' },
      { folder: at('Karen Traviss', 'Halo', 'Halo Mortal Dictata'), title: 'Halo Mortal Dictata', author: 'Karen Traviss', series: 'Halo' },
      { folder: at('Troy Denning', 'Halo', 'Halo Shadows of Reach'), title: 'Halo Shadows of Reach', author: 'Troy Denning', series: 'Halo' },
    ]);
    expect(result.moves).toEqual([]);
    expect(result.inPlace).toBe(3);
  });

  it('adds a missing series folder and merges series spellings', () => {
    const result = plan([
      { folder: at('Sarah A. Parker', 'When the Moon Hatched'), title: 'When the Moon Hatched', author: 'Sarah A. Parker', series: 'Moonfall' },
      { folder: at('Sarah A. Parker', 'Moonfall', 'The Ballad of Falling Dragons'), title: 'The Ballad of Falling Dragons', author: 'Sarah A. Parker', series: 'Moonfall' },
      { folder: at('Christopher Ruocchio', 'Sun Eater', 'Empire of Silence'), title: 'Empire of Silence', author: 'Christopher Ruocchio', series: 'Sun Eater' },
      { folder: at('Christopher Ruocchio', 'Sun Eater', 'Howling Dark'), title: 'Howling Dark', author: 'Christopher Ruocchio', series: 'The Sun Eater' },
      { folder: at('Christopher Ruocchio', 'The Sun Eater', 'Demon in White'), title: 'Demon in White', author: 'Christopher Ruocchio', series: 'Sun Eater' },
    ]);
    expect(result.moves).toEqual([
      expect.objectContaining({ to: at('Sarah A. Parker', 'Moonfall', 'When the Moon Hatched'), reason: 'add series folder "Moonfall"' }),
      expect.objectContaining({ to: at('Christopher Ruocchio', 'Sun Eater', 'Demon in White') }),
    ]);
  });

  it('leaves correct folders, alternate versions and doubtful metadata alone', () => {
    const result = plan([
      { folder: at('Sue Grafton', 'Kinsey Millhone Mysteries', 'A Is for Alibi'), title: 'A Is for Alibi', author: 'Sue Grafton', series: 'Kinsey Millhone Mysteries' },
      { folder: at('Brandon Sanderson', 'Mistborn {Graphic Audio}', 'The Well of Ascension'), title: 'The Well of Ascension', author: 'Brandon Sanderson', series: 'The Mistborn Saga' },
      { folder: at('Brandon Sanderson', 'Non-Canon (First Drafts)', 'The Way of Kings'), title: 'The Way of Kings', author: 'Brandon Sanderson', series: 'The Stormlight Archive' },
      { folder: at('R. F. Kuang', 'The Poppy War', 'The Poppy War 03'), title: 'Some Other Book', author: 'Somebody Else', series: 'Other' },
      { folder: at('Loose Book'), title: 'Loose Book', author: 'Anyone' },
    ]);
    expect(result.moves).toEqual([]);
    expect(result.inPlace).toBe(1);
    expect(result.skipped.map(s => s.reason)).toEqual([
      'metadata author "Somebody Else" doesn\'t match folder "R. F. Kuang" — check its match',
      'not inside an author folder',
    ]);
  });

  it('normalises a co-authored standalone book and never nests a book inside itself', () => {
    const result = plan([
      { folder: at('James Patterson,Viola Davis', 'Judge Stone'), title: 'Judge Stone', author: 'James Patterson, Viola Davis' },
      { folder: at('Brandon Sanderson', 'Warbreaker'), title: 'Warbreaker', author: 'Brandon Sanderson', series: 'Warbreaker' },
    ]);
    expect(result.moves).toEqual([expect.objectContaining({ to: at('James Patterson, Viola Davis', 'Judge Stone') })]);
    expect(result.skipped[0].reason).toContain('would nest it inside itself');
  });

  it('does not add series folders when the layout has none', () => {
    const result = plan([
      { folder: at('Sarah A. Parker', 'When the Moon Hatched'), title: 'When the Moon Hatched', author: 'Sarah A. Parker', series: 'Moonfall' },
    ], [], false);
    expect(result.moves).toEqual([]);
  });
});
