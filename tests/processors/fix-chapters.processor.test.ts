/**
 * Component: Fix Chapters Processor Tests
 * Documentation: documentation/features/chapter-merging.md
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaMock } from '../helpers/prisma';

const prismaMock = createPrismaMock();
const config: Record<string, string> = {};
const configMock = vi.hoisted(() => ({ get: vi.fn(), getBackendMode: vi.fn() }));
const libraryServiceMock = vi.hoisted(() => ({ triggerLibraryScan: vi.fn() }));
const fixMock = vi.hoisted(() => vi.fn());
const getABSItemMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/db', () => ({ prisma: prismaMock }));
vi.mock('@/lib/services/config.service', () => ({ getConfigService: () => configMock }));
vi.mock('@/lib/services/library', () => ({ getLibraryService: () => libraryServiceMock }));
vi.mock('@/lib/services/audiobookshelf/api', () => ({ getABSItem: getABSItemMock }));
vi.mock('@/lib/utils/chapter-fixer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/utils/chapter-fixer')>()),
  fixChaptersIfBetter: fixMock,
}));

let mediaDir: string;

async function makeBook(name: string, files: string[]): Promise<string> {
  const dir = path.join(mediaDir, 'Author', name);
  await fs.mkdir(dir, { recursive: true });
  for (const f of files) await fs.writeFile(path.join(dir, f), 'x');
  return dir;
}

const book = (id: string, title: string, filePath: string | null, extra: Record<string, unknown> = {}) => ({
  id, title, author: 'Author', narrator: null, audibleAsin: `ASIN-${id}`, year: null, series: null, seriesPart: null,
  filePath, absItemId: null, ...extra,
});

async function run(payload: Record<string, unknown>) {
  const { processFixChapters } = await import('@/lib/processors/fix-chapters.processor');
  return processFixChapters({ jobId: 'job-1', ...payload } as any);
}

beforeEach(async () => {
  vi.clearAllMocks();
  mediaDir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'rmab-fixch-')), 'media');
  await fs.mkdir(mediaDir, { recursive: true });
  Object.keys(config).forEach(k => delete config[k]);
  Object.assign(config, { media_dir: mediaDir, 'plex.trigger_scan_after_import': 'true', plex_audiobook_library_id: 'lib-1' });
  configMock.get.mockImplementation(async (key: string) => config[key] ?? null);
  configMock.getBackendMode.mockResolvedValue('plex');
  fixMock.mockResolvedValue({ status: 'fixed', reason: 'only 9 chapters vs 35', currentCount: 9, audnexusCount: 35, lookedUp: false });
});

describe('processFixChapters — single book', () => {
  it('applies to the book\'s single file and rescans the library', async () => {
    const dir = await makeBook('Book A', ['Book A.m4b', 'cover.jpg']);
    prismaMock.request.findFirst.mockResolvedValue({ id: 'req-1', audiobook: book('a', 'Book A', dir) });

    const result = await run({ requestId: 'req-1', mode: 'apply' });

    expect(fixMock).toHaveBeenCalledWith(path.join(dir, 'Book A.m4b'), 'ASIN-a', expect.objectContaining({ apply: true }));
    expect(result).toMatchObject({ status: 'fixed' });
    expect(libraryServiceMock.triggerLibraryScan).toHaveBeenCalledWith('lib-1');
  });

  it('refuses multi-file books (merge first)', async () => {
    const dir = await makeBook('Split', ['p1.m4b', 'p2.m4b']);
    prismaMock.request.findFirst.mockResolvedValue({ id: 'req-2', audiobook: book('b', 'Split', dir) });

    await expect(run({ requestId: 'req-2' })).rejects.toThrow('merge first');
    expect(fixMock).not.toHaveBeenCalled();
  });
});

describe('processFixChapters — library-wide', () => {
  it('report mode checks single-file books only and never applies', async () => {
    const single = await makeBook('Single', ['Single.m4b']);
    const split = await makeBook('Split', ['p1.mp3', 'p2.mp3']);
    prismaMock.audiobook.findMany.mockResolvedValue([book('s', 'Single', single), book('m', 'Split', split)]);
    fixMock.mockResolvedValue({ status: 'would_fix', reason: 'x', currentCount: 1, audnexusCount: 20, lookedUp: false });

    const result = await run({ mode: 'report' });

    expect(fixMock).toHaveBeenCalledTimes(1);
    expect(fixMock).toHaveBeenCalledWith(path.join(single, 'Single.m4b'), 'ASIN-s', expect.objectContaining({ apply: false }));
    expect(result).toMatchObject({ mode: 'report', checked: 2, would_fix: 1, not_single_file: 1, fixed: 0 });
    expect(libraryServiceMock.triggerLibraryScan).not.toHaveBeenCalled();
  });

  it('apply mode includes reachable Audiobookshelf items and skips duplicates/unreachable', async () => {
    configMock.getBackendMode.mockResolvedValue('audiobookshelf');
    Object.assign(config, { 'audiobookshelf.trigger_scan_after_import': 'true', 'audiobookshelf.library_id': 'abs-lib' });
    const imported = await makeBook('Imported', ['Imported.m4b']);
    const absOnly = await makeBook('Abs Only', ['Abs Only.m4b']);
    prismaMock.audiobook.findMany.mockResolvedValue([book('i', 'Imported', imported)]);
    prismaMock.plexLibrary.findMany.mockResolvedValue([
      { plexGuid: 'abs-1', asin: 'ASIN-i', title: 'Imported' }, // same folder as the imported book
      { plexGuid: 'abs-2', asin: 'ASIN-x', title: 'Abs Only' },
      { plexGuid: 'abs-3', asin: 'ASIN-y', title: 'Elsewhere' },
    ]);
    getABSItemMock.mockImplementation(async (id: string) => ({
      'abs-1': { path: imported }, 'abs-2': { path: absOnly }, 'abs-3': { path: '/somewhere/else' },
    } as Record<string, unknown>)[id]);

    const result = await run({ mode: 'apply' });

    expect(fixMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ mode: 'apply', checked: 2, fixed: 2 });
    expect(libraryServiceMock.triggerLibraryScan).toHaveBeenCalledWith('abs-lib');
  });
});
