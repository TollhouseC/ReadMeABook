/**
 * Component: Archived Audible Series
 * Documentation: documentation/features/watched-lists.md
 *
 * Audible sometimes replaces a series with a new one and empties the old page, renaming it
 * "<name> [ARCHIVED]" (e.g. "Black Company" → "Chronicles of the Black Company"). Audnexus
 * keeps the old series ASIN on its books, so watches and series links pointed at an empty
 * page. This finds the replacement — the series a known book of the old one is listed in
 * now, on Audible's live catalog — and moves watches and book links over. The series name
 * stored on books (used for library folders) is left alone so new books still land next
 * to the old ones.
 */

import { compareTwoStrings } from 'string-similarity';
import { prisma } from '../db';
import { seriesKey } from '../utils/author-identity';
import type { RMABLogger } from '../utils/logger';

export interface ReplacementSeries {
  asin: string;
  title: string;
}

type Log = Pick<RMABLogger, 'info' | 'warn'>;

const ARCHIVED_RE = /\[\s*archived\s*\]/i;

export const isArchivedSeriesTitle = (title?: string | null) => !!title && ARCHIVED_RE.test(title);
export const stripArchived = (title: string) => title.replace(ARCHIVED_RE, '').trim();

/** "Black Company" ~ "Chronicles of the Black Company" (one name inside the other, or similar). */
export function sameSeriesName(a: string, b: string): boolean {
  const x = seriesKey(stripArchived(a));
  const y = seriesKey(stripArchived(b));
  if (!x || !y) return false;
  return ` ${y} `.includes(` ${x} `) || ` ${x} `.includes(` ${y} `) || compareTwoStrings(x, y) >= 0.6;
}

/**
 * The series that replaced an archived (or emptied) one, or null.
 * 1. Books ReadMeABook has on record in the old series → their current series on Audible.
 * 2. Otherwise an Audible series search for the old name — only when exactly one result fits.
 */
export async function findReplacementSeries(archivedAsin: string, archivedTitle: string): Promise<ReplacementSeries | null> {
  const name = stripArchived(archivedTitle);
  const fits = (asin?: string, title?: string): title is string =>
    !!asin && !!title && asin !== archivedAsin && !isArchivedSeriesTitle(title) && sameSeriesName(name, title);

  const books = await prisma.audiobook.findMany({
    where: { seriesAsin: archivedAsin, audibleAsin: { not: null } },
    select: { audibleAsin: true },
    take: 5,
  });
  if (books.length > 0) {
    const { getAudibleService } = await import('../integrations/audible.service');
    const products = await getAudibleService().getProductsByAsins(books.map(b => b.audibleAsin!));
    const hit = products.find(p => fits(p.seriesAsin, p.series));
    if (hit) return { asin: hit.seriesAsin!, title: hit.series! };
  }

  if (!name) return null;
  const { searchForSeries } = await import('../integrations/audible-series');
  const found = (await searchForSeries(name)).filter(s => fits(s.asin, s.title));
  return found.length === 1 ? { asin: found[0].asin, title: found[0].title } : null;
}

/**
 * Point everything at the replacement series: watches (an existing watch on the new series
 * wins — the old one is removed), book series links, and the old series' upcoming releases.
 * Returns the number of watches moved.
 */
export async function moveToReplacementSeries(archivedAsin: string, replacement: ReplacementSeries, log?: Log): Promise<number> {
  const watches = await prisma.watchedSeries.findMany({ where: { seriesAsin: archivedAsin } });
  let moved = 0;
  for (const watch of watches) {
    const existing = await prisma.watchedSeries.findFirst({ where: { userId: watch.userId, seriesAsin: replacement.asin } });
    if (existing) {
      await prisma.watchedSeries.delete({ where: { id: watch.id } });
    } else {
      await prisma.watchedSeries.update({ where: { id: watch.id }, data: { seriesAsin: replacement.asin, seriesTitle: replacement.title } });
      moved++;
    }
  }
  const books = await prisma.audiobook.updateMany({ where: { seriesAsin: archivedAsin }, data: { seriesAsin: replacement.asin } });
  await prisma.upcomingRelease.deleteMany({ where: { sourceAsin: archivedAsin } });
  await log?.info(
    `Series ${archivedAsin} was archived on Audible — replaced by "${replacement.title}" (${replacement.asin}): ` +
    `${moved} watch(es) moved, ${watches.length - moved} duplicate watch(es) removed, ${books.count} book link(s) updated`
  );
  return moved;
}
