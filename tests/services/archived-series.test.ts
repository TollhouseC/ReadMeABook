/**
 * Component: Archived Audible Series Tests
 * Documentation: documentation/features/watched-lists.md
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaMock } from '../helpers/prisma';

const prismaMock = createPrismaMock();
const mocks = vi.hoisted(() => ({ getProductsByAsins: vi.fn(), searchForSeries: vi.fn() }));

vi.mock('@/lib/db', () => ({ prisma: prismaMock }));
vi.mock('@/lib/integrations/audible.service', () => ({ getAudibleService: () => ({ getProductsByAsins: mocks.getProductsByAsins }) }));
vi.mock('@/lib/integrations/audible-series', () => ({ searchForSeries: mocks.searchForSeries }));

const load = () => import('@/lib/services/archived-series');

const OLD = 'B005NBPHB8';
const NEW = { asin: 'B0H363Q436', title: 'Chronicles of the Black Company' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.searchForSeries.mockResolvedValue([]);
  mocks.getProductsByAsins.mockResolvedValue([]);
});

describe('archived series names', () => {
  it('recognises archived titles and related names', async () => {
    const { isArchivedSeriesTitle, sameSeriesName, stripArchived } = await load();
    expect(isArchivedSeriesTitle('Black Company [ARCHIVED]')).toBe(true);
    expect(isArchivedSeriesTitle('Black Company')).toBe(false);
    expect(stripArchived('Black Company [ARCHIVED]')).toBe('Black Company');
    expect(sameSeriesName('Black Company [ARCHIVED]', 'Chronicles of the Black Company')).toBe(true);
    expect(sameSeriesName('Black Company', 'The Dresden Files')).toBe(false);
  });
});

describe('findReplacementSeries', () => {
  it('uses the current series of a book from the archived one (Black Company)', async () => {
    const { findReplacementSeries } = await load();
    prismaMock.audiobook.findMany.mockResolvedValue([{ audibleAsin: 'B003XX5CCM' }]);
    mocks.getProductsByAsins.mockResolvedValue([{ asin: 'B003XX5CCM', title: 'Shadows Linger', series: NEW.title, seriesAsin: NEW.asin }]);

    expect(await findReplacementSeries(OLD, 'Black Company [ARCHIVED]')).toEqual(NEW);
    expect(mocks.getProductsByAsins).toHaveBeenCalledWith(['B003XX5CCM']);
  });

  it('ignores a book now listed in an unrelated series', async () => {
    const { findReplacementSeries } = await load();
    prismaMock.audiobook.findMany.mockResolvedValue([{ audibleAsin: 'B1' }]);
    mocks.getProductsByAsins.mockResolvedValue([{ asin: 'B1', title: 'X', series: 'Some Other Universe', seriesAsin: 'B0OTHER000' }]);
    expect(await findReplacementSeries(OLD, 'Black Company [ARCHIVED]')).toBeNull();
  });

  it('falls back to a series search only when exactly one result fits', async () => {
    const { findReplacementSeries } = await load();
    prismaMock.audiobook.findMany.mockResolvedValue([]);
    mocks.searchForSeries.mockResolvedValue([
      { asin: OLD, title: 'Black Company [ARCHIVED]' },
      { asin: NEW.asin, title: NEW.title },
      { asin: 'B0UNRELATE', title: 'The Company of Wolves' },
    ]);
    expect(await findReplacementSeries(OLD, 'Black Company [ARCHIVED]')).toEqual(NEW);

    mocks.searchForSeries.mockResolvedValue([{ asin: NEW.asin, title: NEW.title }, { asin: 'B0TWO00000', title: 'Black Company Omnibus' }]);
    expect(await findReplacementSeries(OLD, 'Black Company [ARCHIVED]')).toBeNull();
  });
});

describe('moveToReplacementSeries', () => {
  it('moves watches (dropping duplicates) and book links, keeping series names', async () => {
    const { moveToReplacementSeries } = await load();
    prismaMock.watchedSeries.findMany.mockResolvedValue([
      { id: 'w1', userId: 'u1', seriesAsin: OLD },
      { id: 'w2', userId: 'u2', seriesAsin: OLD },
    ]);
    prismaMock.watchedSeries.findFirst.mockImplementation(async (args: any) => (args.where.userId === 'u2' ? { id: 'existing' } : null));
    prismaMock.watchedSeries.update.mockResolvedValue({});
    prismaMock.watchedSeries.delete.mockResolvedValue({});
    prismaMock.audiobook.updateMany.mockResolvedValue({ count: 7 });
    prismaMock.upcomingRelease.deleteMany.mockResolvedValue({ count: 0 });

    expect(await moveToReplacementSeries(OLD, NEW)).toBe(1);
    expect(prismaMock.watchedSeries.update).toHaveBeenCalledWith({ where: { id: 'w1' }, data: { seriesAsin: NEW.asin, seriesTitle: NEW.title } });
    expect(prismaMock.watchedSeries.delete).toHaveBeenCalledWith({ where: { id: 'w2' } });
    expect(prismaMock.audiobook.updateMany).toHaveBeenCalledWith({ where: { seriesAsin: OLD }, data: { seriesAsin: NEW.asin } });
    expect(prismaMock.upcomingRelease.deleteMany).toHaveBeenCalledWith({ where: { sourceAsin: OLD } });
  });
});
