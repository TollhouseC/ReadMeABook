/**
 * Component: Audiobookshelf Chapter Sync Tests
 * Documentation: documentation/features/chapter-merging.md
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const absMock = vi.hoisted(() => ({ absRequest: vi.fn(), getABSItem: vi.fn() }));
const probeMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/services/audiobookshelf/api', () => absMock);
vi.mock('@/lib/utils/chapter-list', () => ({ probeEmbeddedChapters: probeMock }));

import { getABSChapterCount, pushChaptersToABS, syncFileChaptersToABS } from '@/lib/services/abs-chapter-sync';

describe('abs chapter sync', () => {
  beforeEach(() => vi.clearAllMocks());

  it('posts chapters to Audiobookshelf in seconds with ids', async () => {
    absMock.absRequest.mockResolvedValue({ success: true });
    await pushChaptersToABS('abs-1', [
      { title: 'Opening Credits', startMs: 0, endMs: 20_500 },
      { title: 'Chapter 1', startMs: 20_500, endMs: 600_000 },
    ]);
    expect(absMock.absRequest).toHaveBeenCalledWith('/items/abs-1/chapters', {
      method: 'POST',
      body: { chapters: [
        { id: 0, start: 0, end: 20.5, title: 'Opening Credits' },
        { id: 1, start: 20.5, end: 600, title: 'Chapter 1' },
      ] },
    });
  });

  it('reads the chapter count Audiobookshelf shows', async () => {
    absMock.getABSItem.mockResolvedValue({ media: { chapters: [{}, {}, {}] } });
    expect(await getABSChapterCount('abs-1')).toBe(3);
  });

  it('syncs a file\'s embedded chapters, and never throws', async () => {
    probeMock.mockResolvedValue([{ title: 'A', startMs: 0, endMs: 1000 }]);
    absMock.absRequest.mockResolvedValue({ success: true });
    expect(await syncFileChaptersToABS('abs-1', '/lib/book.m4b')).toBe(true);

    probeMock.mockResolvedValue([]);
    expect(await syncFileChaptersToABS('abs-1', '/lib/book.m4b')).toBe(false);

    probeMock.mockResolvedValue([{ title: 'A', startMs: 0, endMs: 1000 }]);
    absMock.absRequest.mockRejectedValue(new Error('ABS API error: 403'));
    expect(await syncFileChaptersToABS('abs-1', '/lib/book.m4b')).toBe(false);
  });
});
