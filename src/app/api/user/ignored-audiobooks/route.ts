/**
 * Component: Ignored Audiobooks API Routes
 * Documentation: documentation/features/ignored-audiobooks.md
 *
 * Server-wide ignore list for auto-request suppression.
 * GET returns the full global ignore list; POST adds a new entry.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, AuthenticatedRequest } from '@/lib/middleware/auth';
import { prisma } from '@/lib/db';
import { z } from 'zod';
import { RMABLogger } from '@/lib/utils/logger';

const logger = RMABLogger.create('API.IgnoredAudiobooks');

const AddIgnoredSchema = z.object({
  asin: z.string().min(1).max(20),
  title: z.string().min(1).max(500),
  author: z.string().min(1).max(500),
  coverArtUrl: z.string().optional(),
});

/**
 * GET /api/user/ignored-audiobooks
 * List all globally ignored audiobooks
 */
export async function GET(request: NextRequest) {
  return requireAuth(request, async (req: AuthenticatedRequest) => {
    try {
      if (!req.user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }

      const ignored = await prisma.ignoredAudiobook.findMany({
        orderBy: { createdAt: 'desc' },
      });

      return NextResponse.json({
        success: true,
        ignoredAudiobooks: ignored.map((item) => ({
          id: item.id,
          asin: item.asin,
          title: item.title,
          author: item.author,
          coverArtUrl: item.coverArtUrl,
          createdAt: item.createdAt.toISOString(),
        })),
      });
    } catch (error) {
      logger.error('Failed to list ignored audiobooks', {
        error: error instanceof Error ? error.message : String(error),
      });
      return NextResponse.json(
        { error: 'FetchError', message: 'Failed to fetch ignored audiobooks' },
        { status: 500 }
      );
    }
  });
}

/**
 * POST /api/user/ignored-audiobooks
 * Add an audiobook to the global ignore list
 */
export async function POST(request: NextRequest) {
  return requireAuth(request, async (req: AuthenticatedRequest) => {
    try {
      if (!req.user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }

      const body = await req.json();
      const data = AddIgnoredSchema.parse(body);

      const ignored = await prisma.ignoredAudiobook.upsert({
        where: { asin: data.asin },
        update: {},
        create: {
          asin: data.asin,
          title: data.title,
          author: data.author,
          coverArtUrl: data.coverArtUrl,
        },
      });

      logger.info(`User ${req.user.id} added ASIN ${data.asin} ("${data.title}") to global ignore list`);

      return NextResponse.json({
        success: true,
        ignoredAudiobook: {
          id: ignored.id,
          asin: ignored.asin,
          title: ignored.title,
          author: ignored.author,
          coverArtUrl: ignored.coverArtUrl,
          createdAt: ignored.createdAt.toISOString(),
        },
      }, { status: 201 });
    } catch (error) {
      logger.error('Failed to add ignored audiobook', {
        error: error instanceof Error ? error.message : String(error),
      });

      if (error instanceof z.ZodError) {
        return NextResponse.json(
          { error: 'ValidationError', details: error.errors },
          { status: 400 }
        );
      }

      return NextResponse.json(
        { error: 'CreateError', message: 'Failed to ignore audiobook' },
        { status: 500 }
      );
    }
  });
}
