/**
 * Component: Fix Chapters Processor
 * Documentation: documentation/features/chapter-merging.md
 *
 * Replaces single-file books' chapters with Audnexus's when Audnexus is clearly better.
 * - Per book (requestId): always applies.
 * - Library-wide (no requestId): `report` lists what would change, `apply` changes it.
 *   Covers books ReadMeABook imported plus, on Audiobookshelf, every library item whose
 *   folder is reachable inside media_dir. ~1 Audnexus lookup per second.
 */

import path from 'path';
import { prisma } from '../db';
import { RMABLogger } from '../utils/logger';
import { getConfigService } from '../services/config.service';
import type { FixChaptersPayload } from '../services/job-queue.service';
import { AUDIO_EXTENSIONS } from '../constants/audio-formats';
import { fixChaptersIfBetter, findSingleAudioFile, type ChapterFixStatus } from '../utils/chapter-fixer';
import { isDirectory, isInside, resolveBookFolder, triggerLibraryScan, type BookRecord } from '../utils/library-book-files';

const LOOKUP_DELAY_MS = 1000;

interface Candidate {
  title: string;
  asin: string;
  folder: string;
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
  if (result.status === 'fixed') await triggerLibraryScan(logger);
  return { success: true, ...result };
}

async function collectCandidates(mediaDir: string, logger: RMABLogger): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  const seenFolders = new Set<string>();
  const add = (title: string, asin: string, folder: string) => {
    const key = path.resolve(folder);
    if (seenFolders.has(key)) return;
    seenFolders.add(key);
    candidates.push({ title, asin, folder });
  };

  // Books ReadMeABook imported
  const books = await prisma.audiobook.findMany({
    where: { audibleAsin: { not: null }, OR: [{ filePath: { not: null } }, { absItemId: { not: null } }] },
  });
  for (const book of books as BookRecord[]) {
    const folder = await resolveBookFolder(book, mediaDir);
    if (folder && book.audibleAsin) add(book.title, book.audibleAsin, folder);
  }

  // Audiobookshelf: every library item with an ASIN (item path must be reachable here)
  if ((await getConfigService().getBackendMode()) === 'audiobookshelf') {
    const { getABSItem } = await import('../services/audiobookshelf/api');
    const items = await prisma.plexLibrary.findMany({
      where: { asin: { not: null } },
      select: { plexGuid: true, asin: true, title: true },
    });
    let unreachable = 0;
    for (const item of items) {
      try {
        const folder = (await getABSItem(item.plexGuid))?.path;
        if (folder && isInside(folder, mediaDir) && (await isDirectory(folder))) add(item.title, item.asin!, folder);
        else unreachable++;
      } catch {
        unreachable++;
      }
    }
    if (unreachable > 0) {
      await logger.info(`${unreachable} Audiobookshelf item(s) skipped: folder not reachable inside ${mediaDir}`);
    }
  }

  return candidates;
}

async function processLibrary(mode: 'report' | 'apply', logger: RMABLogger) {
  const apply = mode === 'apply';
  const mediaDir = await getMediaDir();
  const candidates = await collectCandidates(mediaDir, logger);
  await logger.info(`Chapter ${apply ? 'fix' : 'check (report only)'}: ${candidates.length} book folder(s) to check`);

  const counts: Record<ChapterFixStatus | 'not_single_file', number> = {
    fixed: 0, would_fix: 0, kept: 0, skipped: 0, failed: 0, not_single_file: 0,
  };

  for (const candidate of candidates) {
    const { file } = await findSingleAudioFile(candidate.folder, AUDIO_EXTENSIONS).catch(() => ({ file: null }));
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
    } else if (result.status === 'failed') {
      await logger.warn(`Failed "${candidate.title}": ${result.reason}`);
    }
    if (result.lookedUp) await delay(LOOKUP_DELAY_MS);
  }

  await logger.info(
    `Chapter ${apply ? 'fix' : 'check'} complete — ${apply ? `fixed ${counts.fixed}` : `would fix ${counts.would_fix}`}, ` +
    `already fine ${counts.kept}, no usable Audnexus match ${counts.skipped}, multi-file ${counts.not_single_file}, failed ${counts.failed}`
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
