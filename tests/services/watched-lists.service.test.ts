/**
 * Component: Watched Lists Service Tests
 * Documentation: documentation/features/watched-lists.md
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaMock } from '../helpers/prisma';

const prismaMock = createPrismaMock();

vi.mock('@/lib/db', () => ({
  prisma: prismaMock,
}));

vi.mock('@/lib/utils/logger', () => ({
  RMABLogger: {
    create: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
    forJob: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

// Mock scrapeSeriesPage
const mockScrapeSeriesPage = vi.fn();
vi.mock('@/lib/integrations/audible-series', () => ({
  scrapeSeriesPage: (...args: any[]) => mockScrapeSeriesPage(...args),
}));

// Mock AudibleService
const mockSearchByAuthorAsin = vi.fn();
vi.mock('@/lib/integrations/audible.service', () => ({
  getAudibleService: () => ({
    searchByAuthorAsin: mockSearchByAuthorAsin,
  }),
}));

// Mock deduplicateAndCollectGroups
const mockDeduplicateAndCollectGroups = vi.fn();
vi.mock('@/lib/utils/deduplicate-audiobooks', () => ({
  deduplicateAndCollectGroups: (...args: any[]) => mockDeduplicateAndCollectGroups(...args),
}));

// Mock works service
const mockPersistDedupGroups = vi.fn();
const mockGetSiblingAsins = vi.fn();
vi.mock('@/lib/services/works.service', () => ({
  persistDedupGroups: (...args: any[]) => mockPersistDedupGroups(...args),
  getSiblingAsins: (...args: any[]) => mockGetSiblingAsins(...args),
}));

// Mock request creator
const mockCreateRequestForUser = vi.fn();
vi.mock('@/lib/services/request-creator.service', () => ({
  createRequestForUser: (...args: any[]) => mockCreateRequestForUser(...args),
}));

// Mock findPlexMatch
vi.mock('@/lib/utils/audiobook-matcher', () => ({
  findPlexMatch: vi.fn().mockResolvedValue(null),
}));

// Archived series: no replacement by default
const mockFollowArchivedSeries = vi.fn();
vi.mock('@/lib/services/archived-series', () => ({
  isArchivedSeriesTitle: (t?: string) => !!t && t.toLowerCase().includes('[archived]'),
  followArchivedSeries: (...args: any[]) => mockFollowArchivedSeries(...args),
}));

describe('processWatchedLists', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();

    // Default: empty library, no siblings
    prismaMock.plexLibrary.findMany.mockResolvedValue([]);
    mockGetSiblingAsins.mockResolvedValue(new Map());
    mockPersistDedupGroups.mockResolvedValue(undefined);
    mockFollowArchivedSeries.mockResolvedValue(null);
  });

  it('follows a series Audible archived to its replacement and moves the watch', async () => {
    prismaMock.watchedSeries.findMany.mockResolvedValue([{
      id: 'ws-1', userId: 'user-1', seriesAsin: 'B005NBPHB8', seriesTitle: 'Black Company', coverArtUrl: null, lastCheckedAt: null,
      user: { id: 'user-1', plexUsername: 'testuser' },
    }]);
    prismaMock.watchedAuthor.findMany.mockResolvedValue([]);
    prismaMock.watchedSeries.update.mockResolvedValue({});
    const book = { asin: 'B003XX5CCM', title: 'Shadows Linger', author: 'Glen Cook', narrator: 'N' };
    mockScrapeSeriesPage.mockImplementation(async (asin: string) => (asin === 'B005NBPHB8'
      ? { asin, title: 'Black Company [ARCHIVED]', bookCount: 0, books: [], hasMore: false, page: 1 }
      : { asin, title: 'Chronicles of the Black Company', bookCount: 1, books: [book], hasMore: false, page: 1 }));
    mockFollowArchivedSeries.mockResolvedValue({ asin: 'B0H363Q436', title: 'Chronicles of the Black Company', from: 'Black Company [ARCHIVED]' });
    mockDeduplicateAndCollectGroups.mockReturnValue({ books: [book], groups: [] });
    mockCreateRequestForUser.mockResolvedValue({ success: true, request: {} });

    const { processWatchedLists } = await import('@/lib/services/watched-lists.service');
    const stats = await processWatchedLists();

    expect(mockFollowArchivedSeries).toHaveBeenCalledWith('B005NBPHB8', 'Black Company [ARCHIVED]', expect.anything());
    expect(mockScrapeSeriesPage).toHaveBeenCalledWith('B0H363Q436', 1);
    expect(stats.booksFound).toBe(1);
  });

  it('processes watched series and creates requests for new books', async () => {
    // Setup: one user watching one series
    prismaMock.watchedSeries.findMany.mockResolvedValue([
      {
        id: 'ws-1',
        userId: 'user-1',
        seriesAsin: 'B001SERIES1',
        seriesTitle: 'Test Series',
        coverArtUrl: null,
        lastCheckedAt: null,
        user: { id: 'user-1', plexUsername: 'testuser' },
      },
    ]);

    prismaMock.watchedAuthor.findMany.mockResolvedValue([]);
    prismaMock.watchedSeries.update.mockResolvedValue({});

    // Series page returns 2 books
    mockScrapeSeriesPage.mockResolvedValueOnce({
      asin: 'B001SERIES1',
      title: 'Test Series',
      bookCount: 2,
      books: [
        { asin: 'B001BOOK01', title: 'Book One', author: 'Author A', narrator: 'Narrator' },
        { asin: 'B001BOOK02', title: 'Book Two', author: 'Author A', narrator: 'Narrator' },
      ],
      hasMore: false,
      page: 1,
    });

    // No dedup (each book is unique)
    mockDeduplicateAndCollectGroups.mockReturnValue({
      books: [
        { asin: 'B001BOOK01', title: 'Book One', author: 'Author A', narrator: 'Narrator' },
        { asin: 'B001BOOK02', title: 'Book Two', author: 'Author A', narrator: 'Narrator' },
      ],
      groups: [],
    });

    // Both requests succeed
    mockCreateRequestForUser.mockResolvedValue({ success: true, request: {} });

    const { processWatchedLists } = await import('@/lib/services/watched-lists.service');
    const stats = await processWatchedLists();

    expect(stats.seriesChecked).toBe(1);
    expect(stats.requestsCreated).toBe(2);
    expect(mockCreateRequestForUser).toHaveBeenCalledTimes(2);
    expect(prismaMock.watchedSeries.update).toHaveBeenCalledWith({
      where: { id: 'ws-1' },
      data: { lastCheckedAt: expect.any(Date) },
    });
  });

  it('holds pre-orders until release and lists them as upcoming', async () => {
    prismaMock.watchedSeries.findMany.mockResolvedValue([{
      id: 'ws-1', userId: 'user-1', seriesAsin: 'B001SERIES1', seriesTitle: 'Chronicles',
      coverArtUrl: null, lastCheckedAt: null, user: { id: 'user-1', plexUsername: 'testuser' },
    }]);
    prismaMock.watchedAuthor.findMany.mockResolvedValue([]);
    prismaMock.watchedSeries.update.mockResolvedValue({});

    const books = [
      { asin: 'B001BOOK01', title: 'Released', author: 'Glen Cook', releaseDate: '2020-05-01' },
      { asin: 'B001BOOK02', title: 'Pre-order', author: 'Glen Cook', releaseDate: '2099-03-01', seriesPart: '12' },
      { asin: 'B0H361BYVY', title: 'They Cry', author: 'Glen Cook', releaseDate: '2200-01-01' }, // placeholder
    ];
    mockScrapeSeriesPage.mockResolvedValueOnce({ books, hasMore: false, page: 1 });
    mockDeduplicateAndCollectGroups.mockReturnValue({ books, groups: [] });
    mockCreateRequestForUser.mockResolvedValue({ success: true, request: {} });

    const { processWatchedLists } = await import('@/lib/services/watched-lists.service');
    const stats = await processWatchedLists();

    expect(stats.requestsCreated).toBe(1);
    expect(stats.skippedUpcoming).toBe(2);
    expect(mockCreateRequestForUser).toHaveBeenCalledTimes(1);
    expect(mockCreateRequestForUser.mock.calls[0][1]).toMatchObject({ asin: 'B001BOOK01' });

    // Only the real pre-order is listed (placeholder skipped), with the series title filled in
    expect(prismaMock.upcomingRelease.upsert).toHaveBeenCalledTimes(1);
    expect(prismaMock.upcomingRelease.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { asin_sourceAsin: { asin: 'B001BOOK02', sourceAsin: 'B001SERIES1' } },
      create: expect.objectContaining({ series: 'Chronicles', seriesPart: '12', sourceType: 'series' }),
    }));
  });

  it('skips books already in the library', async () => {
    prismaMock.watchedSeries.findMany.mockResolvedValue([
      {
        id: 'ws-1',
        userId: 'user-1',
        seriesAsin: 'B001SERIES1',
        seriesTitle: 'Test Series',
        coverArtUrl: null,
        lastCheckedAt: null,
        user: { id: 'user-1', plexUsername: 'testuser' },
      },
    ]);

    prismaMock.watchedAuthor.findMany.mockResolvedValue([]);
    prismaMock.watchedSeries.update.mockResolvedValue({});

    mockScrapeSeriesPage.mockResolvedValueOnce({
      asin: 'B001SERIES1',
      title: 'Test Series',
      bookCount: 2,
      books: [
        { asin: 'B001BOOK01', title: 'Book One', author: 'Author A' },
        { asin: 'B001BOOK02', title: 'Book Two', author: 'Author A' },
      ],
      hasMore: false,
      page: 1,
    });

    mockDeduplicateAndCollectGroups.mockReturnValue({
      books: [
        { asin: 'B001BOOK01', title: 'Book One', author: 'Author A' },
        { asin: 'B001BOOK02', title: 'Book Two', author: 'Author A' },
      ],
      groups: [],
    });

    // Book One is already in library
    prismaMock.plexLibrary.findMany.mockResolvedValue([
      { asin: 'B001BOOK01' },
    ]);

    mockCreateRequestForUser.mockResolvedValue({ success: true, request: {} });

    const { processWatchedLists } = await import('@/lib/services/watched-lists.service');
    const stats = await processWatchedLists();

    expect(stats.skippedOwned).toBe(1);
    expect(stats.requestsCreated).toBe(1);
    expect(mockCreateRequestForUser).toHaveBeenCalledTimes(1);
    expect(mockCreateRequestForUser).toHaveBeenCalledWith('user-1', expect.objectContaining({ asin: 'B001BOOK02' }));
  });

  it('processes watched authors and creates requests', async () => {
    prismaMock.watchedSeries.findMany.mockResolvedValue([]);

    prismaMock.watchedAuthor.findMany.mockResolvedValue([
      {
        id: 'wa-1',
        userId: 'user-1',
        authorAsin: 'B001AUTH001',
        authorName: 'Author A',
        coverArtUrl: null,
        lastCheckedAt: null,
        user: { id: 'user-1', plexUsername: 'testuser' },
      },
    ]);

    prismaMock.watchedAuthor.update.mockResolvedValue({});

    // Author has 1 book
    mockSearchByAuthorAsin.mockResolvedValueOnce({
      books: [
        { asin: 'B001BOOK01', title: 'Author Book', author: 'Author A' },
      ],
      hasMore: false,
      page: 1,
      totalResults: 1,
    });

    mockDeduplicateAndCollectGroups.mockReturnValue({
      books: [
        { asin: 'B001BOOK01', title: 'Author Book', author: 'Author A' },
      ],
      groups: [],
    });

    mockCreateRequestForUser.mockResolvedValue({ success: true, request: {} });

    const { processWatchedLists } = await import('@/lib/services/watched-lists.service');
    const stats = await processWatchedLists();

    expect(stats.authorsChecked).toBe(1);
    expect(stats.requestsCreated).toBe(1);
    expect(mockSearchByAuthorAsin).toHaveBeenCalledWith('Author A', 'B001AUTH001', 1);
  });

  it('counts duplicate/already-available books as skippedExisting', async () => {
    prismaMock.watchedSeries.findMany.mockResolvedValue([
      {
        id: 'ws-1',
        userId: 'user-1',
        seriesAsin: 'B001SERIES1',
        seriesTitle: 'Test Series',
        coverArtUrl: null,
        lastCheckedAt: null,
        user: { id: 'user-1', plexUsername: 'testuser' },
      },
    ]);

    prismaMock.watchedAuthor.findMany.mockResolvedValue([]);
    prismaMock.watchedSeries.update.mockResolvedValue({});

    mockScrapeSeriesPage.mockResolvedValueOnce({
      asin: 'B001SERIES1',
      title: 'Test Series',
      bookCount: 1,
      books: [
        { asin: 'B001BOOK01', title: 'Book One', author: 'Author A' },
      ],
      hasMore: false,
      page: 1,
    });

    mockDeduplicateAndCollectGroups.mockReturnValue({
      books: [
        { asin: 'B001BOOK01', title: 'Book One', author: 'Author A' },
      ],
      groups: [],
    });

    // Request creation returns duplicate
    mockCreateRequestForUser.mockResolvedValue({
      success: false,
      reason: 'duplicate',
      message: 'Already requested',
    });

    const { processWatchedLists } = await import('@/lib/services/watched-lists.service');
    const stats = await processWatchedLists();

    expect(stats.skippedExisting).toBe(1);
    expect(stats.requestsCreated).toBe(0);
  });

  it('deduplicates scraping when multiple users watch same series', async () => {
    prismaMock.watchedSeries.findMany.mockResolvedValue([
      {
        id: 'ws-1',
        userId: 'user-1',
        seriesAsin: 'B001SERIES1',
        seriesTitle: 'Same Series',
        coverArtUrl: null,
        lastCheckedAt: null,
        user: { id: 'user-1', plexUsername: 'user1' },
      },
      {
        id: 'ws-2',
        userId: 'user-2',
        seriesAsin: 'B001SERIES1',
        seriesTitle: 'Same Series',
        coverArtUrl: null,
        lastCheckedAt: null,
        user: { id: 'user-2', plexUsername: 'user2' },
      },
    ]);

    prismaMock.watchedAuthor.findMany.mockResolvedValue([]);
    prismaMock.watchedSeries.update.mockResolvedValue({});

    // Should only scrape once despite 2 subscriptions
    mockScrapeSeriesPage.mockResolvedValueOnce({
      asin: 'B001SERIES1',
      title: 'Same Series',
      bookCount: 1,
      books: [
        { asin: 'B001BOOK01', title: 'Book One', author: 'Author A' },
      ],
      hasMore: false,
      page: 1,
    });

    mockDeduplicateAndCollectGroups.mockReturnValue({
      books: [
        { asin: 'B001BOOK01', title: 'Book One', author: 'Author A' },
      ],
      groups: [],
    });

    mockCreateRequestForUser.mockResolvedValue({ success: true, request: {} });

    const { processWatchedLists } = await import('@/lib/services/watched-lists.service');
    const stats = await processWatchedLists();

    // Scraped once, but created requests for both users
    expect(mockScrapeSeriesPage).toHaveBeenCalledTimes(1);
    expect(mockCreateRequestForUser).toHaveBeenCalledTimes(2);
    expect(stats.requestsCreated).toBe(2);
  });

  it('handles empty series page gracefully', async () => {
    prismaMock.watchedSeries.findMany.mockResolvedValue([
      {
        id: 'ws-1',
        userId: 'user-1',
        seriesAsin: 'B001SERIES1',
        seriesTitle: 'Empty Series',
        coverArtUrl: null,
        lastCheckedAt: null,
        user: { id: 'user-1', plexUsername: 'testuser' },
      },
    ]);

    prismaMock.watchedAuthor.findMany.mockResolvedValue([]);

    mockScrapeSeriesPage.mockResolvedValueOnce(null);

    const { processWatchedLists } = await import('@/lib/services/watched-lists.service');
    const stats = await processWatchedLists();

    expect(stats.seriesChecked).toBe(1);
    expect(stats.booksFound).toBe(0);
    expect(stats.requestsCreated).toBe(0);
    expect(mockCreateRequestForUser).not.toHaveBeenCalled();
  });

  it('returns empty stats when no watched items exist', async () => {
    prismaMock.watchedSeries.findMany.mockResolvedValue([]);
    prismaMock.watchedAuthor.findMany.mockResolvedValue([]);

    const { processWatchedLists } = await import('@/lib/services/watched-lists.service');
    const stats = await processWatchedLists();

    expect(stats.seriesChecked).toBe(0);
    expect(stats.authorsChecked).toBe(0);
    expect(stats.booksFound).toBe(0);
    expect(stats.requestsCreated).toBe(0);
    expect(stats.errors).toBe(0);
  });

  it('persists dedup groups to works table', async () => {
    prismaMock.watchedSeries.findMany.mockResolvedValue([
      {
        id: 'ws-1',
        userId: 'user-1',
        seriesAsin: 'B001SERIES1',
        seriesTitle: 'Test Series',
        coverArtUrl: null,
        lastCheckedAt: null,
        user: { id: 'user-1', plexUsername: 'testuser' },
      },
    ]);

    prismaMock.watchedAuthor.findMany.mockResolvedValue([]);
    prismaMock.watchedSeries.update.mockResolvedValue({});

    mockScrapeSeriesPage.mockResolvedValueOnce({
      asin: 'B001SERIES1',
      title: 'Test Series',
      bookCount: 2,
      books: [
        { asin: 'B001BOOK01', title: 'Book One', author: 'Author A' },
        { asin: 'B001BOOK02', title: 'Book One (Remastered)', author: 'Author A' },
      ],
      hasMore: false,
      page: 1,
    });

    const dedupGroup = {
      canonicalAsin: 'B001BOOK01',
      allAsins: ['B001BOOK01', 'B001BOOK02'],
      title: 'Book One',
      author: 'Author A',
    };

    mockDeduplicateAndCollectGroups.mockReturnValue({
      books: [{ asin: 'B001BOOK01', title: 'Book One', author: 'Author A' }],
      groups: [dedupGroup],
    });

    mockCreateRequestForUser.mockResolvedValue({ success: true, request: {} });

    const { processWatchedLists } = await import('@/lib/services/watched-lists.service');
    await processWatchedLists();

    expect(mockPersistDedupGroups).toHaveBeenCalledWith([dedupGroup]);
  });

  // ---- Targeted processing tests ----

  it('filters by seriesAsin when provided in options', async () => {
    // Two series exist, but we only want to process one
    prismaMock.watchedSeries.findMany.mockResolvedValue([
      {
        id: 'ws-1',
        userId: 'user-1',
        seriesAsin: 'B001SERIES1',
        seriesTitle: 'Target Series',
        coverArtUrl: null,
        lastCheckedAt: null,
        user: { id: 'user-1', plexUsername: 'testuser' },
      },
    ]);

    prismaMock.watchedAuthor.findMany.mockResolvedValue([]);
    prismaMock.watchedSeries.update.mockResolvedValue({});

    mockScrapeSeriesPage.mockResolvedValueOnce({
      asin: 'B001SERIES1',
      title: 'Target Series',
      bookCount: 1,
      books: [
        { asin: 'B001BOOK01', title: 'Book One', author: 'Author A' },
      ],
      hasMore: false,
      page: 1,
    });

    mockDeduplicateAndCollectGroups.mockReturnValue({
      books: [
        { asin: 'B001BOOK01', title: 'Book One', author: 'Author A' },
      ],
      groups: [],
    });

    mockCreateRequestForUser.mockResolvedValue({ success: true, request: {} });

    const { processWatchedLists } = await import('@/lib/services/watched-lists.service');
    const stats = await processWatchedLists(undefined, {
      userId: 'user-1',
      seriesAsin: 'B001SERIES1',
    });

    // Should have passed both userId and seriesAsin to the Prisma query
    expect(prismaMock.watchedSeries.findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', seriesAsin: 'B001SERIES1' },
      include: { user: { select: { id: true, plexUsername: true } } },
    });

    expect(stats.seriesChecked).toBe(1);
    expect(stats.requestsCreated).toBe(1);
  });

  it('filters by authorAsin when provided in options', async () => {
    prismaMock.watchedSeries.findMany.mockResolvedValue([]);

    prismaMock.watchedAuthor.findMany.mockResolvedValue([
      {
        id: 'wa-1',
        userId: 'user-1',
        authorAsin: 'B001AUTH001',
        authorName: 'Target Author',
        coverArtUrl: null,
        lastCheckedAt: null,
        user: { id: 'user-1', plexUsername: 'testuser' },
      },
    ]);

    prismaMock.watchedAuthor.update.mockResolvedValue({});

    mockSearchByAuthorAsin.mockResolvedValueOnce({
      books: [
        { asin: 'B001BOOK01', title: 'Author Book', author: 'Target Author' },
      ],
      hasMore: false,
      page: 1,
      totalResults: 1,
    });

    mockDeduplicateAndCollectGroups.mockReturnValue({
      books: [
        { asin: 'B001BOOK01', title: 'Author Book', author: 'Target Author' },
      ],
      groups: [],
    });

    mockCreateRequestForUser.mockResolvedValue({ success: true, request: {} });

    const { processWatchedLists } = await import('@/lib/services/watched-lists.service');
    const stats = await processWatchedLists(undefined, {
      userId: 'user-1',
      authorAsin: 'B001AUTH001',
    });

    // Should have passed both userId and authorAsin to the Prisma query
    expect(prismaMock.watchedAuthor.findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', authorAsin: 'B001AUTH001' },
      include: { user: { select: { id: true, plexUsername: true } } },
    });

    expect(stats.authorsChecked).toBe(1);
    expect(stats.requestsCreated).toBe(1);
  });

  it('skips authors when targeted for a specific series only', async () => {
    // When seriesAsin is provided but no authorAsin, authors should still be queried
    // but with no authorAsin filter (only userId), so they run normally.
    // The key behavior: seriesAsin filter applies to series, not authors.
    prismaMock.watchedSeries.findMany.mockResolvedValue([
      {
        id: 'ws-1',
        userId: 'user-1',
        seriesAsin: 'B001SERIES1',
        seriesTitle: 'Target Series',
        coverArtUrl: null,
        lastCheckedAt: null,
        user: { id: 'user-1', plexUsername: 'testuser' },
      },
    ]);

    prismaMock.watchedAuthor.findMany.mockResolvedValue([]);
    prismaMock.watchedSeries.update.mockResolvedValue({});

    mockScrapeSeriesPage.mockResolvedValueOnce({
      asin: 'B001SERIES1',
      title: 'Target Series',
      bookCount: 1,
      books: [
        { asin: 'B001BOOK01', title: 'Book One', author: 'Author A' },
      ],
      hasMore: false,
      page: 1,
    });

    mockDeduplicateAndCollectGroups.mockReturnValue({
      books: [
        { asin: 'B001BOOK01', title: 'Book One', author: 'Author A' },
      ],
      groups: [],
    });

    mockCreateRequestForUser.mockResolvedValue({ success: true, request: {} });

    const { processWatchedLists } = await import('@/lib/services/watched-lists.service');
    const stats = await processWatchedLists(undefined, {
      userId: 'user-1',
      seriesAsin: 'B001SERIES1',
    });

    // Series should be filtered by seriesAsin
    expect(prismaMock.watchedSeries.findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', seriesAsin: 'B001SERIES1' },
      include: { user: { select: { id: true, plexUsername: true } } },
    });

    // Authors query should only filter by userId (no authorAsin filter)
    expect(prismaMock.watchedAuthor.findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      include: { user: { select: { id: true, plexUsername: true } } },
    });

    expect(stats.seriesChecked).toBe(1);
  });
  describe('duplicate versions', () => {
    const standard = { asin: 'B0STANDARD', title: 'Mistborn: The Final Empire', author: 'Brandon Sanderson', narrator: 'Michael Kramer', rating: 4.7 };
    const dramatized = { asin: 'B0DRAMATIZ', title: 'Mistborn: The Final Empire (Dramatized Adaptation)', author: 'Brandon Sanderson', narrator: 'Full Cast', rating: 4.8 };

    function watchSeries(allowAlternateVersions: boolean) {
      prismaMock.watchedSeries.findMany.mockResolvedValue([
        {
          id: 'ws-v',
          userId: 'user-1',
          seriesAsin: 'B00MISTBRN',
          seriesTitle: 'Mistborn',
          coverArtUrl: null,
          lastCheckedAt: null,
          allowAlternateVersions,
          user: { id: 'user-1', plexUsername: 'testuser' },
        },
      ]);
      prismaMock.watchedAuthor.findMany.mockResolvedValue([]);
      prismaMock.watchedSeries.update.mockResolvedValue({});
      prismaMock.audiobook.findMany.mockResolvedValue([]); // nothing requested yet
      mockScrapeSeriesPage.mockResolvedValueOnce({
        asin: 'B00MISTBRN', title: 'Mistborn', bookCount: 2, books: [dramatized, standard], hasMore: false, page: 1,
      });
      mockDeduplicateAndCollectGroups.mockReturnValue({ books: [dramatized, standard], groups: [] });
      mockCreateRequestForUser.mockResolvedValue({ success: true, request: {} });
    }

    it('requests only the standard version by default and skips the dramatization', async () => {
      watchSeries(false);

      const { processWatchedLists } = await import('@/lib/services/watched-lists.service');
      const stats = await processWatchedLists();

      expect(mockCreateRequestForUser).toHaveBeenCalledTimes(1);
      expect(mockCreateRequestForUser).toHaveBeenCalledWith('user-1', expect.objectContaining({ asin: 'B0STANDARD' }));
      expect(stats.requestsCreated).toBe(1);
      expect(stats.skippedDuplicateVersion).toBe(1);
      expect(stats.alternateVersionsQueued).toBe(0);
    });

    it('skips both versions when the library already has one of them', async () => {
      watchSeries(false);
      prismaMock.plexLibrary.findMany.mockResolvedValue([{ asin: 'B0DRAMATIZ', title: dramatized.title, author: dramatized.author }]);

      const { processWatchedLists } = await import('@/lib/services/watched-lists.service');
      const stats = await processWatchedLists();

      expect(mockCreateRequestForUser).not.toHaveBeenCalled();
      expect(stats.skippedOwned).toBe(1);
      expect(stats.skippedDuplicateVersion).toBe(1);
    });

    it('queues the dramatization for admin approval with a label when the series opts in', async () => {
      watchSeries(true);

      const { processWatchedLists } = await import('@/lib/services/watched-lists.service');
      const stats = await processWatchedLists();

      expect(mockCreateRequestForUser).toHaveBeenCalledTimes(2);
      expect(mockCreateRequestForUser).toHaveBeenCalledWith('user-1', expect.objectContaining({ asin: 'B0STANDARD' }));
      expect(mockCreateRequestForUser).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({ asin: 'B0DRAMATIZ' }),
        { forceApproval: true, versionLabel: 'Dramatized Adaptation' }
      );
      expect(stats.requestsCreated).toBe(1);
      expect(stats.alternateVersionsQueued).toBe(1);
    });
  });
});
