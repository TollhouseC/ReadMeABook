/**
 * Component: Archived Series Replacement API Route
 * Documentation: documentation/features/watched-lists.md
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser } from '@/lib/middleware/auth';
import { RMABLogger } from '@/lib/utils/logger';
import { followArchivedSeries } from '@/lib/services/archived-series';

const logger = RMABLogger.create('API.Series.Replacement');

/**
 * POST /api/series/{asin}/replacement  { title }
 * For a series Audible archived: find (or recall) the series that replaced it and move
 * watches / book links over. → { movedTo: { asin, title, from } | null }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ asin: string }> }
) {
  if (!getCurrentUser(request)) {
    return NextResponse.json({ error: 'Unauthorized', message: 'Authentication required' }, { status: 401 });
  }

  const { asin } = await params;
  if (!asin || !/^[A-Z0-9]{10}$/.test(asin)) {
    return NextResponse.json({ error: 'ValidationError', message: 'Valid series ASIN is required' }, { status: 400 });
  }

  const body = await request.json().catch(() => ({}));
  const title = typeof body?.title === 'string' ? body.title : '';

  try {
    const movedTo = await followArchivedSeries(asin, title, logger);
    logger.info(movedTo ? `Archived series ${asin} → "${movedTo.title}" (${movedTo.asin})` : `No replacement found for archived series ${asin} ("${title}")`);
    return NextResponse.json({ success: true, movedTo });
  } catch (error) {
    logger.error('Failed to find series replacement', { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json({ error: 'FetchError', message: 'Failed to look up the replacement series' }, { status: 500 });
  }
}
