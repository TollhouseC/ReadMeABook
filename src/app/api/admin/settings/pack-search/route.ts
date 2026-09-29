/**
 * Component: Admin Pack Search Settings API
 * Documentation: documentation/features/series-packs.md
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireAdmin, AuthenticatedRequest } from '@/lib/middleware/auth';
import { getConfigService } from '@/lib/services/config.service';
import { RMABLogger } from '@/lib/utils/logger';
import { z } from 'zod';

const logger = RMABLogger.create('API.Admin.Settings.PackSearch');

const AUTHOR_MODES = ['disabled', 'log_only', 'enabled'] as const;

const UpdateSchema = z.object({
  enabled: z.boolean().optional(),
  authorPackMode: z.enum(AUTHOR_MODES).optional(),
});

async function readSettings() {
  const config = getConfigService();
  const [enabled, mode] = await Promise.all([
    config.get('pack_search_enabled'),
    config.get('pack_search_author_mode'),
  ]);
  return {
    // Defaults: series packs on, author packs log-only
    enabled: enabled !== 'false',
    authorPackMode: (AUTHOR_MODES as readonly string[]).includes(mode || '') ? mode : 'log_only',
  };
}

/**
 * GET /api/admin/settings/pack-search
 * { enabled: boolean, authorPackMode: 'disabled' | 'log_only' | 'enabled' }
 */
export async function GET(request: NextRequest) {
  return requireAuth(request, async (req: AuthenticatedRequest) => {
    return requireAdmin(req, async () => {
      try {
        return NextResponse.json(await readSettings());
      } catch (error) {
        logger.error('Failed to fetch pack search settings', { error: error instanceof Error ? error.message : String(error) });
        return NextResponse.json({ error: 'Failed to fetch pack search settings' }, { status: 500 });
      }
    });
  });
}

/**
 * PUT /api/admin/settings/pack-search
 * Body: { enabled?: boolean, authorPackMode?: 'disabled' | 'log_only' | 'enabled' }
 */
export async function PUT(request: NextRequest) {
  return requireAuth(request, async (req: AuthenticatedRequest) => {
    return requireAdmin(req, async () => {
      try {
        const { enabled, authorPackMode } = UpdateSchema.parse(await request.json());

        const updates: { key: string; value: string; category: string; description: string }[] = [];
        if (enabled !== undefined) {
          updates.push({
            key: 'pack_search_enabled',
            value: String(enabled),
            category: 'indexers',
            description: 'Search for series/author packs when a series book has no individual release after 24h',
          });
        }
        if (authorPackMode !== undefined) {
          updates.push({
            key: 'pack_search_author_mode',
            value: authorPackMode,
            category: 'indexers',
            description: 'Author collection packs: disabled, log_only (evaluate but never download), or enabled',
          });
        }
        if (updates.length > 0) await getConfigService().setMany(updates);

        logger.info('Pack search settings updated', { enabled, authorPackMode, userId: req.user?.sub });
        return NextResponse.json(await readSettings());
      } catch (error) {
        if (error instanceof z.ZodError) {
          return NextResponse.json({ error: 'Invalid settings', details: error.errors }, { status: 400 });
        }
        logger.error('Failed to update pack search settings', { error: error instanceof Error ? error.message : String(error) });
        return NextResponse.json({ error: 'Failed to update pack search settings' }, { status: 500 });
      }
    });
  });
}
