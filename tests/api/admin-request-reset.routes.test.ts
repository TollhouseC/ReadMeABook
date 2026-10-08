/**
 * Component: Admin Reset & Re-request API Tests
 * Documentation: documentation/admin-features/request-deletion.md
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaMock } from '../helpers/prisma';

const prismaMock = createPrismaMock();
const requireAuthMock = vi.hoisted(() => vi.fn());
const requireAdminMock = vi.hoisted(() => vi.fn());
const retireMock = vi.hoisted(() => vi.fn());
const jobQueueMock = vi.hoisted(() => ({ addSearchJob: vi.fn(), addSearchEbookJob: vi.fn() }));

vi.mock('@/lib/db', () => ({ prisma: prismaMock }));
vi.mock('@/lib/middleware/auth', () => ({ requireAuth: requireAuthMock, requireAdmin: requireAdminMock }));
vi.mock('@/lib/services/request-reset.service', () => ({ retireCurrentDownload: retireMock }));
vi.mock('@/lib/services/job-queue.service', () => ({ getJobQueueService: () => jobQueueMock }));

describe('POST /api/admin/requests/[id]/reset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireAuthMock.mockImplementation((_req: any, handler: any) => handler({ user: { sub: 'admin-1', role: 'admin' } }));
    requireAdminMock.mockImplementation((_req: any, handler: any) => handler());
    prismaMock.audiobook.update.mockResolvedValue({});
    prismaMock.request.update.mockResolvedValue({});
  });

  it('resets to pending, retires the current release, and does NOT search automatically', async () => {
    prismaMock.request.findUnique.mockResolvedValue({
      id: 'req-1', type: 'audiobook', status: 'downloading', audiobook: { id: 'ab-1', title: 'Book', author: 'A', audibleAsin: 'B0X' },
    });
    retireMock.mockResolvedValue({ blacklisted: true, removedFromClient: true, keptSeeding: false, sharedPack: false, releaseTitle: 'Wrong [M4B]' });

    const { POST } = await import('@/app/api/admin/requests/[id]/reset/route');
    const response = await POST({} as any, { params: Promise.resolve({ id: 'req-1' }) });
    const payload = await response.json();

    expect(retireMock).toHaveBeenCalledWith('req-1', 'ab-1', expect.anything());
    expect(prismaMock.request.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'req-1' }, data: expect.objectContaining({ status: 'pending' }),
    }));
    expect(jobQueueMock.addSearchJob).not.toHaveBeenCalled();
    expect(jobQueueMock.addSearchEbookJob).not.toHaveBeenCalled();
    expect(payload).toMatchObject({ success: true, type: 'audiobook', blacklisted: true, removedFromClient: true });
    expect(payload.message).toMatch(/blacklisted "Wrong \[M4B\]".*choose a release/);
  });

  it('returns 404 for an unknown request', async () => {
    prismaMock.request.findUnique.mockResolvedValue(null);
    const { POST } = await import('@/app/api/admin/requests/[id]/reset/route');
    expect((await POST({} as any, { params: Promise.resolve({ id: 'nope' }) })).status).toBe(404);
    expect(retireMock).not.toHaveBeenCalled();
  });
});
