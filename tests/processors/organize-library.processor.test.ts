/**
 * Component: Library Organize Processor Tests
 * Documentation: documentation/phase3/file-organization.md
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaMock } from '../helpers/prisma';

const prismaMock = createPrismaMock();
const state = vi.hoisted(() => ({ root: '' }));
const mocks = vi.hoisted(() => ({ collectCandidates: vi.fn(), triggerLibraryScan: vi.fn(), configGet: vi.fn() }));

vi.mock('@/lib/db', () => ({ prisma: prismaMock }));
vi.mock('@/lib/processors/fix-chapters.processor', () => ({
  collectCandidates: mocks.collectCandidates,
  getMediaDir: async () => state.root,
}));
vi.mock('@/lib/utils/library-book-files', () => ({ triggerLibraryScan: mocks.triggerLibraryScan }));
vi.mock('@/lib/services/config.service', () => ({ getConfigService: () => ({ get: mocks.configGet }) }));
const forceRescan = vi.hoisted(() => vi.fn());
vi.mock('@/lib/services/abs-maintenance', () => ({ forceRescanABS: forceRescan }));

const HW = 'He Who Fights with Monsters';
const RMAB_AUTHOR = 'Shirtaloon, Travis Deverell';
let configDir: string;

async function book(...parts: string[]) {
  const dir = path.join(state.root, ...parts);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${parts[parts.length - 1]}.m4b`), 'x');
  await fs.writeFile(path.join(dir, 'cover.jpg'), 'x');
  return dir;
}

async function run(mode: 'report' | 'apply') {
  const { processOrganizeLibrary } = await import('@/lib/processors/organize-library.processor');
  return processOrganizeLibrary({ mode });
}

beforeEach(async () => {
  vi.clearAllMocks();
  state.root = await fs.mkdtemp(path.join(os.tmpdir(), 'rmab-organize-'));
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmab-config-'));
  process.env.CONFIG_DIR = configDir;
  mocks.configGet.mockImplementation(async (key: string) => (key === 'audiobook_path_template' ? '{author}/{series}/{title}' : null));
  prismaMock.audiobook.findMany.mockResolvedValue([
    { id: 'ab-1', audibleAsin: 'B1', author: RMAB_AUTHOR, series: HW, versionLabel: null },
    { id: 'ab-2', audibleAsin: 'B2', author: RMAB_AUTHOR, series: HW, versionLabel: null },
  ]);
  prismaMock.audiobook.updateMany.mockResolvedValue({ count: 1 });
  forceRescan.mockResolvedValue(false);
});

afterEach(async () => {
  delete process.env.CONFIG_DIR;
  await fs.rm(state.root, { recursive: true, force: true });
  await fs.rm(configDir, { recursive: true, force: true });
});

describe('processOrganizeLibrary', () => {
  it('reports, then moves a split author back with an undo log', async () => {
    const book1 = await book(RMAB_AUTHOR, HW, `${HW} 1`);
    const book2 = await book('Travis Deverell Shirtaloon', HW, `${HW} 2`);
    mocks.collectCandidates.mockResolvedValue([
      { title: `${HW} 1`, asin: 'B1', folder: book1, audiobookId: 'ab-1', author: RMAB_AUTHOR, series: HW },
      { title: `${HW} 2`, asin: 'B2', folder: book2, absItemId: 'li-2', author: 'Travis Deverell Shirtaloon', series: HW },
    ]);

    const report = await run('report');
    expect(report).toMatchObject({ would_move: 1, moved: 0, in_place: 1 });
    expect(await fs.readdir(book2)).toContain(`${HW} 2.m4b`); // untouched

    // Earlier undo logs are all kept
    const undoDir = path.join(configDir, 'organize-undo');
    await fs.mkdir(undoDir, { recursive: true });
    for (let i = 0; i < 25; i++) await fs.writeFile(path.join(undoDir, `undo-2020010${i % 10}-0000${String(i).padStart(2, '0')}.json`), '[]');

    const result = await run('apply');
    const target = path.join(state.root, RMAB_AUTHOR, HW, `${HW} 2`);
    expect(result).toMatchObject({ moved: 1, failed: 0 });
    expect((await fs.readdir(target)).sort()).toEqual([`${HW} 2.m4b`, 'cover.jpg']);
    await expect(fs.stat(path.join(state.root, 'Travis Deverell Shirtaloon'))).rejects.toThrow(); // emptied folders removed
    expect(prismaMock.audiobook.updateMany).toHaveBeenCalledWith({ where: { id: 'ab-2' }, data: { filePath: target } });
    expect(prismaMock.audiobook.updateMany).toHaveBeenCalledWith({ where: { absItemId: 'li-2' }, data: { filePath: target } });
    expect(forceRescan).toHaveBeenCalled(); // Audiobookshelf re-reads moved items
    expect(mocks.triggerLibraryScan).toHaveBeenCalled(); // fallback when not on Audiobookshelf (mock returns undefined)

    const logs = (await fs.readdir(undoDir)).sort();
    expect(logs).toHaveLength(26);
    const entries = JSON.parse(await fs.readFile(path.join(undoDir, logs[logs.length - 1]), 'utf-8'));
    expect(entries).toEqual([expect.objectContaining({ from: book2, to: target, title: `${HW} 2` })]);
  });

  it('does not move onto an existing book or out of a folder holding another book', async () => {
    const book1 = await book(RMAB_AUTHOR, HW, `${HW} 2`);
    const dupe = await book('Travis Deverell Shirtaloon', HW, `${HW} 2`);
    mocks.collectCandidates.mockResolvedValue([
      { title: `${HW} 2`, asin: 'B2', folder: book1, author: RMAB_AUTHOR, series: HW },
      { title: `${HW} 2 copy`, asin: 'B2', folder: dupe, author: 'Travis Deverell Shirtaloon', series: HW },
    ]);

    const result = await run('apply');

    expect(result).toMatchObject({ moved: 0, blocked: 1 });
    expect(await fs.readdir(dupe)).toContain(`${HW} 2.m4b`);
    expect(mocks.triggerLibraryScan).not.toHaveBeenCalled();
  });

  it('ignores recorded folders without audio and templates without {author}', async () => {
    const emptyFolder = path.join(state.root, 'Travis Deverell Shirtaloon', HW, `${HW} 3`);
    await fs.mkdir(emptyFolder, { recursive: true });
    mocks.collectCandidates.mockResolvedValue([{ title: `${HW} 3`, asin: 'B3', folder: emptyFolder, author: RMAB_AUTHOR, series: HW }]);
    expect(await run('report')).toMatchObject({ books: 0, would_move: 0 });

    mocks.configGet.mockImplementation(async (key: string) => (key === 'audiobook_path_template' ? '{title}' : null));
    expect(await run('apply')).toMatchObject({ moved: 0 });
    expect(mocks.collectCandidates).toHaveBeenCalledTimes(1);
  });
});
