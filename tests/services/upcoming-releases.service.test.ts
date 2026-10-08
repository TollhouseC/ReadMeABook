/**
 * Component: Upcoming Releases Service Tests
 * Documentation: documentation/features/watched-lists.md
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaMock } from '../helpers/prisma';

const prismaMock = createPrismaMock();
vi.mock('@/lib/db', () => ({ prisma: prismaMock }));

let svc: typeof import('@/lib/services/upcoming-releases.service');
beforeAll(async () => {
  svc = await import('@/lib/services/upcoming-releases.service');
});
const isUpcoming: typeof svc.isUpcoming = (...args) => svc.isUpcoming(...args);
const isPlaceholderListing: typeof svc.isPlaceholderListing = (...args) => svc.isPlaceholderListing(...args);
const syncUpcomingReleases: typeof svc.syncUpcomingReleases = (...args) => svc.syncUpcomingReleases(...args);
const getUpcomingReleasesForUser: typeof svc.getUpcomingReleasesForUser = (...args) => svc.getUpcomingReleasesForUser(...args);

const NOW = new Date('2026-10-08T15:00:00Z');
const book = (asin: string, releaseDate?: string, extra: Record<string, unknown> = {}) =>
  ({ asin, title: `Title ${asin}`, author: 'Author', releaseDate, ...extra }) as any;

describe('isUpcoming / isPlaceholderListing', () => {
  it('treats only dates after today as upcoming', () => {
    expect(isUpcoming(book('A', '2026-10-09'), NOW)).toBe(true);
    expect(isUpcoming(book('A', '2026-10-08'), NOW)).toBe(false); // release day: request it
    expect(isUpcoming(book('A', '2025-01-01'), NOW)).toBe(false);
    expect(isUpcoming(book('A'), NOW)).toBe(false); // no date: current behavior
    expect(isUpcoming(book('A', '2026-11-01T00:00:00.000Z'), NOW)).toBe(true);
  });

  it('flags Audible placeholder listings', () => {
    expect(isPlaceholderListing(book('A', '2200-01-01T00:00:00.000Z'))).toBe(true);
    expect(isPlaceholderListing(book('A', '2027-01-01', { publisherName: 'ZZZ - Series Advisor Placeholder' }))).toBe(true);
    expect(isPlaceholderListing(book('A', '2027-01-01', { publisherName: 'Macmillan Audio' }))).toBe(false);
  });
});

describe('syncUpcomingReleases', () => {
  beforeEach(() => vi.clearAllMocks());

  it('upserts future books, drops ones no longer listed, and prunes past dates', async () => {
    await syncUpcomingReleases('author', 'AUTH1', [
      book('PAST', '2020-01-01'),
      book('SOON', '2026-12-01', { series: 'Saga', seriesPart: '3' }),
      book('FAKE', '2200-01-01'),
    ], { now: NOW });

    expect(prismaMock.upcomingRelease.upsert).toHaveBeenCalledTimes(1);
    expect(prismaMock.upcomingRelease.upsert.mock.calls[0][0]).toMatchObject({
      where: { asin_sourceAsin: { asin: 'SOON', sourceAsin: 'AUTH1' } },
      create: { asin: 'SOON', sourceAsin: 'AUTH1', series: 'Saga', seriesPart: '3', sourceType: 'author' },
    });
    expect(prismaMock.upcomingRelease.deleteMany).toHaveBeenCalledWith({
      where: { sourceAsin: 'AUTH1', asin: { notIn: ['SOON'] } },
    });
    expect(prismaMock.upcomingRelease.deleteMany).toHaveBeenCalledWith({
      where: { releaseDate: { lt: new Date('2026-10-08T00:00:00Z') } },
    });
  });
});

describe('getUpcomingReleasesForUser', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns nothing (no query) when the user watches nothing', async () => {
    prismaMock.watchedSeries.findMany.mockResolvedValue([]);
    prismaMock.watchedAuthor.findMany.mockResolvedValue([]);
    expect(await getUpcomingReleasesForUser('u1', NOW)).toEqual([]);
    expect(prismaMock.upcomingRelease.findMany).not.toHaveBeenCalled();
  });

  it('dedupes a book seen via series and author, preferring the series row', async () => {
    prismaMock.watchedSeries.findMany.mockResolvedValue([{ seriesAsin: 'SER1' }]);
    prismaMock.watchedAuthor.findMany.mockResolvedValue([{ authorAsin: 'AUTH1' }]);
    const row = (asin: string, sourceAsin: string, series: string | null, date: string) => ({
      asin, sourceAsin, series, seriesPart: series ? '2' : null, title: `T ${asin}`, author: 'A',
      coverArtUrl: null, releaseDate: new Date(`${date}T00:00:00Z`),
    });
    prismaMock.upcomingRelease.findMany.mockResolvedValue([
      row('B1', 'AUTH1', null, '2026-11-01'),
      row('B1', 'SER1', 'Saga', '2026-11-01'),
      row('B2', 'AUTH1', null, '2026-12-01'),
    ]);

    const result = await getUpcomingReleasesForUser('u1', NOW);

    expect(prismaMock.upcomingRelease.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { sourceAsin: { in: ['SER1', 'AUTH1'] }, releaseDate: { gte: new Date('2026-10-08T00:00:00Z') } },
    }));
    expect(result).toEqual([
      { asin: 'B1', title: 'T B1', author: 'A', series: 'Saga', seriesPart: '2', coverArtUrl: null, releaseDate: '2026-11-01' },
      { asin: 'B2', title: 'T B2', author: 'A', series: null, seriesPart: null, coverArtUrl: null, releaseDate: '2026-12-01' },
    ]);
  });
});
