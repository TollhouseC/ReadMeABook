/**
 * Component: Library Merge Processor Tests (clean-up + merge)
 * Documentation: documentation/features/chapter-merging.md
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaMock } from '../helpers/prisma';

const prismaMock = createPrismaMock();
const H = 3_600_000;
const durations = vi.hoisted(() => new Map<string, number | null>());
const mocks = vi.hoisted(() => ({
  collectCandidates: vi.fn(),
  checkRuntime: vi.fn(),
  mergeFolderInPlace: vi.fn(),
  triggerLibraryScan: vi.fn(),
  syncFileChaptersToABS: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ prisma: prismaMock }));
vi.mock('@/lib/processors/fix-chapters.processor', () => ({
  collectCandidates: mocks.collectCandidates,
  getMediaDir: async () => '/Audiobooks/Audio',
}));
vi.mock('@/lib/services/library-merge.service', () => ({
  checkRuntime: mocks.checkRuntime,
  mergeFolderInPlace: mocks.mergeFolderInPlace,
  needsReencode: (format: string) => format !== '.m4b',
}));
vi.mock('@/lib/services/abs-chapter-sync', () => ({
  isAudiobookshelfBackend: async () => true,
  syncFileChaptersToABS: mocks.syncFileChaptersToABS,
}));
vi.mock('@/lib/utils/library-book-files', () => ({ triggerLibraryScan: mocks.triggerLibraryScan }));
vi.mock('@/lib/utils/chapter-merger', () => ({
  formatDuration: (ms: number) => `${Math.round(ms / 60000)}m`,
  probeAudioFile: async (p: string) => {
    const d = durations.get(path.basename(p));
    if (d === null || d === undefined) throw new Error('Failed to probe audio file');
    return { duration: d, format: 'mp4' };
  },
}));

let root: string;

async function book(name: string, files: Record<string, number | null>) {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  for (const [file, hours] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, file), 'x'.repeat(hours ? Math.round(hours * 10) : 1));
    durations.set(file, hours === null ? null : hours * H);
  }
  return dir;
}

async function run(mode: 'report' | 'apply') {
  const { processMergeLibrary } = await import('@/lib/processors/merge-library.processor');
  return processMergeLibrary({ jobId: 'job-1', mode });
}

describe('processMergeLibrary', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    durations.clear();
    vi.useFakeTimers({ toFake: ['setTimeout'], shouldAdvanceTime: true, advanceTimeDelta: 1000 });
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'rmab-libmergejob-'));
    const halo = await book('Halo', { 'Halo.m4a': 10, 'Halo.m4b': 10 });               // duplicate copies
    const ender = await book('Ender', { 'Ender - 1.mp3': 5, 'Ender - 2.mp3': 5 });     // split → merge
    const empire = await book('Empire', { 'Empire - 01.m4b': 10, 'Empire - 02.m4b': null }); // unreadable leftover
    const mixed = await book('Mixed', { 'Book.m4b': 10, 'Other.m4b': 6 });             // unexplained
    const single = await book('Single', { 'Single.m4b': 10 });
    mocks.collectCandidates.mockResolvedValue([
      { title: 'Halo', asin: 'A1', folder: halo, absItemId: 'abs-halo' },
      { title: 'Ender', asin: 'A2', folder: ender, author: 'Card', audiobookId: 'ab-ender' },
      { title: 'Empire', asin: 'A3', folder: empire },
      { title: 'Mixed', asin: 'A4', folder: mixed },
      { title: 'Single', asin: 'A5', folder: single },
    ]);
    mocks.checkRuntime.mockResolvedValue({ expectedMs: 10 * H, matches: null });
    mocks.mergeFolderInPlace.mockResolvedValue({ status: 'merged', finalPath: 'x', finalName: 'Ender.m4b', chapterCount: 20, sizeBytes: 1 });
    prismaMock.job.findUnique.mockResolvedValue({ cancelRequested: false });
  });
  afterEach(() => vi.useRealTimers());

  it('report: lists duplicates to remove and books to merge, touches nothing', async () => {
    const result = await run('report');
    expect(result).toMatchObject({
      mode: 'report', would_clean: 2, files_to_remove: 2, would_merge: 1, unexplained_left: 1, single_file: 1, merged: 0, cleaned: 0,
    });
    expect((await fs.readdir(path.join(root, 'Halo'))).sort()).toEqual(['Halo.m4a', 'Halo.m4b']);
    expect(mocks.mergeFolderInPlace).not.toHaveBeenCalled();
  });

  it('apply: deletes duplicates (keeping the m4b), merges split books, leaves unexplained audio alone', async () => {
    const result = await run('apply');
    expect(result).toMatchObject({ mode: 'apply', cleaned: 2, files_removed: 2, merged: 1, unexplained_left: 1 });

    expect(await fs.readdir(path.join(root, 'Halo'))).toEqual(['Halo.m4b']);
    expect(await fs.readdir(path.join(root, 'Empire'))).toEqual(['Empire.m4b']); // leftover numbering cleaned up
    expect((await fs.readdir(path.join(root, 'Mixed'))).sort()).toEqual(['Book.m4b', 'Other.m4b']);
    expect(mocks.syncFileChaptersToABS).toHaveBeenCalledWith('abs-halo', path.join(root, 'Halo', 'Halo.m4b'), expect.anything());
    expect(mocks.mergeFolderInPlace).toHaveBeenCalledTimes(1);
    expect(mocks.mergeFolderInPlace).toHaveBeenCalledWith(expect.objectContaining({
      folder: path.join(root, 'Ender'), audiobookId: 'ab-ender',
      parts: [path.join(root, 'Ender', 'Ender - 1.mp3'), path.join(root, 'Ender', 'Ender - 2.mp3')],
    }));
    expect(mocks.triggerLibraryScan).toHaveBeenCalledTimes(1);
  });

  it('same book in two folders (author written two ways): removes a same-length copy, alerts on a different-length one', async () => {
    const good = await book('Shirtaloon, Travis Deverell/HWFwM 10', { 'HWFwM 10.m4b': 10 });
    const sameLen = await book('Travis Deverell Shirtaloon/HWFwM 10', { 'HWFwM 10.m4a': 10 });
    await fs.writeFile(path.join(sameLen, 'cover.jpg'), 'img');
    const broken = await book('Shirtaloon/HWFwM 10', { 'HWFwM 10 - 01.m4b': 7, 'HWFwM 10 - 02.m4b': 0.3 });
    mocks.collectCandidates.mockResolvedValue([
      { title: 'HWFwM 10', asin: 'B0HW', folder: good },
      { title: 'HWFwM 10', asin: 'B0HW', folder: sameLen },
      { title: 'HWFwM 10', asin: 'B0HW', folder: broken },
    ]);

    const report = await run('report');
    expect(report).toMatchObject({ folders_to_remove: 1, different_length_alerts: 1, folders_removed: 0 });
    expect(await fs.readdir(sameLen)).toHaveLength(2);

    const result = await run('apply');
    expect(result).toMatchObject({ folders_removed: 1, different_length_alerts: 1 });
    await expect(fs.stat(sameLen)).rejects.toThrow(); // folder gone (audio + cover)
    expect((await fs.readdir(broken)).sort()).toEqual(['HWFwM 10 - 01.m4b', 'HWFwM 10 - 02.m4b']); // never deleted
    expect(await fs.readdir(good)).toEqual(['HWFwM 10.m4b']);
  });

  it('never removes a different book that Audiobookshelf matched to the same ASIN', async () => {
    const book2 = await book('R. F. Kuang/The Poppy War/The Poppy War 02 - The Dragon Republic', { 'The Dragon Republic.m4b': 10 });
    const book3 = await book('R. F. Kuang/The Poppy War/The Poppy War 03 - The Burning God', { 'The Burning God.m4b': 10 });
    const wc1 = await book('GRRM/Wild Cards/Wild Cards I', { 'Wild Cards I.m4b': 10 });
    const wc27 = await book('GRRM/Wild Cards/Wild Cards 27 - Knaves over Queens', { 'Knaves over Queens.m4b': 10 });
    mocks.collectCandidates.mockResolvedValue([
      { title: 'The Poppy War 02 - The Dragon Republic', asin: 'B0POPPY', folder: book2 },
      { title: 'The Poppy War 03 - The Burning God', asin: 'B0POPPY', folder: book3 },
      { title: 'Wild Cards I', asin: 'B0WC', folder: wc1 },
      // ABS title overwritten by the bad match — the folder name still differs
      { title: 'Wild Cards I', asin: 'B0WC', folder: wc27 },
    ]);

    const result = await run('apply');

    expect(result).toMatchObject({ folders_removed: 0, different_length_alerts: 2 });
    expect(await fs.readdir(book3)).toEqual(['The Burning God.m4b']);
    expect(await fs.readdir(wc27)).toEqual(['Knaves over Queens.m4b']);
  });

  it('keeps Graphic Audio / dramatized editions without alerting', async () => {
    const standard = await book('Brandon Sanderson/The Mistborn Saga/The Well of Ascension', { 'The Well of Ascension.m4b': 10 });
    const ga = await book('Brandon Sanderson/Mistborn {Graphic Audio}/The Well of Ascension', { 'The Well of Ascension.m4b': 7.5 });
    mocks.collectCandidates.mockResolvedValue([
      { title: 'The Well of Ascension', asin: 'B0WOA', folder: standard },
      { title: 'The Well of Ascension', asin: 'B0WOA', folder: ga },
    ]);

    const result = await run('apply');

    expect(result).toMatchObject({ folders_removed: 0, different_length_alerts: 0 });
    expect(await fs.readdir(ga)).toEqual(['The Well of Ascension.m4b']);
  });

  it('removes exact copies of sibling books misfiled by an old series-pack import, then renames', async () => {
    // Sun Eater: each book folder also got the other books of the pack
    const empire = await book('Ruocchio/Sun Eater/Empire of Silence', { 'Empire of Silence - 01.m4b': 9 });
    const howling = await book('Ruocchio/Sun Eater/Howling Dark', { 'Howling Dark - 01.m4b': 9.0001, 'Howling Dark - 02.m4b': 10 });
    mocks.collectCandidates.mockResolvedValue([
      { title: 'Empire of Silence', asin: 'B0E', folder: empire },
      { title: 'Howling Dark', asin: 'B0H', folder: howling },
    ]);
    mocks.checkRuntime.mockImplementation(async (_ms: number, asin: string) => ({ expectedMs: asin === 'B0E' ? 9 * H : 10 * H, matches: null }));

    const report = await run('report');
    expect(report).toMatchObject({ would_clean: 1, different_length_alerts: 0 });

    const result = await run('apply');
    expect(result).toMatchObject({ cleaned: 1, files_removed: 1 });
    expect(await fs.readdir(howling)).toEqual(['Howling Dark.m4b']); // misplaced copy gone, leftover numbering cleaned
    expect(await fs.readdir(empire)).toEqual(['Empire of Silence - 01.m4b']); // the real copy stays
  });

  it('converts a book that is a single MP3 to M4B (report lists it, apply converts it)', async () => {
    const mp3 = await book('Heir', { 'Heir.mp3': 10 });
    mocks.collectCandidates.mockResolvedValue([
      { title: 'Heir', asin: 'A9', folder: mp3, author: 'Someone', audiobookId: 'ab-heir', absItemId: 'abs-heir' },
      { title: 'Single', asin: 'A5', folder: path.join(root, 'Single') },
    ]);

    expect(await run('report')).toMatchObject({ would_convert: 1, single_file: 1, converted: 0 });
    expect(mocks.mergeFolderInPlace).not.toHaveBeenCalled();

    mocks.mergeFolderInPlace.mockResolvedValue({ status: 'merged', finalPath: 'x', finalName: 'Heir.m4b', chapterCount: 30, sizeBytes: 1 });
    expect(await run('apply')).toMatchObject({ converted: 1, single_file: 1 });
    expect(mocks.mergeFolderInPlace).toHaveBeenCalledWith(expect.objectContaining({
      folder: mp3, parts: [path.join(mp3, 'Heir.mp3')], audiobookId: 'ab-heir', absItemId: 'abs-heir',
    }));
    expect(mocks.triggerLibraryScan).toHaveBeenCalled();
  });

  it('leaves folders alone when no complete copy matches the book', async () => {
    mocks.checkRuntime.mockResolvedValue({ expectedMs: 40 * H, matches: null });
    const result = await run('apply');
    expect(result).toMatchObject({ cleaned: 0, merged: 0, no_complete_copy: 4 });
    expect((await fs.readdir(path.join(root, 'Halo'))).sort()).toEqual(['Halo.m4a', 'Halo.m4b']);
  });

  it('stops when a merge is cancelled mid-book', async () => {
    mocks.mergeFolderInPlace.mockResolvedValueOnce({ status: 'cancelled' });
    const result = await run('apply');
    expect(result).toMatchObject({ cancelled: true, merged: 0 });
  });
});
