/**
 * Component: Series / Author Pack Search Service
 * Documentation: documentation/features/series-packs.md
 *
 * When a series book has been searching for 24h+ with no usable individual release,
 * look for multi-book packs (whole series, or an author collection), verify a pack's
 * real file list contains the book, then download only the requested series' books
 * from it and import each one. Other stuck requests for the same series are linked to
 * the same download, and missing series books are filled out (auto-approved users).
 */

import { prisma } from '@/lib/db';
import { RMABLogger } from '@/lib/utils/logger';
import { getConfigService } from '@/lib/services/config.service';
import { getDownloadClientManager } from '@/lib/services/download-client-manager.service';
import { getJobQueueService } from '@/lib/services/job-queue.service';
import { filterBlacklistedResults, blacklistRelease } from '@/lib/utils/release-blacklist';
import { getRequiredReleaseLanguage } from '@/lib/utils/release-language';
import { rankPackResults, type PackCandidate, type PackType } from '@/lib/utils/pack-ranking';
import { matchPackFiles, type PackMatchResult } from '@/lib/utils/pack-matcher';
import { planLinks, wantedFileIndexes } from '@/lib/services/pack-links.service';
import { buildSeriesUniverse, searchPackResults, type SeriesUniverse } from '@/lib/services/pack-sources';
import { isPackSearchDue } from '@/lib/utils/pack-search-due';

type Logger = ReturnType<typeof RMABLogger.forJob> | ReturnType<typeof RMABLogger.create>;

const MAX_SERIES_CANDIDATES = 3;
const MAX_AUTHOR_CANDIDATES = 2;

export type AuthorPackMode = 'disabled' | 'log_only' | 'enabled';

export interface PackSearchOptions {
  pollIntervalMs?: number;
  metadataTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface PackSearchResult {
  status: 'disabled' | 'skipped' | 'no_pack' | 'grabbed';
  reason?: string;
  packTitle?: string;
  packType?: PackType;
  importedBooks?: string[];
}

/** Minimal qBittorrent surface used here (duck-typed so tests can supply a fake). */
interface PackTorrentClient {
  clientType: string;
  addTorrent(url: string, options: { category?: string; tags?: string[]; stopCondition?: 'MetadataReceived' }): Promise<string>;
  getFiles(hash: string): Promise<Array<{ name: string; size: number; index: number }>>;
  setFilePriority(hash: string, fileIndexes: number[], priority: 0 | 1): Promise<void>;
  resumeTorrent(hash: string): Promise<void>;
  deleteTorrent(hash: string, deleteFiles?: boolean): Promise<void>;
}

function isPackTorrentClient(client: any): client is PackTorrentClient {
  return !!client && client.clientType === 'qbittorrent' &&
    ['addTorrent', 'getFiles', 'setFilePriority', 'resumeTorrent', 'deleteTorrent'].every(m => typeof client[m] === 'function');
}

function primaryAuthor(author: string): string {
  return (author || '').split(/,|&|\band\b/i)[0].trim();
}

// ---------------------------------------------------------------------------
// Candidate inspection (real file list, before downloading anything)
// ---------------------------------------------------------------------------

interface Inspection {
  accepted: boolean;
  reason: string;
  hash?: string;
  files?: Array<{ name: string; size: number; index: number }>;
  match?: PackMatchResult;
}

function summarizeMatches(match: PackMatchResult): string {
  return match.matches
    .map(m => `${m.position ? `#${m.position} ` : ''}"${m.title}" (${m.matchedBy}, ${m.files.length} file(s))`)
    .join(', ') || 'none';
}

async function inspectCandidate(
  qbit: PackTorrentClient,
  candidate: PackCandidate,
  universe: SeriesUniverse,
  ctx: { triggeringKey: string; audiobookId: string; seriesName: string; category: string; authorMode: AuthorPackMode },
  logger: Logger,
  timing: Required<PackSearchOptions>
): Promise<Inspection> {
  const { result, packType } = candidate;

  let hash: string;
  try {
    hash = await qbit.addTorrent(result.downloadUrl, {
      category: ctx.category,
      tags: ['audiobook', 'pack'],
      stopCondition: 'MetadataReceived', // fetch file list, then stop before downloading data
    });
  } catch (error) {
    return { accepted: false, reason: `add failed: ${error instanceof Error ? error.message : String(error)}` };
  }

  // Never touch a torrent something else is already using
  const inUse = await prisma.downloadHistory.findFirst({
    where: { downloadClientId: hash, downloadStatus: { in: ['queued', 'downloading', 'completed', 'seeding'] } },
    select: { id: true },
  });
  if (inUse) return { accepted: false, reason: 'torrent already in use by another download' };

  const remove = async () => {
    try { await qbit.deleteTorrent(hash, true); } catch { /* best effort */ }
  };
  const reject = async (reason: string, blacklist: boolean): Promise<Inspection> => {
    await remove();
    if (blacklist) {
      await blacklistRelease({
        audiobookId: ctx.audiobookId,
        title: result.title,
        indexerName: result.indexer,
        infoHash: result.infoHash || hash,
        releaseUrl: result.infoUrl || result.guid,
        sizeBytes: result.size,
        reason,
      });
    }
    return { accepted: false, reason };
  };

  // Wait for metadata (the file list) — magnets need peers to provide it
  let files: Array<{ name: string; size: number; index: number }> = [];
  const deadline = Date.now() + timing.metadataTimeoutMs;
  while (true) {
    try { files = await qbit.getFiles(hash); } catch { files = []; }
    if (files.length > 0 || Date.now() >= deadline) break;
    await timing.sleep(timing.pollIntervalMs);
  }
  if (files.length === 0) return reject('pack_no_metadata', true);

  const match = matchPackFiles(files, universe.books, { mode: packType, seriesName: ctx.seriesName });
  const containsBook = match.matches.some(m => m.asin === ctx.triggeringKey);
  logger.info(`Inspected ${packType} pack "${result.title}": ${files.length} file(s); matched ${summarizeMatches(match)}`);

  if (!containsBook) return reject('pack_missing_book', true);

  if (packType === 'author' && ctx.authorMode === 'log_only') {
    logger.info(`[author packs: log-only] Would grab "${result.title}" and import: ${summarizeMatches(match)}`);
    return reject('author_pack_log_only', false);
  }

  return { accepted: true, reason: 'contains book', hash, files, match };
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function runPackSearch(
  requestId: string,
  logger: Logger,
  options: PackSearchOptions = {}
): Promise<PackSearchResult> {
  const timing: Required<PackSearchOptions> = {
    pollIntervalMs: options.pollIntervalMs ?? 5000,
    metadataTimeoutMs: options.metadataTimeoutMs ?? 120_000,
    sleep: options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))),
  };

