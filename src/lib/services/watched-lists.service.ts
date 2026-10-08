/**
 * Component: Watched Lists Service
 * Documentation: documentation/features/watched-lists.md
 *
 * Checks watched series and watched authors for new releases.
 * Deduplicates results using the works table, checks against user's library,
 * and auto-creates requests via the shared request-creator service.
 * Follows the same pattern as goodreads-sync.service.ts.
 */

import { prisma } from '@/lib/db';
import { getAudibleService, AudibleAudiobook } from '@/lib/integrations/audible.service';
import { scrapeSeriesPage } from '@/lib/integrations/audible-series';
import { deduplicateAndCollectGroups } from '@/lib/utils/deduplicate-audiobooks';
import { persistDedupGroups } from '@/lib/services/works.service';
import { createRequestForUser } from '@/lib/services/request-creator.service';
import { findPlexMatch } from '@/lib/utils/audiobook-matcher';
import { getSiblingAsins } from '@/lib/services/works.service';
import { planVersionRequests, getOwnedWorkKeys, getRequestedAsins } from '@/lib/services/watched-lists-versions';
import { RMABLogger } from '@/lib/utils/logger';
import { isPlaceholderListing, isUpcoming, syncUpcomingReleases } from '@/lib/services/upcoming-releases.service';
import { createJobProgress, type JobProgressReporter } from '@/lib/utils/job-progress';

const logger = RMABLogger.create('WatchedLists');

/** Max books to process per series (avoid excessively long runs) */
const MAX_BOOKS_PER_SERIES = 200;

/** Max author book pages to scrape */
const MAX_AUTHOR_PAGES = 4;

/** Delay between scrapes to avoid rate limiting (ms) */
const SCRAPE_DELAY_MS = 2000;

export interface WatchedListsSyncStats {
  seriesChecked: number;
  authorsChecked: number;
  booksFound: number;
  requestsCreated: number;
  skippedOwned: number;
  skippedExisting: number;
  /** Another version of the book is already on the server or requested */
  skippedDuplicateVersion: number;
  /** Alternate versions requested pending admin approval (series opted in) */
  alternateVersionsQueued: number;
  /** Pre-orders held until their release date (listed as upcoming instead) */
  skippedUpcoming: number;
  errors: number;
  /** Stopped early by the admin Cancel button */
  cancelled?: boolean;
}

export interface WatchedListsSyncOptions {
  /** Process only this specific user (for targeted sync) */
  userId?: string;
  /** Process only this specific series (for immediate sync on watch) */
  seriesAsin?: string;
  /** Process only this specific author (for immediate sync on watch) */
  authorAsin?: string;
  /** Job row for live progress / cancel (admin UI) */
  jobId?: string;
}

/**
 * Process all watched series and authors: scrape for new releases,
 * deduplicate, check library ownership, and create requests.
 * Called from the check_watched_lists processor.
 */
export async function processWatchedLists(
  jobLogger?: ReturnType<typeof RMABLogger.forJob>,
  options: WatchedListsSyncOptions = {}
): Promise<WatchedListsSyncStats> {
  const log = jobLogger || logger;
  const stats: WatchedListsSyncStats = {
    seriesChecked: 0,
    authorsChecked: 0,
    booksFound: 0,
    requestsCreated: 0,
    skippedOwned: 0,
    skippedExisting: 0,
    skippedDuplicateVersion: 0,
    alternateVersionsQueued: 0,
    skippedUpcoming: 0,
    errors: 0,
  };

  const progress = createJobProgress(options.jobId, 'Watched lists — series', { cancellable: true });

  // ---- Watched Series ----
  await processAllWatchedSeries(log, stats, options, progress);

  // ---- Watched Authors ----
  if (!stats.cancelled) await processAllWatchedAuthors(log, stats, options, progress);
  await progress.finish(stats.cancelled ? 'Cancelled' : 'Done');

  log.info('Watched lists sync complete', {
    seriesChecked: stats.seriesChecked,
    authorsChecked: stats.authorsChecked,
    booksFound: stats.booksFound,
    requestsCreated: stats.requestsCreated,
    skippedOwned: stats.skippedOwned,
    skippedExisting: stats.skippedExisting,
    skippedDuplicateVersion: stats.skippedDuplicateVersion,
    alternateVersionsQueued: stats.alternateVersionsQueued,
    skippedUpcoming: stats.skippedUpcoming,
    errors: stats.errors,
  });

  return stats;
}

