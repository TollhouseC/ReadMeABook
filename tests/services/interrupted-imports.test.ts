/**
 * Component: Interrupted Import Recovery Tests
 * Documentation: documentation/backend/services/jobs.md
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaMock } from '../helpers/prisma';
import { createJobQueueMock } from '../helpers/job-queue';

const prismaMock = createPrismaMock();
const jobQueueMock = createJobQueueMock();

vi.mock('@/lib/db', () => ({ prisma: prismaMock }));
vi.mock('@/lib/services/job-queue.service', () => ({ getJobQueueService: () => jobQueueMock }));

const load = () => import('@/lib/services/interrupted-imports');
const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const FALL_OF_LIGHT = { id: 'req-fol', audiobook: { title: 'Fall of Light' }, downloadHistory: [{ id: 'dh-1' }] };

beforeEach(() => {
  vi.clearAllMocks();
  jobQueueMock.hasQueuedJob.mockResolvedValue(false);
  prismaMock.request.findMany.mockResolvedValue([FALL_OF_LIGHT]);
  prismaMock.request.update.mockResolvedValue({});
  prismaMock.job.updateMany.mockResolvedValue({ count: 1 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('recoverInterruptedImports', () => {
  it('sends a request stuck in processing back to awaiting_import and closes its dead job', async () => {
    const { recoverInterruptedImports } = await load();
    expect(await recoverInterruptedImports(logger())).toEqual({ requeued: 1, needsSearch: [] });

    expect(prismaMock.request.update).toHaveBeenCalledWith({
      where: { id: 'req-fol' },
      data: expect.objectContaining({ status: 'awaiting_import' }),
    });
    expect(prismaMock.job.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ requestId: 'req-fol', type: 'organize_files' }),
      data: expect.objectContaining({ status: 'failed' }),
    }));
    expect(jobQueueMock.addRetryFailedImportsJob).toHaveBeenCalledTimes(1);
  });

  it('leaves requests whose import job Bull still holds, and reports those without a download', async () => {
    prismaMock.request.findMany.mockResolvedValue([
      FALL_OF_LIGHT,
      { id: 'req-nodl', audiobook: { title: 'X' }, downloadHistory: [] },
    ]);
    jobQueueMock.hasQueuedJob.mockImplementation(async (_type: string, id: string) => id === 'req-fol');

    const { recoverInterruptedImports } = await load();
    expect(await recoverInterruptedImports(logger())).toEqual({ requeued: 0, needsSearch: ['req-nodl'] });
    expect(prismaMock.request.update).not.toHaveBeenCalled();
    expect(jobQueueMock.addRetryFailedImportsJob).not.toHaveBeenCalled();
  });

  it('only looks at requests untouched for the given time', async () => {
    const { recoverInterruptedImports } = await load();
    await recoverInterruptedImports(logger(), { olderThanMs: 60_000 });
    const where = prismaMock.request.findMany.mock.calls[0][0].where;
    expect(where.status).toBe('processing');
    expect(Date.now() - where.updatedAt.lt.getTime()).toBeGreaterThanOrEqual(60_000);
  });
});

describe('scheduleStartupRecovery', () => {
  it('runs once per process, after Bull has had time to re-queue stalled jobs', async () => {
    vi.useFakeTimers();
    const { scheduleStartupRecovery, STARTUP_RECOVERY_DELAY_MS } = await load();
    expect(scheduleStartupRecovery(logger())).toBe(true);
    expect(scheduleStartupRecovery(logger())).toBe(false);
    expect(prismaMock.request.findMany).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(STARTUP_RECOVERY_DELAY_MS);
    expect(prismaMock.request.findMany).toHaveBeenCalledTimes(1);
    delete (globalThis as Record<string, unknown>).__rmabInterruptedImportRecovery;
  });
});