  const configService = getConfigService();
  if ((await configService.get('pack_search_enabled')) === 'false') {
    return { status: 'disabled' };
  }
  const modeSetting = await configService.get('pack_search_author_mode');
  const authorMode: AuthorPackMode =
    modeSetting === 'enabled' || modeSetting === 'disabled' ? modeSetting : 'log_only';

  const request = await prisma.request.findUnique({
    where: { id: requestId },
    include: {
      audiobook: true,
      user: { select: { id: true, role: true, autoApproveRequests: true, plexUsername: true } },
    },
  });
  if (!request || request.deletedAt || request.type !== 'audiobook') return { status: 'skipped', reason: 'not an active audiobook request' };
  if (request.status !== 'awaiting_search') return { status: 'skipped', reason: `status is ${request.status}` };
  if (!isPackSearchDue(request)) return { status: 'skipped', reason: 'not due' };

  const audiobook = request.audiobook;
  await prisma.request.update({ where: { id: requestId }, data: { lastPackSearchAt: new Date() } });

  if (!audiobook.series) return { status: 'skipped', reason: 'book is not in a series' };

  const manager = getDownloadClientManager(configService);
  const client = await manager.getClientServiceForProtocol('torrent');
  if (!isPackTorrentClient(client)) {
    return { status: 'skipped', reason: 'pack downloads need qBittorrent (file lists + partial download)' };
  }
  const clientConfig = await manager.getClientForProtocol('torrent');
  const category = clientConfig?.category || 'readmeabook';

  const triggeringKey = audiobook.audibleAsin || audiobook.id;
  const author = primaryAuthor(audiobook.author);
  logger.info(`Pack search for "${audiobook.title}" — series "${audiobook.series}" by ${author} (author packs: ${authorMode})`);

  const universe = await buildSeriesUniverse(audiobook, triggeringKey, logger);
  const rawResults = await searchPackResults(audiobook.series, author, authorMode !== 'disabled', logger);
  const { results } = await filterBlacklistedResults(audiobook.id, rawResults);

