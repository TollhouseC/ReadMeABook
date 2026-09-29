/**
 * Component: Pack Search Scheduling
 * Documentation: documentation/features/series-packs.md
 *
 * When a request qualifies for a series/author pack search. Kept dependency-free so
 * the regular search processor can check it without loading the pack pipeline.
 */

/** A request must have been searching this long before packs are considered. */
export const PACK_SEARCH_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/** Minimum gap between pack searches for one request (slightly under 24h for schedule drift). */
export const PACK_SEARCH_INTERVAL_MS = 20 * 60 * 60 * 1000;

/** Whether a request is old enough and hasn't had a pack search recently. */
export function isPackSearchDue(
  request: { createdAt: Date; lastPackSearchAt: Date | null },
  now: Date = new Date()
): boolean {
  if (now.getTime() - request.createdAt.getTime() < PACK_SEARCH_MIN_AGE_MS) return false;
  return !request.lastPackSearchAt || now.getTime() - request.lastPackSearchAt.getTime() >= PACK_SEARCH_INTERVAL_MS;
}
