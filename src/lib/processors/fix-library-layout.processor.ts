/**
 * Component: Fix Library Layout Processor
 * Documentation: documentation/phase3/file-organization.md
 *
 * Library-wide: find book folders that also contain other books' folders (Audiobookshelf
 * merges those into one item) and, in apply mode, move the outer book's own files into
 * <folder>/<folder name>/ so every book in the series has its own folder.
 */

import { prisma } from '../db';
import { RMABLogger } from '../utils/logger';
import { getConfigService } from '../services/config.service';
import type { FixLibraryLayoutPayload } from '../services/job-queue.service';
import { findNestedBooks, moveBookIntoOwnSubfolder } from '../utils/library-layout';
import { triggerLibraryScan } from '../utils/library-book-files';
import { createJobProgress, CANCELLED_RESULT } from '../utils/job-progress';

export async function processFixLibraryLayout(payload: FixLibraryLayoutPayload) {
  const logger = RMABLogger.forJob(payload.jobId, 'FixLibraryLayout');
  const apply = payload.mode === 'apply';
  const configService = getConfigService();
  const mediaDir = (await configService.get('media_dir')) || process.env.MEDIA_DIR || '/media/audiobooks';
  const dirMode = parseInt((await configService.get('dir_chmod')) || '775', 8);

  const progress = createJobProgress(payload.jobId, `${apply ? 'Fixing' : 'Checking'} library layout — scanning folders`, { cancellable: true });
  await progress.update(0, { force: true });
  const nested = await findNestedBooks(mediaDir);
  await progress.update(0, { total: nested.length, label: apply ? 'Fixing library layout' : 'Checking library layout', force: true });
  let cancelled = false;
  await logger.info(`Library layout ${apply ? 'fix' : 'check (report only)'}: ${nested.length} book folder(s) contain other books`);

  let moved = 0;
  let failed = 0;
  for (const [index, { outer, inner }] of nested.entries()) {
    if (await progress.isCancelled()) {
      cancelled = true;
      await logger.warn(`Cancelled by admin after ${index} of ${nested.length} folder(s)`);
      break;
    }
    await progress.update(index, { detail: outer });
    const innerList = inner.map(p => `"${p}"`).join(', ');
    if (!apply) {
      await logger.info(`Nested: "${outer}" contains ${innerList}`);
      continue;
    }
    try {
      const to = await moveBookIntoOwnSubfolder(outer, dirMode);
      await prisma.audiobook.updateMany({ where: { filePath: outer }, data: { filePath: to } });
      moved++;
      await logger.info(`Moved book files "${outer}" → "${to}" (was containing ${innerList})`);
    } catch (error) {
      failed++;
      await logger.warn(`Failed to fix "${outer}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!cancelled) await progress.update(nested.length);
  await progress.finish(cancelled ? 'Cancelled' : 'Done');
  await logger.info(`Library layout ${apply ? `fix complete — moved ${moved}, failed ${failed}` : `check complete — ${nested.length} to fix`}`);
  if (moved > 0) await triggerLibraryScan(logger);
  return { success: true, mode: apply ? 'apply' : 'report', nested: nested.length, moved, failed, ...(cancelled && CANCELLED_RESULT) };
}
