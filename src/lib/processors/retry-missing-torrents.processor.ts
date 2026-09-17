/**
 * Component: Retry Missing Torrents Processor
 * Documentation: documentation/backend/services/scheduler.md
 *
 * Retries search for requests that are awaiting torrent search
 */

import { prisma } from '../db';
import { RMABLogger } from '../utils/logger';
import { getJobQueueService } from '../services/job-queue.service';

export interface RetryMissingTorrentsPayload {
  jobId?: string;
  scheduledJobId?: string;
}

export async function processRetryMissingTorrents(payload: RetryMissingTorrentsPayload): Promise<any> {
  const { jobId, scheduledJobId } = payload;
  const logger = RMABLogger.forJob(jobId, 'RetryMissingTorrents');

  logger.info('Starting retry job for requests awaiting search...');

  try {
    // Find all active requests (audiobook or ebook) in awaiting_search status
    const requests = await prisma.request.findMany({
      where: {
        status: 'awaiting_search',
        deletedAt: null,
      },
      include: {
        audiobook: true,
      },
      take: 50, // Limit to 50 requests per run
    });

    logger.info(`Found ${requests.length} requests awaiting search`);

    if (requests.length === 0) {
      return {
        success: true,
        message: 'No requests awaiting search',
        triggered: 0,
      };
    }

    // Trigger appropriate search job for each request based on type
    // Throttle: 100ms delay between jobs to avoid connection pool burst
    const jobQueue = getJobQueueService();
    let triggered = 0;

    for (const request of requests) {
      try {
        if (request.type === 'ebook') {
          // Ebook requests use ebook search (Anna's Archive, etc.)
          await jobQueue.addSearchEbookJob(request.id, {
            id: request.audiobook.id,
            title: request.audiobook.title,
            author: request.audiobook.author,
            asin: request.audiobook.audibleAsin || undefined,
          });
          triggered++;
          logger.info(`Triggered ebook search for request ${request.id}: ${request.audiobook.title}`);
        } else {
          // Audiobook requests use indexer search (Prowlarr)
          await jobQueue.addSearchJob(request.id, {
            id: request.audiobook.id,
            title: request.audiobook.title,
            author: request.audiobook.author,
            asin: request.audiobook.audibleAsin || undefined,
          });
          triggered++;
          logger.info(`Triggered audiobook search for request ${request.id}: ${request.audiobook.title}`);
        }
      } catch (error) {
        logger.error(`Failed to trigger search for request ${request.id}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }

      // Spread DB operations over time to avoid connection pool exhaustion
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    logger.info(`Triggered ${triggered}/${requests.length} search jobs`);

    // Recover requests stranded mid-pipeline whose job died (server restart, lost
    // job). Reset to awaiting_search and re-trigger a fresh search so they self-heal.
    // Staleness (updatedAt) is the signal, with a per-status threshold:
    //  - 'downloading': monitor bumps updatedAt at least every 5 min → 2h means dead.
    //  - 'processing': chapter-merging a long audiobook can run for hours without an
    //    updatedAt bump (max merge timeout ~4.2h), so use 8h to never interrupt a
    //    valid in-progress merge.
    const requeueStuck = async (
      status: 'downloading' | 'processing',
      cutoffMs: number
    ): Promise<number> => {
      const cutoff = new Date(Date.now() - cutoffMs);

      const stuck = await prisma.request.findMany({
        where: {
          status,
          deletedAt: null,
          updatedAt: { lt: cutoff },
        },
        include: { audiobook: true },
        take: 50,
      });

      logger.info(`Found ${stuck.length} requests stuck in '${status}'`);

      let requeued = 0;
      for (const request of stuck) {
        try {
          // Reset to awaiting_search so state is consistent before re-triggering
          await prisma.request.update({
            where: { id: request.id },
            data: { status: 'awaiting_search', updatedAt: new Date() },
          });

          if (request.type === 'ebook') {
            await jobQueue.addSearchEbookJob(request.id, {
              id: request.audiobook.id,
              title: request.audiobook.title,
              author: request.audiobook.author,
              asin: request.audiobook.audibleAsin || undefined,
            });
          } else {
            await jobQueue.addSearchJob(request.id, {
              id: request.audiobook.id,
              title: request.audiobook.title,
              author: request.audiobook.author,
              asin: request.audiobook.audibleAsin || undefined,
            });
          }
          requeued++;
          logger.info(`Re-queued stuck '${status}' ${request.type} request ${request.id}: ${request.audiobook.title}`);
        } catch (error) {
          logger.error(`Failed to re-queue stuck '${status}' request ${request.id}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }

        await new Promise(resolve => setTimeout(resolve, 100));
      }

      if (requeued > 0) {
        logger.info(`Re-queued ${requeued} stuck '${status}' request(s)`);
      }
      return requeued;
    };

    const stuckRequeued = await requeueStuck('downloading', 2 * 60 * 60 * 1000); // 2 hours
    const stuckProcessingRequeued = await requeueStuck('processing', 8 * 60 * 60 * 1000); // 8 hours

    return {
      success: true,
      message: 'Retry missing torrents completed',
      totalRequests: requests.length,
      triggered,
      stuckRequeued,
      stuckProcessingRequeued,
    };
  } catch (error) {
    logger.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    throw error;
  }
}
