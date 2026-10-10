/**
 * Component: Import Edition Match Tests
 * Documentation: documentation/phase3/file-organization.md
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaMock } from '../helpers/prisma';

const prismaMock = createPrismaMock();
const mocks = vi.hoisted(() => ({ get: vi.fn(), getABSItem: vi.fn(), getABSLibraryItems: vi.fn(), triggerABSItemMatch: vi.fn() }));

vi.mock('@/lib/db', () => ({ prisma: prismaMock }));
vi.mock('@/lib/services/config.service', () => ({ getConfigService: () => ({ get: mocks.get }) }));
vi.mock('@/lib/services/audiobookshelf/api', () => ({
  getABSItem: mocks.getABSItem, getABSLibraryItems: mocks.getABSLibraryItems, triggerABSItemMatch: mocks.triggerABSItemMatch,
}));

const load = () => import('@/lib/services/import-match');
const logger = () => ({ info: vi.fn(), warn: vi.fn() });
const NEW = 'Timothy Zahn/Star Wars/Thrawn (Star Wars)';
const THRAWN = { id: 'ab-thrawn', title: 'Thrawn', audibleAsin: 'B01N7KSAV2', absItemId: 'li-new', filePath: `/Audiobooks/Audio/${NEW}` };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockImplementation(async (key: string) => ({ media_dir: '/Audiobooks/Audio', 'audiobookshelf.library_id': 'lib-1' } as Record<string, string>)[key] ?? null);
  prismaMock.audiobook.findMany.mockResolvedValue([THRAWN]);
  prismaMock.audiobook.update.mockResolvedValue({});
  mocks.getABSItem.mockResolvedValue({ relPath: NEW });
  mocks.getABSLibraryItems.mockResolvedValue([]);
  mocks.triggerABSItemMatch.mockResolvedValue({ updated: true, asin: 'B01N7KSAV2' });
});

describe('matchImportsToRequestedEdition', () => {
  it('matches a recent import to the requested ASIN with override, once', async () => {
    const { matchImportsToRequestedEdition } = await load();
    expect(await matchImportsToRequestedEdition(logger())).toEqual({ matched: 1, failed: 0, waiting: 0 });

    expect(mocks.triggerABSItemMatch).toHaveBeenCalledWith('li-new', 'B01N7KSAV2', { overrideDetails: true, overrideCover: true, throwOnError: true });
    expect(prismaMock.audiobook.update).toHaveBeenCalledWith({ where: { id: 'ab-thrawn' }, data: { absMatchedAt: expect.any(Date), absItemId: 'li-new' } });
    const where = prismaMock.audiobook.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ absMatchedAt: null, requests: { some: { status: 'available' } } });
    expect(where.completedAt.gte.getTime()).toBeGreaterThan(Date.now() - 4 * 86_400_000);
  });

  it('matches the item in the imported folder when the linked one is the old copy', async () => {
    mocks.getABSItem.mockResolvedValue({ relPath: 'Timothy Zahn/Star Wars Thrawn/Thrawn (Star Wars)' });
    mocks.getABSLibraryItems.mockResolvedValue([{ id: 'li-old', relPath: 'Timothy Zahn/Star Wars Thrawn/Thrawn (Star Wars)' }, { id: 'li-real-new', relPath: NEW }]);
    const { matchImportsToRequestedEdition } = await load();
    await matchImportsToRequestedEdition(logger());
    expect(mocks.triggerABSItemMatch).toHaveBeenCalledWith('li-real-new', 'B01N7KSAV2', expect.anything());
  });

  it('waits when Audiobookshelf has not scanned the new folder yet', async () => {
    mocks.getABSItem.mockResolvedValue({ relPath: 'somewhere/else' });
    const { matchImportsToRequestedEdition } = await load();
    expect(await matchImportsToRequestedEdition(logger())).toEqual({ matched: 0, failed: 0, waiting: 1 });
    expect(mocks.triggerABSItemMatch).not.toHaveBeenCalled();
  });

  it('leaves the book for a retry when the match fails or lands on another ASIN', async () => {
    mocks.triggerABSItemMatch.mockResolvedValueOnce({ updated: true, asin: 'B0WRONG' });
    const { matchImportsToRequestedEdition } = await load();
    const log = logger();
    expect(await matchImportsToRequestedEdition(log)).toMatchObject({ matched: 0, failed: 1 });
    expect(prismaMock.audiobook.update).not.toHaveBeenCalled();
    expect(log.warn.mock.calls[0][0]).toContain('retrying');

    mocks.triggerABSItemMatch.mockRejectedValueOnce(new Error('ABS API error: 500'));
    expect(await matchImportsToRequestedEdition(log)).toMatchObject({ failed: 1 });
  });

  it('counts an item already up to date as matched', async () => {
    mocks.triggerABSItemMatch.mockResolvedValue({ updated: false, asin: 'b01n7ksav2' });
    const { matchImportsToRequestedEdition } = await load();
    expect(await matchImportsToRequestedEdition(logger())).toMatchObject({ matched: 1 });
  });
});
