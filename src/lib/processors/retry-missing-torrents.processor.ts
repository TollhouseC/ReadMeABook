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

    // Recover requests stranded mid-download. The download monitor bumps updatedAt
    // on every poll (at most every 5 min), so a 'downloading' request untouched for
    // >2h means the monitor job died (server restart, lost job) and it will never
    // complete. Re-queue a fresh search so it self-heals.
    // Note: 'processing' is intentionally excluded — chapter-merging a long audiobook
    // can legitimately run for hours without an updatedAt bump, and re-queuing it
    // would interrupt a valid in-progress merge.
    const STUCK_DOWNLOAD_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours
    const stuckCutoff = new Date(Date.now() - STUCK_DOWNLOAD_THRESHOLD_MS);

    const stuckRequests = await prisma.request.findMany({
      where: {
        status: 'downloading',
        deletedAt: null,
        updatedAt: { lt: stuckCutoff },
      },
      include: { audiobook: true },
      take: 50,
    });

    logger.info(`Found ${stuckRequests.length} requests stuck in 'downloading'`);

    let stuckRequeued = 0;
    for (const request of stuckRequests) {
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
        stuckRequeued++;
        logger.info(`Re-queued stuck 'downloading' ${request.type} request ${request.id}: ${request.audiobook.title}`);
      } catch (error) {
        logger.error(`Failed to re-queue stuck request ${request.id}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }

      await new Promise(resolve => setTimeout(resolve, 100));
    }

    if (stuckRequeued > 0) {
      logger.info(`Re-queued ${stuckRequeued} stuck 'downloading' request(s)`);
    }

    return {
      success: true,
      message: 'Retry missing torrents completed',
      totalRequests: requests.length,
      triggered,
      stuckRequeued,
    };
  } catch (error) {
    logger.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    throw error;
  }
}
