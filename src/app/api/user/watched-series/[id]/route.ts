/**
 * Component: Watched Series Item Routes (update + delete)
 * Documentation: documentation/features/watched-lists.md
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, AuthenticatedRequest } from '@/lib/middleware/auth';
import { prisma } from '@/lib/db';
import { getJobQueueService } from '@/lib/services/job-queue.service';
import { z } from 'zod';
import { RMABLogger } from '@/lib/utils/logger';

const logger = RMABLogger.create('API.WatchedSeries');

const UpdateWatchedSeriesSchema = z.object({
  allowAlternateVersions: z.boolean(),
});

/**
 * PATCH /api/user/watched-series/[id]
 * Update a watched series' settings (ownership check).
 * Body: { allowAlternateVersions: boolean } — when true, other versions of each book
 * are also requested (always pending admin approval) and imported as their own series.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return requireAuth(request, async (req: AuthenticatedRequest) => {
    try {
      if (!req.user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }

      const { id } = await params;
      const { allowAlternateVersions } = UpdateWatchedSeriesSchema.parse(await request.json());

      const watched = await prisma.watchedSeries.findUnique({ where: { id } });
      if (!watched) {
        return NextResponse.json({ error: 'Watched series not found' }, { status: 404 });
      }
      if (watched.userId !== req.user.id) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }

      const updated = await prisma.watchedSeries.update({
        where: { id },
        data: { allowAlternateVersions },
      });

      logger.info(
        `User ${req.user.id} ${allowAlternateVersions ? 'enabled' : 'disabled'} alternate versions ` +
        `for series "${watched.seriesTitle}" (${watched.seriesAsin})`
      );

      // Queue alternates now rather than waiting for the nightly check
      if (allowAlternateVersions && !watched.allowAlternateVersions) {
        try {
          await getJobQueueService().addCheckWatchedItemJob(req.user.id, watched.seriesAsin);
        } catch (error) {
          logger.error('Failed to trigger watched series check after enabling alternates', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return NextResponse.json({
        success: true,
        series: {
          id: updated.id,
          seriesAsin: updated.seriesAsin,
          seriesTitle: updated.seriesTitle,
          coverArtUrl: updated.coverArtUrl,
          allowAlternateVersions: updated.allowAlternateVersions,
          lastCheckedAt: updated.lastCheckedAt,
          createdAt: updated.createdAt,
        },
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return NextResponse.json({ error: 'Invalid request body', details: error.errors }, { status: 400 });
      }
      logger.error('Failed to update watched series', { error: error instanceof Error ? error.message : String(error) });
      return NextResponse.json({ error: 'Failed to update watched series' }, { status: 500 });
    }
  });
}

/**
 * DELETE /api/user/watched-series/[id]
 * Remove a series from the user's watch list (ownership check)
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return requireAuth(request, async (req: AuthenticatedRequest) => {
    try {
      if (!req.user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }

      const { id } = await params;

      const watched = await prisma.watchedSeries.findUnique({
        where: { id },
      });

      if (!watched) {
        return NextResponse.json({ error: 'Watched series not found' }, { status: 404 });
      }

      // Ownership check
      if (watched.userId !== req.user.id) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }

      await prisma.watchedSeries.delete({ where: { id } });

      logger.info(`User ${req.user.id} stopped watching series "${watched.seriesTitle}" (${watched.seriesAsin})`);

      return NextResponse.json({ success: true });
    } catch (error) {
      logger.error('Failed to delete watched series', { error: error instanceof Error ? error.message : String(error) });
      return NextResponse.json({ error: 'Failed to delete watched series' }, { status: 500 });
    }
  });
}
