/**
 * Component: Library Merge Processor (library-wide clean-up + merge)
 * Documentation: documentation/features/chapter-merging.md
 *
 * For every book folder with 2+ audio files:
 *   1. Clean up duplicates (library-dedupe.service): another full copy (e.g. .m4a next to
 *      .m4b), a duplicate set of parts, or unreadable leftovers — recognised against the
 *      book's Audible runtime. The best complete copy is kept (M4B > M4A > MP3, larger).
 *   2. If the kept copy is still split, merge it into one M4B in place (mp3/m4a → AAC).
 * Unexplained audio (could be a different book) is never deleted; such folders are left
 * alone and reported. `report` lists everything; `apply` does it. Cancel stops before the
 * next book or mid-ffmpeg (parts untouched).
 */

import fs from 'fs/promises';
import path from 'path';
import { RMABLogger } from '../utils/logger';
import type { MergeLibraryPayload } from '../services/job-queue.service';
import { formatDuration } from '../utils/chapter-merger';
import { createJobProgress, CANCELLED_RESULT } from '../utils/job-progress';
import { triggerLibraryScan } from '../utils/library-book-files';
import { checkRuntime, mergeFolderInPlace, needsReencode } from '../services/library-merge.service';
import { listAudioFiles, planFolderCleanup } from '../services/library-dedupe.service';
import { isAudiobookshelfBackend, syncFileChaptersToABS } from '../services/abs-chapter-sync';
import { AUDIO_EXTENSIONS } from '../constants/audio-formats';
import { collectCandidates, getMediaDir } from './fix-chapters.processor';

const LOOKUP_DELAY_MS = 1000;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function audioFileCount(folder: string): Promise<number> {
  const entries = await fs.readdir(folder, { withFileTypes: true });
  return entries.filter(e => e.isFile() && (AUDIO_EXTENSIONS as readonly string[]).includes(path.extname(e.name).toLowerCase())).length;
}

export async function processMergeLibrary(payload: MergeLibraryPayload) {
  const logger = RMABLogger.forJob(payload.jobId, 'MergeLibrary');
  const apply = payload.mode === 'apply';
  const label = apply ? 'Cleaning up & merging split books' : 'Checking for duplicates & split books';
  const progress = createJobProgress(payload.jobId, `${label} — finding books`, { cancellable: true });
  await progress.update(0, { force: true });

  const candidates = (await collectCandidates(await getMediaDir(), logger)).filter(c => c.folder);
  await logger.info(`Library merge ${apply ? '' : '(report only) '}: ${candidates.length} book folder(s) to check`);
  await progress.update(0, { total: candidates.length, label, force: true });

  const counts = {
    merged: 0, would_merge: 0, cleaned: 0, would_clean: 0, files_removed: 0, files_to_remove: 0,
    no_complete_copy: 0, unexplained_left: 0, no_runtime: 0, single_file: 0, failed: 0,
  };
  const absMode = apply && (await isAudiobookshelfBackend());
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
      const folder = candidate.folder!;

      try {
        if ((await audioFileCount(folder)) < 2) {
          counts.single_file++;
          continue;
        }

        const { expectedMs } = await checkRuntime(0, candidate.asin);
        await delay(LOOKUP_DELAY_MS);
        if (!expectedMs) {
          counts.no_runtime++;
          await logger.info(`Skipped "${candidate.title}": no Audible runtime to check copies against`);
          continue;
        }

        const files = await listAudioFiles(folder);
        const plan = planFolderCleanup(files, expectedMs);
        const name = (p: string) => path.basename(p);
        const total = files.reduce((sum, f) => sum + (f.duration ?? 0), 0);

        if (!plan.resolved) {
          counts.no_complete_copy++;
          await logger.warn(
            `No complete copy found — left alone "${candidate.title}": ${files.length} file(s), ${formatDuration(total)} total ` +
            `(Audible ${formatDuration(expectedMs)})${files.some(f => f.duration === null) ? ', some unreadable' : ''} (${folder})`
          );
          continue;
        }

        // 1. Duplicates
        if (plan.remove.length > 0) {
          const list = plan.remove.map(r => `${name(r.path)} (${r.reason})`).join(', ');
          const kept = plan.keep.map(name).join(', ');
          if (!apply) {
            counts.would_clean++;
            counts.files_to_remove += plan.remove.length;
            await logger.info(`Would remove from "${candidate.title}": ${list} — keeping ${kept}`);
          } else {
            for (const item of plan.remove) await fs.unlink(item.path);
            counts.cleaned++;
            counts.files_removed += plan.remove.length;
            await logger.info(`Removed from "${candidate.title}": ${list} — kept ${kept}`);
          }
        }
        if (plan.unexplained.length > 0) {
          counts.unexplained_left++;
          await logger.warn(`Left ${plan.unexplained.length} unexplained file(s) in "${candidate.title}" (not merging): ${plan.unexplained.map(name).join(', ')}`);
          continue;
        }

        // 2. Merge the kept copy if it's split
        if (plan.keep.length < 2) {
          // Tracks changed in ABS → give it the kept file's chapters
          if (apply && plan.remove.length > 0 && absMode && candidate.absItemId) {
            await syncFileChaptersToABS(candidate.absItemId, plan.keep[0], logger);
          }
          continue;
        }
        const format = path.extname(plan.keep[0]).toLowerCase();
        const keptMs = files.filter(f => plan.keep.includes(f.path)).reduce((sum, f) => sum + (f.duration ?? 0), 0);
        const speed = needsReencode(format) ? `slow (re-encode ${format.slice(1).toUpperCase()} → M4B)` : 'fast (no re-encode)';
        const summary = `${plan.keep.length} × ${format}, ${formatDuration(keptMs)} (Audible ${formatDuration(expectedMs)}) — ${speed}`;
        if (!apply) {
          counts.would_merge++;
          await logger.info(`Would merge "${candidate.title}": ${summary}`);
          continue;
        }

        await logger.info(`Merging "${candidate.title}": ${summary}`);
        const result = await mergeFolderInPlace({
          folder,
          parts: plan.keep,
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
    `Library merge ${cancelled ? 'cancelled' : 'complete'} — ` +
    (apply
      ? `cleaned ${counts.cleaned} book(s) (${counts.files_removed} duplicate file(s) removed), merged ${counts.merged}`
      : `would clean ${counts.would_clean} book(s) (${counts.files_to_remove} duplicate file(s)), would merge ${counts.would_merge}`) +
    `, no complete copy ${counts.no_complete_copy}, unexplained files left ${counts.unexplained_left}, no Audible runtime ${counts.no_runtime}, ` +
    `failed ${counts.failed} (single-file books: ${counts.single_file})`
  );
  if (counts.merged > 0 || counts.cleaned > 0) await triggerLibraryScan(logger);
  return { success: true, mode: apply ? 'apply' : 'report', checked: candidates.length, ...counts, ...(cancelled && CANCELLED_RESULT) };
}
