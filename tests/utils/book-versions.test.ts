/**
 * Component: Book Version Detection Utility Tests
 * Documentation: documentation/features/watched-lists.md
 */

import { describe, expect, it } from 'vitest';
import {
  applyVersionLabel,
  detectVersionMarker,
  getWorkKey,
  groupByWork,
  pickPreferredVersion,
  stripVersionMarkers,
  versionLabelFor,
} from '@/lib/utils/book-versions';

const book = (title: string, extra: Record<string, any> = {}) => ({
  asin: extra.asin || title,
  title,
  author: 'Brandon Sanderson',
  ...extra,
});

describe('stripVersionMarkers / getWorkKey', () => {
  it('treats a dramatized adaptation as the same work as the standard version', () => {
    expect(getWorkKey(book('Mistborn: The Final Empire (Dramatized Adaptation)')))
      .toBe(getWorkKey(book('Mistborn: The Final Empire')));
  });

  it('strips version markers given as a subtitle, not just in brackets', () => {
    expect(stripVersionMarkers('The Hobbit: A Full-Cast Dramatization')).toBe('The Hobbit');
    expect(stripVersionMarkers('Dune - Unabridged Edition')).toBe('Dune');
    expect(stripVersionMarkers('Dune [Abridged]')).toBe('Dune');
  });

  it('keeps real subtitles so different books in a series stay distinct', () => {
    expect(getWorkKey(book('Halo: The Fall of Reach', { author: 'Eric Nylund' })))
      .not.toBe(getWorkKey(book('Halo: Ghosts of Onyx', { author: 'Eric Nylund' })));
  });

  it('keys on the primary author, ignoring co-authors and case/punctuation', () => {
    expect(getWorkKey(book('Songs of the Dead', { author: 'Brandon Sanderson, Peter Orullian' })))
      .toBe(getWorkKey(book('songs of the dead', { author: 'brandon sanderson' })));
  });

  it('does not merge the same title by different authors', () => {
    expect(getWorkKey(book('Dune', { author: 'Frank Herbert' })))
      .not.toBe(getWorkKey(book('Dune', { author: 'Someone Else' })));
  });

  it('groups split dramatization parts with the standard version (GraphicAudio style)', () => {
    const rr = (title: string) => getWorkKey({ title, author: 'Pierce Brown' });
    expect(rr('Golden Son (Part 1 of 2) (Dramatized Adaptation)')).toBe(rr('Golden Son'));
    expect(rr('Golden Son (Part 2 of 2) (Dramatized Adaptation)')).toBe(rr('Golden Son'));
    expect(rr('Morning Star (2 of 2) (Dramatized Adaptation)')).toBe(rr('Morning Star'));
    expect(rr('Light Bringer (1 of 3) [Dramatized Adaptation]')).toBe(rr('Light Bringer'));
  });

  it('strips "N of M" part markers in any bracket or trailing form', () => {
    expect(stripVersionMarkers('Dune (Pt. 1/2)')).toBe('Dune');
    expect(stripVersionMarkers('Dune [Book 2 of 3]')).toBe('Dune');
    expect(stripVersionMarkers('Dune, Part 1 of 2')).toBe('Dune');
    expect(stripVersionMarkers('Dune: Part 2 of 2')).toBe('Dune');
    expect(stripVersionMarkers('Dune - 1 of 3')).toBe('Dune');
  });

  it('keeps a bare "Part 2" and numbers that are part of the title', () => {
    expect(getWorkKey(book('Dune Part Two'))).not.toBe(getWorkKey(book('Dune')));
    expect(stripVersionMarkers('Catch-22')).toBe('Catch-22');
    expect(stripVersionMarkers('Fahrenheit 451')).toBe('Fahrenheit 451');
  });

  it('ignores trailing descriptors like "A Novel"', () => {
    expect(getWorkKey(book('Project Hail Mary: A Novel'))).toBe(getWorkKey(book('Project Hail Mary')));
  });
});

