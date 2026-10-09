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
    expect(await fs.readdir(path.join(root, 'Empire'))).toEqual(['Empire - 01.m4b']);
    expect((await fs.readdir(path.join(root, 'Mixed'))).sort()).toEqual(['Book.m4b', 'Other.m4b']);
    expect(mocks.syncFileChaptersToABS).toHaveBeenCalledWith('abs-halo', path.join(root, 'Halo', 'Halo.m4b'), expect.anything());
    expect(mocks.mergeFolderInPlace).toHaveBeenCalledTimes(1);
    expect(mocks.mergeFolderInPlace).toHaveBeenCalledWith(expect.objectContaining({
      folder: path.join(root, 'Ender'), audiobookId: 'ab-ender',
      parts: [path.join(root, 'Ender', 'Ender - 1.mp3'), path.join(root, 'Ender', 'Ender - 2.mp3')],
    }));
    expect(mocks.triggerLibraryScan).toHaveBeenCalledTimes(1);
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
