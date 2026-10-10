/**
 * Component: Single MP3 → M4B Conversion Tests
 * Documentation: documentation/features/chapter-merging.md
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ analyzeChapterFiles: vi.fn(), mergeChapters: vi.fn() }));
vi.mock('@/lib/utils/chapter-merger', () => mocks);

import { convertMp3ToM4b, estimateConvertMinutes, isMp3 } from '@/lib/utils/mp3-convert';

beforeEach(() => vi.clearAllMocks());

describe('mp3-convert', () => {
  it('encodes the one MP3 through the merge pipeline into the temp output', async () => {
    const chapter = { path: '/d/Heir.mp3', filename: 'Heir.mp3', duration: 3_600_000 };
    mocks.analyzeChapterFiles.mockResolvedValue([chapter]);
    mocks.mergeChapters.mockResolvedValue({ success: true, outputPath: '/tmp/Heir.m4b', chapterCount: 30 });

    const result = await convertMp3ToM4b('/d/Heir.mp3', { title: 'Heir', author: 'A', asin: 'B0H' }, '/tmp/Heir.m4b', 0o775);

    expect(mocks.mergeChapters).toHaveBeenCalledWith([chapter], expect.objectContaining({ title: 'Heir', asin: 'B0H', outputPath: '/tmp/Heir.m4b', dirMode: 0o775 }), undefined);
    expect(result).toEqual({ success: true, outputPath: '/tmp/Heir.m4b' });
  });

  it('reports failures (unreadable file, failed validation)', async () => {
    mocks.analyzeChapterFiles.mockResolvedValue([]);
    expect(await convertMp3ToM4b('/d/x.mp3', { title: 'X', author: 'A' }, '/tmp/x.m4b', 0o775)).toEqual({ success: false, error: 'could not read the MP3' });

    mocks.analyzeChapterFiles.mockResolvedValue([{ path: '/d/x.mp3', filename: 'x.mp3', duration: 1 }]);
    mocks.mergeChapters.mockResolvedValue({ success: false, error: 'Duration mismatch' });
    expect(await convertMp3ToM4b('/d/x.mp3', { title: 'X', author: 'A' }, '/tmp/x.m4b', 0o775)).toEqual({ success: false, error: 'Duration mismatch' });
  });

  it('helpers', () => {
    expect(isMp3('Book.MP3')).toBe(true);
    expect(isMp3('Book.m4b')).toBe(false);
    expect(estimateConvertMinutes(28.9 * 3_600_000)).toBe(35);
  });
});
