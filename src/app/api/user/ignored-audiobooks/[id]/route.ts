/**
 * Component: Ignored Audiobook Delete Route
 * Documentation: documentation/features/ignored-audiobooks.md
 *
 * DELETE removes a single entry from the global ignore list (un-ignore).
 * Any authenticated user can remove entries.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, AuthenticatedRequest } from '@/lib/middleware/auth';
import { prisma } from '@/lib/db';
import { RMABLogger } from '@/lib/utils/logger';

const logger = RMABLogger.create('API.IgnoredAudiobooks');

/**
 * DELETE /api/user/ignored-audiobooks/[id]
 * Remove an audiobook from the global ignore list
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

      const existing = await prisma.ignoredAudiobook.findUnique({ where: { id } });

      if (!existing) {
        return NextResponse.json(
          { error: 'NotFound', message: 'Ignored audiobook entry not found' },
          { status: 404 }
        );
      }

      await prisma.ignoredAudiobook.delete({ where: { id } });

      logger.info(`User ${req.user.id} removed ASIN ${existing.asin} ("${existing.title}") from global ignore list`);

      return NextResponse.json({ success: true });
    } catch (error) {
      logger.error('Failed to remove ignored audiobook', {
        error: error instanceof Error ? error.message : String(error),
      });
      return NextResponse.json(
        { error: 'DeleteError', message: 'Failed to remove ignored audiobook' },
        { status: 500 }
      );
    }
  });
}
