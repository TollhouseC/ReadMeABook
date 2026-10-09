/**
 * Component: Author Identity Tests
 * Documentation: documentation/phase3/file-organization.md
 */

import { describe, expect, it } from 'vitest';
import { authorSetKey, parsePersons, seriesKey, sharesPerson, SpellingRegistry } from '@/lib/utils/author-identity';

describe('author identity', () => {
  it('treats spelling variants of the same people as equal', () => {
    expect(authorSetKey('Shirtaloon, Travis Deverell')).toBe(authorSetKey('Travis Deverell Shirtaloon'));
    expect(authorSetKey('Lucy Score,Claire Kingsley')).toBe(authorSetKey('Claire Kingsley, Lucy Score'));
    expect(authorSetKey('William H. Gass')).toBe(authorSetKey('William Gass'));
    expect(authorSetKey('Lorena Castell García,Chloe Walsh')).toBe(authorSetKey('Chloe Walsh, Lorena Castell Garcia'));
    expect(authorSetKey('Brandon Sanderson')).not.toBe(authorSetKey('Brandon Sanderson, Janci Patterson'));
  });

  it('splits co-authors but keeps "Last, First" as one person', () => {
    expect(parsePersons('Lucy Score, Claire Kingsley').map(p => p.spelling)).toEqual(['Lucy Score', 'Claire Kingsley']);
    expect(parsePersons("Frank O'Connor,Steve Downs,Jen Taylor")).toHaveLength(3);
    expect(parsePersons('Sanderson, Brandon')).toHaveLength(1);
    expect(parsePersons('Shirtaloon, Travis Deverell')).toHaveLength(1);
  });

  it('detects a shared person', () => {
    expect(sharesPerson('Lucy Score', 'Claire Kingsley, Lucy Score')).toBe(true);
    expect(sharesPerson('Greg Bear', 'Karen Traviss')).toBe(false);
  });

  it('compares series loosely', () => {
    expect(seriesKey('The Sun Eater')).toBe(seriesKey('Sun Eater'));
    expect(seriesKey('Mistborn {Graphic Audio}')).not.toBe(seriesKey('Mistborn'));
  });

  it('prefers ReadMeABook spellings, then ", " over ","', () => {
    const registry = new SpellingRegistry();
    registry.add('Travis Deverell Shirtaloon');
    registry.add('Travis Deverell Shirtaloon');
    registry.add('Shirtaloon, Travis Deverell', 3);
    expect(registry.authorSet('Travis Deverell Shirtaloon')).toBe('Shirtaloon, Travis Deverell');

    const commas = new SpellingRegistry();
    commas.add('James Patterson,Viola Davis');
    commas.add('James Patterson, Viola Davis');
    expect(commas.authorSet('James Patterson,Viola Davis')).toBe('James Patterson, Viola Davis');

    const unknown = new SpellingRegistry();
    expect(unknown.authorSet('Peter Orullian,Brandon Sanderson')).toBe('Peter Orullian, Brandon Sanderson');
  });
});
