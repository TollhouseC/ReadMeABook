/**
 * Component: Job Progress & Cancellation Tests
 * Documentation: documentation/backend/services/jobs.md
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaMock } from '../helpers/prisma';

const prismaMock = createPrismaMock();
vi.mock('@/lib/db', () => ({ prisma: prismaMock }));

async function mod() {
  return import('@/lib/utils/job-progress');
}

describe('createJobProgress', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-09T12:00:00Z'));
    prismaMock.job.update.mockResolvedValue({});
  });
  afterEach(() => vi.useRealTimers());

  it('throttles progress writes to one every 2s, with force and finish always writing', async () => {
    const { createJobProgress } = await mod();
    const progress = createJobProgress('job-1', 'Checking chapters', { total: 10, cancellable: true });

    await progress.update(1);
    await progress.update(2); // within 2s → skipped
    expect(prismaMock.job.update).toHaveBeenCalledTimes(1);
    expect(prismaMock.job.update).toHaveBeenLastCalledWith({
      where: { id: 'job-1' },
      data: { progress: expect.objectContaining({ current: 1, total: 10, label: 'Checking chapters', cancellable: true }) },
    });

    vi.advanceTimersByTime(2100);
    await progress.update(3, { detail: 'Book Three' });
    expect(prismaMock.job.update).toHaveBeenCalledTimes(2);

    await progress.update(4, { force: true });
    await progress.finish('Done');
    expect(prismaMock.job.update).toHaveBeenCalledTimes(4);
    expect(prismaMock.job.update).toHaveBeenLastCalledWith({
      where: { id: 'job-1' },
      data: { progress: expect.objectContaining({ current: 4, detail: 'Done', cancellable: false }) },
    });
  });

  it('checks the cancel flag at most every 2s and remembers it', async () => {
    prismaMock.job.findUnique.mockResolvedValue({ cancelRequested: false });
    const { createJobProgress } = await mod();
    const progress = createJobProgress('job-1', 'x');

    expect(await progress.isCancelled()).toBe(false);
    prismaMock.job.findUnique.mockResolvedValue({ cancelRequested: true });
    expect(await progress.isCancelled()).toBe(false); // cached
    vi.advanceTimersByTime(2100);
    expect(await progress.isCancelled()).toBe(true);
    expect(progress.cancelledSync).toBe(true);
    expect(prismaMock.job.findUnique).toHaveBeenCalledTimes(2);
  });

  it('is a no-op without a job id', async () => {
    const { createJobProgress } = await mod();
    const progress = createJobProgress(undefined, 'x');
    await progress.update(1, { force: true });
    expect(await progress.isCancelled()).toBe(false);
    expect(prismaMock.job.update).not.toHaveBeenCalled();
  });
});

describe('requestJobCancel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('flags running or queued jobs only', async () => {
    const { requestJobCancel } = await mod();
    prismaMock.job.findUnique.mockResolvedValueOnce({ status: 'active' });
    expect(await requestJobCancel('j1')).toBe(true);
    expect(prismaMock.job.update).toHaveBeenCalledWith({ where: { id: 'j1' }, data: { cancelRequested: true } });

    prismaMock.job.findUnique.mockResolvedValueOnce({ status: 'completed' });
    expect(await requestJobCancel('j2')).toBe(false);
    expect(prismaMock.job.update).toHaveBeenCalledTimes(1);
  });
});
