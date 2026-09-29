/**
 * Component: Check Stalled Downloads Processor
 * Documentation: documentation/backend/services/scheduler.md
 *
 * Runs every 24h. For each active download it records a progress baseline; if the
 * next run finds no progress since that baseline, the release is blacklisted for the
 * book, removed from the download client (with its partial files), and the request
 * is re-searched — automatic search skips blacklisted releases.
 *
 * The download monitor never fails a stalled download (it only backs off polling),
 * so without this job a dead torrent stays 'downloading' indefinitely.
 */

import { prisma } from '../db';
import { RMABLogger } from '../utils/logger';
import { getJobQueueService } from '../services/job-queue.service';
import { getConfigService } from '../services/config.service';
import { getDownloadClientManager } from '../services/download-client-manager.service';
import { CLIENT_PROTOCOL_MAP, DownloadClientType, DownloadStatus } from '../interfaces/download-client.interface';
import { blacklistRelease } from '../utils/release-blacklist';

export interface CheckStalledDownloadsPayload {
  jobId?: string;
  scheduledJobId?: string;
}

/**
 * Minimum time between baseline and a stall verdict. Slightly under 24h so a daily
 * schedule with minor drift still triggers, but a manual re-run minutes after the
 * scheduled one can't blacklist a download on no evidence.
 */
export const MIN_STALL_WINDOW_MS = 20 * 60 * 60 * 1000;

/** Progress must grow by more than this fraction to count as "progressing". */
const PROGRESS_EPSILON = 0.0001;

/**
 * States where lack of progress isn't the release's fault (user-paused, waiting in
 * the client's queue, verifying files). Tracking restarts once they're active again.
 */
const EXEMPT_STATES: DownloadStatus[] = ['paused', 'queued', 'checking'];

export async function processCheckStalledDownloads(payload: CheckStalledDownloadsPayload): Promise<any> {
  const logger = RMABLogger.forJob(payload.jobId, 'CheckStalledDownloads');
  logger.info('Checking active downloads for stalls...');

  const stats = { checked: 0, baselined: 0, progressing: 0, exempt: 0, blacklisted: 0, errors: 0 };

  const downloads = await prisma.downloadHistory.findMany({
    where: {
      selected: true,
      downloadStatus: 'downloading',
      downloadClientId: { not: null },
      downloadClient: { not: 'direct' }, // direct HTTP ebook downloads have their own monitor
      request: { status: 'downloading', deletedAt: null },
    },
    include: { request: { include: { audiobook: true } } },
  });

  logger.info(`Found ${downloads.length} active download(s)`);

  const manager = getDownloadClientManager(getConfigService());
  const jobQueue = getJobQueueService();

  for (const dh of downloads) {
    stats.checked++;
    try {
      const protocol = CLIENT_PROTOCOL_MAP[dh.downloadClient as DownloadClientType];
      const client = protocol ? await manager.getClientServiceForProtocol(protocol) : null;
      if (!client) {
        logger.warn(`No client available for ${dh.downloadClient}, skipping download ${dh.id}`);
        continue;
      }

      const info = await client.getDownload(dh.downloadClientId!);
      if (!info || info.progress >= 1) {
        // Missing (monitor handles "not found") or already complete — nothing to judge
        continue;
      }

      const now = new Date();

      if (EXEMPT_STATES.includes(info.status)) {
        // Restart tracking once it's active again
        if (dh.stallCheckProgress !== null || dh.stallCheckedAt !== null) {
          await prisma.downloadHistory.update({
            where: { id: dh.id },
            data: { stallCheckProgress: null, stallCheckedAt: null },
          });
        }
        stats.exempt++;
        continue;
      }

      // First check: record the baseline
      if (dh.stallCheckProgress === null || dh.stallCheckedAt === null) {
        await prisma.downloadHistory.update({
          where: { id: dh.id },
          data: { stallCheckProgress: info.progress, stallCheckedAt: now },
        });
        stats.baselined++;
        continue;
      }

      // Progress since the baseline: move the baseline forward
      if (info.progress > dh.stallCheckProgress + PROGRESS_EPSILON) {
        await prisma.downloadHistory.update({
          where: { id: dh.id },
          data: { stallCheckProgress: info.progress, stallCheckedAt: now },
        });
        stats.progressing++;
        continue;
      }

      // No progress — but only give a verdict once a full window has elapsed
      if (now.getTime() - dh.stallCheckedAt.getTime() < MIN_STALL_WINDOW_MS) {
        continue;
      }

      const request = dh.request;
      const title = request.audiobook.title;
      const pct = (info.progress * 100).toFixed(1);
      logger.warn(`Stalled: "${dh.torrentName}" for "${title}" at ${pct}% since ${dh.stallCheckedAt.toISOString()} — blacklisting`);

      await blacklistRelease({
        audiobookId: request.audiobookId,
        title: dh.torrentName || title,
        indexerName: dh.indexerName,
        infoHash: dh.torrentHash,
        releaseUrl: dh.torrentUrl,
        sizeBytes: dh.torrentSizeBytes,
        reason: 'stalled',
      });

      // Mark first so the monitor stops quietly before the torrent disappears
      await prisma.downloadHistory.update({
        where: { id: dh.id },
        data: {
          downloadStatus: 'blacklisted',
          downloadError: `Stalled: no progress in 24h (stuck at ${pct}%)`,
        },
      });

      try {
        await client.deleteDownload(dh.downloadClientId!, true);
      } catch (error) {
        logger.warn(`Failed to remove stalled download from ${dh.downloadClient}: ${error instanceof Error ? error.message : String(error)}`);
      }

      // Re-search; automatic search skips blacklisted releases
      await prisma.request.update({
        where: { id: request.id },
        data: {
          status: 'pending',
          progress: 0,
          errorMessage: 'Previous download stalled for 24h; searching for another release',
          updatedAt: now,
        },
      });

      const audiobookData = {
        id: request.audiobook.id,
        title: request.audiobook.title,
        author: request.audiobook.author,
        asin: request.audiobook.audibleAsin || undefined,
      };
      if (request.type === 'ebook') {
        await jobQueue.addSearchEbookJob(request.id, audiobookData);
      } else {
        await jobQueue.addSearchJob(request.id, audiobookData);
      }

      stats.blacklisted++;
    } catch (error) {
      stats.errors++;
      logger.error(`Failed to check download ${dh.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  logger.info('Stalled download check complete', { stats });

  return {
    success: true,
    message: 'Stalled download check completed',
    ...stats,
  };
}
