/**
 * Component: Admin Fix Chapters API
 * Documentation: documentation/features/chapter-merging.md
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireAdmin, AuthenticatedRequest } from '@/lib/middleware/auth';
import { prisma } from '@/lib/db';
import { getJobQueueService } from '@/lib/services/job-queue.service';
import { RMABLogger } from '@/lib/utils/logger';

const logger = RMABLogger.create('API.Admin.Requests.FixChapters');

const FIXABLE_STATUSES = ['available', 'downloaded'];

/**
 * POST /api/admin/requests/[id]/fix-chapters
 * Admin-only: queue replacing a single-file book's chapters with Audnexus's (if better).
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
          select: { id: true, type: true, status: true, audiobook: { select: { title: true, audibleAsin: true } } },
        });

        if (!requestRecord) {
          return NextResponse.json({ error: 'NotFound', message: 'Request not found' }, { status: 404 });
        }
        if (requestRecord.type === 'ebook' || !FIXABLE_STATUSES.includes(requestRecord.status)) {
          return NextResponse.json(
            { error: 'InvalidState', message: 'Only imported audiobook requests (available/downloaded) can be fixed' },
            { status: 400 }
          );
        }
        if (!requestRecord.audiobook.audibleAsin) {
          return NextResponse.json({ error: 'NoAsin', message: 'This book has no Audible ASIN' }, { status: 400 });
        }

        const jobId = await getJobQueueService().addFixChaptersJob({ requestId: id, mode: 'apply' });
        logger.info(`Admin ${req.user?.id} queued chapter fix for "${requestRecord.audiobook.title}" (request ${id})`);

        return NextResponse.json({ success: true, jobId, message: 'Chapter fix queued' }, { status: 202 });
      } catch (error) {
        logger.error('Failed to queue chapter fix', { error: error instanceof Error ? error.message : String(error) });
        return NextResponse.json({ error: 'FixChaptersError', message: 'Failed to queue chapter fix' }, { status: 500 });
      }
    });
  });
}
