/**
 * Component: Library Merge Processor Tests
 * Documentation: documentation/features/chapter-merging.md
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaMock } from '../helpers/prisma';

const prismaMock = createPrismaMock();
const mocks = vi.hoisted(() => ({
  collectCandidates: vi.fn(),
  listMergeableParts: vi.fn(),
  totalDurationMs: vi.fn(),
  checkRuntime: vi.fn(),
  mergeFolderInPlace: vi.fn(),
  triggerLibraryScan: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ prisma: prismaMock }));
vi.mock('@/lib/processors/fix-chapters.processor', () => ({
  collectCandidates: mocks.collectCandidates,
  getMediaDir: async () => '/Audiobooks/Audio',
}));
vi.mock('@/lib/services/library-merge.service', () => ({
  listMergeableParts: mocks.listMergeableParts,
  totalDurationMs: mocks.totalDurationMs,
  checkRuntime: mocks.checkRuntime,
  mergeFolderInPlace: mocks.mergeFolderInPlace,
  needsReencode: (format: string) => format !== '.m4b',
}));
vi.mock('@/lib/utils/library-book-files', () => ({ triggerLibraryScan: mocks.triggerLibraryScan }));
vi.mock('@/lib/utils/chapter-merger', () => ({ formatDuration: (ms: number) => `${Math.round(ms / 60000)}m` }));

const HOUR = 3_600_000;
const books = [
  { title: 'HWFwM 10', asin: 'A1', folder: '/lib/hwfwm10', absItemId: 'abs-1', author: 'Shirtaloon' },
  { title: 'MP3 Book', asin: 'A2', folder: '/lib/mp3book', author: 'Someone', audiobookId: 'ab-2' },
  { title: 'Two Books In One', asin: 'A3', folder: '/lib/wrong' },
  { title: 'No ASIN Runtime', asin: 'A4', folder: '/lib/unknown' },
  { title: 'Mixed', asin: 'A5', folder: '/lib/mixed' },
  { title: 'Already One File', asin: 'A6', folder: '/lib/single' },
  { title: 'Root File', asin: 'A7', file: '/lib/root.m4b' },
];

async function run(mode: 'report' | 'apply') {
  const { processMergeLibrary } = await import('@/lib/processors/merge-library.processor');
  return processMergeLibrary({ jobId: 'job-1', mode });
}

describe('processMergeLibrary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The 1s Audnexus throttle: let fake time advance on its own
    vi.useFakeTimers({ toFake: ['setTimeout'], shouldAdvanceTime: true, advanceTimeDelta: 1000 });
    mocks.collectCandidates.mockResolvedValue(books);
    mocks.listMergeableParts.mockImplementation(async (folder: string) => ({
      '/lib/hwfwm10': { ok: true, parts: ['p1', 'p2'], format: '.m4b' },
      '/lib/mp3book': { ok: true, parts: ['c1', 'c2', 'c3'], format: '.mp3' },
      '/lib/wrong': { ok: true, parts: ['x', 'y'], format: '.m4b' },
      '/lib/unknown': { ok: true, parts: ['u1', 'u2'], format: '.m4b' },
      '/lib/mixed': { ok: false, reason: 'mixed_formats', detail: '.mp3, .m4b' },
      '/lib/single': { ok: false, reason: 'single_file', detail: '1 audio file(s)' },
    } as Record<string, unknown>)[folder]);
    mocks.totalDurationMs.mockResolvedValue(10 * HOUR);
    mocks.checkRuntime.mockImplementation(async (_ms: number, asin: string) =>
      asin === 'A3' ? { expectedMs: 20 * HOUR, matches: false }
        : asin === 'A4' ? { expectedMs: null, matches: null }
          : { expectedMs: 10 * HOUR, matches: true });
    mocks.mergeFolderInPlace.mockResolvedValue({ status: 'merged', finalPath: '/lib/x.m4b', finalName: 'x.m4b', chapterCount: 30, sizeBytes: 1 });
    prismaMock.job.findUnique.mockResolvedValue({ cancelRequested: false });
  });

  afterEach(() => vi.useRealTimers());
  const runFast = (mode: 'report' | 'apply') => run(mode);

  it('report: lists only runtime-verified split books, flags slow re-encodes, merges nothing', async () => {
    const result = await runFast('report');
    expect(result).toMatchObject({
      mode: 'report', checked: 6, would_merge: 2, length_mismatch: 1, no_runtime: 1, mixed_formats: 1, single_file: 1, merged: 0,
    });
    expect(mocks.mergeFolderInPlace).not.toHaveBeenCalled();
    expect(mocks.triggerLibraryScan).not.toHaveBeenCalled();
  });

  it('apply: merges verified books (mp3 included) with their metadata, then scans once', async () => {
    const result = await runFast('apply');
    expect(result).toMatchObject({ mode: 'apply', merged: 2, length_mismatch: 1, no_runtime: 1 });
    expect(mocks.mergeFolderInPlace).toHaveBeenCalledTimes(2);
    expect(mocks.mergeFolderInPlace).toHaveBeenCalledWith(expect.objectContaining({
      folder: '/lib/hwfwm10', absItemId: 'abs-1', meta: expect.objectContaining({ title: 'HWFwM 10', author: 'Shirtaloon', asin: 'A1' }),
    }));
    expect(mocks.mergeFolderInPlace).toHaveBeenCalledWith(expect.objectContaining({ folder: '/lib/mp3book', audiobookId: 'ab-2', parts: ['c1', 'c2', 'c3'] }));
    expect(mocks.triggerLibraryScan).toHaveBeenCalledTimes(1);
  });

  it('stops when a merge is cancelled mid-book', async () => {
    mocks.mergeFolderInPlace.mockResolvedValueOnce({ status: 'cancelled' });
    const result = await runFast('apply');
    expect(result).toMatchObject({ cancelled: true, merged: 0 });
    expect(mocks.mergeFolderInPlace).toHaveBeenCalledTimes(1);
  });
});
