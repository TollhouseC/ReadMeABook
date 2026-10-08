/**
 * Component: Admin Job Run Cancel API
 * Documentation: documentation/backend/services/jobs.md
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireAdmin, AuthenticatedRequest } from '@/lib/middleware/auth';
import { prisma } from '@/lib/db';
import { getJobQueueService } from '@/lib/services/job-queue.service';
import { requestJobCancel } from '@/lib/utils/job-progress';
import { RMABLogger } from '@/lib/utils/logger';

const logger = RMABLogger.create('API.Admin.JobRuns.Cancel');

/**
 * POST /api/admin/job-runs/[id]/cancel
 * Queued job → removed from the queue. Running job → always accepted: it stops at its next
 * safe point (during an uninterruptible step, e.g. a scan's cleanup or a merge's file swap,
 * it finishes that step first).
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return requireAuth(request, async (req: AuthenticatedRequest) => {
    return requireAdmin(req, async () => {
      try {
        const { id } = await params;
        const job = await prisma.job.findUnique({ where: { id }, select: { id: true, type: true, status: true, progress: true } });
        if (!job) return NextResponse.json({ error: 'NotFound', message: 'Job not found' }, { status: 404 });

        if (job.status === 'pending' || job.status === 'delayed') {
          await getJobQueueService().cancelJob(id);
          logger.info(`Admin ${req.user?.id} removed queued job ${id} (${job.type})`);
          return NextResponse.json({ success: true, message: 'Removed from the queue' });
        }

        if (!(await requestJobCancel(id))) {
          return NextResponse.json({ error: 'NotRunning', message: 'This job has already finished' }, { status: 400 });
        }

        // cancellable=false: inside a step that must finish (cleanup, file swap) — it stops right after
        const stopsNow = (job.progress as { cancellable?: boolean } | null)?.cancellable !== false;
        logger.info(`Admin ${req.user?.id} requested cancel of job ${id} (${job.type})`);
        return NextResponse.json({
          success: true,
          message: stopsNow ? 'Stopping at the next safe point' : 'Will stop as soon as the current step finishes safely',
        });
      } catch (error) {
        logger.error('Failed to cancel job', { error: error instanceof Error ? error.message : String(error) });
        return NextResponse.json({ error: 'CancelError', message: 'Failed to cancel job' }, { status: 500 });
      }
    });
  });
}
