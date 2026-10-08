/**
 * Component: Request Reset Service Tests
 * Documentation: documentation/admin-features/request-deletion.md
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaMock } from '../helpers/prisma';

const prismaMock = createPrismaMock();
const blacklistMock = vi.hoisted(() => vi.fn());
const clientMock = vi.hoisted(() => ({ protocol: 'torrent', clientType: 'qbittorrent', getDownload: vi.fn(), deleteDownload: vi.fn() }));
const managerMock = vi.hoisted(() => ({ getClientServiceForProtocol: vi.fn() }));

vi.mock('@/lib/db', () => ({ prisma: prismaMock }));
vi.mock('@/lib/utils/release-blacklist', () => ({ blacklistRelease: blacklistMock }));
vi.mock('@/lib/services/config.service', () => ({ getConfigService: () => ({}) }));
vi.mock('@/lib/services/download-client-manager.service', () => ({ getDownloadClientManager: () => managerMock }));

const download = (overrides: Record<string, unknown> = {}) => ({
  id: 'dh-1', requestId: 'req-1', indexerName: 'MAM', torrentName: 'Wrong Book [M4B]', torrentHash: 'abc123',
  torrentUrl: 'http://x', torrentSizeBytes: BigInt(500), downloadClient: 'qbittorrent', downloadClientId: 'abc123',
  nzbId: null, downloadStatus: 'downloading', packFiles: null, ...overrides,
});

async function retire() {
  const { retireCurrentDownload } = await import('@/lib/services/request-reset.service');
  return retireCurrentDownload('req-1', 'ab-1');
}

describe('retireCurrentDownload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    managerMock.getClientServiceForProtocol.mockResolvedValue(clientMock);
    prismaMock.downloadHistory.update.mockResolvedValue({});
    prismaMock.downloadHistory.count.mockResolvedValue(0);
  });

  it('blacklists the release and removes an unfinished download with its files', async () => {
    prismaMock.downloadHistory.findFirst.mockResolvedValue(download());
    clientMock.getDownload.mockResolvedValue({ progress: 0.4, status: 'downloading' });

    const result = await retire();

    expect(blacklistMock).toHaveBeenCalledWith(expect.objectContaining({
      audiobookId: 'ab-1', title: 'Wrong Book [M4B]', infoHash: 'abc123', reason: 'reset',
    }));
    expect(prismaMock.downloadHistory.update).toHaveBeenCalledWith({
      where: { id: 'dh-1' }, data: { downloadStatus: 'blacklisted', downloadError: 'Reset by admin' },
    });
    expect(clientMock.deleteDownload).toHaveBeenCalledWith('abc123', true);
    expect(result).toMatchObject({ blacklisted: true, removedFromClient: true, keptSeeding: false });
  });

  it('keeps a finished torrent seeding', async () => {
    prismaMock.downloadHistory.findFirst.mockResolvedValue(download({ downloadStatus: 'completed' }));
    clientMock.getDownload.mockResolvedValue({ progress: 1, status: 'seeding' });

    const result = await retire();

    expect(clientMock.deleteDownload).not.toHaveBeenCalled();
    expect(result).toMatchObject({ blacklisted: true, removedFromClient: false, keptSeeding: true });
  });

  it('leaves a pack shared with other requests running', async () => {
    prismaMock.downloadHistory.findFirst.mockResolvedValue(download({ packFiles: ['Book 2/b2.m4b'] }));
    prismaMock.downloadHistory.count.mockResolvedValue(2);

    const result = await retire();

    expect(blacklistMock).toHaveBeenCalled();
    expect(prismaMock.downloadHistory.update).not.toHaveBeenCalled();
    expect(clientMock.deleteDownload).not.toHaveBeenCalled();
    expect(result.sharedPack).toBe(true);
  });

  it('does nothing when there is no current download', async () => {
    prismaMock.downloadHistory.findFirst.mockResolvedValue(null);
    expect(await retire()).toEqual({ blacklisted: false, removedFromClient: false, keptSeeding: false, sharedPack: false });
    expect(blacklistMock).not.toHaveBeenCalled();
  });
});
