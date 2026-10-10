/**
 * Component: Library Leftovers Tests
 * Documentation: documentation/backend/services/reported-issues.md
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaMock } from '../helpers/prisma';

const prismaMock = createPrismaMock();
const mocks = vi.hoisted(() => ({ get: vi.fn(), getBackendMode: vi.fn(), getABSLibraryItems: vi.fn() }));

vi.mock('@/lib/db', () => ({ prisma: prismaMock }));
vi.mock('@/lib/services/config.service', () => ({ getConfigService: () => ({ get: mocks.get, getBackendMode: mocks.getBackendMode }) }));
vi.mock('@/lib/services/audiobookshelf/api', () => ({ getABSLibraryItems: mocks.getABSLibraryItems, getABSItem: vi.fn() }));

const load = () => import('@/lib/services/library-leftovers');
const logger = () => ({ info: vi.fn(), warn: vi.fn() });

const THRAWN = {
  audiobookId: 'ab-thrawn', title: 'Thrawn', author: 'Timothy Zahn', asin: 'B01N7KSAV2',
  itemIds: ['li-gone'], reason: 'no folder found', source: 'replace' as const, recordedAt: '2026-10-09T23:00:00.000Z',
};
const item = (id: string, relPath: string, title = 'Thrawn', asin?: string) => ({ id, relPath, media: { metadata: { title, asin } } });
let stored: string | null;

beforeEach(() => {
  vi.clearAllMocks();
  stored = JSON.stringify([THRAWN]);
  prismaMock.configuration.findUnique.mockImplementation(async () => (stored ? { value: stored } : null));
  prismaMock.configuration.upsert.mockImplementation(async (args: any) => { stored = args.update.value; return {}; });
  mocks.get.mockImplementation(async (key: string) => ({ media_dir: '/Audiobooks/Audio', 'audiobookshelf.library_id': 'lib-1' } as Record<string, string>)[key] ?? null);
  mocks.getBackendMode.mockResolvedValue('audiobookshelf');
  prismaMock.audiobook.findUnique.mockResolvedValue({ absItemId: 'li-new', filePath: '/Audiobooks/Audio/Timothy Zahn/Star Wars/Thrawn (Star Wars)' });
});

describe('remainingCopies', () => {
  it('matches the old item by id or by title (same/no ASIN), never the new import or another edition', async () => {
    const { remainingCopies } = await load();
    const items = [
      { id: 'li-new', title: 'Thrawn', asin: 'B01N7KSAV2', relPath: 'Timothy Zahn/Star Wars/Thrawn (Star Wars)' },
      { id: 'li-old', title: 'Thrawn (Star Wars)', asin: 'B01N7KSAV2', relPath: 'Timothy Zahn/Star Wars Thrawn/Thrawn (Star Wars)' },
      { id: 'li-other-edition', title: 'Thrawn', asin: 'B0DRAMA', relPath: 'Timothy Zahn/Thrawn Dramatized' },
    ];
    const copies = remainingCopies(THRAWN, items, { absItemId: 'li-old', relPath: 'Timothy Zahn/Star Wars/Thrawn (Star Wars)' });
    expect(copies.map(c => c.id)).toEqual(['li-old']);
  });
});

describe('checkLeftovers', () => {
  it('lists an old copy still in the library with its folder', async () => {
    mocks.getABSLibraryItems.mockResolvedValue([
      item('li-new', 'Timothy Zahn/Star Wars/Thrawn (Star Wars)'),
      item('li-old', 'Timothy Zahn/Star Wars Thrawn/Thrawn (Star Wars)', 'Thrawn (Star Wars)'),
    ]);
    const log = logger();
    const { checkLeftovers } = await load();

    expect(await checkLeftovers(log)).toEqual({ leftovers: 1, cleaned: 0 });
    expect(log.warn.mock.calls[0][0]).toContain('"/Audiobooks/Audio/Timothy Zahn/Star Wars Thrawn/Thrawn (Star Wars)"');
    expect(prismaMock.configuration.upsert).not.toHaveBeenCalled();
  });

  it('drops the entry once only the new import is left', async () => {
    mocks.getABSLibraryItems.mockResolvedValue([item('li-new', 'Timothy Zahn/Star Wars/Thrawn (Star Wars)')]);
    const { checkLeftovers, listLeftovers } = await load();

    expect(await checkLeftovers(logger())).toEqual({ leftovers: 0, cleaned: 1 });
    expect(await listLeftovers()).toEqual([]);
  });

  it('says so when nothing was left behind', async () => {
    stored = null;
    const log = logger();
    const { checkLeftovers } = await load();
    expect(await checkLeftovers(log)).toEqual({ leftovers: 0, cleaned: 0 });
    expect(mocks.getABSLibraryItems).not.toHaveBeenCalled();
  });
});

describe('recordLeftover', () => {
  it('keeps one entry per book and never throws', async () => {
    const { recordLeftover, listLeftovers } = await load();
    await recordLeftover({ audiobookId: 'ab-thrawn', title: 'Thrawn', author: 'Timothy Zahn', itemIds: ['a', 'a', ''], reason: 'r2', source: 'delete' });
    const list = await listLeftovers();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ reason: 'r2', itemIds: ['a'], source: 'delete' });

    prismaMock.configuration.upsert.mockRejectedValue(new Error('db down'));
    await expect(recordLeftover({ ...THRAWN, audiobookId: 'x' })).resolves.toBeUndefined();
  });
});
