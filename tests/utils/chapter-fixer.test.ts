/**
 * Component: Chapter Fixer Tests
 * Documentation: documentation/features/chapter-merging.md
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChapterMarker } from '@/lib/utils/chapter-list';

const mocks = vi.hoisted(() => ({
  probeAudioFile: vi.fn(),
  probeEmbeddedChapters: vi.fn(),
  fetchAudnexusChapters: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock('child_process', () => {
  const custom = Symbol.for('nodejs.util.promisify.custom');
  const execFile = vi.fn();
  (execFile as any)[custom] = (...args: unknown[]) => mocks.execFile(...args);
  return { execFile, exec: vi.fn() };
});
vi.mock('@/lib/utils/chapter-merger', () => ({ probeAudioFile: mocks.probeAudioFile }));
vi.mock('@/lib/utils/chapter-list', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/utils/chapter-list')>()),
  probeEmbeddedChapters: mocks.probeEmbeddedChapters,
}));
vi.mock('@/lib/integrations/audnexus-chapters', () => ({ fetchAudnexusChapters: mocks.fetchAudnexusChapters }));

import { chapterReplacementReason, fixChaptersIfBetter } from '@/lib/utils/chapter-fixer';

const markers = (titles: string[], lengthMs = 60_000): ChapterMarker[] =>
  titles.map((title, i) => ({ title, startMs: i * lengthMs, endMs: (i + 1) * lengthMs }));
const numbered = (n: number, prefix = 'Chapter ') => markers(Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`));

describe('chapterReplacementReason', () => {
  const audnexus = markers(['Opening Credits', 'Prologue', ...Array.from({ length: 18 }, (_, i) => `Chapter ${i + 1}`)]);

  it('replaces missing or single chapters', () => {
    expect(chapterReplacementReason([], audnexus)).toMatch(/0 chapter/);
    expect(chapterReplacementReason(markers(['Book']), audnexus)).toMatch(/1 chapter/);
  });

  it('replaces far fewer chapters (e.g. one per merged part)', () => {
    expect(chapterReplacementReason(numbered(9, 'Part '), audnexus)).toMatch(/only 9 chapters vs 20/);
  });

  it('replaces identical or number-only names when Audnexus has real titles', () => {
    expect(chapterReplacementReason(markers(Array(20).fill('He Who Fights with Monsters 10')), audnexus)).toMatch(/same name/);
    expect(chapterReplacementReason(numbered(20, 'Track '), audnexus)).toMatch(/only numbers/);
    expect(chapterReplacementReason(numbered(20, ''), audnexus)).toMatch(/only numbers/);
  });

  it('keeps similar chapters, even plain "Chapter N"', () => {
    expect(chapterReplacementReason(numbered(19), audnexus)).toBeNull();
    expect(chapterReplacementReason(numbered(20, 'Track '), numbered(20))).toBeNull(); // Audnexus no better
  });
});

describe('fixChaptersIfBetter', () => {
  let dir: string;
  let file: string;
  const audnexusData = {
    isAccurate: true,
    runtimeLengthMs: 1_200_000,
    chapters: Array.from({ length: 20 }, (_, i) => ({ title: i === 0 ? 'Opening Credits' : `Chapter ${i}`, startOffsetMs: i * 60_000, lengthMs: 60_000 })),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmab-chfix-'));
    file = path.join(dir, 'Book.m4b');
    await fs.writeFile(file, 'original');
    process.env.TEMP_DIR = path.join(dir, 'tmp');
    mocks.probeAudioFile.mockResolvedValue({ duration: 1_200_000, format: 'mp4' });
    mocks.probeEmbeddedChapters.mockImplementation(async (p: string) => (p.endsWith('.rmab-tmp') ? numbered(20) : numbered(9, 'Part ')));
    mocks.fetchAudnexusChapters.mockResolvedValue(audnexusData);
    mocks.execFile.mockImplementation(async (cmd: string, args: string[]) => {
      if (cmd === 'ffprobe') return { stdout: '1\n', stderr: '' }; // has a cover stream
      await fs.writeFile(args[args.length - 1], 'rewritten');
      return { stdout: '', stderr: '' };
    });
  });

  it('reports what would change without touching the file', async () => {
    const result = await fixChaptersIfBetter(file, 'B0TEST0001', { apply: false });
    expect(result).toMatchObject({ status: 'would_fix', currentCount: 9, audnexusCount: 20, lookedUp: true });
    expect(mocks.execFile).not.toHaveBeenCalled();
    expect(await fs.readFile(file, 'utf8')).toBe('original');
  });

  it('rewrites chapters with a stream copy (keeping the cover) and swaps the file in', async () => {
    const result = await fixChaptersIfBetter(file, 'B0TEST0001', { apply: true });

    expect(result.status).toBe('fixed');
    expect(await fs.readFile(file, 'utf8')).toBe('rewritten');
    const ffmpegArgs = mocks.execFile.mock.calls.find(([cmd]) => cmd === 'ffmpeg')![1] as string[];
    expect(ffmpegArgs).toEqual(expect.arrayContaining(['-c', 'copy', '-map_chapters', '1', '-map', '0:v', 'attached_pic']));
    expect((await fs.readdir(dir)).filter(f => f.endsWith('.rmab-tmp'))).toEqual([]);
  });

  it('keeps the original when the rewritten file fails validation', async () => {
    mocks.probeAudioFile.mockImplementation(async (p: string) => ({ duration: p.endsWith('.rmab-tmp') ? 600_000 : 1_200_000, format: 'mp4' }));

    const result = await fixChaptersIfBetter(file, 'B0TEST0001', { apply: true });

    expect(result).toMatchObject({ status: 'failed' });
    expect(result.reason).toMatch(/duration changed/);
    expect(await fs.readFile(file, 'utf8')).toBe('original');
    expect(await fs.readdir(dir)).not.toContain('Book.m4b.rmab-tmp');
  });

  it('skips when Audnexus does not match this recording', async () => {
    mocks.fetchAudnexusChapters.mockResolvedValue({ ...audnexusData, runtimeLengthMs: 2_000_000 });
    expect(await fixChaptersIfBetter(file, 'B0TEST0001', { apply: true })).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/runtime mismatch/) });
  });

  it('keeps good chapters and skips books without an ASIN or mp4 container', async () => {
    mocks.probeEmbeddedChapters.mockResolvedValue(numbered(20));
    expect((await fixChaptersIfBetter(file, 'B0TEST0001', { apply: true })).status).toBe('kept');
    expect((await fixChaptersIfBetter(file, null, { apply: true })).status).toBe('skipped');
    expect((await fixChaptersIfBetter(path.join(dir, 'a.mp3'), 'B0TEST0001', { apply: true })).status).toBe('skipped');
  });
});
