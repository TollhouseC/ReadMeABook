/**
 * Component: Watched Lists Version Planner
 * Documentation: documentation/features/watched-lists.md
 *
 * Decides, per book from a watched series/author, whether to request it, skip it,
 * or queue it as an alternate version — so only one version of each book is pulled
 * unless the watched series opts into alternate versions (admin-approved).
 */

import { prisma } from '@/lib/db';
import type { AudibleAudiobook } from '@/lib/integrations/audible.service';
import {
  detectVersionMarker,
  getWorkKey,
  groupByWork,
  pickPreferredVersion,
  versionLabelFor,
} from '@/lib/utils/book-versions';

export type VersionPlanItem =
  /** Request normally (the preferred version; no other version exists) */
  | { book: AudibleAudiobook; action: 'request' }
  /** Request pending admin approval, imported as its own series via versionLabel */
  | { book: AudibleAudiobook; action: 'request_alternate'; versionLabel?: string }
  /** This exact ASIN is already in the library */
  | { book: AudibleAudiobook; action: 'skip_owned' }
  /** This exact ASIN already has an active request */
  | { book: AudibleAudiobook; action: 'skip_requested' }
  /** Another version of this book is on the server, requested, or preferred */
  | { book: AudibleAudiobook; action: 'skip_duplicate_version' };

export interface VersionPlanContext {
  /** ASINs in the library (direct or via works-table siblings) */
  ownedAsins: Set<string>;
  /** Work keys of library items (catches a copy stored under an ASIN not in the listing) */
  ownedWorkKeys: Set<string>;
  /** ASINs with an active (not failed/cancelled/denied) audiobook request */
  requestedAsins: Set<string>;
  /** Watched-series opt-in: also request other versions, pending admin approval */
  allowAlternateVersions: boolean;
}

/**
 * Plan what to do with each book. Pure — no I/O.
 *
 * Per work (all versions of one book):
 * - A version already owned/requested → that exact ASIN is skipped as owned/requested.
 * - Alternates off (default): if any version exists, the rest are skipped; otherwise
 *   only the preferred version (standard narration) is requested.
 * - Alternates on: the preferred version is requested normally if no version exists;
 *   every other missing version is requested pending admin approval, labelled so it
 *   imports as its own series.
 */
export function planVersionRequests(books: AudibleAudiobook[], ctx: VersionPlanContext): VersionPlanItem[] {
  const plan: VersionPlanItem[] = [];

  for (const [workKey, versions] of groupByWork(books)) {
    const preferred = pickPreferredVersion(versions);
    const versionExists =
      ctx.ownedWorkKeys.has(workKey) ||
      versions.some(v => ctx.ownedAsins.has(v.asin) || ctx.requestedAsins.has(v.asin));

    for (const book of versions) {
      if (ctx.ownedAsins.has(book.asin)) {
        plan.push({ book, action: 'skip_owned' });
      } else if (ctx.requestedAsins.has(book.asin)) {
        plan.push({ book, action: 'skip_requested' });
      } else if (!versionExists && book === preferred) {
        plan.push({ book, action: 'request' });
      } else if (!ctx.allowAlternateVersions) {
        plan.push({ book, action: 'skip_duplicate_version' });
      } else {
        // The preferred version keeps the main series unless it's intrinsically
        // non-standard; every other version is labelled relative to the preferred one.
        const versionLabel = book === preferred
          ? detectVersionMarker(book) ?? undefined
          : versionLabelFor(book, preferred);
        plan.push({ book, action: 'request_alternate', versionLabel });
      }
    }
  }

  return plan;
}

/**
 * Work keys of library items by the same primary authors — catches a version already
 * on the server under an ASIN that isn't part of the scraped listing.
 */
export async function getOwnedWorkKeys(books: AudibleAudiobook[]): Promise<Set<string>> {
  const authors = [...new Set(
    books
      .map(b => (b.author || '').split(/,|&|\band\b/i)[0].trim())
      .filter(Boolean)
  )];
  if (authors.length === 0) return new Set();

  const libraryItems = await prisma.plexLibrary.findMany({
    where: { OR: authors.map(name => ({ author: { contains: name, mode: 'insensitive' as const } })) },
    select: { title: true, author: true },
  });

  return new Set((libraryItems || []).map(item => getWorkKey({ title: item.title, author: item.author })));
}

/**
 * ASINs that already have an active audiobook request (any user). Failed, warn,
 * cancelled, and denied requests don't count — those versions may be retried.
 */
export async function getRequestedAsins(asins: string[]): Promise<Set<string>> {
  if (asins.length === 0) return new Set();

  const audiobooks = await prisma.audiobook.findMany({
    where: {
      audibleAsin: { in: asins },
      requests: {
        some: {
          type: 'audiobook',
          deletedAt: null,
          status: { notIn: ['failed', 'warn', 'cancelled', 'denied'] },
        },
      },
    },
    select: { audibleAsin: true },
  });

  return new Set((audiobooks || []).map(a => a.audibleAsin).filter((asin): asin is string => !!asin));
}
