/**
 * Component: Admin Job Runs API (live progress)
 * Documentation: documentation/backend/services/jobs.md
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireAdmin, AuthenticatedRequest } from '@/lib/middleware/auth';
import { prisma } from '@/lib/db';
import { Prisma } from '@/generated/prisma';
import { jobTypeLabel } from '@/lib/constants/job-labels';
import { RMABLogger } from '@/lib/utils/logger';

const logger = RMABLogger.create('API.Admin.JobRuns');

/** Finished jobs that reported progress stay listed briefly so the bar can show "Done". */
const RECENTLY_FINISHED_MS = 60 * 1000;

/**
 * GET /api/admin/job-runs
 * Long jobs (those reporting progress) that are running/queued, or finished in the last minute.
 */
export async function GET(request: NextRequest) {
  return requireAuth(request, async (req: AuthenticatedRequest) => {
    return requireAdmin(req, async () => {
      try {
        const jobs = await prisma.job.findMany({
          // Only long jobs report progress — short ones (monitors, searches) would just flicker
          where: {
            progress: { not: Prisma.DbNull },
            OR: [
              { status: { in: ['active', 'pending', 'delayed', 'stuck'] } },
              {
                status: { in: ['completed', 'failed', 'cancelled'] },
                completedAt: { gte: new Date(Date.now() - RECENTLY_FINISHED_MS) },
              },
            ],
          },
          orderBy: { createdAt: 'desc' },
          take: 25,
          select: {
            id: true, bullJobId: true, type: true, status: true, progress: true, cancelRequested: true,
            startedAt: true, completedAt: true, createdAt: true, errorMessage: true,
            request: { select: { audiobook: { select: { title: true } } } },
          },
        });

        return NextResponse.json({
          jobs: jobs.map(({ request: linked, ...job }: (typeof jobs)[number] & { request?: { audiobook?: { title: string } | null } | null }) => ({
            ...job,
            name: jobTypeLabel(job.type),
            bookTitle: linked?.audiobook?.title ?? null,
          })),
        });
      } catch (error) {
        logger.error('Failed to list job runs', { error: error instanceof Error ? error.message : String(error) });
        return NextResponse.json({ error: 'Failed to list job runs' }, { status: 500 });
      }
    });
  });
}
