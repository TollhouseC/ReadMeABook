/**
 * Component: Chapter Sync to Audiobookshelf (library-wide)
 * Documentation: documentation/features/chapter-merging.md
 *
 * Catch-up for books whose file chapters were fixed but Audiobookshelf still shows its
 * old list (ABS keeps chapters in metadata.json, which wins on rescan). For every
 * single-file book with an ABS item: if the file has more chapters than ABS shows,
 * report it ("sync_report") or push the file's chapters to ABS ("sync_apply").
 * No Audnexus lookups — fast.
 */

import type { RMABLogger } from '../utils/logger';
import { AUDIO_EXTENSIONS } from '../constants/audio-formats';
import { findSingleAudioFile } from '../utils/chapter-fixer';
import { probeEmbeddedChapters } from '../utils/chapter-list';
import { createJobProgress, CANCELLED_RESULT } from '../utils/job-progress';
import { getABSChapterCount, isAudiobookshelfBackend, pushChaptersToABS } from '../services/abs-chapter-sync';
import { collectCandidates, getMediaDir } from './fix-chapters.processor';

export async function processChapterSync(apply: boolean, logger: RMABLogger, jobId?: string) {
  const label = apply ? 'Syncing chapters to Audiobookshelf' : 'Comparing chapters with Audiobookshelf';
  const progress = createJobProgress(jobId, `${label} — finding books`, { cancellable: true });
  await progress.update(0, { force: true });

  if (!(await isAudiobookshelfBackend())) {
    await logger.info('Chapter sync only applies to Audiobookshelf libraries — nothing to do');
    await progress.finish('Not an Audiobookshelf library');
    return { success: true, mode: apply ? 'sync_apply' : 'sync_report', checked: 0 };
  }

  const candidates = (await collectCandidates(await getMediaDir(), logger)).filter(c => c.absItemId);
  await logger.info(`Chapter sync ${apply ? '' : '(report only) '}: ${candidates.length} Audiobookshelf book(s) to compare`);
  await progress.update(0, { total: candidates.length, label, force: true });

  const counts = { synced: 0, would_sync: 0, in_sync: 0, not_single_file: 0, failed: 0 };
  let cancelled = false;

  for (const [index, candidate] of candidates.entries()) {
    if (await progress.isCancelled()) {
      cancelled = true;
      await logger.warn(`Cancelled by admin after ${index} of ${candidates.length} book(s)`);
      break;
    }
    await progress.update(index, { detail: candidate.title });

    try {
      const file = candidate.file
        ?? (await findSingleAudioFile(candidate.folder!, AUDIO_EXTENSIONS).catch(() => ({ file: null }))).file;
      if (!file) {
        counts.not_single_file++;
        continue;
      }

      const fileChapters = await probeEmbeddedChapters(file);
      const absCount = candidate.absChapterCount ?? (await getABSChapterCount(candidate.absItemId!)) ?? 0;
      // Only when the file is better: never overwrite a richer list set in ABS (e.g. its own lookup)
      if (fileChapters.length <= 1 || fileChapters.length <= absCount) {
        counts.in_sync++;
        continue;
      }

      if (!apply) {
        counts.would_sync++;
        await logger.info(`Would sync "${candidate.title}": Audiobookshelf ${absCount} → file ${fileChapters.length} chapters`);
        continue;
      }
      await pushChaptersToABS(candidate.absItemId!, fileChapters);
      counts.synced++;
      await logger.info(`Synced "${candidate.title}": Audiobookshelf ${absCount} → ${fileChapters.length} chapters`);
    } catch (error) {
      counts.failed++;
      await logger.warn(`Failed "${candidate.title}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!cancelled) await progress.update(candidates.length);
  await progress.finish(cancelled ? 'Cancelled' : 'Done');
  await logger.info(
    `Chapter sync ${cancelled ? 'cancelled' : 'complete'} — ${apply ? `synced ${counts.synced}` : `would sync ${counts.would_sync}`}, ` +
    `already in sync ${counts.in_sync}, multi-file ${counts.not_single_file}, failed ${counts.failed}`
  );
  return { success: true, mode: apply ? 'sync_apply' : 'sync_report', checked: candidates.length, ...counts, ...(cancelled && CANCELLED_RESULT) };
}
