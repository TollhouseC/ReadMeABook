/**
 * Component: Fix Chapters Processor
 * Documentation: documentation/features/chapter-merging.md
 *
 * Replaces single-file books' chapters with Audnexus's when Audnexus is clearly better.
 * - Per book (requestId): always applies.
 * - Library-wide (no requestId): `report` lists what would change, `apply` changes it.
 *   Covers books ReadMeABook imported plus, on Audiobookshelf, every library item with an
 *   ASIN whose path translates to one inside media_dir (see abs-path-mapper.ts).
 *   Unplayable files are reported as corrupt. ~1 Audnexus lookup per second.
 */

import fs from 'fs/promises';
import path from 'path';
import { prisma } from '../db';
import { RMABLogger } from '../utils/logger';
import { createJobProgress, CANCELLED_RESULT } from '../utils/job-progress';
import { isAudiobookshelfBackend, syncFileChaptersToABS } from '../services/abs-chapter-sync';
import { getConfigService } from '../services/config.service';
import type { FixChaptersPayload } from '../services/job-queue.service';
import { AUDIO_EXTENSIONS } from '../constants/audio-formats';
import { fixChaptersIfBetter, findSingleAudioFile, type ChapterFixStatus } from '../utils/chapter-fixer';
import { resolveBookFolder, triggerLibraryScan, type BookRecord } from '../utils/library-book-files';
import { localPathCandidates, mountMappingsFromRelPaths, resolveLocalPath } from '../utils/abs-path-mapper';

const LOOKUP_DELAY_MS = 1000;

/** A book to check: a folder (expects one audio file) or, for root-level ABS items, the file itself. */
export interface Candidate {
  title: string;
  asin: string;
  folder?: string;
  file?: string;
  /** Audiobookshelf item, when known — its chapter list is kept in sync with the file */
  absItemId?: string;
  /** Chapter count Audiobookshelf shows (from the library listing), when available */
  absChapterCount?: number;
  /** ReadMeABook audiobook record, when imported by ReadMeABook */
  audiobookId?: string;
  /** Tag/naming metadata (used by the library merge job) */
  author?: string;
  narrator?: string;
  series?: string;
  seriesPart?: string;
  year?: number;
}