// ---------------------------------------------------------------------------
// Watched Series
// ---------------------------------------------------------------------------

async function processAllWatchedSeries(
  log: ReturnType<typeof RMABLogger.forJob> | ReturnType<typeof RMABLogger.create>,
  stats: WatchedListsSyncStats,
  options: WatchedListsSyncOptions,
  progress?: JobProgressReporter
): Promise<void> {
  const whereClause: any = {};
  if (options.userId) whereClause.userId = options.userId;
  if (options.seriesAsin) whereClause.seriesAsin = options.seriesAsin;
  const watchedSeries = await prisma.watchedSeries.findMany({
    where: whereClause,
    include: { user: { select: { id: true, plexUsername: true } } },
  });

  if (watchedSeries.length === 0) {
    log.info('No watched series to process');
    return;
  }

  // Group by seriesAsin to avoid re-scraping the same series for multiple users
  const seriesByAsin = new Map<string, typeof watchedSeries>();
  for (const ws of watchedSeries) {
    const list = seriesByAsin.get(ws.seriesAsin) || [];
    list.push(ws);
    seriesByAsin.set(ws.seriesAsin, list);
  }

  log.info(`Processing ${seriesByAsin.size} unique watched series (${watchedSeries.length} total subscriptions)`);

  await progress?.update(0, { total: seriesByAsin.size, label: 'Watched lists — series', force: true });
  let seriesIndex = 0;
  for (const [seriesAsin, subscriptions] of seriesByAsin) {
    if (await progress?.isCancelled()) {
      stats.cancelled = true;
      log.warn(`Watched lists cancelled by admin after ${seriesIndex} of ${seriesByAsin.size} series`);
      return;
    }
    await progress?.update(seriesIndex++, { detail: subscriptions[0].seriesTitle });
    try {
      await processSeriesForUsers(seriesAsin, subscriptions, log, stats);
    } catch (error) {
      stats.errors++;
      log.error(`Failed to process watched series ${seriesAsin}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Rate limit between series
    await delay(SCRAPE_DELAY_MS);
  }
}

async function processSeriesForUsers(
  seriesAsin: string,
  subscriptions: Array<{
    id: string;
    seriesTitle: string;
    allowAlternateVersions?: boolean;
    user: { id: string; plexUsername: string };
  }>,
  log: ReturnType<typeof RMABLogger.forJob> | ReturnType<typeof RMABLogger.create>,
  stats: WatchedListsSyncStats
): Promise<void> {
  const title = subscriptions[0].seriesTitle;
  log.info(`Scraping watched series: "${title}" (${seriesAsin})`);

  // Scrape all pages of the series (up to MAX_BOOKS_PER_SERIES)
  const allBooks: AudibleAudiobook[] = [];
  let page = 1;
  let hasMore = true;

  while (hasMore && allBooks.length < MAX_BOOKS_PER_SERIES) {
    const result = await scrapeSeriesPage(seriesAsin, page);
    if (!result || result.books.length === 0) break;

    allBooks.push(...result.books);
    hasMore = result.hasMore;
    page++;

    if (hasMore) await delay(1000);
  }

  if (allBooks.length === 0) {
    log.info(`No books found for series "${title}"`);
    stats.seriesChecked++;
    return;
  }

  stats.booksFound += allBooks.length;

  // Deduplicate
  const { books: dedupedBooks, groups } = deduplicateAndCollectGroups(allBooks);

  // Persist dedup groups (fire-and-forget)
  if (groups.length > 0) {
    persistDedupGroups(groups).catch(() => {});
  }

  // Refresh the upcoming-releases list for this series (best-effort)
  await syncUpcomingReleases('series', seriesAsin, dedupedBooks, { seriesTitle: title }).catch(error =>
    log.warn(`Failed to update upcoming releases for series ${seriesAsin}: ${error instanceof Error ? error.message : String(error)}`));

  // For each user watching this series, create requests for new books
  for (const subscription of subscriptions) {
    await createRequestsForUser(
      subscription.user.id,
      subscription.user.plexUsername,
      dedupedBooks,
      log,
      stats,
      { allowAlternateVersions: subscription.allowAlternateVersions === true }
    );

    // Update lastCheckedAt
    await prisma.watchedSeries.update({
      where: { id: subscription.id },
      data: { lastCheckedAt: new Date() },
    }).catch(() => {});
  }

  stats.seriesChecked++;
}

// ---------------------------------------------------------------------------
// Watched Authors
// ---------------------------------------------------------------------------

async function processAllWatchedAuthors(
  log: ReturnType<typeof RMABLogger.forJob> | ReturnType<typeof RMABLogger.create>,
  stats: WatchedListsSyncStats,
  options: WatchedListsSyncOptions,
  progress?: JobProgressReporter
): Promise<void> {
  const whereClause: any = {};
  if (options.userId) whereClause.userId = options.userId;
  if (options.authorAsin) whereClause.authorAsin = options.authorAsin;
  const watchedAuthors = await prisma.watchedAuthor.findMany({
    where: whereClause,
    include: { user: { select: { id: true, plexUsername: true } } },
  });

  if (watchedAuthors.length === 0) {
    log.info('No watched authors to process');
    return;
  }

  // Group by authorAsin to avoid re-scraping the same author for multiple users
  const authorsByAsin = new Map<string, typeof watchedAuthors>();
  for (const wa of watchedAuthors) {
    const list = authorsByAsin.get(wa.authorAsin) || [];
    list.push(wa);
    authorsByAsin.set(wa.authorAsin, list);
  }

  log.info(`Processing ${authorsByAsin.size} unique watched authors (${watchedAuthors.length} total subscriptions)`);

  await progress?.update(0, { total: authorsByAsin.size, label: 'Watched lists — authors', force: true });
  let authorIndex = 0;
  for (const [authorAsin, subscriptions] of authorsByAsin) {
    if (await progress?.isCancelled()) {
      stats.cancelled = true;
      log.warn(`Watched lists cancelled by admin after ${authorIndex} of ${authorsByAsin.size} authors`);
      return;
    }
    await progress?.update(authorIndex++, { detail: subscriptions[0].authorName });
    try {
      await processAuthorForUsers(authorAsin, subscriptions, log, stats);
    } catch (error) {
      stats.errors++;
      log.error(`Failed to process watched author ${authorAsin}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Rate limit between authors
    await delay(SCRAPE_DELAY_MS);
  }
}

async function processAuthorForUsers(
  authorAsin: string,
  subscriptions: Array<{ id: string; authorName: string; user: { id: string; plexUsername: string } }>,
  log: ReturnType<typeof RMABLogger.forJob> | ReturnType<typeof RMABLogger.create>,
  stats: WatchedListsSyncStats
): Promise<void> {
  const authorName = subscriptions[0].authorName;
  log.info(`Scraping watched author: "${authorName}" (${authorAsin})`);

  const audibleService = getAudibleService();
  const allBooks: AudibleAudiobook[] = [];
  let page = 1;
  let hasMore = true;

  while (hasMore && page <= MAX_AUTHOR_PAGES) {
    try {
      const result = await audibleService.searchByAuthorAsin(authorName, authorAsin, page);
      if (result.books.length === 0) break;

      allBooks.push(...result.books);
      hasMore = result.hasMore;
      page++;

      if (hasMore) await delay(1000);
    } catch (error) {
      log.error(`Failed to scrape author page ${page} for "${authorName}"`, {
        error: error instanceof Error ? error.message : String(error),
      });
      break;
    }
  }

  if (allBooks.length === 0) {
    log.info(`No books found for author "${authorName}"`);
    stats.authorsChecked++;
    return;
  }

  stats.booksFound += allBooks.length;

  // Deduplicate
  const { books: dedupedBooks, groups } = deduplicateAndCollectGroups(allBooks);

  // Persist dedup groups (fire-and-forget)
  if (groups.length > 0) {
    persistDedupGroups(groups).catch(() => {});
  }

  // Refresh the upcoming-releases list for this author (best-effort)
  await syncUpcomingReleases('author', authorAsin, dedupedBooks).catch(error =>
    log.warn(`Failed to update upcoming releases for author ${authorAsin}: ${error instanceof Error ? error.message : String(error)}`));

  // For each user watching this author, create requests for new books.
  // Alternate versions are a per-series opt-in, so authors always pull one version.
  for (const subscription of subscriptions) {
    await createRequestsForUser(
      subscription.user.id,
      subscription.user.plexUsername,
      dedupedBooks,
      log,
      stats,
      { allowAlternateVersions: false }
    );

    // Update lastCheckedAt
    await prisma.watchedAuthor.update({
      where: { id: subscription.id },
      data: { lastCheckedAt: new Date() },
    }).catch(() => {});
  }

  stats.authorsChecked++;
}

// ---------------------------------------------------------------------------
// Shared: Create requests for a user from a list of books
// ---------------------------------------------------------------------------

async function createRequestsForUser(
  userId: string,
  username: string,
  books: AudibleAudiobook[],
  log: ReturnType<typeof RMABLogger.forJob> | ReturnType<typeof RMABLogger.create>,
  stats: WatchedListsSyncStats,
  { allowAlternateVersions }: { allowAlternateVersions: boolean }
): Promise<void> {
  // Filter to books that have an ASIN
  const booksWithAsin = books.filter(b => b.asin);
  if (booksWithAsin.length === 0) return;

  const asins = booksWithAsin.map(b => b.asin);
  const [ownedAsins, ownedWorkKeys, requestedAsins] = await Promise.all([
    getOwnedAsins(asins), // direct + sibling expansion
    getOwnedWorkKeys(booksWithAsin),
    getRequestedAsins(asins),
  ]);

  // One version per book unless the series opted into alternate versions
  const plan = planVersionRequests(booksWithAsin, {
    ownedAsins,
    ownedWorkKeys,
    requestedAsins,
    allowAlternateVersions,
  });

  for (const item of plan) {
    const { book } = item;

    if (item.action === 'skip_owned') {
      stats.skippedOwned++;
      continue;
    }
    if (item.action === 'skip_requested') {
      stats.skippedExisting++;
      continue;
    }
    if (item.action === 'skip_duplicate_version') {
      stats.skippedDuplicateVersion++;
      log.info(`Skipped "${book.title}" (${book.asin}) — another version of this book is already on the server, requested, or preferred`);
      continue;
    }

    // Pre-orders are listed as upcoming and requested on/after release day. Held here
    // (not before planning) so a future standard version still outranks a released
    // dramatization in the version planner.
    if (isUpcoming(book) || isPlaceholderListing(book)) {
      stats.skippedUpcoming++;
      log.info(`Holding "${book.title}" (${book.asin}) until its release date ${book.releaseDate}`);
      continue;
    }

    const isAlternate = item.action === 'request_alternate';
    const input = {
      asin: book.asin,
      title: book.title,
      author: book.author,
      narrator: book.narrator,
      description: book.description,
      coverArtUrl: book.coverArtUrl,
    };
    try {
      const result = isAlternate
        ? await createRequestForUser(userId, input, { forceApproval: true, versionLabel: item.versionLabel })
        : await createRequestForUser(userId, input);

      if (!result.success) {
        // already_available, being_processed, duplicate — all expected
        stats.skippedExisting++;
      } else if (isAlternate) {
        stats.alternateVersionsQueued++;
        log.info(
          `Queued alternate version "${book.title}"${item.versionLabel ? ` (${item.versionLabel})` : ''} ` +
          `by ${book.author} for ${username}, pending admin approval`
        );
      } else {
        stats.requestsCreated++;
        log.info(`Auto-requested "${book.title}" by ${book.author} for ${username}`);
      }
    } catch (error) {
      log.error(`Failed to create request for "${book.title}" for ${username}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Get the set of ASINs that are already in the library (direct match + sibling expansion).
 */
async function getOwnedAsins(asins: string[]): Promise<Set<string>> {
  const owned = new Set<string>();

  // Direct library lookup
  const libraryItems = await prisma.plexLibrary.findMany({
    where: { asin: { in: asins } },
    select: { asin: true },
  });
  for (const item of libraryItems) {
    if (item.asin) owned.add(item.asin);
  }

  // Sibling expansion via works table
  try {
    const siblingMap = await getSiblingAsins(asins);
    if (siblingMap.size > 0) {
      const allSiblings = new Set<string>();
      for (const siblings of siblingMap.values()) {
        for (const s of siblings) allSiblings.add(s);
      }

      if (allSiblings.size > 0) {
        const siblingLibrary = await prisma.plexLibrary.findMany({
          where: { asin: { in: [...allSiblings] } },
          select: { asin: true },
        });

        for (const item of siblingLibrary) {
          if (item.asin) {
            // Mark the original ASIN as owned (not the sibling)
            for (const [originalAsin, siblings] of siblingMap) {
              if (siblings.includes(item.asin)) {
                owned.add(originalAsin);
              }
            }
          }
        }
      }
    }
  } catch {
    // Works table expansion is best-effort
  }

  return owned;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
