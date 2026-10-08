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
import { getConfigService } from '../services/config.service';
import type { FixChaptersPayload } from '../services/job-queue.service';
import { AUDIO_EXTENSIONS } from '../constants/audio-formats';
import { fixChaptersIfBetter, findSingleAudioFile, type ChapterFixStatus } from '../utils/chapter-fixer';
import { resolveBookFolder, triggerLibraryScan, type BookRecord } from '../utils/library-book-files';
import { learnPrefixMappings, localPathCandidates, resolveLocalPath } from '../utils/abs-path-mapper';

const LOOKUP_DELAY_MS = 1000;

/** A book to check: a folder (expects one audio file) or, for root-level ABS items, the file itself. */
interface Candidate {
  title: string;
  asin: string;
  folder?: string;
  file?: string;
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function getMediaDir(): Promise<string> {
  return (await getConfigService().get('media_dir')) || process.env.MEDIA_DIR || '/media/audiobooks';
}

async function processSingleBook(requestId: string, logger: RMABLogger) {
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

  const result = await fixChaptersIfBetter(file, book.audibleAsin, { apply: true, logger });
  await logger.info(`"${book.title}": ${result.status} — ${result.reason} (current ${result.currentCount}, Audnexus ${result.audnexusCount})`);
  if (result.status === 'failed') throw new Error(result.reason);
  if (result.status === 'corrupt') throw new Error(`"${book.title}" is unplayable (${result.reason}) — re-download it`);
  if (result.status === 'fixed') await triggerLibraryScan(logger);
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
  const mappings = learnPrefixMappings(importedPairs
    .map(pair => ({ absPath: itemsById.get(pair.absItemId)?.path as string, localPath: pair.localPath }))
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
    add(item.isFile ? { title, asin, file: local } : { title, asin, folder: local });
  }

  await logger.info(
    `Audiobookshelf: ${items.length} item(s) — ${noAsin} without an ASIN (no chapter lookup possible), ` +
    `${unreachable} not reachable inside ${mediaDir}` +
    (mappings.length ? `; path mapping ${mappings.map(m => `${m.from} → ${m.to}`).join(', ')}` : '')
  );
  if (example) await logger.info(`Example unreachable item: ${example}`);
}

async function collectCandidates(mediaDir: string, logger: RMABLogger): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  const add = (candidate: Candidate) => {
    const key = path.resolve(candidate.file ?? candidate.folder!);
    if (seen.has(key)) return;
    seen.add(key);
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
    add({ title: book.title, asin: book.audibleAsin, folder });
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

async function processLibrary(mode: 'report' | 'apply', logger: RMABLogger) {
  const apply = mode === 'apply';
  const mediaDir = await getMediaDir();
  const candidates = await collectCandidates(mediaDir, logger);
  await logger.info(`Chapter ${apply ? 'fix' : 'check (report only)'}: ${candidates.length} book(s) to check`);

  const counts: Record<ChapterFixStatus | 'not_single_file', number> = {
    fixed: 0, would_fix: 0, kept: 0, skipped: 0, corrupt: 0, failed: 0, not_single_file: 0,
  };

  for (const candidate of candidates) {
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
    } else if (result.status === 'corrupt') {
      await logger.warn(`Corrupt (unplayable) "${candidate.title}": ${file} — ${result.reason}`);
    } else if (result.status === 'failed') {
      await logger.warn(`Failed "${candidate.title}": ${result.reason}`);
    }
    if (result.lookedUp) await delay(LOOKUP_DELAY_MS);
  }

  await logger.info(
    `Chapter ${apply ? 'fix' : 'check'} complete — ${apply ? `fixed ${counts.fixed}` : `would fix ${counts.would_fix}`}, ` +
    `already fine ${counts.kept}, no usable Audnexus match ${counts.skipped}, multi-file ${counts.not_single_file}, ` +
    `corrupt ${counts.corrupt}, failed ${counts.failed}`
  );
  if (counts.fixed > 0) await triggerLibraryScan(logger);
  return { success: true, mode, checked: candidates.length, ...counts };
}

export async function processFixChapters(payload: FixChaptersPayload) {
  const logger = RMABLogger.forJob(payload.jobId, 'FixChapters');
  return payload.requestId
    ? processSingleBook(payload.requestId, logger)
    : processLibrary(payload.mode === 'apply' ? 'apply' : 'report', logger);
}
