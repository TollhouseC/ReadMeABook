/**
 * Component: Fix Library Layout Processor Tests
 * Documentation: documentation/phase3/file-organization.md
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

vi.mock('@/lib/db', () => ({ prisma: prismaMock }));
vi.mock('@/lib/services/config.service', () => ({ getConfigService: () => configMock }));
vi.mock('@/lib/services/library', () => ({ getLibraryService: () => libraryServiceMock }));

let media: string;

beforeEach(async () => {
  vi.clearAllMocks();
  media = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'rmab-layoutjob-')), 'Audio');
  for (const rel of ['A/The Academy/The Academy.m4b', 'A/The Academy/The Thoroughbreds/The Thoroughbreds.m4b', 'B/S/Fine/fine.m4b']) {
    await fs.mkdir(path.dirname(path.join(media, rel)), { recursive: true });
    await fs.writeFile(path.join(media, rel), 'x');
  }
  Object.keys(config).forEach(k => delete config[k]);
  Object.assign(config, { media_dir: media, 'plex.trigger_scan_after_import': 'true', plex_audiobook_library_id: 'lib-1' });
  configMock.get.mockImplementation(async (key: string) => config[key] ?? null);
  configMock.getBackendMode.mockResolvedValue('plex');
  prismaMock.audiobook.updateMany.mockResolvedValue({ count: 1 });
});

async function run(mode: 'report' | 'apply') {
  const { processFixLibraryLayout } = await import('@/lib/processors/fix-library-layout.processor');
  return processFixLibraryLayout({ jobId: 'job-1', mode });
}

describe('processFixLibraryLayout', () => {
  it('report mode lists nested books without moving anything', async () => {
    expect(await run('report')).toMatchObject({ mode: 'report', nested: 1, moved: 0 });
    expect((await fs.readdir(path.join(media, 'A', 'The Academy'))).sort()).toEqual(['The Academy.m4b', 'The Thoroughbreds']);
    expect(libraryServiceMock.triggerLibraryScan).not.toHaveBeenCalled();
  });

  it('apply mode moves the outer book into its own folder, updates records, and rescans', async () => {
    const outer = path.join(media, 'A', 'The Academy');
    expect(await run('apply')).toMatchObject({ mode: 'apply', nested: 1, moved: 1, failed: 0 });
    expect((await fs.readdir(outer)).sort()).toEqual(['The Academy', 'The Thoroughbreds']);
    expect(prismaMock.audiobook.updateMany).toHaveBeenCalledWith({
      where: { filePath: outer }, data: { filePath: path.join(outer, 'The Academy') },
    });
    expect(libraryServiceMock.triggerLibraryScan).toHaveBeenCalledWith('lib-1');
  });
});
