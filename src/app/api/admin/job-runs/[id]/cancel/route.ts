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
 * Queued job → removed from the queue. Running long job → asked to stop at its next safe point.
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

        const cancellable = (job.progress as { cancellable?: boolean } | null)?.cancellable === true;
        if (job.status !== 'active' || !cancellable) {
          return NextResponse.json({ error: 'NotCancellable', message: 'This job can no longer be cancelled' }, { status: 400 });
        }

        await requestJobCancel(id);
        logger.info(`Admin ${req.user?.id} requested cancel of job ${id} (${job.type})`);
        return NextResponse.json({ success: true, message: 'Stopping at the next safe point' });
      } catch (error) {
        logger.error('Failed to cancel job', { error: error instanceof Error ? error.message : String(error) });
        return NextResponse.json({ error: 'CancelError', message: 'Failed to cancel job' }, { status: 500 });
      }
    });
  });
}
