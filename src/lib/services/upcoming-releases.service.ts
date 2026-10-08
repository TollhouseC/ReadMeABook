/**
 * Component: Upcoming Releases Service
 * Documentation: documentation/features/watched-lists.md
 *
 * Keeps the upcoming_releases table in sync with future-dated books seen during the
 * nightly watched-lists scrape (no extra Audible calls), and answers "what's coming
 * out" for a user's watched series/authors. Also decides which books are held back
 * from auto-requesting until their release day.
 */

import { prisma } from '../db';
import type { AudibleAudiobook } from '../integrations/audible.service';

export interface UpcomingReleaseItem {
  asin: string;
  title: string;
  author: string;
  series: string | null;
  seriesPart: string | null;
  coverArtUrl: string | null;
  releaseDate: string; // YYYY-MM-DD
}

/** Audible placeholder listings: release year 2100+ or a "ZZZ - ..." publisher. */
const PLACEHOLDER_MIN_YEAR = 2100;

function todayIso(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Release date as YYYY-MM-DD, or null if missing/unparseable. */
export function releaseDateIso(book: Pick<AudibleAudiobook, 'releaseDate'>): string | null {
  if (!book.releaseDate) return null;
  const match = String(book.releaseDate).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  const parsed = new Date(book.releaseDate);
  return isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

export function isPlaceholderListing(book: Pick<AudibleAudiobook, 'releaseDate' | 'publisherName'>): boolean {
  const date = releaseDateIso(book);
  if (date && parseInt(date.slice(0, 4), 10) >= PLACEHOLDER_MIN_YEAR) return true;
  return /^zzz\b/i.test(book.publisherName || '');
}

/** True when the book has a release date after today (it's a pre-order). */
export function isUpcoming(book: Pick<AudibleAudiobook, 'releaseDate'>, now = new Date()): boolean {
  const date = releaseDateIso(book);
  return !!date && date > todayIso(now);
}

/**
 * Replace a watched series/author's upcoming rows with the future-dated books from
 * this scrape (placeholders skipped), and prune rows whose date has passed.
 */
export async function syncUpcomingReleases(
  sourceType: 'series' | 'author',
  sourceAsin: string,
  books: AudibleAudiobook[],
  options: { seriesTitle?: string; now?: Date } = {}
): Promise<number> {
  const now = options.now ?? new Date();
  const upcoming = books.filter(b => b.asin && isUpcoming(b, now) && !isPlaceholderListing(b));

  for (const book of upcoming) {
    const data = {
      title: book.title,
      author: book.author,
      series: book.series || (sourceType === 'series' ? options.seriesTitle : undefined) || null,
      seriesPart: book.seriesPart || null,
      coverArtUrl: book.coverArtUrl || null,
      releaseDate: new Date(`${releaseDateIso(book)}T00:00:00Z`),
      sourceType,
      lastSeenAt: now,
    };
    await prisma.upcomingRelease.upsert({
      where: { asin_sourceAsin: { asin: book.asin, sourceAsin } },
      create: { asin: book.asin, sourceAsin, ...data },
      update: data,
    });
  }

  await prisma.upcomingRelease.deleteMany({
    where: { sourceAsin, asin: { notIn: upcoming.map(b => b.asin) } },
  });
  await prisma.upcomingRelease.deleteMany({
    where: { releaseDate: { lt: new Date(`${todayIso(now)}T00:00:00Z`) } },
  });

  return upcoming.length;
}

/** Upcoming books from the user's watched series and authors, soonest first. */
export async function getUpcomingReleasesForUser(userId: string, now = new Date()): Promise<UpcomingReleaseItem[]> {
  const [series, authors] = await Promise.all([
    prisma.watchedSeries.findMany({ where: { userId }, select: { seriesAsin: true } }),
    prisma.watchedAuthor.findMany({ where: { userId }, select: { authorAsin: true } }),
  ]);
  const sourceAsins = [...series.map(s => s.seriesAsin), ...authors.map(a => a.authorAsin)];
  if (sourceAsins.length === 0) return [];

  const rows = await prisma.upcomingRelease.findMany({
    where: {
      sourceAsin: { in: sourceAsins },
      releaseDate: { gte: new Date(`${todayIso(now)}T00:00:00Z`) },
    },
    orderBy: [{ releaseDate: 'asc' }, { title: 'asc' }],
  });

  // Same book can come from a watched series and a watched author — keep one, preferring series info
  const byAsin = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const existing = byAsin.get(row.asin);
    if (!existing || (!existing.series && row.series)) byAsin.set(row.asin, row);
  }

  return [...byAsin.values()].map(row => ({
    asin: row.asin,
    title: row.title,
    author: row.author,
    series: row.series,
    seriesPart: row.seriesPart,
    coverArtUrl: row.coverArtUrl,
    releaseDate: row.releaseDate.toISOString().slice(0, 10),
  }));
}
