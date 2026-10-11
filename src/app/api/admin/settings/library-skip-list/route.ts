/**
 * Component: Admin Library Skip List API
 * Documentation: documentation/backend/services/jobs.md
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireAdmin, AuthenticatedRequest } from '@/lib/middleware/auth';
import { RMABLogger } from '@/lib/utils/logger';
import { loadSkipListText, parseSkipList, saveSkipListText } from '@/lib/services/library-skip-list';
import { z } from 'zod';

const logger = RMABLogger.create('API.Admin.Settings.LibrarySkipList');

const UpdateSchema = z.object({ text: z.string().max(200_000) });

const describe = (text: string) => {
  const { entries, errors } = parseSkipList(text);
  return { text, entries: entries.length, errors };
};

/** GET /api/admin/settings/library-skip-list → { text, entries, errors } */
export async function GET(request: NextRequest) {
  return requireAuth(request, async (req: AuthenticatedRequest) => {
    return requireAdmin(req, async () => {
      try {
        return NextResponse.json(describe(await loadSkipListText()));
      } catch (error) {
        logger.error('Failed to read skip list', { error: error instanceof Error ? error.message : String(error) });
        return NextResponse.json({ error: 'Failed to read skip list' }, { status: 500 });
      }
    });
  });
}

/**
 * PUT /api/admin/settings/library-skip-list  Body: { text } — replaces the whole list.
 * Lines with errors are reported back (and ignored by the jobs); the text is saved as is.
 */
export async function PUT(request: NextRequest) {
  return requireAuth(request, async (req: AuthenticatedRequest) => {
    return requireAdmin(req, async () => {
      try {
        const { text } = UpdateSchema.parse(await request.json());
        const parsed = await saveSkipListText(text);
        logger.info('Library skip list saved', { entries: parsed.entries.length, errors: parsed.errors.length, userId: req.user?.sub });
        return NextResponse.json({ text, entries: parsed.entries.length, errors: parsed.errors });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return NextResponse.json({ error: 'Invalid skip list', details: error.errors }, { status: 400 });
        }
        logger.error('Failed to save skip list', { error: error instanceof Error ? error.message : String(error) });
        return NextResponse.json({ error: 'Failed to save skip list' }, { status: 500 });
      }
    });
  });
}
