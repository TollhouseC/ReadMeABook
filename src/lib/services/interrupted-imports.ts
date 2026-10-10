/**
 * Component: Interrupted Import Recovery
 * Documentation: documentation/backend/services/jobs.md
 *
 * A container restart during an import (e.g. a long chapter merge) leaves the request in
 * 'processing' with no job left to finish it. The download is already complete, so the
 * request goes back to 'awaiting_import' and Retry Failed Imports redoes the import from
 * the finished download — nothing is searched or downloaded again. Requests Bull still holds
 * an organize job for (it re-runs stalled jobs itself) are left alone. Used at startup
 * (once per process, after Bull's stalled check), when Bull gives up on a stalled organize
 * job, and by the midnight stuck-request check.
 */

import { prisma } from '../db';
import type { RMABLogger } from '../utils/logger';

type Log = Pick<RMABLogger, 'info' | 'warn'>;

/** Give Bull's stalled-job check (every 30s) time to re-queue jobs it will re-run itself */
export const STARTUP_RECOVERY_DELAY_MS = 90_000;

export interface RecoveryResult {
  /** Requests sent back to awaiting_import */
  requeued: number;
  /** Stuck requests with no download to import from (caller may search again) */
  needsSearch: string[];
}

/** Request → awaiting_import; its organize job records closed as interrupted. */
export async function requeueImport(requestId: string, reason: string): Promise<void> {
  await prisma.request.update({
    where: { id: requestId },
    data: { status: 'awaiting_import', errorMessage: reason, updatedAt: new Date() },
  });
  await prisma.job.updateMany({
    where: { requestId, type: 'organize_files', status: { in: ['pending', 'active', 'stuck', 'delayed'] } },
    data: { status: 'failed', errorMessage: reason, completedAt: new Date() },
  });
}

export async function recoverInterruptedImports(
  logger: Log,
  options: { olderThanMs?: number; reason?: string } = {}
): Promise<RecoveryResult> {
  const reason = options.reason ?? 'Import interrupted by a restart — retrying from the finished download';
  const stuck = await prisma.request.findMany({
    where: {
      status: 'processing',
      deletedAt: null,
      ...(options.olderThanMs !== undefined && { updatedAt: { lt: new Date(Date.now() - options.olderThanMs) } }),
    },
    select: {
      id: true,
      audiobook: { select: { title: true } },
      downloadHistory: { where: { selected: true }, select: { id: true }, take: 1 },
    },
    take: 50,
  });
  const result: RecoveryResult = { requeued: 0, needsSearch: [] };
  if (!stuck?.length) return result;

  const { getJobQueueService } = await import('./job-queue.service');
  const jobQueue = getJobQueueService();

  for (const request of stuck) {
    const title = request.audiobook?.title ?? request.id;
    try {
      if (await jobQueue.hasQueuedJob('organize_files', request.id)) {
        await logger.info(`"${title}" is still processing — its import job is queued/running, left alone`);
        continue;
      }
      if (!request.downloadHistory?.length) {
        result.needsSearch.push(request.id);
        continue;
      }
      await requeueImport(request.id, reason);
      result.requeued++;
      await logger.warn(`"${title}" was stuck in processing (import interrupted) — import queued again from the finished download`);
    } catch (error) {
      await logger.warn(`Could not recover "${title}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (result.requeued > 0) await jobQueue.addRetryFailedImportsJob();
  return result;
}

const STARTED_FLAG = '__rmabInterruptedImportRecovery';

/** Startup: once per process, after Bull has re-queued what it will re-run itself. */
export function scheduleStartupRecovery(logger: Log & Pick<RMABLogger, 'error'>): boolean {
  const g = globalThis as Record<string, unknown>;
  if (g[STARTED_FLAG]) return false;
  g[STARTED_FLAG] = true;
  const timer = setTimeout(() => {
    // Skip anything touched since the restart (an import Bull re-ran, a direct download finishing)
    recoverInterruptedImports(logger, { olderThanMs: 60_000 }).catch(error => {
      logger.error(`Interrupted import recovery failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, STARTUP_RECOVERY_DELAY_MS);
  (timer as { unref?: () => void }).unref?.();
  return true;
}
