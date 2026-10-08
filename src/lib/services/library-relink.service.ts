/**
 * Component: Library Relink Service (library scan safety)
 * Documentation: documentation/backend/services/jobs.md
 *
 * Keeps requests linked to books that are still in the library when the backend's item
 * ID changes (Audiobookshelf re-creates items on folder moves/rescans) or a scan comes
 * back incomplete — instead of cancelling them as "Removed from library".
 * - Grace: a library record must be missing from scans for STALE_GRACE_MS before removal.
 * - Relink: a missing item whose ASIN is present under a new item moves its links there.
 * - Restore: requests cancelled as "Removed from library" whose ASIN is back are restored.
 */

import { prisma } from '../db';
import type { RMABLogger } from '../utils/logger';

/** A record must be missing this long (≥ 2 regular 6-hourly scans) before it's treated as removed. */
export const STALE_GRACE_MS = 12 * 60 * 60 * 1000;

export const REMOVED_FROM_LIBRARY = 'Removed from library';

type BackendMode = 'plex' | 'audiobookshelf';

/** ASIN (lowercase) → library item external ID, from the items seen in this scan. */
export function buildAsinIndex(items: Array<{ asin?: string | null; externalId?: string | null }>): Map<string, string> {
  const index = new Map<string, string>();
  for (const item of items) {
    if (item.asin && item.externalId && !index.has(item.asin.toLowerCase())) {
      index.set(item.asin.toLowerCase(), item.externalId);
    }
  }
  return index;
}

function linkField(backendMode: BackendMode): 'absItemId' | 'plexGuid' {
  return backendMode === 'audiobookshelf' ? 'absItemId' : 'plexGuid';
}

/** Point every audiobook linked to `oldGuid` at `newGuid`. Returns how many were moved. */
export async function relinkAudiobooks(oldGuid: string, newGuid: string, backendMode: BackendMode): Promise<number> {
  const field = linkField(backendMode);
  const { count } = await prisma.audiobook.updateMany({
    where: { OR: [{ plexGuid: oldGuid }, { absItemId: oldGuid }] },
    data: { [field]: newGuid, updatedAt: new Date() },
  });
  return count;
}

/** Link one audiobook to a library item. */
export async function linkAudiobook(audiobookId: string, guid: string, backendMode: BackendMode): Promise<void> {
  await prisma.audiobook.update({
    where: { id: audiobookId },
    data: { [linkField(backendMode)]: guid, updatedAt: new Date() },
  });
}

/**
 * Restore requests cancelled as "Removed from library" whose book (by ASIN) is in the
 * library again, unless the book has since been requested again.
 */
export async function restoreRemovedFromLibraryRequests(
  asinIndex: Map<string, string>,
  backendMode: BackendMode,
  logger?: RMABLogger
): Promise<number> {
  if (asinIndex.size === 0) return 0;

  const cancelled = await prisma.request.findMany({
    where: { type: 'audiobook', status: 'cancelled', errorMessage: REMOVED_FROM_LIBRARY, deletedAt: null },
    include: { audiobook: { select: { id: true, title: true, audibleAsin: true } } },
  });

  let restored = 0;
  for (const request of cancelled) {
    const asin = request.audiobook.audibleAsin?.toLowerCase();
    const guid = asin ? asinIndex.get(asin) : undefined;
    if (!guid) continue;

    const newer = await prisma.request.findFirst({
      where: {
        audiobookId: request.audiobook.id,
        type: 'audiobook',
        deletedAt: null,
        id: { not: request.id },
        status: { notIn: ['cancelled', 'denied', 'failed'] },
      },
      select: { id: true },
    });
    if (newer) continue;

    await linkAudiobook(request.audiobook.id, guid, backendMode);
    await prisma.request.update({
      where: { id: request.id },
      data: { status: 'available', errorMessage: null, updatedAt: new Date() },
    });
    restored++;
    await logger?.info(`Restored "${request.audiobook.title}" to available (still in library — was cancelled as removed)`);
  }
  return restored;
}