  let bookDurationMinutes: number | undefined;
  if (audiobook.audibleAsin) {
    try {
      const { getAudibleService } = await import('@/lib/integrations/audible.service');
      bookDurationMinutes = (await getAudibleService().getRuntime(audiobook.audibleAsin)) || undefined;
    } catch { /* size heuristic is optional */ }
  }

  const requiredLanguage = await getRequiredReleaseLanguage();
  const ranked = rankPackResults(results, { seriesName: audiobook.series, author, bookDurationMinutes, requiredLanguage });
  const candidates = [
    ...ranked.filter(c => c.packType === 'series').slice(0, MAX_SERIES_CANDIDATES),
    ...(authorMode === 'disabled' ? [] : ranked.filter(c => c.packType === 'author').slice(0, MAX_AUTHOR_CANDIDATES)),
  ];
  logger.info(`Pack candidates: ${candidates.length} of ${results.length} result(s)` +
    (candidates.length ? ` — ${candidates.map(c => `[${c.packType}] "${c.result.title}" (${c.reasons.join(', ')})`).join('; ')}` : ''));

  for (const candidate of candidates) {
    const inspection = await inspectCandidate(
      client,
      candidate,
      universe,
      { triggeringKey, audiobookId: audiobook.id, seriesName: audiobook.series, category, authorMode },
      logger,
      timing
    );
    if (!inspection.accepted) {
      logger.info(`Pack rejected: "${candidate.result.title}" — ${inspection.reason}`);
      continue;
    }

    const hash = inspection.hash!;
    const links = await planLinks(requestId, triggeringKey, request.user, inspection.match!, universe, logger);

    // Download only the linked books' files
    const wanted = wantedFileIndexes(inspection.files!, links);
    const unwanted = inspection.files!.map(f => f.index).filter(i => !wanted.has(i));
    try {
      await client.setFilePriority(hash, unwanted, 0);
      await client.setFilePriority(hash, [...wanted], 1);
    } catch (error) {
      logger.warn(`Could not set file priorities (downloading full pack): ${error instanceof Error ? error.message : String(error)}`);
    }

    // Record one DownloadHistory per linked request, all sharing the torrent
    let primaryHistoryId: string | null = null;
    for (const link of links) {
      await prisma.downloadHistory.updateMany({ where: { requestId: link.requestId, selected: true }, data: { selected: false } });
      const history = await prisma.downloadHistory.create({
        data: {
          requestId: link.requestId,
          indexerName: candidate.result.indexer,
          indexerId: candidate.result.indexerId,
          torrentName: candidate.result.title,
          torrentHash: hash,
          torrentSizeBytes: candidate.result.size,
          torrentUrl: candidate.result.infoUrl || candidate.result.guid,
          magnetLink: candidate.result.downloadUrl,
          seeders: candidate.result.seeders || 0,
          leechers: candidate.result.leechers || 0,
          downloadClient: 'qbittorrent',
          downloadClientId: hash,
          downloadStatus: 'downloading',
          selected: true,
          startedAt: new Date(),
          packFiles: link.match.relativePaths,
          packType: candidate.packType,
        },
      });
      if (link.origin === 'triggering') primaryHistoryId = history.id;

      await prisma.request.update({
        where: { id: link.requestId },
        data: { status: 'downloading', progress: 0, errorMessage: null, updatedAt: new Date() },
      });
    }

    await client.resumeTorrent(hash);

    // One monitor for the shared torrent; completion fans out to every linked request
    await getJobQueueService().addMonitorJob(requestId, primaryHistoryId!, hash, 'qbittorrent', 3);

    const counts = { triggering: 0, linked: 0, filled: 0 };
    for (const link of links) counts[link.origin]++;
    logger.info(
      `Grabbed ${candidate.packType} pack "${candidate.result.title}": importing ${links.length} book(s) ` +
      `(${counts.linked} linked request(s), ${counts.filled} filled out); ` +
      `downloading ${wanted.size}/${inspection.files!.length} file(s)`
    );

    return {
      status: 'grabbed',
      packTitle: candidate.result.title,
      packType: candidate.packType,
      importedBooks: links.map(l => l.match.title),
    };
  }

  return { status: 'no_pack', reason: candidates.length ? 'no candidate contained the book' : 'no pack candidates' };
}
