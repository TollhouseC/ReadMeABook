/**
 * Component: Library Scan Processor Tests
 * Documentation: documentation/backend/services/jobs.md
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaMock } from '../helpers/prisma';

const prismaMock = createPrismaMock();
const libraryServiceMock = vi.hoisted(() => ({
  getLibraryItems: vi.fn(),
  getCoverCachingParams: vi.fn(),
}));
const configMock = vi.hoisted(() => ({
  getBackendMode: vi.fn(),
  getPlexConfig: vi.fn(),
  get: vi.fn(),
}));
const thumbnailCacheServiceMock = vi.hoisted(() => ({
  cacheLibraryThumbnail: vi.fn(),
}));
const jobQueueMock = vi.hoisted(() => ({
  addNotificationJob: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/lib/utils/audiobook-matcher', () => ({
  findPlexMatch: vi.fn(),
}));

vi.mock('@/lib/services/job-queue.service', () => ({
  getJobQueueService: () => jobQueueMock,
}));

vi.mock('@/lib/services/audiobookshelf/api', () => ({
  triggerABSItemMatch: vi.fn(),
  getABSItem: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: prismaMock,
}));

vi.mock('@/lib/services/library', () => ({
  getLibraryService: () => libraryServiceMock,
}));

vi.mock('@/lib/services/config.service', () => ({
  getConfigService: () => configMock,
}));

vi.mock('@/lib/services/thumbnail-cache.service', () => ({
  getThumbnailCacheService: () => thumbnailCacheServiceMock,
}));

describe('processScanPlex', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates and updates library items, matches requests', async () => {
    configMock.getBackendMode.mockResolvedValue('plex');
    configMock.getPlexConfig.mockResolvedValue({
      serverUrl: 'http://plex',
      authToken: 'token',
      libraryId: 'lib-1',
      machineIdentifier: 'machine',
    });

    libraryServiceMock.getCoverCachingParams.mockResolvedValue({
      backendBaseUrl: 'http://plex',
      authToken: 'token',
      backendMode: 'plex',
    });

    thumbnailCacheServiceMock.cacheLibraryThumbnail.mockResolvedValue('/app/cache/library/test.jpg');

    libraryServiceMock.getLibraryItems.mockResolvedValue([
      {
        id: 'rating-1',
        externalId: 'guid-1',
        title: 'New Book',
        author: 'Author',
        addedAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'rating-2',
        externalId: 'guid-2',
        title: 'Existing Book',
        author: 'Author',
        addedAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    prismaMock.plexLibrary.findFirst.mockImplementation(async (query: any) => {
      if (query.where.plexGuid === 'guid-2') {
        return { id: 'existing-id', plexGuid: 'guid-2' };
      }
      return null;
    });
    prismaMock.plexLibrary.create.mockResolvedValue({ id: 'new-id', plexGuid: 'guid-1' });
    prismaMock.plexLibrary.update.mockResolvedValue({});
    prismaMock.plexLibrary.findMany.mockResolvedValue([]);
    prismaMock.audiobook.findMany.mockResolvedValue([]);
    prismaMock.request.findMany.mockResolvedValue([
      {
        id: 'req-1',
        status: 'downloaded',
        audiobook: {
          id: 'a1',
          title: 'New Book',
          author: 'Author',
          narrator: null,
          audibleAsin: 'ASIN1',
        },
      },
    ]);
    prismaMock.audiobook.update.mockResolvedValue({});
    prismaMock.request.update.mockResolvedValue({});

    const matcher = await import('@/lib/utils/audiobook-matcher');
    vi.spyOn(matcher, 'findPlexMatch').mockResolvedValue({
      plexGuid: 'guid-1',
      plexRatingKey: 'rating-1',
      title: 'New Book',
      author: 'Author',
    });

    const { processScanPlex } = await import('@/lib/processors/scan-plex.processor');
    const result = await processScanPlex({ jobId: 'job-1' });

    expect(result.success).toBe(true);
    expect(prismaMock.plexLibrary.create).toHaveBeenCalled();
    expect(prismaMock.plexLibrary.update).toHaveBeenCalled();
    expect(prismaMock.request.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'available' }),
      })
    );
  });

  it('throws when audiobookshelf library is not configured', async () => {
    configMock.getBackendMode.mockResolvedValue('audiobookshelf');
    configMock.get.mockResolvedValue(null);

    libraryServiceMock.getCoverCachingParams.mockResolvedValue({
      backendBaseUrl: 'http://abs',
      authToken: 'token',
      backendMode: 'audiobookshelf',
    });

    const { processScanPlex } = await import('@/lib/processors/scan-plex.processor');

    await expect(processScanPlex({ jobId: 'job-2' })).rejects.toThrow(
      'Audiobookshelf library not configured'
    );
    expect(libraryServiceMock.getLibraryItems).not.toHaveBeenCalled();
  });

  it('removes stale items and resets linked audiobooks and requests', async () => {
    configMock.getBackendMode.mockResolvedValue('plex');
    configMock.getPlexConfig.mockResolvedValue({
      serverUrl: 'http://plex',
      authToken: 'token',
      libraryId: 'lib-1',
      machineIdentifier: 'machine',
    });

    libraryServiceMock.getCoverCachingParams.mockResolvedValue({
      backendBaseUrl: 'http://plex',
      authToken: 'token',
      backendMode: 'plex',
    });

    thumbnailCacheServiceMock.cacheLibraryThumbnail.mockResolvedValue('/app/cache/library/test.jpg');

    libraryServiceMock.getLibraryItems.mockResolvedValue([
      {
        id: 'rating-1',
        externalId: 'guid-1',
        title: 'Current Book',
        author: 'Author',
        addedAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    prismaMock.plexLibrary.findFirst.mockResolvedValue(null);
    prismaMock.plexLibrary.create.mockResolvedValue({ id: 'new-id', plexGuid: 'guid-1' });
    prismaMock.plexLibrary.findMany
      .mockResolvedValueOnce([{ id: 'stale-1', plexGuid: 'stale-guid', title: 'Stale Book', lastScannedAt: new Date('2020-01-01') }])
      .mockResolvedValueOnce([{ plexGuid: 'guid-1' }])
      .mockResolvedValueOnce([]); // step 5c: library ASINs
    prismaMock.plexLibrary.delete.mockResolvedValue({});
    prismaMock.audiobook.findMany
      .mockResolvedValueOnce([
        {
          id: 'ab-1',
          title: 'Stale Book',
          requests: [{ id: 'req-1', status: 'available' }],
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'ab-valid',
          title: 'Valid Book',
          plexGuid: 'guid-1',
          absItemId: null,
          requests: [],
        },
        {
          id: 'ab-orphan',
          title: 'Orphaned Book',
          plexGuid: null,
          absItemId: 'missing-guid',
          requests: [{ id: 'req-2', status: 'available' }],
        },
      ]);
    prismaMock.audiobook.update.mockResolvedValue({});
    prismaMock.request.update.mockResolvedValue({});
    prismaMock.request.findMany.mockResolvedValue([]);

    const matcher = await import('@/lib/utils/audiobook-matcher');
    (matcher.findPlexMatch as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const { processScanPlex } = await import('@/lib/processors/scan-plex.processor');
    const result = await processScanPlex({ jobId: 'job-3' });

    expect(result.success).toBe(true);
    expect(prismaMock.plexLibrary.delete).toHaveBeenCalledWith({ where: { id: 'stale-1' } });
    expect(prismaMock.audiobook.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'ab-orphan' },
        data: expect.objectContaining({ plexGuid: null, absItemId: null }),
      })
    );
    // Removed from library → cancelled (re-requestable), not the old 'downloaded' dead-end
    for (const id of ['req-1', 'req-2']) {
      expect(prismaMock.request.update).toHaveBeenCalledWith({
        where: { id },
        data: expect.objectContaining({ status: 'cancelled', errorMessage: 'Removed from library' }),
      });
    }
    expect(prismaMock.request.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'downloaded' }) })
    );
  });

  it('relinks books whose library item ID changed, keeps briefly-missing items, and restores wrongly cancelled requests', async () => {
    configMock.getBackendMode.mockResolvedValue('plex');
    configMock.getPlexConfig.mockResolvedValue({ serverUrl: 'http://plex', authToken: 'token', libraryId: 'lib-1', machineIdentifier: 'machine' });
    libraryServiceMock.getCoverCachingParams.mockResolvedValue({ backendBaseUrl: 'http://plex', authToken: 'token', backendMode: 'plex' });
    libraryServiceMock.getLibraryItems.mockResolvedValue([
      { id: 'r1', externalId: 'new-guid', title: 'HWFwM 3', author: 'Shirtaloon', asin: 'B0HWFWM003', addedAt: new Date(), updatedAt: new Date() },
      { id: 'r2', externalId: 'guid-9', title: 'Gin Fling', author: 'Lucy Score', asin: 'B0GINFLING', addedAt: new Date(), updatedAt: new Date() },
    ]);
    prismaMock.plexLibrary.findFirst.mockResolvedValue(null);
    prismaMock.plexLibrary.create.mockResolvedValue({ id: 'x', plexGuid: 'x' });
    prismaMock.plexLibrary.findMany
      .mockResolvedValueOnce([
        // Same book, old ID, missing > 12h → relink, not remove-and-cancel
        { id: 'old-rec', plexGuid: 'old-guid', title: 'HWFwM 3', asin: 'B0HWFWM003', lastScannedAt: new Date('2020-01-01') },
        // Missing from this scan only (seen 1h ago) → kept for now
        { id: 'recent-rec', plexGuid: 'recent-guid', title: 'Partial Scan Book', asin: 'B0PARTIAL1', lastScannedAt: new Date(Date.now() - 3600000) },
      ])
      .mockResolvedValueOnce([{ plexGuid: 'new-guid' }, { plexGuid: 'guid-9' }, { plexGuid: 'recent-guid' }])
      .mockResolvedValueOnce([]);
    prismaMock.plexLibrary.delete.mockResolvedValue({});
    prismaMock.audiobook.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.audiobook.findMany.mockResolvedValueOnce([]); // step 5b: no orphans
    prismaMock.audiobook.update.mockResolvedValue({});
    prismaMock.request.update.mockResolvedValue({});
    prismaMock.request.findFirst.mockResolvedValue(null);
    prismaMock.request.findMany.mockImplementation(async (args: any) =>
      args?.where?.status === 'cancelled'
        ? [{ id: 'req-gin', audiobook: { id: 'ab-gin', title: 'Gin Fling', audibleAsin: 'B0GINFLING' } }]
        : []);

    const matcher = await import('@/lib/utils/audiobook-matcher');
    (matcher.findPlexMatch as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const { processScanPlex } = await import('@/lib/processors/scan-plex.processor');
    const result = await processScanPlex({ jobId: 'job-relink' });

    expect(prismaMock.audiobook.updateMany).toHaveBeenCalledWith({
      where: { OR: [{ plexGuid: 'old-guid' }, { absItemId: 'old-guid' }] },
      data: expect.objectContaining({ plexGuid: 'new-guid' }),
    });
    expect(prismaMock.plexLibrary.delete).toHaveBeenCalledWith({ where: { id: 'old-rec' } });
    expect(prismaMock.plexLibrary.delete).not.toHaveBeenCalledWith({ where: { id: 'recent-rec' } });
    expect(prismaMock.request.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'cancelled' }) })
    );
    // Wrongly cancelled request restored and relinked
    expect(prismaMock.request.update).toHaveBeenCalledWith({
      where: { id: 'req-gin' },
      data: expect.objectContaining({ status: 'available', errorMessage: null }),
    });
    expect(prismaMock.audiobook.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'ab-gin' }, data: expect.objectContaining({ plexGuid: 'guid-9' }),
    }));
    expect(result).toMatchObject({ audiobooksRelinked: 1, requestsRestored: 1 });
  });

  it('relinks an orphaned audiobook by ASIN instead of cancelling its request', async () => {
    configMock.getBackendMode.mockResolvedValue('audiobookshelf');
    libraryServiceMock.getCoverCachingParams.mockResolvedValue({ backendBaseUrl: 'http://abs', authToken: 't', backendMode: 'audiobookshelf' });
    configMock.get.mockResolvedValue('abs-lib');
    libraryServiceMock.getLibraryItems.mockResolvedValue([
      { id: 'i1', externalId: 'abs-new', title: "Ender's Game", author: 'Card', asin: 'B0ENDER001', addedAt: new Date(), updatedAt: new Date() },
    ]);
    prismaMock.plexLibrary.findFirst.mockResolvedValue({ id: 'rec', plexGuid: 'abs-new' });
    prismaMock.plexLibrary.update.mockResolvedValue({});
    prismaMock.plexLibrary.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ plexGuid: 'abs-new' }])
      .mockResolvedValueOnce([]);
    prismaMock.audiobook.findMany.mockResolvedValueOnce([
      { id: 'ab-ender', title: "Ender's Game", audibleAsin: 'B0ENDER001', plexGuid: null, absItemId: 'abs-gone', requests: [{ id: 'req-e', status: 'available' }] },
    ]);
    prismaMock.audiobook.update.mockResolvedValue({});
    prismaMock.request.findMany.mockResolvedValue([]);

    const matcher = await import('@/lib/utils/audiobook-matcher');
    (matcher.findPlexMatch as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const { processScanPlex } = await import('@/lib/processors/scan-plex.processor');
    await processScanPlex({ jobId: 'job-orphan' });

    expect(prismaMock.audiobook.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'ab-ender' }, data: expect.objectContaining({ absItemId: 'abs-new' }),
    }));
    expect(prismaMock.request.update).not.toHaveBeenCalled();
  });

  it('stops during the item pass when cancelled and never runs stale cleanup', async () => {
    configMock.getBackendMode.mockResolvedValue('plex');
    configMock.getPlexConfig.mockResolvedValue({ serverUrl: 'http://plex', authToken: 'token', libraryId: 'lib-1', machineIdentifier: 'machine' });
    libraryServiceMock.getCoverCachingParams.mockResolvedValue({ backendBaseUrl: 'http://plex', authToken: 'token', backendMode: 'plex' });
    libraryServiceMock.getLibraryItems.mockResolvedValue([
      { id: 'r1', externalId: 'g1', title: 'One', author: 'A', addedAt: new Date(), updatedAt: new Date() },
    ]);
    prismaMock.job.findUnique.mockResolvedValue({ cancelRequested: true });

    const { processScanPlex } = await import('@/lib/processors/scan-plex.processor');
    const result = await processScanPlex({ jobId: 'job-cancel' });

    expect(result).toMatchObject({ cancelled: true, totalScanned: 0 });
    expect(prismaMock.plexLibrary.findMany).not.toHaveBeenCalled(); // no stale cleanup
    expect(prismaMock.request.update).not.toHaveBeenCalled();
  });

  it('cancels requests stuck at downloaded whose book is no longer in the library', async () => {
    configMock.getBackendMode.mockResolvedValue('plex');
    configMock.getPlexConfig.mockResolvedValue({
      serverUrl: 'http://plex',
      authToken: 'token',
      libraryId: 'lib-1',
      machineIdentifier: 'machine',
    });
    libraryServiceMock.getCoverCachingParams.mockResolvedValue({
      backendBaseUrl: 'http://plex',
      authToken: 'token',
      backendMode: 'plex',
    });
    // Empty scan → stale cleanup is skipped by its safety guard
    libraryServiceMock.getLibraryItems.mockResolvedValue([]);

    prismaMock.plexLibrary.findMany
      .mockResolvedValueOnce([]) // step 5b: valid guids
      .mockResolvedValueOnce([{ asin: 'B0INLIBRARY' }]); // step 5c: library ASINs
    prismaMock.audiobook.findMany.mockResolvedValueOnce([]); // step 5b: no orphans
    prismaMock.request.findMany
      .mockResolvedValueOnce([
        { id: 'req-gone', audiobook: { title: 'Gone Book', audibleAsin: 'B0GONEBOOK', plexGuid: null, absItemId: null } },
        { id: 'req-present', audiobook: { title: 'Present Book', audibleAsin: 'b0inlibrary', plexGuid: null, absItemId: null } },
        { id: 'req-linked', audiobook: { title: 'Linked Book', audibleAsin: 'B0LINKED01', plexGuid: 'guid-x', absItemId: null } },
      ])
      .mockResolvedValueOnce([]); // step 6: matchable requests
    prismaMock.request.update.mockResolvedValue({});

    const { processScanPlex } = await import('@/lib/processors/scan-plex.processor');
    const result = await processScanPlex({ jobId: 'job-5c' });

    // Only stale (>48h), unlinked, not-in-library 'downloaded' requests are queried
    expect(prismaMock.request.findMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({
        type: 'audiobook',
        status: 'downloaded',
        deletedAt: null,
        updatedAt: { lt: expect.any(Date) },
      }),
    }));
    expect(prismaMock.request.update).toHaveBeenCalledTimes(1);
    expect(prismaMock.request.update).toHaveBeenCalledWith({
      where: { id: 'req-gone' },
      data: expect.objectContaining({ status: 'cancelled', errorMessage: 'Removed from library' }),
    });
    expect(result.stuckDownloadedCancelled).toBe(1);
  });

  it('matches audiobookshelf requests without re-triggering metadata match', async () => {
    configMock.getBackendMode.mockResolvedValue('audiobookshelf');
    configMock.get.mockResolvedValue('abs-lib');

    libraryServiceMock.getCoverCachingParams.mockResolvedValue({
      backendBaseUrl: 'http://abs',
      authToken: 'token',
      backendMode: 'audiobookshelf',
    });

    thumbnailCacheServiceMock.cacheLibraryThumbnail.mockResolvedValue('/app/cache/library/test.jpg');

    libraryServiceMock.getLibraryItems.mockResolvedValue([]);

    prismaMock.plexLibrary.findMany.mockResolvedValue([]);
    prismaMock.audiobook.findMany.mockResolvedValue([]);
    prismaMock.request.findMany.mockResolvedValue([
      {
        id: 'req-abs',
        status: 'downloaded',
        audiobook: {
          id: 'abs-audio',
          title: 'ABS Title',
          author: 'ABS Author',
          narrator: 'Narrator',
          audibleAsin: 'ASIN123',
        },
        user: {
          plexUsername: 'testuser',
        },
      },
    ] as any);
    prismaMock.audiobook.update.mockResolvedValue({});
    prismaMock.request.update.mockResolvedValue({});

    const matcher = await import('@/lib/utils/audiobook-matcher');
    (matcher.findPlexMatch as ReturnType<typeof vi.fn>).mockResolvedValue({
      plexGuid: 'abs-item-1',
      plexRatingKey: 'rating-abs',
      title: 'ABS Title',
      author: 'ABS Author',
    });

    const absApi = await import('@/lib/services/audiobookshelf/api');

    const { processScanPlex } = await import('@/lib/processors/scan-plex.processor');
    const result = await processScanPlex({ jobId: 'job-4' });

    expect(result.success).toBe(true);
    expect(prismaMock.audiobook.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ absItemId: 'abs-item-1' }),
      })
    );
    // Should NOT trigger metadata match - items with ASIN already have correct metadata
    expect(absApi.triggerABSItemMatch).not.toHaveBeenCalled();
  });

  it('uses file hash matching for ABS items without ASIN', async () => {
    configMock.getBackendMode.mockResolvedValue('audiobookshelf');
    configMock.get.mockResolvedValue('abs-lib');

    libraryServiceMock.getCoverCachingParams.mockResolvedValue({
      backendBaseUrl: 'http://abs',
      authToken: 'token',
      backendMode: 'audiobookshelf',
    });

    thumbnailCacheServiceMock.cacheLibraryThumbnail.mockResolvedValue('/app/cache/library/test.jpg');

    // Return an item without ASIN
    libraryServiceMock.getLibraryItems.mockResolvedValue([
      {
        id: 'rating-hash-1',
        externalId: 'abs-hash-1',
        title: 'Book Without ASIN',
        author: 'Author',
        asin: null, // No ASIN yet
        addedAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    prismaMock.plexLibrary.findFirst.mockResolvedValue(null);
    prismaMock.plexLibrary.create.mockResolvedValue({});
    prismaMock.plexLibrary.findMany.mockResolvedValue([]);
    prismaMock.audiobook.findMany.mockResolvedValue([]);
    prismaMock.request.findMany.mockResolvedValue([]);

    // Mock getABSItem to return item with audio files
    const absApi = await import('@/lib/services/audiobookshelf/api');
    (absApi.getABSItem as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'abs-hash-1',
      media: {
        audioFiles: [
          { metadata: { filename: 'Chapter 01.mp3' } },
          { metadata: { filename: 'Chapter 02.mp3' } },
          { metadata: { filename: 'Chapter 03.mp3' } },
        ],
      },
    });

    // Mock findFirst to return matching audiobook with filesHash
    prismaMock.audiobook.findFirst.mockResolvedValue({
      id: 'matched-audio-1',
      audibleAsin: 'MATCHED-ASIN',
      title: 'Matched Book Title',
      status: 'completed',
    } as any);

    const { processScanPlex } = await import('@/lib/processors/scan-plex.processor');
    const result = await processScanPlex({ jobId: 'job-hash-1' });

    expect(result.success).toBe(true);

    // Verify getABSItem was called
    expect(absApi.getABSItem).toHaveBeenCalledWith('abs-hash-1');

    // Verify audiobook.findFirst was called with hash matching
    expect(prismaMock.audiobook.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          filesHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          status: 'completed',
        }),
      })
    );

    // Verify triggerABSItemMatch was called with matched ASIN
    expect(absApi.triggerABSItemMatch).toHaveBeenCalledWith('abs-hash-1', 'MATCHED-ASIN');
  });

  it('falls back to fuzzy matching when no file hash match found', async () => {
    configMock.getBackendMode.mockResolvedValue('audiobookshelf');
    configMock.get.mockResolvedValue('abs-lib');

    libraryServiceMock.getCoverCachingParams.mockResolvedValue({
      backendBaseUrl: 'http://abs',
      authToken: 'token',
      backendMode: 'audiobookshelf',
    });

    thumbnailCacheServiceMock.cacheLibraryThumbnail.mockResolvedValue('/app/cache/library/test.jpg');

    // Return an item without ASIN
    libraryServiceMock.getLibraryItems.mockResolvedValue([
      {
        id: 'rating-fuzzy-1',
        externalId: 'abs-fuzzy-1',
        title: 'External Book',
        author: 'Author',
        asin: null,
        addedAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    prismaMock.plexLibrary.findFirst.mockResolvedValue(null);
    prismaMock.plexLibrary.create.mockResolvedValue({});
    prismaMock.plexLibrary.findMany.mockResolvedValue([]);
    prismaMock.audiobook.findMany.mockResolvedValue([]);
    prismaMock.request.findMany.mockResolvedValue([]);

    // Mock getABSItem to return item with audio files
    const absApi = await import('@/lib/services/audiobookshelf/api');
    (absApi.getABSItem as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'abs-fuzzy-1',
      media: {
        audioFiles: [{ metadata: { filename: 'Some File.mp3' } }],
      },
    });

    // Mock findFirst to return NO match (external content)
    prismaMock.audiobook.findFirst.mockResolvedValue(null);

    const { processScanPlex } = await import('@/lib/processors/scan-plex.processor');
    const result = await processScanPlex({ jobId: 'job-fuzzy-1' });

    expect(result.success).toBe(true);

    // Verify triggerABSItemMatch was called WITHOUT ASIN (fuzzy fallback)
    expect(absApi.triggerABSItemMatch).toHaveBeenCalledWith('abs-fuzzy-1', undefined);
  });
});


