/**
 * Component: Admin Reset & Re-request API
 * Documentation: documentation/admin-features/request-deletion.md
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireAdmin, AuthenticatedRequest } from '@/lib/middleware/auth';
import { prisma } from '@/lib/db';
import { getJobQueueService } from '@/lib/services/job-queue.service';
import { RMABLogger } from '@/lib/utils/logger';

const logger = RMABLogger.create('API.Admin.Requests.Reset');

/**
 * POST /api/admin/requests/[id]/reset
 * Admin-only: fully un-stick a request from ANY status and re-fetch from scratch.
 *
 * Unlike manual-search (which only works from pending/failed/awaiting_search), this
 * clears a request wedged at downloaded/available/processing/downloading — e.g. a
 * book whose library copy was removed or corrupted and can no longer progress.
 *
 * It clears the audiobook's library linkage, resets the request state and retry
 * counters, and triggers a fresh search.
 *
 * Note: if the book's item still exists in the library backend (Plex/ABS), its ASIN
 * is still in plex_library, so the next library scan will re-match this request to
 * 'available'. For a corrupt-but-still-present copy, remove the item from the library
 * backend first, then reset.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return requireAuth(request, async (req: AuthenticatedRequest) => {
    return requireAdmin(req, async () => {
      try {
        const { id } = await params;

        const requestRecord = await prisma.request.findUnique({
          where: { id },
          include: { audiobook: true },
        });

        if (!requestRecord) {
          return NextResponse.json(
            { error: 'NotFound', message: 'Request not found' },
            { status: 404 }
          );
        }

        const previousStatus = requestRecord.status;

        // Clear the audiobook's library linkage so a stale/corrupt library link doesn't
        // keep it pinned (mirrors the scan's stale-cleanup reset).
        await prisma.audiobook.update({
          where: { id: requestRecord.audiobook.id },
          data: {
            status: 'requested',
            plexGuid: null,
            absItemId: null,
            updatedAt: new Date(),
          },
        });

        // Reset the request to a clean, searchable state.
        await prisma.request.update({
          where: { id },
          data: {
            status: 'pending',
            progress: 0,
            errorMessage: null,
            completedAt: null,
            searchAttempts: 0,
            downloadAttempts: 0,
            importAttempts: 0,
            updatedAt: new Date(),
          },
        });

        // Trigger a fresh search by type.
        const jobQueue = getJobQueueService();
        const audiobookData = {
          id: requestRecord.audiobook.id,
          title: requestRecord.audiobook.title,
          author: requestRecord.audiobook.author,
          asin: requestRecord.audiobook.audibleAsin || undefined,
        };

        if (requestRecord.type === 'ebook') {
          await jobQueue.addSearchEbookJob(id, audiobookData);
        } else {
          await jobQueue.addSearchJob(id, audiobookData);
        }

        logger.info(`Admin reset request ${id} (was '${previousStatus}') and re-triggered search`, {
          requestId: id,
          adminId: req.user!.sub,
          previousStatus,
          type: requestRecord.type,
          title: requestRecord.audiobook.title,
        });

        return NextResponse.json({
          success: true,
          message: `Request reset from '${previousStatus}' and re-search started`,
        });
      } catch (error) {
        logger.error('Failed to reset request', {
          error: error instanceof Error ? error.message : String(error),
        });
        return NextResponse.json(
          { error: 'ResetError', message: 'Failed to reset request' },
          { status: 500 }
        );
      }
    });
  });
}
