/**
 * Component: Upcoming Releases API Route
 * Documentation: documentation/features/watched-lists.md
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, AuthenticatedRequest } from '@/lib/middleware/auth';
import { getUpcomingReleasesForUser } from '@/lib/services/upcoming-releases.service';
import { RMABLogger } from '@/lib/utils/logger';

const logger = RMABLogger.create('API.Upcoming');

/**
 * GET /api/user/upcoming
 * Future-dated books from the current user's watched series and authors, soonest first.
 */
export async function GET(request: NextRequest) {
  return requireAuth(request, async (req: AuthenticatedRequest) => {
    try {
      if (!req.user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
      return NextResponse.json({ success: true, upcoming: await getUpcomingReleasesForUser(req.user.id) });
    } catch (error) {
      logger.error('Failed to list upcoming releases', { error: error instanceof Error ? error.message : String(error) });
      return NextResponse.json({ error: 'Failed to list upcoming releases' }, { status: 500 });
    }
  });
}
