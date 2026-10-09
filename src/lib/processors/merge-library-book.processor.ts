/**
 * Component: Merge Library Book Processor
 * Documentation: documentation/features/chapter-merging.md
 *
 * Admin action: merge an already-imported multi-file book (e.g. 9 × .m4b parts) into a
 * single M4B in its library folder. Merges into the temp dir, validates, copies in as
 * .partial, renames, and only then deletes the original parts — any failure leaves the
 * originals untouched. Library files are copies (not hardlinks), so seeding is unaffected.
 */

import { prisma } from '../db';
import { RMABLogger } from '../utils/logger';
import { getConfigService } from '../services/config.service';
import { MergeLibraryBookPayload } from '../services/job-queue.service';
import { createJobProgress, CANCELLED_RESULT } from '../utils/job-progress';
import { resolveBookFolder, triggerLibraryScan, type BookRecord } from '../utils/library-book-files';
import { checkRuntime, listMergeableParts, mergeFolderInPlace, totalDurationMs } from '../services/library-merge.service';

export async function processMergeLibraryBook(payload: MergeLibraryBookPayload) {
  const { requestId, jobId } = payload;
  const logger = RMABLogger.forJob(jobId, 'MergeLibraryBook');
  const progress = createJobProgress(jobId, 'Merging into single M4B — preparing', { total: 100, cancellable: true });
  await progress.update(0, { force: true });

  const request = await prisma.request.findFirst({
    where: { id: requestId, deletedAt: null },
    include: { audiobook: true },
  });
  if (!request?.audiobook) throw new Error(`Request ${requestId} not found`);
  const book = request.audiobook as BookRecord;
  await logger.info(`Merging library files for "${book.title}" by ${book.author}`);

  const mediaDir = (await getConfigService().get('media_dir')) || process.env.MEDIA_DIR || '/media/audiobooks';
  const folder = await resolveBookFolder(book, mediaDir, logger);
  if (!folder) throw new Error(`Could not find the library folder for "${book.title}" inside ${mediaDir}`);

  const check = await listMergeableParts(folder);
  if (!check.ok) {
    throw new Error(check.reason === 'single_file'
      ? `Found ${check.detail} in ${folder} — nothing to merge`
      : `Can't merge: ${check.reason === 'mixed_formats' ? 'mixed audio formats' : 'unsupported format'} (${check.detail})`);
  }
  await logger.info(`Found ${check.parts.length} ${check.format} files to merge`);

  // Manual action: a runtime mismatch is a warning, not a blocker
  const runtime = await checkRuntime(await totalDurationMs(check.parts), book.audibleAsin);
  if (runtime.matches === false) {
    await logger.warn(`Total length differs from the Audible runtime (${Math.round((runtime.expectedMs ?? 0) / 60000)} min) — merging anyway (manual action)`);
  }

  // Refresh the cancel flag in the background; ffmpeg's progress callback reads it synchronously
  const cancelPoll = setInterval(() => { progress.isCancelled().catch(() => {}); }, 2000);
  try {
    await progress.update(0, { label: 'Merging into single M4B', detail: book.title, force: true });
    const result = await mergeFolderInPlace({
      folder,
      parts: check.parts,
      meta: {
        title: book.title, author: book.author, narrator: book.narrator || undefined, year: book.year || undefined,
        asin: book.audibleAsin || undefined, series: book.series || undefined, seriesPart: book.seriesPart || undefined,
      },
      audiobookId: book.id,
      absItemId: book.absItemId || undefined,
      logger,
      tempName: requestId,
      onProgress: percent => { progress.update(Math.min(percent, 99)).catch(() => {}); },
      shouldCancel: () => progress.cancelledSync,
      isCancelled: () => progress.isCancelled({ fresh: true }),
      onSwap: () => progress.update(99, { label: 'Merging into single M4B — swapping files in', cancellable: false, force: true }),
    });

    if (result.status === 'cancelled') {
      await logger.warn('Merge cancelled by admin — original files left untouched');
      await progress.finish('Cancelled');
      return { success: false, ...CANCELLED_RESULT, folder };
    }

    await triggerLibraryScan(logger);
    if (await progress.isCancelled()) {
      await logger.info('Cancel was requested while swapping files — the swap had to finish, so the merge is complete');
    }
    await progress.update(100);
    await progress.finish('Done');
    return { success: true, folder, file: result.finalName, partsMerged: check.parts.length, chapterCount: result.chapterCount };
  } finally {
    clearInterval(cancelPoll);
  }
}
