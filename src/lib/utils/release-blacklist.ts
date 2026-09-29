/**
 * Component: Release Blacklist Utility
 * Documentation: documentation/backend/services/scheduler.md
 *
 * Records releases that should never be auto-selected again for a book (e.g. a
 * torrent that stalled for 24h) and filters them out of search results before
 * ranking. Blacklist entries are scoped to the audiobook, not the request, so they
 * survive a re-request (which deletes the old request and its download history).
 */

import { prisma } from '../db';
import type { TorrentResult } from './ranking-algorithm';

export interface BlacklistReleaseInput {
  audiobookId: string;
  title: string;
  indexerName?: string | null;
  infoHash?: string | null;
  releaseUrl?: string | null;
  sizeBytes?: bigint | number | null;
  reason: string;
}

interface BlacklistEntry {
  title: string;
  indexerName: string | null;
  infoHash: string | null;
  releaseUrl: string | null;
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Add a release to a book's blacklist.
 */
export async function blacklistRelease(input: BlacklistReleaseInput): Promise<void> {
  await prisma.blacklistedRelease.create({
    data: {
      audiobookId: input.audiobookId,
      title: input.title,
      indexerName: input.indexerName || null,
      infoHash: input.infoHash ? input.infoHash.toLowerCase() : null,
      releaseUrl: input.releaseUrl || null,
      sizeBytes: input.sizeBytes != null ? BigInt(input.sizeBytes) : null,
      reason: input.reason,
    },
  });
}

/**
 * True if a search result matches a blacklist entry. Matches on (any of):
 * - info hash (when both sides have one)
 * - indexer page URL / guid
 * - release title + indexer (title alone when the entry has no indexer)
 */
export function isResultBlacklisted(result: TorrentResult, entries: BlacklistEntry[]): boolean {
  const resultHash = result.infoHash?.toLowerCase();
  const resultTitle = normalizeTitle(result.title || '');
  const resultIndexer = (result.indexer || '').toLowerCase();

  return entries.some(entry => {
    if (entry.infoHash && resultHash && entry.infoHash === resultHash) return true;

    if (entry.releaseUrl && (entry.releaseUrl === result.infoUrl || entry.releaseUrl === result.guid)) {
      return true;
    }

    if (resultTitle && normalizeTitle(entry.title) === resultTitle) {
      if (!entry.indexerName || !resultIndexer) return true;
      return entry.indexerName.toLowerCase() === resultIndexer;
    }

    return false;
  });
}

/**
 * Remove blacklisted releases for a book from a list of search results.
 * Returns the kept results and how many were removed.
 */
export async function filterBlacklistedResults<T extends TorrentResult>(
  audiobookId: string | undefined,
  results: T[]
): Promise<{ results: T[]; removed: number }> {
  if (!audiobookId || results.length === 0) return { results, removed: 0 };

  const entries = await prisma.blacklistedRelease.findMany({
    where: { audiobookId },
    select: { title: true, indexerName: true, infoHash: true, releaseUrl: true },
  });
  if (!entries || entries.length === 0) return { results, removed: 0 };

  const kept = results.filter(result => !isResultBlacklisted(result, entries));
  return { results: kept, removed: results.length - kept.length };
}
