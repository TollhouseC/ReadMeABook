/**
 * Component: Library Relink Service Tests
 * Documentation: documentation/backend/services/jobs.md
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaMock } from '../helpers/prisma';

const prismaMock = createPrismaMock();
vi.mock('@/lib/db', () => ({ prisma: prismaMock }));

async function svc() {
  return import('@/lib/services/library-relink.service');
}

describe('library relink service', () => {
  beforeEach(() => vi.clearAllMocks());

  it('indexes scanned items by lowercase ASIN', async () => {
    const { buildAsinIndex } = await svc();
    const index = buildAsinIndex([{ asin: 'B0ABC', externalId: 'g1' }, { asin: null, externalId: 'g2' }, { asin: 'b0abc', externalId: 'g3' }]);
    expect([...index.entries()]).toEqual([['b0abc', 'g1']]);
  });

  it('moves links from the old item ID to the new one (Audiobookshelf field)', async () => {
    prismaMock.audiobook.updateMany.mockResolvedValue({ count: 2 });
    const { relinkAudiobooks } = await svc();

    expect(await relinkAudiobooks('old', 'new', 'audiobookshelf')).toBe(2);
    expect(prismaMock.audiobook.updateMany).toHaveBeenCalledWith({
      where: { OR: [{ plexGuid: 'old' }, { absItemId: 'old' }] },
      data: expect.objectContaining({ absItemId: 'new' }),
    });
  });

  it('restores requests cancelled as removed when the book is back, unless re-requested since', async () => {
    prismaMock.request.findMany.mockResolvedValue([
      { id: 'r1', audiobook: { id: 'a1', title: 'HWFwM 3', audibleAsin: 'B0HWFWM003' } },
      { id: 'r2', audiobook: { id: 'a2', title: 'Really Gone', audibleAsin: 'B0GONE0001' } },
      { id: 'r3', audiobook: { id: 'a3', title: 'Re-requested', audibleAsin: 'B0AGAIN001' } },
    ]);
    prismaMock.request.findFirst.mockImplementation(async (args: any) => (args.where.audiobookId === 'a3' ? { id: 'newer' } : null));
    const { restoreRemovedFromLibraryRequests } = await svc();

    const restored = await restoreRemovedFromLibraryRequests(
      new Map([['b0hwfwm003', 'abs-1'], ['b0again001', 'abs-3']]),
      'audiobookshelf'
    );

    expect(restored).toBe(1);
    expect(prismaMock.request.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { type: 'audiobook', status: 'cancelled', errorMessage: 'Removed from library', deletedAt: null },
    }));
    expect(prismaMock.request.update).toHaveBeenCalledTimes(1);
    expect(prismaMock.request.update).toHaveBeenCalledWith({
      where: { id: 'r1' },
      data: expect.objectContaining({ status: 'available', errorMessage: null }),
    });
    expect(prismaMock.audiobook.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'a1' }, data: expect.objectContaining({ absItemId: 'abs-1' }),
    }));
  });
});
