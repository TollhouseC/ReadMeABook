/**
 * Component: Search Indexers Processor Tests
 * Documentation: documentation/backend/services/jobs.md
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaMock } from '../helpers/prisma';
import { createJobQueueMock } from '../helpers/job-queue';

const prismaMock = createPrismaMock();
const configMock = vi.hoisted(() => ({ get: vi.fn(), getAudibleRegion: vi.fn().mockResolvedValue('us') }));
const jobQueueMock = createJobQueueMock();
const prowlarrMock = vi.hoisted(() => ({ search: vi.fn(), searchWithVariations: vi.fn() }));

vi.mock('@/lib/db', () => ({
  prisma: prismaMock,
}));

vi.mock('@/lib/services/config.service', () => ({
  getConfigService: () => configMock,
}));

vi.mock('@/lib/services/job-queue.service', () => ({
  getJobQueueService: () => jobQueueMock,
}));

vi.mock('@/lib/integrations/prowlarr.service', () => ({
  getProwlarrService: () => prowlarrMock,
}));

vi.mock('@/lib/integrations/audible.service', () => ({
  getAudibleService: () => ({ getRuntime: vi.fn().mockResolvedValue(null) }),
}));

describe('processSearchIndexers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configMock.getAudibleRegion.mockResolvedValue('us');
  });

  it('marks request awaiting_search when no results found', async () => {
    configMock.get.mockImplementation(async (key: string) => {
      if (key === 'prowlarr_indexers') {
        return JSON.stringify([{ id: 1, name: 'Indexer', protocol: 'torrent', priority: 10, categories: [3030] }]);
      }
      return null;
    });
    prowlarrMock.searchWithVariations.mockResolvedValue([]);
    prismaMock.request.update.mockResolvedValue({});

    const { processSearchIndexers } = await import('@/lib/processors/search-indexers.processor');
    const result = await processSearchIndexers({
      requestId: 'req-1',
      audiobook: { id: 'a1', title: 'Book', author: 'Author' },
      jobId: 'job-1',
    });

    expect(result.success).toBe(false);
    expect(prismaMock.request.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'awaiting_search' }),
      })
    );
  });

  it('queues download job when results are ranked', async () => {
    configMock.get.mockImplementation(async (key: string) => {
      if (key === 'prowlarr_indexers') {
        return JSON.stringify([{ id: 1, name: 'Indexer', protocol: 'torrent', priority: 10, categories: [3030] }]);
      }
      if (key === 'indexer_flag_config') {
        return JSON.stringify([]);
      }
      return null;
    });

    prowlarrMock.searchWithVariations.mockResolvedValue([
      {
        indexer: 'Indexer',
        indexerId: 1,
        title: 'Book - Author',
        size: 50 * 1024 * 1024,
        seeders: 10,
        publishDate: new Date(),
        downloadUrl: 'magnet:?xt=urn:btih:abc',
        guid: 'guid-1',
        format: 'M4B',
      },
    ]);

    prismaMock.request.update.mockResolvedValue({});

    const { processSearchIndexers } = await import('@/lib/processors/search-indexers.processor');
    const result = await processSearchIndexers({
      requestId: 'req-2',
      audiobook: { id: 'a2', title: 'Book', author: 'Author' },
      jobId: 'job-2',
    });

    expect(result.success).toBe(true);
    expect(jobQueueMock.addDownloadJob).toHaveBeenCalledWith(
      'req-2',
      { id: 'a2', title: 'Book', author: 'Author' },
      expect.objectContaining({ title: 'Book - Author' })
    );
  });

  it('skips blacklisted releases and picks the next best one', async () => {
    configMock.get.mockImplementation(async (key: string) => {
      if (key === 'prowlarr_indexers') {
        return JSON.stringify([{ id: 1, name: 'Indexer', protocol: 'torrent', priority: 10, categories: [3030] }]);
      }
      if (key === 'indexer_flag_config') return JSON.stringify([]);
      return null;
    });

    const base = {
      indexer: 'Indexer', indexerId: 1, title: 'Book - Author', size: 50 * 1024 * 1024,
      seeders: 10, publishDate: new Date(), downloadUrl: 'magnet:?xt=urn:btih:abc',
    };
    prowlarrMock.searchWithVariations.mockResolvedValue([
      { ...base, guid: 'guid-dead', format: 'M4B' },
      { ...base, guid: 'guid-alive', format: 'MP3' },
    ]);
    prismaMock.blacklistedRelease.findMany.mockResolvedValueOnce([
      { title: 'unrelated', indexerName: null, infoHash: null, releaseUrl: 'guid-dead' },
    ]);
    prismaMock.request.update.mockResolvedValue({});

    const { processSearchIndexers } = await import('@/lib/processors/search-indexers.processor');
    const result = await processSearchIndexers({
      requestId: 'req-bl',
      audiobook: { id: 'a-bl', title: 'Book', author: 'Author' },
      jobId: 'job-bl',
    });

    expect(result.success).toBe(true);
    expect(prismaMock.blacklistedRelease.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { audiobookId: 'a-bl' } })
    );
    expect(jobQueueMock.addDownloadJob).toHaveBeenCalledWith(
      'req-bl',
      expect.anything(),
      expect.objectContaining({ guid: 'guid-alive' })
    );
  });

  it('queues re-search when every result is blacklisted', async () => {
    configMock.get.mockImplementation(async (key: string) => {
      if (key === 'prowlarr_indexers') {
        return JSON.stringify([{ id: 1, name: 'Indexer', protocol: 'torrent', priority: 10, categories: [3030] }]);
      }
      return null;
    });
    prowlarrMock.searchWithVariations.mockResolvedValue([
      {
        indexer: 'Indexer', indexerId: 1, title: 'Book - Author', size: 50 * 1024 * 1024,
        seeders: 10, publishDate: new Date(), downloadUrl: 'magnet:?xt=urn:btih:abc', guid: 'guid-dead',
      },
    ]);
    prismaMock.blacklistedRelease.findMany.mockResolvedValueOnce([
      { title: 'unrelated', indexerName: null, infoHash: null, releaseUrl: 'guid-dead' },
    ]);
    prismaMock.request.update.mockResolvedValue({});

    const { processSearchIndexers } = await import('@/lib/processors/search-indexers.processor');
    const result = await processSearchIndexers({
      requestId: 'req-all-bl',
      audiobook: { id: 'a-all-bl', title: 'Book', author: 'Author' },
      jobId: 'job-all-bl',
    });

    expect(result.success).toBe(false);
    expect(jobQueueMock.addDownloadJob).not.toHaveBeenCalled();
    expect(prismaMock.request.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'awaiting_search' }) })
    );
  });

  describe('series/author pack search', () => {
    const DAY = 24 * 60 * 60 * 1000;

    function noResults() {
      configMock.get.mockImplementation(async (key: string) =>
        key === 'prowlarr_indexers'
          ? JSON.stringify([{ id: 1, name: 'Indexer', protocol: 'torrent', priority: 10, categories: [3030] }])
          : null
      );
      prowlarrMock.searchWithVariations.mockResolvedValue([]);
      prismaMock.request.update.mockResolvedValue({});
      (jobQueueMock as any).addSearchPacksJob = vi.fn().mockResolvedValue('job');
    }

    async function search() {
      const { processSearchIndexers } = await import('@/lib/processors/search-indexers.processor');
      return processSearchIndexers({ requestId: 'req-p', audiobook: { id: 'a-p', title: 'Book', author: 'Author' }, jobId: 'job-p' });
    }

    it('queues a pack search when an audiobook request has searched for 24h+', async () => {
      noResults();
      prismaMock.request.findUnique.mockResolvedValueOnce({
        status: 'awaiting_search', type: 'audiobook', createdAt: new Date(Date.now() - 2 * DAY), lastPackSearchAt: null, customSearchTerms: null,
      });

      await search();

      expect((jobQueueMock as any).addSearchPacksJob).toHaveBeenCalledWith('req-p');
    });

    it('does not queue a pack search for a new request or one searched recently', async () => {
      noResults();
      prismaMock.request.findUnique.mockResolvedValueOnce({
        status: 'awaiting_search', type: 'audiobook', createdAt: new Date(), lastPackSearchAt: null, customSearchTerms: null,
      });
      await search();

      prismaMock.request.findUnique.mockResolvedValueOnce({
        status: 'awaiting_search', type: 'audiobook', createdAt: new Date(Date.now() - 3 * DAY),
        lastPackSearchAt: new Date(Date.now() - 60 * 60 * 1000), customSearchTerms: null,
      });
      await search();

      expect((jobQueueMock as any).addSearchPacksJob).not.toHaveBeenCalled();
    });

    it('skips the search entirely when the request is already downloading (e.g. linked to a pack)', async () => {
      noResults();
      prismaMock.request.findUnique.mockResolvedValueOnce({
        status: 'downloading', type: 'audiobook', createdAt: new Date(), lastPackSearchAt: null, customSearchTerms: null,
      });

      const result = await search();

      expect(result.message).toContain('already downloading');
      expect(prismaMock.request.update).not.toHaveBeenCalled();
      expect(prowlarrMock.searchWithVariations).not.toHaveBeenCalled();
    });
  });

  it('fails when no indexers are configured', async () => {
    configMock.get.mockResolvedValue(null);
    prismaMock.request.update.mockResolvedValue({});

    const { processSearchIndexers } = await import('@/lib/processors/search-indexers.processor');
    await expect(
      processSearchIndexers({
        requestId: 'req-3',
        audiobook: { id: 'a3', title: 'Book', author: 'Author' },
        jobId: 'job-3',
      })
    ).rejects.toThrow('No indexers configured');

    expect(prismaMock.request.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'failed' }),
      })
    );
  });
});


