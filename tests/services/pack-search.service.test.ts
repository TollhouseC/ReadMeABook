/**
 * Component: Pack Search Service Tests
 * Documentation: documentation/features/series-packs.md
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaMock } from '../helpers/prisma';

const prismaMock = createPrismaMock();
const mocks = vi.hoisted(() => ({
  configGet: vi.fn(),
  getClientServiceForProtocol: vi.fn(),
  getClientForProtocol: vi.fn(),
  addMonitorJob: vi.fn(),
  prowlarrSearch: vi.fn(),
  scrapeSeriesPage: vi.fn(),
  getRuntime: vi.fn(),
  createRequestForUser: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ prisma: prismaMock }));
vi.mock('@/lib/services/config.service', () => ({ getConfigService: () => ({ get: mocks.configGet }) }));
vi.mock('@/lib/services/download-client-manager.service', () => ({
  getDownloadClientManager: () => ({
    getClientServiceForProtocol: mocks.getClientServiceForProtocol,
    getClientForProtocol: mocks.getClientForProtocol,
  }),
}));
vi.mock('@/lib/services/job-queue.service', () => ({ getJobQueueService: () => ({ addMonitorJob: mocks.addMonitorJob }) }));
vi.mock('@/lib/integrations/prowlarr.service', () => ({ getProwlarrService: async () => ({ search: mocks.prowlarrSearch }) }));
vi.mock('@/lib/integrations/audible-series', () => ({ scrapeSeriesPage: mocks.scrapeSeriesPage }));
vi.mock('@/lib/integrations/audible.service', () => ({ getAudibleService: () => ({ getRuntime: mocks.getRuntime }) }));
vi.mock('@/lib/services/request-creator.service', () => ({ createRequestForUser: mocks.createRequestForUser }));

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;
const HASH = 'abc123hash';
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;

const qbit = {
  clientType: 'qbittorrent',
  addTorrent: vi.fn(),
  getFiles: vi.fn(),
  setFilePriority: vi.fn(),
  resumeTorrent: vi.fn(),
  deleteTorrent: vi.fn(),
};

const SERIES_LISTING = [
  { asin: 'B01', title: 'Mistborn: The Final Empire', author: 'Brandon Sanderson', narrator: 'Michael Kramer', seriesPart: '1' },
  { asin: 'B02', title: 'The Well of Ascension', author: 'Brandon Sanderson', narrator: 'Michael Kramer', seriesPart: '2' },
  { asin: 'B03', title: 'The Hero of Ages', author: 'Brandon Sanderson', narrator: 'Michael Kramer', seriesPart: '3' },
];

const SERIES_PACK = {
  indexer: 'ABB', indexerId: 1, title: 'Brandon Sanderson - Mistborn Complete Series (Books 1-3) [M4B]',
  size: 3 * GB, seeders: 12, publishDate: new Date(), downloadUrl: 'magnet:?xt=urn:btih:pack', guid: 'g-series', infoUrl: 'https://abb/pack',
};
const AUTHOR_PACK = {
  indexer: 'ABB', indexerId: 1, title: 'Brandon Sanderson - Complete Audiobook Collection',
  size: 40 * GB, seeders: 5, publishDate: new Date(), downloadUrl: 'magnet:?xt=urn:btih:author', guid: 'g-author',
};

const PACK_FILES = [
  { name: 'Mistborn Complete/01 - The Final Empire/a.m4b', size: 800 * MB, index: 0 },
  { name: 'Mistborn Complete/02 - Well of Ascension/a.m4b', size: 900 * MB, index: 1 },
  { name: 'Mistborn Complete/03 - Hero of Ages/a.m4b', size: 900 * MB, index: 2 },
  { name: 'Mistborn Complete/02 - Well of Ascension/cover.jpg', size: 1 * MB, index: 3 },
  { name: 'Mistborn Complete/Bonus - Unrelated Novella/a.mp3', size: 100 * MB, index: 4 },
];

function triggeringRequest(overrides: Record<string, any> = {}) {
  return {
    id: 'req-2',
    type: 'audiobook',
    status: 'awaiting_search',
    deletedAt: null,
    createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
    lastPackSearchAt: null,
    audiobook: {
      id: 'ab-2', audibleAsin: 'B02', title: 'The Well of Ascension', author: 'Brandon Sanderson',
      narrator: 'Michael Kramer', series: 'Mistborn', seriesAsin: 'SER1', seriesPart: '2',
    },
    user: { id: 'u1', role: 'admin', autoApproveRequests: null, plexUsername: 'admin' },
    ...overrides,
  };
}

async function run(options = {}) {
  const { runPackSearch } = await import('@/lib/services/pack-search.service');
  return runPackSearch('req-2', logger, { metadataTimeoutMs: 0, pollIntervalMs: 0, sleep: async () => {}, ...options });
}

describe('runPackSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-applied each test: clearAllMocks resets resolved values in this Vitest version
    mocks.configGet.mockImplementation(async (key: string) =>
      key === 'prowlarr_indexers'
        ? JSON.stringify([{ id: 1, name: 'ABB', protocol: 'torrent', priority: 10, categories: [3030] }])
        : null
    );
    mocks.getClientServiceForProtocol.mockResolvedValue(qbit);
    mocks.getClientForProtocol.mockResolvedValue({ category: 'readmeabook' });
    mocks.addMonitorJob.mockResolvedValue('job');
    mocks.prowlarrSearch.mockResolvedValue([SERIES_PACK]);
    mocks.scrapeSeriesPage.mockResolvedValue({ books: SERIES_LISTING, hasMore: false });
    mocks.getRuntime.mockResolvedValue(null);
    mocks.createRequestForUser.mockResolvedValue({ success: true, request: { id: 'req-1' } });

    qbit.addTorrent.mockResolvedValue(HASH);
    qbit.getFiles.mockResolvedValue(PACK_FILES);
    qbit.setFilePriority.mockResolvedValue(undefined);
    qbit.resumeTorrent.mockResolvedValue(undefined);
    qbit.deleteTorrent.mockResolvedValue(undefined);

    prismaMock.request.findUnique.mockResolvedValue(triggeringRequest());
    prismaMock.request.update.mockResolvedValue({});
    prismaMock.request.findFirst.mockImplementation(async ({ where }: any) =>
      where.audiobook?.audibleAsin === 'B03' ? { id: 'req-3', status: 'awaiting_search' } : null
    );
    prismaMock.downloadHistory.findFirst.mockResolvedValue(null);
    prismaMock.downloadHistory.updateMany.mockResolvedValue({});
    prismaMock.downloadHistory.create.mockImplementation(async ({ data }: any) => ({ id: `dh-${data.requestId}` }));
    prismaMock.blacklistedRelease.findMany.mockResolvedValue([]);
    prismaMock.blacklistedRelease.create.mockResolvedValue({});
    prismaMock.plexLibrary.findMany.mockResolvedValue([]);
    prismaMock.configuration.findUnique.mockResolvedValue(null);
  });

  it('grabs a verified series pack, links stuck requests, fills out the series, and downloads only its books', async () => {
    const result = await run();

    expect(result).toMatchObject({ status: 'grabbed', packType: 'series' });
    expect(result.importedBooks).toEqual(['Mistborn: The Final Empire', 'The Well of Ascension', 'The Hero of Ages']);

    // Inspected with metadata-only add
    expect(qbit.addTorrent).toHaveBeenCalledWith(SERIES_PACK.downloadUrl, expect.objectContaining({
      category: 'readmeabook', stopCondition: 'MetadataReceived',
    }));

    // Only the series books (+ the cover next to one) download; the unrelated novella doesn't
    expect(qbit.setFilePriority).toHaveBeenCalledWith(HASH, [4], 0);
    const wantedCall = qbit.setFilePriority.mock.calls.find(c => c[2] === 1)!;
    expect([...wantedCall[1]].sort()).toEqual([0, 1, 2, 3]);

    // One DownloadHistory per request, sharing the torrent, each with its own files
    expect(prismaMock.downloadHistory.create).toHaveBeenCalledTimes(3);
    expect(prismaMock.downloadHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        requestId: 'req-2',
        downloadClientId: HASH,
        downloadStatus: 'downloading',
        packType: 'series',
        packFiles: ['02 - Well of Ascension/a.m4b'],
      }),
    });

    // Filled out the unrequested book (admin = auto-approved), linked the stuck one
    expect(mocks.createRequestForUser).toHaveBeenCalledWith('u1', expect.objectContaining({ asin: 'B01' }), { skipAutoSearch: true });
    for (const id of ['req-1', 'req-2', 'req-3']) {
      expect(prismaMock.request.update).toHaveBeenCalledWith({
        where: { id },
        data: expect.objectContaining({ status: 'downloading' }),
      });
    }

    expect(qbit.resumeTorrent).toHaveBeenCalledWith(HASH);
    expect(mocks.addMonitorJob).toHaveBeenCalledTimes(1);
    expect(mocks.addMonitorJob).toHaveBeenCalledWith('req-2', 'dh-req-2', HASH, 'qbittorrent', 3);
    expect(prismaMock.request.update).toHaveBeenCalledWith({
      where: { id: 'req-2' },
      data: { lastPackSearchAt: expect.any(Date) },
    });
  });

  it('rejects and blacklists a pack that does not contain the book, then stops', async () => {
    qbit.getFiles.mockResolvedValue(PACK_FILES.filter(f => !f.name.includes('Well of Ascension')));

    const result = await run();

    expect(result.status).toBe('no_pack');
    expect(qbit.deleteTorrent).toHaveBeenCalledWith(HASH, true);
    expect(prismaMock.blacklistedRelease.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ audiobookId: 'ab-2', title: SERIES_PACK.title, reason: 'pack_missing_book' }),
    });
    expect(prismaMock.downloadHistory.create).not.toHaveBeenCalled();
    expect(qbit.resumeTorrent).not.toHaveBeenCalled();
  });

  it('blacklists a pack whose file list never arrives', async () => {
    qbit.getFiles.mockResolvedValue([]);

    const result = await run();

    expect(result.status).toBe('no_pack');
    expect(prismaMock.blacklistedRelease.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ reason: 'pack_no_metadata' }),
    });
  });

  it('never touches a torrent another download is already using', async () => {
    prismaMock.downloadHistory.findFirst.mockResolvedValue({ id: 'dh-other' });

    const result = await run();

    expect(result.status).toBe('no_pack');
    expect(qbit.deleteTorrent).not.toHaveBeenCalled();
    expect(prismaMock.blacklistedRelease.create).not.toHaveBeenCalled();
  });

  it('only logs author packs in log-only mode (default) — no download, no blacklist', async () => {
    mocks.prowlarrSearch.mockResolvedValue([AUTHOR_PACK]);

    const result = await run();

    expect(result.status).toBe('no_pack');
    expect(qbit.deleteTorrent).toHaveBeenCalledWith(HASH, true);
    expect(prismaMock.blacklistedRelease.create).not.toHaveBeenCalled();
    expect(prismaMock.downloadHistory.create).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('[author packs: log-only] Would grab'));
  });

  it('grabs author packs when enabled, importing only the requested series', async () => {
    mocks.configGet.mockImplementation(async (key: string) => {
      if (key === 'prowlarr_indexers') return JSON.stringify([{ id: 1, name: 'ABB', protocol: 'torrent', priority: 10, categories: [3030] }]);
      if (key === 'pack_search_author_mode') return 'enabled';
      return null;
    });
    mocks.prowlarrSearch.mockResolvedValue([AUTHOR_PACK]);
    qbit.getFiles.mockResolvedValue([
      { name: 'Sanderson/Mistborn 2 - The Well of Ascension/a.m4b', size: 900 * MB, index: 0 },
      { name: 'Sanderson/Stormlight 02 - Words of Radiance/a.m4b', size: 2 * GB, index: 1 },
      { name: 'Sanderson/Elantris/a.m4b', size: 1 * GB, index: 2 },
    ]);

    const result = await run();

    expect(result).toMatchObject({ status: 'grabbed', packType: 'author', importedBooks: ['The Well of Ascension'] });
    expect(qbit.setFilePriority).toHaveBeenCalledWith(HASH, [1, 2], 0);
  });

  it('does not fill out the series for a user who needs approval', async () => {
    prismaMock.request.findUnique.mockResolvedValue(triggeringRequest({
      user: { id: 'u2', role: 'user', autoApproveRequests: false, plexUsername: 'bob' },
    }));

    const result = await run();

    expect(result.importedBooks).toEqual(['The Well of Ascension', 'The Hero of Ages']);
    expect(mocks.createRequestForUser).not.toHaveBeenCalled();
  });

  describe('skips', () => {
    it('when pack search is disabled', async () => {
      mocks.configGet.mockImplementation(async (key: string) => (key === 'pack_search_enabled' ? 'false' : null));
      expect((await run()).status).toBe('disabled');
      expect(qbit.addTorrent).not.toHaveBeenCalled();
    });

    it('when the request is no longer awaiting search', async () => {
      prismaMock.request.findUnique.mockResolvedValue(triggeringRequest({ status: 'downloading' }));
      expect(await run()).toMatchObject({ status: 'skipped', reason: 'status is downloading' });
    });

    it('when the request is younger than 24h', async () => {
      prismaMock.request.findUnique.mockResolvedValue(triggeringRequest({ createdAt: new Date() }));
      expect(await run()).toMatchObject({ status: 'skipped', reason: 'not due' });
      expect(prismaMock.request.update).not.toHaveBeenCalled();
    });

    it('when the book is not in a series (and records the attempt)', async () => {
      const req = triggeringRequest();
      req.audiobook.series = null as any;
      prismaMock.request.findUnique.mockResolvedValue(req);

      expect(await run()).toMatchObject({ status: 'skipped', reason: 'book is not in a series' });
      expect(prismaMock.request.update).toHaveBeenCalledWith({ where: { id: 'req-2' }, data: { lastPackSearchAt: expect.any(Date) } });
    });

    it('when the torrent client is not qBittorrent', async () => {
      mocks.getClientServiceForProtocol.mockResolvedValue({ clientType: 'transmission' });
      const result = await run();
      expect(result.status).toBe('skipped');
      expect(result.reason).toContain('qBittorrent');
    });
  });
});