describe('detectVersionMarker', () => {
  it('labels dramatized, full cast and abridged versions', () => {
    expect(detectVersionMarker({ title: 'Mistborn (Dramatized Adaptation)' })).toBe('Dramatized Adaptation');
    expect(detectVersionMarker({ title: 'Dune (Full Cast Edition)' })).toBe('Full Cast');
    expect(detectVersionMarker({ title: 'Dune (Abridged)' })).toBe('Abridged');
  });

  it('detects full-cast productions from the narrator field', () => {
    expect(detectVersionMarker({ title: 'The Sandman', narrator: 'Full Cast, Neil Gaiman' })).toBe('Full Cast');
  });

  it('treats unabridged and plain titles as standard', () => {
    expect(detectVersionMarker({ title: 'Dune (Unabridged)' })).toBeNull();
    expect(detectVersionMarker({ title: 'Dune', narrator: 'Scott Brick' })).toBeNull();
  });
});

describe('pickPreferredVersion', () => {
  it('prefers the standard narration over a higher-rated dramatization', () => {
    const standard = book('Mistborn', { rating: 4.5 });
    const dramatized = book('Mistborn (Dramatized Adaptation)', { rating: 4.9 });
    expect(pickPreferredVersion([dramatized, standard])).toBe(standard);
  });

  it('breaks ties between standard versions by rating, then listing order', () => {
    const a = book('Harry Potter', { asin: 'A', narrator: 'Jim Dale', rating: 4.8 });
    const b = book('Harry Potter', { asin: 'B', narrator: 'Stephen Fry', rating: 4.9 });
    const c = book('Harry Potter', { asin: 'C', narrator: 'Other', rating: 4.9 });
    expect(pickPreferredVersion([a, b, c])).toBe(b);
  });

  it('falls back to a non-standard version when that is all there is', () => {
    const dramatized = book('X (Dramatized Adaptation)');
    expect(pickPreferredVersion([dramatized])).toBe(dramatized);
  });
});

describe('versionLabelFor', () => {
  const preferred = book('Harry Potter', { narrator: 'Jim Dale' });

  it('uses the intrinsic marker when present', () => {
    expect(versionLabelFor(book('Harry Potter (Full Cast Dramatization)'), preferred)).toBe('Dramatized Adaptation');
  });

  it('labels a different narration by its first narrator', () => {
    expect(versionLabelFor(book('Harry Potter', { narrator: 'Stephen Fry, Someone' }), preferred)).toBe('Narrated by Stephen Fry');
  });

  it('falls back to a generic label', () => {
    expect(versionLabelFor(book('Harry Potter', { narrator: 'Jim Dale' }), preferred)).toBe('Alternate Version');
  });
});

describe('applyVersionLabel', () => {
  it('appends the label to series and title', () => {
    expect(applyVersionLabel({ title: 'Harry Potter 1', series: 'Harry Potter' }, 'Narrated by Stephen Fry'))
      .toEqual({ title: 'Harry Potter 1 (Narrated by Stephen Fry)', series: 'Harry Potter (Narrated by Stephen Fry)' });
  });

  it('leaves the title alone when it already contains the label', () => {
    expect(applyVersionLabel({ title: 'Mistborn (Dramatized Adaptation)', series: 'Mistborn' }, 'Dramatized Adaptation'))
      .toEqual({ title: 'Mistborn (Dramatized Adaptation)', series: 'Mistborn (Dramatized Adaptation)' });
  });

  it('still labels the title when there is no series', () => {
    expect(applyVersionLabel({ title: 'Standalone' }, 'Abridged')).toEqual({ title: 'Standalone (Abridged)', series: undefined });
  });

  it('is a no-op without a label', () => {
    const meta = { title: 'Book', series: 'Series' };
    expect(applyVersionLabel(meta, undefined)).toBe(meta);
    expect(applyVersionLabel(meta, '  ')).toBe(meta);
  });
});

describe('groupByWork', () => {
  it('groups versions together and preserves first-appearance order', () => {
    const groups = groupByWork([
      book('Book A'),
      book('Book B'),
      book('Book A (Dramatized Adaptation)'),
    ]);
    expect([...groups.values()].map(g => g.map(b => b.title))).toEqual([
      ['Book A', 'Book A (Dramatized Adaptation)'],
      ['Book B'],
    ]);
  });
});
