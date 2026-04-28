/**
 * Component: Ignored Audiobook Check Route
 * Documentation: documentation/features/ignored-audiobooks.md
 *
 * Quick check whether a specific ASIN is in the global ignore list.
 * Includes works-system expansion to catch sibling ASINs.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, AuthenticatedRequest } from '@/lib/middleware/auth';
import { prisma } from '@/lib/db';
import { getSiblingAsins } from '@/lib/services/works.service';
import { RMABLogger } from '@/lib/utils/logger';

const logger = RMABLogger.create('API.IgnoredAudiobooks.Check');

/**
 * GET /api/user/ignored-audiobooks/check/[asin]
 * Returns { ignored: boolean, ignoredId?: string } for the given ASIN.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ asin: string }> }
) {
  return requireAuth(request, async (req: AuthenticatedRequest) => {
    try {
      if (!req.user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }

      const { asin } = await params;

      // Direct check
      const directIgnore = await prisma.ignoredAudiobook.findUnique({
        where: { asin },
      });

      if (directIgnore) {
        return NextResponse.json({ ignored: true, ignoredId: directIgnore.id });
      }

      // Works-system expansion: check sibling ASINs
      try {
        const siblingMap = await getSiblingAsins([asin]);
        const siblings = siblingMap.get(asin);
        if (siblings && siblings.length > 0) {
          const siblingIgnore = await prisma.ignoredAudiobook.findFirst({
            where: { asin: { in: siblings } },
          });
          if (siblingIgnore) {
            return NextResponse.json({ ignored: true, ignoredId: siblingIgnore.id });
          }
        }
      } catch {
        // Works expansion is best-effort
      }

      return NextResponse.json({ ignored: false });
    } catch (error) {
      logger.error('Failed to check ignored status', {
        error: error instanceof Error ? error.message : String(error),
      });
      return NextResponse.json(
        { error: 'CheckError', message: 'Failed to check ignored status' },
        { status: 500 }
      );
    }
  });
}
