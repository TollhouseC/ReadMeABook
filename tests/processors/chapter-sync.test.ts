/**
 * Component: Chapter Sync to Audiobookshelf Tests
 * Documentation: documentation/features/chapter-merging.md
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaMock } from '../helpers/prisma';

const prismaMock = createPrismaMock();
const mocks = vi.hoisted(() => ({
  collectCandidates: vi.fn(),
  probeEmbeddedChapters: vi.fn(),
  isAudiobookshelfBackend: vi.fn(),
  getABSChapterCount: vi.fn(),
  pushChaptersToABS: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ prisma: prismaMock }));
vi.mock('@/lib/processors/fix-chapters.processor', () => ({
  collectCandidates: mocks.collectCandidates,
  getMediaDir: async () => '/Audiobooks/Audio',
}));
vi.mock('@/lib/utils/chapter-list', () => ({ probeEmbeddedChapters: mocks.probeEmbeddedChapters }));
vi.mock('@/lib/services/abs-chapter-sync', () => ({
  isAudiobookshelfBackend: mocks.isAudiobookshelfBackend,
  getABSChapterCount: mocks.getABSChapterCount,
  pushChaptersToABS: mocks.pushChaptersToABS,
}));

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
const chapters = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `Ch ${i + 1}`, startMs: i * 1000, endMs: (i + 1) * 1000 }));

async function run(apply: boolean) {
  const { processChapterSync } = await import('@/lib/processors/chapter-sync');
  return processChapterSync(apply, logger, 'job-1');
}

describe('processChapterSync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isAudiobookshelfBackend.mockResolvedValue(true);
    mocks.collectCandidates.mockResolvedValue([
      { title: 'Sailing to Sarantium', asin: 'A1', file: '/lib/sts.m4b', absItemId: 'abs-1', absChapterCount: 3 },
      { title: 'Already Rich In ABS', asin: 'A2', file: '/lib/rich.m4b', absItemId: 'abs-2' },
      { title: 'Plex-only import', asin: 'A3', file: '/lib/x.m4b' }, // no ABS item → ignored
    ]);
    mocks.probeEmbeddedChapters.mockImplementation(async (file: string) => (file === '/lib/sts.m4b' ? chapters(14) : chapters(3)));
    mocks.getABSChapterCount.mockResolvedValue(20); // ABS has more than the file for "rich"
    mocks.pushChaptersToABS.mockResolvedValue(undefined);
  });

  it('report mode lists books where the file has better chapters than ABS', async () => {
    const result = await run(false);
    expect(result).toMatchObject({ mode: 'sync_report', checked: 2, would_sync: 1, in_sync: 1, synced: 0 });
    expect(mocks.pushChaptersToABS).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('Would sync "Sailing to Sarantium": Audiobookshelf 3 → file 14 chapters');
  });

  it('apply mode pushes the file chapters, never overwriting a richer ABS list', async () => {
    const result = await run(true);
    expect(result).toMatchObject({ mode: 'sync_apply', synced: 1, in_sync: 1 });
    expect(mocks.pushChaptersToABS).toHaveBeenCalledTimes(1);
    expect(mocks.pushChaptersToABS).toHaveBeenCalledWith('abs-1', chapters(14));
  });

  it('does nothing outside Audiobookshelf mode', async () => {
    mocks.isAudiobookshelfBackend.mockResolvedValue(false);
    expect(await run(true)).toMatchObject({ checked: 0 });
    expect(mocks.collectCandidates).not.toHaveBeenCalled();
  });
});
