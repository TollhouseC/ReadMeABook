/**
 * Component: Admin Merge Library Book API
 * Documentation: documentation/features/chapter-merging.md
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireAdmin, AuthenticatedRequest } from '@/lib/middleware/auth';
import { prisma } from '@/lib/db';
import { getJobQueueService } from '@/lib/services/job-queue.service';
import { RMABLogger } from '@/lib/utils/logger';

const logger = RMABLogger.create('API.Admin.Requests.Merge');

const MERGEABLE_STATUSES = ['available', 'downloaded'];

/**
 * POST /api/admin/requests/[id]/merge
 * Admin-only: queue a merge of an imported multi-file book into one M4B in its library folder.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return requireAuth(request, async (req: AuthenticatedRequest) => {
    return requireAdmin(req, async () => {
      try {
        const { id } = await params;

        const requestRecord = await prisma.request.findFirst({
          where: { id, deletedAt: null },
          select: { id: true, type: true, status: true, audiobook: { select: { title: true } } },
        });

        if (!requestRecord) {
          return NextResponse.json({ error: 'NotFound', message: 'Request not found' }, { status: 404 });
        }
        if (requestRecord.type === 'ebook' || !MERGEABLE_STATUSES.includes(requestRecord.status)) {
          return NextResponse.json(
            { error: 'InvalidState', message: 'Only imported audiobook requests (available/downloaded) can be merged' },
            { status: 400 }
          );
        }

        const jobId = await getJobQueueService().addMergeLibraryBookJob(id);
        logger.info(`Admin ${req.user?.id} queued merge for "${requestRecord.audiobook.title}" (request ${id})`);

        return NextResponse.json({ success: true, jobId, message: 'Merge queued' }, { status: 202 });
      } catch (error) {
        logger.error('Failed to queue merge', { error: error instanceof Error ? error.message : String(error) });
        return NextResponse.json({ error: 'MergeError', message: 'Failed to queue merge' }, { status: 500 });
      }
    });
  });
}
