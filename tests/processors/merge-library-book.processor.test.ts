/**
 * Component: Merge Library Book Processor Tests
 * Documentation: documentation/features/chapter-merging.md
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaMock } from '../helpers/prisma';

const prismaMock = createPrismaMock();
const config: Record<string, string> = {};
const configMock = vi.hoisted(() => ({ get: vi.fn(), getBackendMode: vi.fn() }));
const libraryServiceMock = vi.hoisted(() => ({ triggerLibraryScan: vi.fn() }));
const mergerMock = vi.hoisted(() => ({
  analyzeChapterFiles: vi.fn(),
  mergeChapters: vi.fn(),
  checkDiskSpace: vi.fn(),
  estimateOutputSize: vi.fn(),
}));
const getABSItemMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/db', () => ({ prisma: prismaMock }));
vi.mock('@/lib/services/config.service', () => ({ getConfigService: () => configMock }));
vi.mock('@/lib/services/library', () => ({ getLibraryService: () => libraryServiceMock }));
vi.mock('@/lib/utils/chapter-merger', () => mergerMock);
vi.mock('@/lib/utils/metadata-tagger', () => ({ tagAudioFileMetadata: vi.fn() }));
vi.mock('@/lib/services/audiobookshelf/api', () => ({ getABSItem: getABSItemMock }));

let mediaDir: string;
let tempDir: string;
let bookDir: string;

function setRequest(overrides: Record<string, unknown> = {}) {
  prismaMock.request.findFirst.mockResolvedValue({
    id: 'req-1',
    audiobook: {
      id: 'ab-1', title: 'HWFwM 10', author: 'Shirtaloon', narrator: null, audibleAsin: 'B0TEST0001',
      year: 2024, series: 'He Who Fights with Monsters', seriesPart: '10', filePath: bookDir, absItemId: null,
      ...overrides,
    },
  });
}

async function run() {
  const { processMergeLibraryBook } = await import('@/lib/processors/merge-library-book.processor');
  return processMergeLibraryBook({ requestId: 'req-1', jobId: 'job-1' });
}

beforeEach(async () => {
  vi.clearAllMocks();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rmab-merge-'));
  mediaDir = path.join(root, 'media');
  tempDir = path.join(root, 'tmp');
  bookDir = path.join(mediaDir, 'Shirtaloon', 'HWFwM 10');
  await fs.mkdir(bookDir, { recursive: true });
  process.env.TEMP_DIR = tempDir;

  Object.keys(config).forEach(k => delete config[k]);
  Object.assign(config, { media_dir: mediaDir, 'audiobookshelf.trigger_scan_after_import': 'true', 'audiobookshelf.library_id': 'lib-1' });
  configMock.get.mockImplementation(async (key: string) => config[key] ?? null);
  configMock.getBackendMode.mockResolvedValue('audiobookshelf');

  mergerMock.estimateOutputSize.mockResolvedValue(10);
  mergerMock.checkDiskSpace.mockResolvedValue(1_000_000);
  mergerMock.analyzeChapterFiles.mockImplementation(async (paths: string[]) =>
    paths.map(p => ({ path: p, filename: path.basename(p), duration: 1000, chapterTitle: path.basename(p) })));
  mergerMock.mergeChapters.mockImplementation(async (_chapters: unknown, options: { outputPath: string }) => {
    await fs.writeFile(options.outputPath, 'merged-audio');
    return { success: true, outputPath: options.outputPath, chapterCount: 42 };
  });
  prismaMock.audiobook.update.mockResolvedValue({});
  setRequest();
});

afterEach(() => {
  delete process.env.TEMP_DIR;
});

describe('processMergeLibraryBook', () => {
  it('swaps the parts for one merged M4B, updates the record and scans', async () => {
    for (let i = 1; i <= 3; i++) await fs.writeFile(path.join(bookDir, `HWFwM 10 - 0${i}.m4b`), `part${i}`);
    await fs.writeFile(path.join(bookDir, 'cover.jpg'), 'img');

    const result = await run();

    expect(result).toMatchObject({ success: true, file: 'HWFwM 10.m4b', partsMerged: 3, chapterCount: 42 });
    expect((await fs.readdir(bookDir)).sort()).toEqual(['HWFwM 10.m4b', 'cover.jpg']);
    expect(await fs.readFile(path.join(bookDir, 'HWFwM 10.m4b'), 'utf8')).toBe('merged-audio');
    expect(mergerMock.mergeChapters).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ asin: 'B0TEST0001' }), expect.anything());
    expect(prismaMock.audiobook.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'ab-1' }, data: expect.objectContaining({ fileFormat: 'm4b' }),
    }));
    expect(libraryServiceMock.triggerLibraryScan).toHaveBeenCalledWith('lib-1');
    expect(await fs.readdir(tempDir)).toEqual([]); // temp output cleaned up
  });

  it('keeps every original part when the merge fails', async () => {
    for (let i = 1; i <= 2; i++) await fs.writeFile(path.join(bookDir, `part${i}.m4b`), `part${i}`);
    mergerMock.mergeChapters.mockResolvedValue({ success: false, error: 'validation failed' });

    await expect(run()).rejects.toThrow('validation failed');
    expect((await fs.readdir(bookDir)).sort()).toEqual(['part1.m4b', 'part2.m4b']);
    expect(prismaMock.audiobook.update).not.toHaveBeenCalled();
  });

  it('refuses a book that is already a single file', async () => {
    await fs.writeFile(path.join(bookDir, 'HWFwM 10.m4b'), 'single');
    await expect(run()).rejects.toThrow('nothing to merge');
    expect(mergerMock.mergeChapters).not.toHaveBeenCalled();
  });

  it('falls back to the path template when the recorded path is missing', async () => {
    config.audiobook_path_template = '{author}/{title}';
    setRequest({ filePath: null });
    for (let i = 1; i <= 2; i++) await fs.writeFile(path.join(bookDir, `p${i}.mp3`), 'x');

    const result = await run();
    expect(result.folder).toBe(bookDir);
  });

  it('never touches a folder outside the media directory', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'rmab-outside-'));
    for (let i = 1; i <= 2; i++) await fs.writeFile(path.join(outside, `p${i}.m4b`), 'x');
    config.audiobook_path_template = '{author}/missing';
    setRequest({ filePath: outside });

    await expect(run()).rejects.toThrow('Could not find the library folder');
    expect((await fs.readdir(outside)).length).toBe(2);
  });
});
