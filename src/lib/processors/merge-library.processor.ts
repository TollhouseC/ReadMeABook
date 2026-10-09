/**
 * Component: Library Merge Processor (library-wide)
 * Documentation: documentation/features/chapter-merging.md
 *
 * Finds book folders still holding split audio (≥2 files, same format — m4b parts or
 * mp3 chapters) and merges each into one M4B in place (mp3 → AAC M4B). Safety: the
 * parts' total length must match the book's Audible runtime (catches folders holding a
 * different book or a partial set). `report` lists what would merge; `apply` merges.
 * Cancel stops before the next book, or stops ffmpeg mid-book (parts untouched).
 */

import { RMABLogger } from '../utils/logger';
import type { MergeLibraryPayload } from '../services/job-queue.service';
import { formatDuration } from '../utils/chapter-merger';
import { createJobProgress, CANCELLED_RESULT } from '../utils/job-progress';
import { triggerLibraryScan } from '../utils/library-book-files';
import { checkRuntime, listMergeableParts, mergeFolderInPlace, needsReencode, totalDurationMs } from '../services/library-merge.service';
import { collectCandidates, getMediaDir } from './fix-chapters.processor';

const LOOKUP_DELAY_MS = 1000;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function processMergeLibrary(payload: MergeLibraryPayload) {
  const logger = RMABLogger.forJob(payload.jobId, 'MergeLibrary');
  const apply = payload.mode === 'apply';
  const label = apply ? 'Merging split books' : 'Checking for split books';
  const progress = createJobProgress(payload.jobId, `${label} — finding books`, { cancellable: true });
  await progress.update(0, { force: true });

  const candidates = (await collectCandidates(await getMediaDir(), logger)).filter(c => c.folder);
  await logger.info(`Library merge ${apply ? '' : '(report only) '}: ${candidates.length} book folder(s) to check`);
  await progress.update(0, { total: candidates.length, label, force: true });

  const counts = {
    merged: 0, would_merge: 0, single_file: 0, mixed_formats: 0, length_mismatch: 0, no_runtime: 0, unreadable: 0, failed: 0,
  };
  let cancelled = false;
  // Refresh the cancel flag in the background; ffmpeg's progress callback reads it synchronously
  const cancelPoll = setInterval(() => { progress.isCancelled().catch(() => {}); }, 2000);

  try {
    for (const [index, candidate] of candidates.entries()) {
      if (await progress.isCancelled()) {
        cancelled = true;
        await logger.warn(`Cancelled by admin after ${index} of ${candidates.length} folder(s)`);
        break;
      }
      await progress.update(index, { detail: candidate.title, cancellable: true });

      try {
        const check = await listMergeableParts(candidate.folder!);
        if (!check.ok) {
          if (check.reason === 'single_file') counts.single_file++;
          else {
            counts.mixed_formats++;
            await logger.info(`Skipped "${candidate.title}": ${check.reason === 'mixed_formats' ? 'mixed formats' : 'unsupported format'} (${check.detail})`);
          }
          continue;
        }

        let totalMs: number;
        try {
          totalMs = await totalDurationMs(check.parts);
        } catch (error) {
          counts.unreadable++;
          await logger.warn(`Unreadable files in "${candidate.title}" (${candidate.folder}): ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }

        const runtime = await checkRuntime(totalMs, candidate.asin);
        await delay(LOOKUP_DELAY_MS);
        const lengths = `${formatDuration(totalMs)}${runtime.expectedMs ? ` (Audible ${formatDuration(runtime.expectedMs)})` : ''}`;
        if (runtime.matches === null) {
          counts.no_runtime++;
          await logger.info(`Skipped "${candidate.title}": no Audible runtime to verify against — ${check.parts.length} × ${check.format}, ${lengths}`);
          continue;
        }
        if (!runtime.matches) {
          counts.length_mismatch++;
          await logger.warn(`Length doesn't match the book — skipped "${candidate.title}": ${check.parts.length} × ${check.format}, ${lengths} (${candidate.folder})`);
          continue;
        }

        const speed = needsReencode(check.format) ? `slow (re-encode ${check.format.slice(1).toUpperCase()} → M4B)` : 'fast (no re-encode)';
        if (!apply) {
          counts.would_merge++;
          await logger.info(`Would merge "${candidate.title}": ${check.parts.length} × ${check.format}, ${lengths} — ${speed}`);
          continue;
        }

        await logger.info(`Merging "${candidate.title}": ${check.parts.length} × ${check.format}, ${lengths} — ${speed}`);
        const result = await mergeFolderInPlace({
          folder: candidate.folder!,
          parts: check.parts,
          meta: {
            title: candidate.title, author: candidate.author || 'Unknown Author', narrator: candidate.narrator,
            year: candidate.year, asin: candidate.asin, series: candidate.series, seriesPart: candidate.seriesPart,
          },
          audiobookId: candidate.audiobookId,
          absItemId: candidate.absItemId,
          logger,
          tempName: `library_${index}_${Date.now()}`,
          onProgress: percent => { progress.update(index, { detail: `${candidate.title} — ${percent}%` }).catch(() => {}); },
          shouldCancel: () => progress.cancelledSync,
          isCancelled: () => progress.isCancelled({ fresh: true }),
          onSwap: () => progress.update(index, { detail: `${candidate.title} — swapping files in`, cancellable: false, force: true }),
        });
        if (result.status === 'cancelled') {
          cancelled = true;
          await logger.warn(`Cancelled by admin during "${candidate.title}" — its files were left untouched`);
          break;
        }
        counts.merged++;
        await logger.info(`Merged "${candidate.title}" → ${result.finalName} (${result.chapterCount} chapters)`);
      } catch (error) {
        counts.failed++;
        await logger.warn(`Failed "${candidate.title}": ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    clearInterval(cancelPoll);
  }

  if (!cancelled) await progress.update(candidates.length);
  await progress.finish(cancelled ? 'Cancelled' : 'Done');
  await logger.info(
    `Library merge ${cancelled ? 'cancelled' : 'complete'} — ${apply ? `merged ${counts.merged}` : `would merge ${counts.would_merge}`}, ` +
    `length mismatch ${counts.length_mismatch}, no Audible runtime ${counts.no_runtime}, mixed/unsupported formats ${counts.mixed_formats}, ` +
    `unreadable ${counts.unreadable}, failed ${counts.failed} (single-file books: ${counts.single_file})`
  );
  if (counts.merged > 0) await triggerLibraryScan(logger);
  return { success: true, mode: apply ? 'apply' : 'report', checked: candidates.length, ...counts, ...(cancelled && CANCELLED_RESULT) };
}
