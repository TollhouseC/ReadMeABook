/**
 * Component: Admin Job Run Log API
 * Documentation: documentation/backend/services/jobs.md
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireAdmin, AuthenticatedRequest } from '@/lib/middleware/auth';
import { prisma } from '@/lib/db';
import { jobTypeLabel } from '@/lib/constants/job-labels';
import { RMABLogger } from '@/lib/utils/logger';

const logger = RMABLogger.create('API.Admin.JobRuns.Events');

const PAGE_SIZE = 500;

/**
 * GET /api/admin/job-runs/[id]/events?after=<ISO time>
 * Job summary + its log lines (oldest first). `id` may be the job ID or the Bull job ID
 * (scheduled jobs store the latter as lastRunJobId). `after` returns lines at/after that time
 * (inclusive — lines can share a millisecond; the client de-duplicates by id).
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return requireAuth(request, async (req: AuthenticatedRequest) => {
    return requireAdmin(req, async () => {
      try {
        const { id } = await params;
        const job = await prisma.job.findFirst({
          where: { OR: [{ id }, { bullJobId: id }] },
          orderBy: { createdAt: 'desc' },
          select: { id: true, type: true, status: true, progress: true, cancelRequested: true, startedAt: true, completedAt: true, errorMessage: true },
        });
        if (!job) return NextResponse.json({ error: 'NotFound', message: 'Job not found' }, { status: 404 });

        const afterParam = request.nextUrl?.searchParams.get('after');
        const after = afterParam ? new Date(afterParam) : null;
        const events = await prisma.jobEvent.findMany({
          where: { jobId: job.id, ...(after && !isNaN(after.getTime()) && { createdAt: { gte: after } }) },
          orderBy: { createdAt: 'asc' },
          take: PAGE_SIZE,
          select: { id: true, level: true, message: true, createdAt: true },
        });

        return NextResponse.json({ job: { ...job, name: jobTypeLabel(job.type) }, events });
      } catch (error) {
        logger.error('Failed to load job log', { error: error instanceof Error ? error.message : String(error) });
        return NextResponse.json({ error: 'Failed to load job log' }, { status: 500 });
      }
    });
  });
}
