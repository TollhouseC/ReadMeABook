/**
 * Component: Pack Sources
 * Documentation: documentation/features/series-packs.md
 *
 * Inputs for a pack search: the series' book list from Audible (the only books a
 * pack may be matched against) and pack search results from Prowlarr.
 */

import { RMABLogger } from '@/lib/utils/logger';
import { getConfigService } from '@/lib/services/config.service';
import { getProwlarrService } from '@/lib/integrations/prowlarr.service';
import { scrapeSeriesPage } from '@/lib/integrations/audible-series';
import type { AudibleAudiobook } from '@/lib/integrations/audible.service';
import { groupIndexersByCategories } from '@/lib/utils/indexer-grouping';
import { deduplicateAndCollectGroups } from '@/lib/utils/deduplicate-audiobooks';
import { groupByWork, pickPreferredVersion } from '@/lib/utils/book-versions';
import type { PackSeriesBook } from '@/lib/utils/pack-matcher';
import type { TorrentResult } from '@/lib/utils/ranking-algorithm';

type Logger = ReturnType<typeof RMABLogger.forJob> | ReturnType<typeof RMABLogger.create>;

const MAX_SERIES_PAGES = 4;

export interface SeriesUniverse {
  books: PackSeriesBook[];
  /** Full listing entry per book (for creating fill-out requests) */
  details: Map<string, AudibleAudiobook>;
}

/** Series name without scaffolding words, for search queries ("The Mistborn Saga" → "Mistborn"). */
export function coreSeriesName(series: string): string {
  const core = series.replace(/\b(the|saga|series|trilogy|cycle|chronicles)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  return core || series;
}

/**
 * The series' books from Audible, one entry per work (all versions of a book collapse
 * to one, preferring the triggering ASIN for its own work). Always includes the
 * triggering book; without a series ASIN it's the only book.
 */
export async function buildSeriesUniverse(
  audiobook: { title: string; seriesAsin: string | null; seriesPart: string | null },
  triggeringKey: string,
  logger: Logger
): Promise<SeriesUniverse> {
  const listing: AudibleAudiobook[] = [];
  if (audiobook.seriesAsin) {
    for (let page = 1; page <= MAX_SERIES_PAGES; page++) {
      const detail = await scrapeSeriesPage(audiobook.seriesAsin, page);
      if (!detail || detail.books.length === 0) break;
      listing.push(...detail.books);
      if (!detail.hasMore) break;
    }
  }

  const books: PackSeriesBook[] = [];
  const details = new Map<string, AudibleAudiobook>();

  const { books: deduped } = deduplicateAndCollectGroups(listing);
  for (const versions of groupByWork(deduped).values()) {
    const representative = versions.find(v => v.asin === triggeringKey) ?? pickPreferredVersion(versions);
    const position = representative.seriesPart ?? versions.find(v => v.seriesPart)?.seriesPart;
    books.push({ asin: representative.asin, title: representative.title, position });
    details.set(representative.asin, representative);
  }

  if (!books.some(b => b.asin === triggeringKey)) {
    books.push({ asin: triggeringKey, title: audiobook.title, position: audiobook.seriesPart ?? undefined });
  }

  logger.info(`Series universe: ${books.length} book(s)${audiobook.seriesAsin ? '' : ' (no series ASIN — triggering book only)'}`);
  return { books, details };
}

/**
 * Search Prowlarr for series packs (series name ± author surname) and, optionally,
 * author collections (author name). Results are de-duplicated by guid.
 */
export async function searchPackResults(
  seriesName: string,
  author: string,
  includeAuthorPacks: boolean,
  logger: Logger
): Promise<TorrentResult[]> {
  const configService = getConfigService();
  const indexersConfigStr = await configService.get('prowlarr_indexers');
  const indexersConfig = indexersConfigStr ? JSON.parse(indexersConfigStr) : [];
  if (indexersConfig.length === 0) return [];

  const { groups } = groupIndexersByCategories(indexersConfig);
  const core = coreSeriesName(seriesName);
  const surname = author.split(/\s+/).pop() || author;
  const queries = [...new Set([`${core} ${surname}`, core, seriesName])];
  if (includeAuthorPacks) queries.push(author);

  logger.info(`Pack search queries: ${queries.map(q => `"${q}"`).join(', ')}`);

  const prowlarr = await getProwlarrService();
  const byGuid = new Map<string, TorrentResult>();
  for (const query of queries) {
    for (const group of groups) {
      try {
        const results = await prowlarr.search(query, {
          categories: group.categories,
          indexerIds: group.indexerIds,
          minSeeders: 1,
          maxResults: 100,
        });
        for (const r of results) if (!byGuid.has(r.guid)) byGuid.set(r.guid, r);
      } catch (error) {
        logger.warn(`Pack search query "${query}" failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return [...byGuid.values()];
}
