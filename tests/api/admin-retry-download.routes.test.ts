/**
 * Component: Admin Retry Download API Tests
 * Documentation: documentation/phase3/download-clients.md
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaMock } from '../helpers/prisma';
import { createJobQueueMock } from '../helpers/job-queue';

const prismaMock = createPrismaMock();
const jobQueueMock = createJobQueueMock();
const requireAuthMock = vi.hoisted(() => vi.fn());
const requireAdminMock = vi.hoisted(() => vi.fn());
const managerMock = vi.hoisted(() => ({ getClientServiceForProtocol: vi.fn() }));

vi.mock('@/lib/db', () => ({ prisma: prismaMock }));
vi.mock('@/lib/middleware/auth', () => ({ requireAuth: requireAuthMock, requireAdmin: requireAdminMock }));
vi.mock('@/lib/services/job-queue.service', () => ({ getJobQueueService: () => jobQueueMock }));
vi.mock('@/lib/services/config.service', () => ({ getConfigService: () => ({}) }));
vi.mock('@/lib/services/download-client-manager.service', () => ({ getDownloadClientManager: () => managerMock }));

const RELEASE = 'Star Wars - Survivors Quest (NMR) 2004 MP3';
const sab = {
  clientType: 'sabnzbd', protocol: 'usenet',
  getDownload: vi.fn(),
  findDownloadByName: vi.fn(),
};

describe('POST /api/admin/requests/[id]/retry-download', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireAuthMock.mockImplementation((_req: any, handler: any) => handler({ user: { sub: 'admin-1', role: 'admin' } }));
    requireAdminMock.mockImplementation((_req: any, handler: any) => handler());
    managerMock.getClientServiceForProtocol.mockResolvedValue(sab);
    prismaMock.request.findFirst.mockResolvedValue({ id: 'req-sq', status: 'failed', audiobook: { id: 'ab-sq', title: "Survivor's Quest", author: 'Timothy Zahn' } });
    prismaMock.downloadHistory.findFirst.mockResolvedValue({
      id: 'dh-4', downloadClient: 'sabnzbd', downloadClientId: 'e7ce242c', torrentName: RELEASE, magnetLink: 'http://prowlarr/dl', indexerName: 'NZBFinder',
      indexerId: 1, torrentSizeBytes: null, seeders: 0, leechers: 0, torrentHash: null, torrentUrl: null,
    });
    prismaMock.downloadHistory.update.mockResolvedValue({});
    prismaMock.request.update.mockResolvedValue({});
    sab.getDownload.mockResolvedValue(null);
  });

  it('monitors the copy SABnzbd already finished under a new ID instead of adding another', async () => {
    sab.findDownloadByName.mockResolvedValue({ id: 'sab-new', name: RELEASE, status: 'completed', completedAt: new Date() });

    const { POST } = await import('@/app/api/admin/requests/[id]/retry-download/route');
    const payload = await (await POST({} as any, { params: Promise.resolve({ id: 'req-sq' }) })).json();

    expect(payload.path).toBe('resumed_monitoring');
    expect(prismaMock.downloadHistory.update).toHaveBeenCalledWith({
      where: { id: 'dh-4' }, data: { downloadClientId: 'sab-new', nzbId: 'sab-new', downloadStatus: 'completed' },
    });
    expect(jobQueueMock.addMonitorJob).toHaveBeenCalledWith('req-sq', 'dh-4', 'sab-new', 'sabnzbd', 0);
    expect(jobQueueMock.addDownloadJob).not.toHaveBeenCalled();
  });

  it('re-adds the download when no copy of the release is in SABnzbd', async () => {
    sab.findDownloadByName.mockResolvedValue(null);

    const { POST } = await import('@/app/api/admin/requests/[id]/retry-download/route');
    const payload = await (await POST({} as any, { params: Promise.resolve({ id: 'req-sq' }) })).json();

    expect(payload.path).toBe('re_added');
    expect(jobQueueMock.addDownloadJob).toHaveBeenCalled();
  });
});
