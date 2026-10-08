/**
 * Component: Chapter List Builder Tests
 * Documentation: documentation/features/chapter-merging.md
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChapterFile } from '@/lib/utils/chapter-merger';

const execState = vi.hoisted(() => {
  const state = { chaptersByFile: {} as Record<string, unknown[]> };
  const custom = Symbol.for('nodejs.util.promisify.custom');
  const exec = vi.fn();
  (exec as any)[custom] = (command: string) => {
    const file = command.match(/"([^"]+)"$/)?.[1] ?? '';
    return Promise.resolve({ stdout: JSON.stringify({ chapters: state.chaptersByFile[file] ?? [] }), stderr: '' });
  };
  return { exec, state };
});
const fetchAudnexusChaptersMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({ exec: execState.exec, spawn: vi.fn() }));
vi.mock('@/lib/integrations/audnexus-chapters', () => ({ fetchAudnexusChapters: fetchAudnexusChaptersMock }));

import {
  buildChapterList,
  fitAudnexusChapters,
  offsetEmbeddedChapters,
  toFfmetadata,
} from '@/lib/utils/chapter-list';

const file = (name: string, durationMin: number): ChapterFile => ({
  path: `/lib/${name}`, filename: name, duration: durationMin * 60_000, chapterTitle: name,
});
const parts = [file('part1.m4b', 60), file('part2.m4b', 60)]; // 2h total

const ffChapter = (startSec: number, endSec: number, title: string) =>
  ({ start_time: String(startSec), end_time: String(endSec), tags: { title } });

const audnexus = (overrides: Record<string, unknown> = {}) => ({
  isAccurate: true,
  runtimeLengthMs: 7_200_000,
  chapters: [
    { title: 'Opening Credits', startOffsetMs: 0, lengthMs: 20_000 },
    { title: 'Chapter 1', startOffsetMs: 20_000, lengthMs: 3_580_000 },
    { title: 'Chapter 2', startOffsetMs: 3_600_000, lengthMs: 3_600_000 },
  ],
  ...overrides,
});

describe('fitAudnexusChapters', () => {
  it('uses official chapters when accurate and the runtime matches', () => {
    const markers = fitAudnexusChapters(audnexus(), 7_210_000);
    expect(markers?.map(m => m.title)).toEqual(['Opening Credits', 'Chapter 1', 'Chapter 2']);
    expect(markers?.[1]).toEqual({ title: 'Chapter 1', startMs: 20_000, endMs: 3_600_000 });
    expect(markers?.[2].endMs).toBe(7_210_000); // last chapter ends at the merged length
  });

  it('rejects a different edition (runtime off by more than the tolerance)', () => {
    expect(fitAudnexusChapters(audnexus(), 7_200_000 + 120_000)).toBeNull();
  });

  it('rejects chapter lists not marked accurate', () => {
    expect(fitAudnexusChapters(audnexus({ isAccurate: false }), 7_200_000)).toBeNull();
  });
});

describe('offsetEmbeddedChapters', () => {
  it('offsets each part\'s chapters by the parts before it', () => {
    const markers = offsetEmbeddedChapters(parts, [
      [{ title: 'Ch 1', startMs: 0, endMs: 1_800_000 }, { title: 'Ch 2', startMs: 1_800_000, endMs: 3_600_000 }],
      [{ title: 'Ch 3', startMs: 0, endMs: 3_600_000 }],
    ]);
    expect(markers).toEqual([
      { title: 'Ch 1', startMs: 0, endMs: 1_800_000 },
      { title: 'Ch 2', startMs: 1_800_000, endMs: 3_600_000 },
      { title: 'Ch 3', startMs: 3_600_000, endMs: 7_200_000 },
    ]);
  });

  it('is not used when a part has no chapters or it adds nothing over one-per-file', () => {
    expect(offsetEmbeddedChapters(parts, [[{ title: 'A', startMs: 0, endMs: 1 }], []])).toBeNull();
    expect(offsetEmbeddedChapters(parts, [
      [{ title: 'A', startMs: 0, endMs: 3_600_000 }],
      [{ title: 'B', startMs: 0, endMs: 3_600_000 }],
    ])).toBeNull();
  });
});

describe('buildChapterList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execState.state.chaptersByFile = {};
    fetchAudnexusChaptersMock.mockResolvedValue(null);
  });

  it('prefers Audnexus when it fits', async () => {
    fetchAudnexusChaptersMock.mockResolvedValue(audnexus());
    const result = await buildChapterList(parts, { asin: 'B0TEST0001' });
    expect(result.source).toBe('audnexus');
    expect(fetchAudnexusChaptersMock).toHaveBeenCalledWith('B0TEST0001');
  });

  it('falls back to embedded chapters (m4b parts) when Audnexus does not fit', async () => {
    fetchAudnexusChaptersMock.mockResolvedValue(audnexus({ runtimeLengthMs: 9_000_000 }));
    execState.state.chaptersByFile = {
      '/lib/part1.m4b': [ffChapter(0, 1800, 'One'), ffChapter(1800, 3600, 'Two')],
      '/lib/part2.m4b': [ffChapter(0, 3600, 'Three')],
    };
    const result = await buildChapterList(parts, { asin: 'B0TEST0001' });
    expect(result.source).toBe('embedded');
    expect(result.chapters.map(c => c.title)).toEqual(['One', 'Two', 'Three']);
  });

  it('skips Audnexus without an ASIN and ends at one chapter per file', async () => {
    const result = await buildChapterList(parts, {});
    expect(fetchAudnexusChaptersMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ source: 'per-file', chapters: [{ title: 'part1.m4b' }, { title: 'part2.m4b' }] });
  });
});

describe('toFfmetadata', () => {
  it('writes escaped FFMETADATA1 chapters', () => {
    expect(toFfmetadata([{ title: 'A=B; #1', startMs: 0, endMs: 1000 }])).toBe(
      ';FFMETADATA1\n\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=1000\ntitle=A\\=B\\; \\#1\n'
    );
  });
});
