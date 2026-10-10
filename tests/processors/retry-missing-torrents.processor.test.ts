/**
 * Component: Retry Missing Torrents Processor Tests
 * Documentation: documentation/backend/services/scheduler.md
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaMock } from '../helpers/prisma';
import { createJobQueueMock } from '../helpers/job-queue';

const prismaMock = createPrismaMock();
const jobQueueMock = createJobQueueMock();

vi.mock('@/lib/db', () => ({
  prisma: prismaMock,
}));

vi.mock('@/lib/services/job-queue.service', () => ({
  getJobQueueService: () => jobQueueMock,
}));

describe('processRetryMissingTorrents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('queues search jobs for awaiting_search requests', async () => {
    prismaMock.request.findMany.mockResolvedValue([
      {
        id: 'req-1',
        audiobook: { id: 'a1', title: 'Book', author: 'Author', audibleAsin: 'ASIN1' },
      },
    ]);

    const { processRetryMissingTorrents } = await import('@/lib/processors/retry-missing-torrents.processor');
    const result = await processRetryMissingTorrents({ jobId: 'job-1' });

    expect(result.success).toBe(true);
    expect(jobQueueMock.addSearchJob).toHaveBeenCalledWith(
      'req-1',
      expect.objectContaining({ id: 'a1', title: 'Book', author: 'Author' })
    );
  });

  it('redoes the import of a request stuck in processing with a finished download, searches only the rest', async () => {
    jobQueueMock.hasQueuedJob.mockResolvedValue(false);
    prismaMock.request.update.mockResolvedValue({});
    prismaMock.job.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.request.findMany.mockImplementation(async (args: any) => {
      if (args.where.status !== 'processing') return [];
      if (args.select) {
        return [
          { id: 'req-fol', audiobook: { title: 'Fall of Light' }, downloadHistory: [{ id: 'dh-1' }] },
          { id: 'req-nodl', audiobook: { title: 'No Download' }, downloadHistory: [] },
        ];
      }
      return args.where.id.in.map((id: string) => ({ id, type: 'audiobook', audiobook: { id: 'a-' + id, title: id, author: 'A' } }));
    });

    const { processRetryMissingTorrents } = await import('@/lib/processors/retry-missing-torrents.processor');
    const result = await processRetryMissingTorrents({ jobId: 'job-2' });

    expect(prismaMock.request.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'req-fol' }, data: expect.objectContaining({ status: 'awaiting_import' }),
    }));
    expect(jobQueueMock.addRetryFailedImportsJob).toHaveBeenCalledTimes(1);
    expect(jobQueueMock.addSearchJob).toHaveBeenCalledTimes(1);
    expect(jobQueueMock.addSearchJob).toHaveBeenCalledWith('req-nodl', expect.anything());
    expect(result).toMatchObject({ stuckImportsRequeued: 1, stuckProcessingRequeued: 1 });
  });
});


