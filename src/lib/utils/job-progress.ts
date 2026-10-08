/**
 * Component: Job Progress & Cancellation
 * Documentation: documentation/backend/services/jobs.md
 *
 * Long jobs report live progress to their `jobs` row (shown in the admin header
 * indicator and Jobs page) and poll for a clean-cancel request from the admin UI.
 * Writes are throttled; cancellation is cooperative — a job stops at its next
 * checkpoint (between books, before cleanup steps, or by killing ffmpeg).
 */

import { prisma } from '../db';

export interface JobProgressState {
  current: number;
  /** null = indeterminate (steps, scanning) */
  total: number | null;
  label: string;
  detail?: string;
  cancellable: boolean;
  updatedAt: string;
}

export interface JobProgressReporter {
  update(current: number, options?: { total?: number | null; label?: string; detail?: string; cancellable?: boolean; force?: boolean }): Promise<void>;
  /** Checks the cancel flag (cached for CANCEL_CHECK_MS). */
  isCancelled(): Promise<boolean>;
  /** Last known cancel flag without hitting the database (for sync callbacks such as ffmpeg progress). */
  readonly cancelledSync: boolean;
  /** Final write (always flushed). */
  finish(detail?: string): Promise<void>;
}

const WRITE_INTERVAL_MS = 2000;
const CANCEL_CHECK_MS = 2000;

/** Result fragment processors return when they stopped because of a cancel request. */
export const CANCELLED_RESULT = { cancelled: true } as const;

export function createJobProgress(
  jobId: string | undefined,
  label: string,
  options: { total?: number | null; cancellable?: boolean } = {}
): JobProgressReporter {
  const state: JobProgressState = {
    current: 0,
    total: options.total ?? null,
    label,
    cancellable: options.cancellable ?? false,
    updatedAt: new Date().toISOString(),
  };
  let lastWrite = 0;
  let lastCancelCheck = 0;
  let cancelled = false;

  const write = async () => {
    if (!jobId) return;
    lastWrite = Date.now();
    state.updatedAt = new Date().toISOString();
    try {
      await prisma.job.update({ where: { id: jobId }, data: { progress: { ...state } } });
    } catch {
      // Progress is best-effort; never fail a job over it
    }
  };

  return {
    async update(current, opts = {}) {
      state.current = current;
      if (opts.total !== undefined) state.total = opts.total;
      if (opts.label !== undefined) state.label = opts.label;
      if (opts.detail !== undefined) state.detail = opts.detail;
      if (opts.cancellable !== undefined) state.cancellable = opts.cancellable;
      if (opts.force || Date.now() - lastWrite >= WRITE_INTERVAL_MS) await write();
    },
    async isCancelled() {
      if (!jobId || cancelled) return cancelled;
      if (Date.now() - lastCancelCheck < CANCEL_CHECK_MS) return cancelled;
      lastCancelCheck = Date.now();
      try {
        const row = await prisma.job.findUnique({ where: { id: jobId }, select: { cancelRequested: true } });
        cancelled = row?.cancelRequested === true;
      } catch {
        // Treat lookup failures as "not cancelled"
      }
      return cancelled;
    },
    get cancelledSync() {
      return cancelled;
    },
    async finish(detail) {
      if (detail !== undefined) state.detail = detail;
      state.cancellable = false;
      await write();
    },
  };
}

/** Ask a job to stop. Returns false when the job doesn't exist or already finished. */
export async function requestJobCancel(jobId: string): Promise<boolean> {
  const job = await prisma.job.findUnique({ where: { id: jobId }, select: { status: true } });
  if (!job || !['active', 'pending', 'delayed'].includes(job.status)) return false;
  await prisma.job.update({ where: { id: jobId }, data: { cancelRequested: true } });
  return true;
}
