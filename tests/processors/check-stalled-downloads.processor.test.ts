/**
 * Component: Check Stalled Downloads Processor Tests
 * Documentation: documentation/backend/services/scheduler.md
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaMock } from '../helpers/prisma';
import { createJobQueueMock } from '../helpers/job-queue';

const prismaMock = createPrismaMock();
const jobQueueMock = createJobQueueMock();
const clientMock = vi.hoisted(() => ({
  clientType: 'qbittorrent',
  protocol: 'torrent',
  getDownload: vi.fn(),
  deleteDownload: vi.fn(),
}));
const downloadClientManagerMock = vi.hoisted(() => ({
  getClientServiceForProtocol: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ prisma: prismaMock }));
vi.mock('@/lib/services/job-queue.service', () => ({ getJobQueueService: () => jobQueueMock }));
vi.mock('@/lib/services/config.service', () => ({ getConfigService: () => ({}) }));
vi.mock('@/lib/services/download-client-manager.service', () => ({
  getDownloadClientManager: () => downloadClientManagerMock,
}));

const HOUR = 60 * 60 * 1000;

function download(overrides: Record<string, any> = {}) {
  return {
    id: 'dh-1',
    downloadClient: 'qbittorrent',
    downloadClientId: 'abcdef123',
    torrentName: 'Wild Side - Elsie Silver [M4B]',
    indexerName: 'AudioBook Bay',
    torrentHash: 'ABCDEF123',
    torrentUrl: 'https://abb/page/1',
    torrentSizeBytes: BigInt(703070208),
    stallCheckProgress: null,
    stallCheckedAt: null,
    request: {
      id: 'req-1',
      type: 'audiobook',
      audiobookId: 'ab-1',
      audiobook: { id: 'ab-1', title: 'Wild Side', author: 'Elsie Silver', audibleAsin: 'B0TEST0001' },
    },
    ...overrides,
  };
}

function clientReports(progress: number, status = 'downloading') {
  clientMock.getDownload.mockResolvedValue({ id: 'abcdef123', progress, status, downloadSpeed: 0 });
}

async function run() {
  const { processCheckStalledDownloads } = await import('@/lib/processors/check-stalled-downloads.processor');
  return processCheckStalledDownloads({ jobId: 'job-1' });
}

describe('processCheckStalledDownloads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    downloadClientManagerMock.getClientServiceForProtocol.mockResolvedValue(clientMock);
    clientMock.deleteDownload.mockResolvedValue(undefined);
  });

  it('only considers selected, active, non-direct downloads', async () => {
    prismaMock.downloadHistory.findMany.mockResolvedValue([]);

    await run();

    expect(prismaMock.downloadHistory.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        selected: true,
        downloadStatus: 'downloading',
        downloadClient: { not: 'direct' },
        request: { status: 'downloading', deletedAt: null },
      }),
    }));
  });

  it('records a baseline on the first check', async () => {
    prismaMock.downloadHistory.findMany.mockResolvedValue([download()]);
    clientReports(0.12);

    const result = await run();

    expect(prismaMock.downloadHistory.update).toHaveBeenCalledWith({
      where: { id: 'dh-1' },
      data: { stallCheckProgress: 0.12, stallCheckedAt: expect.any(Date) },
    });
    expect(prismaMock.blacklistedRelease.create).not.toHaveBeenCalled();
    expect(result.baselined).toBe(1);
  });

  it('moves the baseline forward when the download progressed', async () => {
    prismaMock.downloadHistory.findMany.mockResolvedValue([
      download({ stallCheckProgress: 0.1, stallCheckedAt: new Date(Date.now() - 25 * HOUR) }),
    ]);
    clientReports(0.35);

    const result = await run();

    expect(prismaMock.downloadHistory.update).toHaveBeenCalledWith({
      where: { id: 'dh-1' },
      data: { stallCheckProgress: 0.35, stallCheckedAt: expect.any(Date) },
    });
    expect(prismaMock.blacklistedRelease.create).not.toHaveBeenCalled();
    expect(result.progressing).toBe(1);
  });

  it('blacklists, removes with files, and re-searches a download with no progress for 24h', async () => {
    prismaMock.downloadHistory.findMany.mockResolvedValue([
      download({ stallCheckProgress: 0.01, stallCheckedAt: new Date(Date.now() - 25 * HOUR) }),
    ]);
    clientReports(0.01);

    const result = await run();

    expect(prismaMock.blacklistedRelease.create).toHaveBeenCalledWith({
      data: {
        audiobookId: 'ab-1',
        title: 'Wild Side - Elsie Silver [M4B]',
        indexerName: 'AudioBook Bay',
        infoHash: 'abcdef123',
        releaseUrl: 'https://abb/page/1',
        sizeBytes: BigInt(703070208),
        reason: 'stalled',
      },
    });
    expect(prismaMock.downloadHistory.update).toHaveBeenCalledWith({
      where: { id: 'dh-1' },
      data: expect.objectContaining({ downloadStatus: 'blacklisted' }),
    });
    expect(clientMock.deleteDownload).toHaveBeenCalledWith('abcdef123', true);
    expect(prismaMock.request.update).toHaveBeenCalledWith({
      where: { id: 'req-1' },
      data: expect.objectContaining({ status: 'pending', progress: 0 }),
    });
    expect(jobQueueMock.addSearchJob).toHaveBeenCalledWith('req-1', {
      id: 'ab-1',
      title: 'Wild Side',
      author: 'Elsie Silver',
      asin: 'B0TEST0001',
    });
    expect(result.blacklisted).toBe(1);
  });

  it('marks the download blacklisted before removing it from the client', async () => {
    prismaMock.downloadHistory.findMany.mockResolvedValue([
      download({ stallCheckProgress: 0.01, stallCheckedAt: new Date(Date.now() - 25 * HOUR) }),
    ]);
    clientReports(0.01);
    const order: string[] = [];
    prismaMock.downloadHistory.update.mockImplementation(async () => { order.push('mark'); return {}; });
    clientMock.deleteDownload.mockImplementation(async () => { order.push('delete'); });

    await run();

    expect(order).toEqual(['mark', 'delete']);
  });

  it('does not blacklist before a full window has passed', async () => {
    prismaMock.downloadHistory.findMany.mockResolvedValue([
      download({ stallCheckProgress: 0.01, stallCheckedAt: new Date(Date.now() - 10 * HOUR) }),
    ]);
    clientReports(0.01);

    await run();

    expect(prismaMock.blacklistedRelease.create).not.toHaveBeenCalled();
    expect(clientMock.deleteDownload).not.toHaveBeenCalled();
    expect(prismaMock.downloadHistory.update).not.toHaveBeenCalled();
  });

  it('skips paused downloads and resets their baseline', async () => {
    prismaMock.downloadHistory.findMany.mockResolvedValue([
      download({ stallCheckProgress: 0.01, stallCheckedAt: new Date(Date.now() - 25 * HOUR) }),
    ]);
    clientReports(0.01, 'paused');

    const result = await run();

    expect(prismaMock.blacklistedRelease.create).not.toHaveBeenCalled();
    expect(prismaMock.downloadHistory.update).toHaveBeenCalledWith({
      where: { id: 'dh-1' },
      data: { stallCheckProgress: null, stallCheckedAt: null },
    });
    expect(result.exempt).toBe(1);
  });

  it('re-searches ebook requests with the ebook search', async () => {
    const dh = download({ stallCheckProgress: 0.01, stallCheckedAt: new Date(Date.now() - 25 * HOUR) });
    dh.request.type = 'ebook';
    prismaMock.downloadHistory.findMany.mockResolvedValue([dh]);
    clientReports(0.01);

    await run();

    expect(jobQueueMock.addSearchEbookJob).toHaveBeenCalledWith('req-1', expect.objectContaining({ id: 'ab-1' }));
    expect(jobQueueMock.addSearchJob).not.toHaveBeenCalled();
  });

  it('still re-searches if removing the torrent from the client fails', async () => {
    prismaMock.downloadHistory.findMany.mockResolvedValue([
      download({ stallCheckProgress: 0.01, stallCheckedAt: new Date(Date.now() - 25 * HOUR) }),
    ]);
    clientReports(0.01);
    clientMock.deleteDownload.mockRejectedValue(new Error('qbit unreachable'));

    const result = await run();

    expect(jobQueueMock.addSearchJob).toHaveBeenCalled();
    expect(result.blacklisted).toBe(1);
  });

  it('ignores downloads that are complete or missing from the client', async () => {
    prismaMock.downloadHistory.findMany.mockResolvedValue([
      download({ id: 'dh-done', stallCheckProgress: 0.5, stallCheckedAt: new Date(Date.now() - 25 * HOUR) }),
    ]);
    clientMock.getDownload.mockResolvedValueOnce({ id: 'x', progress: 1, status: 'completed' });

    await run();
    prismaMock.downloadHistory.findMany.mockResolvedValue([download({ id: 'dh-gone' })]);
    clientMock.getDownload.mockResolvedValueOnce(null);
    await run();

    expect(prismaMock.downloadHistory.update).not.toHaveBeenCalled();
    expect(prismaMock.blacklistedRelease.create).not.toHaveBeenCalled();
  });
});
