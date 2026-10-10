/**
 * Component: Audiobookshelf Maintenance Helpers
 * Documentation: documentation/features/library-match.md
 *
 * - Force re-scan: Audiobookshelf's normal scan only revisits folders it thinks changed;
 *   `?force=1` re-reads every item (used after folder moves and from the Jobs page).
 * - Duplicate tracks: after folder moves Audiobookshelf can list the same file twice as two
 *   tracks, so the book shows double length. A scan doesn't remove the extra entry; removing
 *   the item from Audiobookshelf's database (files kept) and scanning re-creates it cleanly.
 */

import { getConfigService } from './config.service';
import type { RMABLogger } from '../utils/logger';

type Log = Pick<RMABLogger, 'info' | 'warn'>;

/** Force re-scan of the configured Audiobookshelf library. Returns false when not on Audiobookshelf. */
export async function forceRescanABS(logger?: Log): Promise<boolean> {
  const configService = getConfigService();
  if ((await configService.getBackendMode()) !== 'audiobookshelf') return false;
  const libraryId = await configService.get('audiobookshelf.library_id');
  if (!libraryId) throw new Error('Audiobookshelf library ID not configured');
  const { triggerABSScan } = await import('./audiobookshelf/api');
  await triggerABSScan(libraryId, { force: true });
  await logger?.info('Triggered an Audiobookshelf force re-scan (every item re-read)');
  return true;
}

/** Files an Audiobookshelf item lists more than once as tracks ([] when none / unreadable). */
export async function findDuplicateTracks(itemId: string): Promise<string[]> {
  const { getABSItem } = await import('./audiobookshelf/api');
  const item = await getABSItem(itemId);
  const paths: string[] = (item?.media?.audioFiles ?? [])
    .map((f: any) => f?.metadata?.path || f?.metadata?.relPath || f?.metadata?.filename)
    .filter((p: unknown): p is string => typeof p === 'string' && p.length > 0);
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const p of paths) (seen.has(p) ? dupes : seen).add(p);
  return [...dupes];
}
