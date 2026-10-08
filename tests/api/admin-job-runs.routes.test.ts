/**
 * Component: Admin Job Runs API Tests
 * Documentation: documentation/backend/services/jobs.md
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaMock } from '../helpers/prisma';

const prismaMock = createPrismaMock();
const requireAuthMock = vi.hoisted(() => vi.fn());
const requireAdminMock = vi.hoisted(() => vi.fn());
const jobQueueMock = vi.hoisted(() => ({ cancelJob: vi.fn() }));

vi.mock('@/lib/db', () => ({ prisma: prismaMock }));
vi.mock('@/lib/middleware/auth', () => ({ requireAuth: requireAuthMock, requireAdmin: requireAdminMock }));
vi.mock('@/lib/services/job-queue.service', () => ({ getJobQueueService: () => jobQueueMock }));

const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  requireAuthMock.mockImplementation((_req: any, handler: any) => handler({ user: { id: 'admin-1', role: 'admin' } }));
  requireAdminMock.mockImplementation((_req: any, handler: any) => handler());
  prismaMock.job.update.mockResolvedValue({});
});

describe('GET /api/admin/job-runs', () => {
  it('lists long jobs with a readable name and book title', async () => {
    prismaMock.job.findMany.mockResolvedValue([
      { id: 'j1', type: 'fix_chapters', status: 'active', progress: { current: 5, total: 10, label: 'Checking chapters', cancellable: true }, request: null },
      { id: 'j2', type: 'merge_library_book', status: 'active', progress: { current: 40, total: 100, label: 'Merging' }, request: { audiobook: { title: 'HWFwM 10' } } },
    ]);
    const { GET } = await import('@/app/api/admin/job-runs/route');
    const { jobs } = await (await GET({} as any)).json();

    expect(jobs.map((j: any) => [j.name, j.bookTitle])).toEqual([['Chapter Check / Fix', null], ['Merge into Single M4B', 'HWFwM 10']]);
    expect(prismaMock.job.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ OR: expect.any(Array) }),
    }));
  });
});

describe('POST /api/admin/job-runs/[id]/cancel', () => {
  it('removes a queued job from the queue', async () => {
    prismaMock.job.findUnique.mockResolvedValue({ id: 'j1', type: 'fix_chapters', status: 'pending', progress: null });
    const { POST } = await import('@/app/api/admin/job-runs/[id]/cancel/route');
    const res = await POST({} as any, params('j1'));
    expect(res.status).toBe(200);
    expect(jobQueueMock.cancelJob).toHaveBeenCalledWith('j1');
  });

  it('asks a running cancellable job to stop', async () => {
    prismaMock.job.findUnique
      .mockResolvedValueOnce({ id: 'j2', type: 'fix_chapters', status: 'active', progress: { cancellable: true } })
      .mockResolvedValueOnce({ status: 'active' }); // requestJobCancel lookup
    const { POST } = await import('@/app/api/admin/job-runs/[id]/cancel/route');
    const payload = await (await POST({} as any, params('j2'))).json();
    expect(payload.message).toMatch(/next safe point/);
    expect(prismaMock.job.update).toHaveBeenCalledWith({ where: { id: 'j2' }, data: { cancelRequested: true } });
  });

  it('accepts a cancel during an uninterruptible step and says it will stop after it', async () => {
    prismaMock.job.findUnique
      .mockResolvedValueOnce({ id: 'j3', type: 'plex_library_scan', status: 'active', progress: { cancellable: false } })
      .mockResolvedValueOnce({ status: 'active' });
    const { POST } = await import('@/app/api/admin/job-runs/[id]/cancel/route');
    const res = await POST({} as any, params('j3'));
    expect(res.status).toBe(200);
    expect((await res.json()).message).toMatch(/current step finishes/);
    expect(prismaMock.job.update).toHaveBeenCalledWith({ where: { id: 'j3' }, data: { cancelRequested: true } });
  });

  it('rejects a cancel for a job that already finished', async () => {
    prismaMock.job.findUnique
      .mockResolvedValueOnce({ id: 'j4', type: 'fix_chapters', status: 'completed', progress: { cancellable: true } })
      .mockResolvedValueOnce({ status: 'completed' });
    const { POST } = await import('@/app/api/admin/job-runs/[id]/cancel/route');
    expect((await POST({} as any, params('j4'))).status).toBe(400);
  });
});

describe('GET /api/admin/job-runs/[id]/events', () => {
  it('finds the job by job ID or Bull ID and returns lines after a time (inclusive)', async () => {
    prismaMock.job.findFirst.mockResolvedValue({ id: 'j1', type: 'fix_chapters', status: 'completed', progress: null });
    prismaMock.jobEvent.findMany.mockResolvedValue([{ id: 'e1', level: 'info', message: 'Would fix "A"', createdAt: '2026-10-09T12:00:01.000Z' }]);
    const { GET } = await import('@/app/api/admin/job-runs/[id]/events/route');

    const req = { nextUrl: new URL('http://x/api/admin/job-runs/bull-7/events?after=2026-10-09T12:00:00.000Z') };
    const payload = await (await GET(req as any, params('bull-7'))).json();

    expect(prismaMock.job.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { OR: [{ id: 'bull-7' }, { bullJobId: 'bull-7' }] } }));
    expect(prismaMock.jobEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { jobId: 'j1', createdAt: { gte: new Date('2026-10-09T12:00:00.000Z') } },
    }));
    expect(payload.job.name).toBe('Chapter Check / Fix');
    expect(payload.events).toHaveLength(1);
  });
});
