/**
 * Component: Admin Release Language Settings API
 * Documentation: documentation/phase3/ranking-algorithm.md
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireAdmin, AuthenticatedRequest } from '@/lib/middleware/auth';
import { getConfigService } from '@/lib/services/config.service';
import { RMABLogger } from '@/lib/utils/logger';
import { RELEASE_LANGUAGES } from '@/lib/constants/release-languages';
import { getRequiredReleaseLanguage } from '@/lib/utils/release-language';
import { z } from 'zod';

const logger = RMABLogger.create('API.Admin.Settings.ReleaseLanguage');

const UpdateSchema = z.object({
  language: z.enum(['any', ...RELEASE_LANGUAGES]),
});

/**
 * GET /api/admin/settings/release-language → { language }  (default 'english')
 */
export async function GET(request: NextRequest) {
  return requireAuth(request, async (req: AuthenticatedRequest) => {
    return requireAdmin(req, async () => {
      try {
        return NextResponse.json({ language: await getRequiredReleaseLanguage() });
      } catch (error) {
        logger.error('Failed to fetch release language', { error: error instanceof Error ? error.message : String(error) });
        return NextResponse.json({ error: 'Failed to fetch release language' }, { status: 500 });
      }
    });
  });
}

/**
 * PUT /api/admin/settings/release-language  Body: { language: 'any' | 'english' | 'german' | ... }
 */
export async function PUT(request: NextRequest) {
  return requireAuth(request, async (req: AuthenticatedRequest) => {
    return requireAdmin(req, async () => {
      try {
        const { language } = UpdateSchema.parse(await request.json());
        await getConfigService().setMany([{
          key: 'release_language',
          value: language,
          category: 'indexers',
          description: "Required release language for indexer results ('any' disables filtering)",
        }]);
        logger.info('Release language updated', { language, userId: req.user?.sub });
        return NextResponse.json({ language });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return NextResponse.json({ error: 'Invalid language', details: error.errors }, { status: 400 });
        }
        logger.error('Failed to update release language', { error: error instanceof Error ? error.message : String(error) });
        return NextResponse.json({ error: 'Failed to update release language' }, { status: 500 });
      }
    });
  });
}
