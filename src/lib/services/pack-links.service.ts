/**
 * Component: Pack Links Service
 * Documentation: documentation/features/series-packs.md
 *
 * Decides which requests import which books from an accepted series/author pack:
 * the triggering request, other stuck requests for the same series (linked to the
 * same download), and — when the requesting user is auto-approved — new requests for
 * series books nobody asked for yet (filling out the series). Also picks which files
 * of the torrent to download.
 */

import { prisma } from '@/lib/db';
import { RMABLogger } from '@/lib/utils/logger';
import { getWorkKey } from '@/lib/utils/book-versions';
import { getOwnedWorkKeys } from '@/lib/services/watched-lists-versions';
import { createRequestForUser } from '@/lib/services/request-creator.service';
import type { PackBookMatch, PackMatchResult } from '@/lib/utils/pack-matcher';
import type { SeriesUniverse } from '@/lib/services/pack-sources';

type Logger = ReturnType<typeof RMABLogger.forJob> | ReturnType<typeof RMABLogger.create>;

// ---------------------------------------------------------------------------

export async function isUserAutoApproved(user: { role: string; autoApproveRequests: boolean | null }): Promise<boolean> {
  if (user.role === 'admin') return true;
  if (user.autoApproveRequests !== null) return user.autoApproveRequests;
  const global = await prisma.configuration.findUnique({ where: { key: 'auto_approve_requests' } });
  return global === null ? true : global.value === 'true';
}

export interface PackLink {
  requestId: string;
  match: PackBookMatch;
  origin: 'triggering' | 'linked' | 'filled';
}

export async function planLinks(
  triggeringRequestId: string,
  triggeringKey: string,
  user: { id: string; role: string; autoApproveRequests: boolean | null },
  match: PackMatchResult,
  universe: SeriesUniverse,
  logger: Logger
): Promise<PackLink[]> {
  const links: PackLink[] = [];
  const canFillOut = await isUserAutoApproved(user);
  const ownedWorkKeys = await getOwnedWorkKeys([...universe.details.values()]);

  for (const bookMatch of match.matches) {
    if (bookMatch.asin === triggeringKey) {
      links.push({ requestId: triggeringRequestId, match: bookMatch, origin: 'triggering' });
      continue;
    }

    const existing = await prisma.request.findFirst({
      where: {
        audiobook: { audibleAsin: bookMatch.asin },
        type: 'audiobook',
        deletedAt: null,
        status: { notIn: ['failed', 'warn', 'cancelled', 'denied'] },
      },
      select: { id: true, status: true },
    });

    if (existing) {
      if (['awaiting_search', 'pending'].includes(existing.status)) {
        links.push({ requestId: existing.id, match: bookMatch, origin: 'linked' });
      } else {
        logger.info(`Pack: skipping "${bookMatch.title}" — already ${existing.status}`);
      }
      continue;
    }

    const detail = universe.details.get(bookMatch.asin);
    if (!canFillOut || !detail) {
      logger.info(`Pack: skipping unrequested "${bookMatch.title}"${canFillOut ? '' : ' — requesting user needs approval'}`);
      continue;
    }
    if (ownedWorkKeys.has(getWorkKey(detail))) {
      logger.info(`Pack: skipping "${bookMatch.title}" — a version is already in the library`);
      continue;
    }

    const created = await createRequestForUser(
      user.id,
      {
        asin: detail.asin,
        title: detail.title,
        author: detail.author,
        narrator: detail.narrator,
        description: detail.description,
        coverArtUrl: detail.coverArtUrl,
      },
      { skipAutoSearch: true }
    );
    if (created.success) {
      links.push({ requestId: created.request.id, match: bookMatch, origin: 'filled' });
    } else {
      logger.info(`Pack: skipping "${bookMatch.title}" — ${created.reason}`);
    }
  }

  return links;
}

/** File indexes to download: the linked books' audio plus non-audio files beside them (covers). */
export function wantedFileIndexes(files: Array<{ name: string; index: number }>, links: PackLink[]): Set<number> {
  const wanted = new Set<number>();
  const dirs = new Set<string>();
  for (const link of links) {
    for (const f of link.match.files) {
      wanted.add(f.index);
      dirs.add(f.name.replace(/\\/g, '/').split('/').slice(0, -1).join('/'));
    }
  }
  for (const f of files) {
    const dir = f.name.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
    if (dirs.has(dir)) wanted.add(f.index);
  }
  return wanted;
}
