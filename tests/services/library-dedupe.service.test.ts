/**
 * Component: Library Duplicate Cleanup Tests
 * Documentation: documentation/features/chapter-merging.md
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/utils/chapter-merger', () => ({ probeAudioFile: vi.fn() }));

import { planFolderCleanup, type AudioFileInfo } from '@/lib/services/library-dedupe.service';

const H = 3_600_000;
const BOOK = 14 * H; // Audible runtime
const f = (name: string, hours: number | null, size = 500): AudioFileInfo => ({
  path: `/b/${name}`, ext: name.slice(name.lastIndexOf('.')), size, duration: hours === null ? null : Math.round(hours * H),
});
const names = (paths: string[]) => paths.map(p => p.slice(3));

describe('planFolderCleanup', () => {
  it('same book as .m4a and .m4b → keeps the m4b, removes the m4a', () => {
    const plan = planFolderCleanup([f('Book.m4a', 14.02), f('Book.m4b', 14)], BOOK);
    expect(names(plan.keep)).toEqual(['Book.m4b']);
    expect(plan.remove).toEqual([{ path: '/b/Book.m4a', reason: 'duplicate full copy' }]);
    expect(plan.unexplained).toEqual([]);
  });

  it('two full .m4b copies → keeps the larger one', () => {
    const plan = planFolderCleanup([f('Bride.m4b', 12.8, 400), f('Bride (1).m4b', 12.79, 700)], 12.78 * H);
    expect(names(plan.keep)).toEqual(['Bride (1).m4b']);
    expect(names(plan.remove.map(r => r.path))).toEqual(['Bride.m4b']);
  });

  it('a full single file next to an old set of parts → keeps the single, removes the parts', () => {
    const parts = Array.from({ length: 4 }, (_, i) => f(`HWFwM 10 - 0${i + 1}.m4b`, 3.5));
    const plan = planFolderCleanup([...parts, f('HWFwM 10.m4b', 14)], BOOK);
    expect(names(plan.keep)).toEqual(['HWFwM 10.m4b']);
    expect(plan.remove).toHaveLength(4);
    expect(plan.remove.every(r => r.reason === 'duplicate set of parts')).toBe(true);
  });

  it('complete m4a parts and complete m4b parts → keeps the m4b set (still needs merging)', () => {
    const m4a = [f('Speaker - 1.m4a', 7), f('Speaker - 2.m4a', 7)];
    const m4b = [f('Speaker part 1.m4b', 7), f('Speaker part 2.m4b', 7)];
    const plan = planFolderCleanup([...m4a, ...m4b], BOOK);
    expect(names(plan.keep)).toEqual(['Speaker part 1.m4b', 'Speaker part 2.m4b']);
    expect(names(plan.remove.map(r => r.path))).toEqual(['Speaker - 1.m4a', 'Speaker - 2.m4a']);
  });

  it('removes unreadable leftovers only when a good complete copy exists', () => {
    const plan = planFolderCleanup([f('Empire - 01.m4b', 14), f('Empire - 02.m4b', null)], BOOK);
    expect(plan.remove).toEqual([{ path: '/b/Empire - 02.m4b', reason: 'unreadable' }]);

    const unresolved = planFolderCleanup([f('a - 01.m4b', 7), f('a - 02.m4b', null)], BOOK);
    expect(unresolved).toMatchObject({ resolved: false, remove: [], keep: [] });
  });

  it('never deletes audio it cannot explain (could be another book)', () => {
    const plan = planFolderCleanup([f('Book.m4b', 14), f('Other Book.m4b', 9)], BOOK);
    expect(names(plan.keep)).toEqual(['Book.m4b']);
    expect(plan.remove).toEqual([]);
    expect(names(plan.unexplained)).toEqual(['Other Book.m4b']);
  });

  it('two copies of the same recording count as duplicates even if Audible lists another length', () => {
    // Ender's Game: both ~11h11m, Audible 11h57m (different edition) → same recording twice
    const plan = planFolderCleanup([f("Ender's Game.m4a", 11.18), f("Ender's Game.m4b", 11.19)], 11.95 * H);
    expect(names(plan.keep)).toEqual(["Ender's Game.m4b"]);
    expect(names(plan.remove.map(r => r.path))).toEqual(["Ender's Game.m4a"]);
  });

  it('copies of different lengths are never removed', () => {
    const plan = planFolderCleanup([f('The Hobbit.m4a', 4), f('The Hobbit.m4b', 14)], BOOK);
    expect(names(plan.keep)).toEqual(['The Hobbit.m4b']);
    expect(plan.remove).toEqual([]);
    expect(names(plan.unexplained)).toEqual(['The Hobbit.m4a']);
  });

  it('a normal split book (one set of parts) has nothing to remove', () => {
    const plan = planFolderCleanup([f('Ender - 1.mp3', 7), f('Ender - 2.mp3', 7)], BOOK);
    expect(plan).toMatchObject({ resolved: true, remove: [], unexplained: [] });
    expect(plan.keep).toHaveLength(2);
  });
});