/** "Mistborn #2, Cosmere #5" → first series name + position */
function parseAbsSeries(seriesName?: string): { series?: string; seriesPart?: string } {
  const first = (seriesName || '').split(',')[0].trim();
  if (!first) return {};
  const match = first.match(/^(.*?)\s*#\s*([\d.]+)\s*$/);
  return match ? { series: match[1].trim(), seriesPart: match[2] } : { series: first };
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function getMediaDir(): Promise<string> {
  return (await getConfigService().get('media_dir')) || process.env.MEDIA_DIR || '/media/audiobooks';
}

async function processSingleBook(requestId: string, logger: RMABLogger, jobId?: string) {
  // Short (seconds): step labels only, not cancellable
  const progress = createJobProgress(jobId, 'Fixing chapters — finding the book');
  await progress.update(0, { force: true });
  const request = await prisma.request.findFirst({
    where: { id: requestId, deletedAt: null },
    include: { audiobook: true },
  });
  if (!request?.audiobook) throw new Error(`Request ${requestId} not found`);
  const book = request.audiobook as BookRecord;
  if (!book.audibleAsin) throw new Error(`"${book.title}" has no ASIN — can't look up Audnexus chapters`);

  const folder = await resolveBookFolder(book, await getMediaDir(), logger);
  if (!folder) throw new Error(`Could not find the library folder for "${book.title}"`);

  const { file, reason } = await findSingleAudioFile(folder, AUDIO_EXTENSIONS);
  if (!file) throw new Error(`Can't fix chapters for "${book.title}": ${reason}`);

  await progress.update(0, { label: 'Fixing chapters — checking Audnexus', detail: book.title, force: true });
  const result = await fixChaptersIfBetter(file, book.audibleAsin, { apply: true, logger });
  await progress.finish(result.status);
  await logger.info(`"${book.title}": ${result.status} — ${result.reason} (current ${result.currentCount}, Audnexus ${result.audnexusCount})`);
  if (result.status === 'failed') throw new Error(result.reason);
  if (result.status === 'corrupt') throw new Error(`"${book.title}" is unplayable (${result.reason}) — re-download it`);
  if (result.status === 'fixed') {
    // ABS keeps its own chapter list (metadata.json wins on rescan) — update it directly
    if (book.absItemId && (await isAudiobookshelfBackend())) await syncFileChaptersToABS(book.absItemId, file, logger);
    await triggerLibraryScan(logger);
  }
  return { success: true, ...result };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Audiobookshelf library items as candidates, with ABS paths translated to local paths. */
async function collectAudiobookshelfCandidates(
  mediaDir: string,
  importedPairs: Array<{ absItemId: string; localPath: string }>,
  add: (candidate: Candidate) => void,
  logger: RMABLogger
): Promise<void> {
  const libraryId = await getConfigService().get('audiobookshelf.library_id');
  if (!libraryId) {
    await logger.warn('Audiobookshelf library ID not configured — only ReadMeABook imports checked');
    return;
  }

  const { getABSLibraryItems } = await import('../services/audiobookshelf/api');
  const items: any[] = (await getABSLibraryItems(libraryId)) || [];

  // ASINs ReadMeABook already knows (scan cache), in case ABS metadata lacks one
  const cached = await prisma.plexLibrary.findMany({ where: { asin: { not: null } }, select: { plexGuid: true, asin: true } });
  const cachedAsin = new Map(cached.map(row => [row.plexGuid, row.asin as string]));

  // Learn ABS→local mount prefixes from books whose both paths are known
  const itemsById = new Map(items.map(item => [item.id, item]));
  const mappings = mountMappingsFromRelPaths(importedPairs
    .map(pair => {
      const item = itemsById.get(pair.absItemId);
      return { absPath: item?.path as string, relPath: item?.relPath as string | undefined, localPath: pair.localPath };
    })
    .filter(pair => !!pair.absPath));

  let noAsin = 0;
  let unreachable = 0;
  let example: string | null = null;
  for (const item of items) {
    const asin = item.media?.metadata?.asin || cachedAsin.get(item.id);
    if (!asin) {
      noAsin++;
      continue;
    }
    const local = await resolveLocalPath({ path: item.path, relPath: item.relPath }, mediaDir, mappings, pathExists);
    if (!local) {
      unreachable++;
      if (!example) {
        const tried = localPathCandidates({ path: item.path, relPath: item.relPath }, mediaDir, mappings);
        example = `"${item.path}"${tried.length ? ` (tried ${tried.map(t => `"${t}"`).join(', ')})` : ''}`;
      }
      continue;
    }
    const title = item.media?.metadata?.title || path.basename(local);
    const absChapterCount = typeof item.media?.numChapters === 'number' ? item.media.numChapters : undefined;
    const metadata = item.media?.metadata ?? {};
    const year = parseInt(metadata.publishedYear, 10);
    const details = {
      title, asin, absItemId: item.id, absChapterCount,
      author: metadata.authorName || undefined,
      narrator: metadata.narratorName || undefined,
      year: Number.isFinite(year) ? year : undefined,
      ...parseAbsSeries(metadata.seriesName),
    };
    add(item.isFile ? { ...details, file: local } : { ...details, folder: local });
  }

  await logger.info(
    `Audiobookshelf: ${items.length} item(s) — ${noAsin} without an ASIN (no chapter lookup possible), ` +
    `${unreachable} not reachable inside ${mediaDir}` +
    (mappings.length ? `; path mapping ${mappings.map(m => `${m.from} → ${m.to}`).join(', ')}` : '')
  );
  if (example) await logger.info(`Example unreachable item: ${example}`);
}

export async function collectCandidates(mediaDir: string, logger: RMABLogger): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  const byKey = new Map<string, Candidate>();
  const add = (candidate: Candidate) => {
    const key = path.resolve(candidate.file ?? candidate.folder!);
    const existing = byKey.get(key);
    if (existing) {
      // Same book seen as an import and as an ABS item — keep the ABS details
      existing.absItemId ??= candidate.absItemId;
      existing.absChapterCount ??= candidate.absChapterCount;
      existing.series ??= candidate.series;
      existing.seriesPart ??= candidate.seriesPart;
      return;
    }
    byKey.set(key, candidate);
    candidates.push(candidate);
  };

  // Books ReadMeABook imported
  const books = await prisma.audiobook.findMany({
    where: { audibleAsin: { not: null }, OR: [{ filePath: { not: null } }, { absItemId: { not: null } }] },
  });
  const importedPairs: Array<{ absItemId: string; localPath: string }> = [];
  for (const book of books as BookRecord[]) {
    const folder = await resolveBookFolder(book, mediaDir);
    if (!folder || !book.audibleAsin) continue;
    add({
      title: book.title, asin: book.audibleAsin, folder, absItemId: book.absItemId || undefined, audiobookId: book.id,
      author: book.author, narrator: book.narrator || undefined, series: book.series || undefined,
      seriesPart: book.seriesPart || undefined, year: book.year || undefined,
    });
    if (book.absItemId) importedPairs.push({ absItemId: book.absItemId, localPath: folder });
  }

  // Audiobookshelf: the rest of the library
  if ((await getConfigService().getBackendMode()) === 'audiobookshelf') {
    try {
      await collectAudiobookshelfCandidates(mediaDir, importedPairs, add, logger);
    } catch (error) {
      await logger.warn(`Could not read the Audiobookshelf library: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return candidates;
}

async function processLibrary(mode: 'report' | 'apply', logger: RMABLogger, jobId?: string) {
  const apply = mode === 'apply';
  const label = apply ? 'Fixing chapters' : 'Checking chapters';
  const progress = createJobProgress(jobId, `${label} — finding books`, { cancellable: true });
  await progress.update(0, { force: true });
  const mediaDir = await getMediaDir();
  const candidates = await collectCandidates(mediaDir, logger);
  await logger.info(`Chapter ${apply ? 'fix' : 'check (report only)'}: ${candidates.length} book(s) to check`);
  await progress.update(0, { total: candidates.length, label, force: true });
  let cancelled = false;

  const counts: Record<ChapterFixStatus | 'not_single_file', number> = {
    fixed: 0, would_fix: 0, kept: 0, skipped: 0, corrupt: 0, failed: 0, not_single_file: 0,
  };
  const absMode = apply && (await isAudiobookshelfBackend());

  for (const [index, candidate] of candidates.entries()) {
    if (await progress.isCancelled()) {
      cancelled = true;
      await logger.warn(`Cancelled by admin after ${index} of ${candidates.length} book(s)`);
      break;
    }
    await progress.update(index, { detail: candidate.title });

    const file = candidate.file
      ?? (await findSingleAudioFile(candidate.folder!, AUDIO_EXTENSIONS).catch(() => ({ file: null }))).file;
    if (!file) {
      counts.not_single_file++;
      continue;
    }

    const result = await fixChaptersIfBetter(file, candidate.asin, { apply, logger });
    counts[result.status]++;
    if (result.status === 'would_fix') {
      await logger.info(`Would fix "${candidate.title}": ${result.currentCount} → ${result.audnexusCount} chapters (${result.reason})`);
    } else if (result.status === 'fixed') {
      await logger.info(`Fixed "${candidate.title}": ${result.currentCount} → ${result.audnexusCount} chapters (${result.reason})`);
      if (absMode && candidate.absItemId) await syncFileChaptersToABS(candidate.absItemId, file, logger);
    } else if (result.status === 'corrupt') {
      await logger.warn(`Corrupt (unplayable) "${candidate.title}": ${file} — ${result.reason}`);
    } else if (result.status === 'failed') {
      await logger.warn(`Failed "${candidate.title}": ${result.reason}`);
    }
    if (result.lookedUp) await delay(LOOKUP_DELAY_MS);
  }

  if (!cancelled) await progress.update(candidates.length);
  await progress.finish(cancelled ? 'Cancelled' : 'Done');
  await logger.info(
    `Chapter ${apply ? 'fix' : 'check'} ${cancelled ? 'cancelled' : 'complete'} — ${apply ? `fixed ${counts.fixed}` : `would fix ${counts.would_fix}`}, ` +
    `already fine ${counts.kept}, no usable Audnexus match ${counts.skipped}, multi-file ${counts.not_single_file}, ` +
    `corrupt ${counts.corrupt}, failed ${counts.failed}`
  );
  if (counts.fixed > 0) await triggerLibraryScan(logger);
  return { success: true, mode, checked: candidates.length, ...counts, ...(cancelled && CANCELLED_RESULT) };
}

export async function processFixChapters(payload: FixChaptersPayload) {
  const logger = RMABLogger.forJob(payload.jobId, 'FixChapters');
  if (payload.requestId) return processSingleBook(payload.requestId, logger, payload.jobId);
  if (payload.mode === 'sync_report' || payload.mode === 'sync_apply') {
    const { processChapterSync } = await import('./chapter-sync');
    return processChapterSync(payload.mode === 'sync_apply', logger, payload.jobId);
  }
  return processLibrary(payload.mode === 'apply' ? 'apply' : 'report', logger, payload.jobId);
}
