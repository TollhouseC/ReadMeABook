/**
 * Component: Merge Library Book Processor
 * Documentation: documentation/features/chapter-merging.md
 *
 * Admin action: merge an already-imported multi-file book (e.g. 9 × .m4b parts) into a
 * single M4B in its library folder. Merges into the temp dir, validates, copies in as
 * .partial, renames, and only then deletes the original parts — any failure leaves the
 * originals untouched. Library files are copies (not hardlinks), so seeding is unaffected.
 */

import fs from 'fs/promises';
import path from 'path';
import { prisma } from '../db';
import { RMABLogger } from '../utils/logger';
import { getConfigService } from '../services/config.service';
import { MergeLibraryBookPayload } from '../services/job-queue.service';
import { analyzeChapterFiles, checkDiskSpace, estimateOutputSize, mergeChapters, MERGE_CANCELLED } from '../utils/chapter-merger';
import { createJobProgress, CANCELLED_RESULT } from '../utils/job-progress';
import { tagAudioFileMetadata } from '../utils/metadata-tagger';
import { buildRenamedFilename } from '../utils/path-template.util';
import { copyFile } from '../utils/copy-file';
import { generateFilesHash } from '../utils/files-hash';
import { resolveBookFolder, triggerLibraryScan, type BookRecord } from '../utils/library-book-files';
import { CHAPTER_MERGE_FORMATS } from '../constants/audio-formats';

function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim().replace(/^\.+|\.+$/g, '').slice(0, 200);
}

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

  const configService = getConfigService();
  const mediaDir = (await configService.get('media_dir')) || process.env.MEDIA_DIR || '/media/audiobooks';
  const folder = await resolveBookFolder(book, mediaDir, logger);
  if (!folder) throw new Error(`Could not find the library folder for "${book.title}" inside ${mediaDir}`);

  // Top-level audio files only, same format
  const entries = await fs.readdir(folder, { withFileTypes: true });
  const parts = entries
    .filter(e => e.isFile() && (CHAPTER_MERGE_FORMATS as readonly string[]).includes(path.extname(e.name).toLowerCase()))
    .map(e => path.join(folder, e.name));
  if (parts.length < 2) throw new Error(`Found ${parts.length} audio file(s) in ${folder} — nothing to merge`);
  const formats = new Set(parts.map(p => path.extname(p).toLowerCase()));
  if (formats.size > 1) throw new Error(`Mixed audio formats (${[...formats].join(', ')}) — not merging`);
  await logger.info(`Found ${parts.length} ${[...formats][0]} files to merge`);

  const tempDir = process.env.TEMP_DIR || '/tmp/readmeabook';
  const fileMode = parseInt((await configService.get('file_chmod')) || '664', 8);
  const dirMode = parseInt((await configService.get('dir_chmod')) || '775', 8);
  await fs.mkdir(tempDir, { recursive: true, mode: dirMode });

  const needed = await estimateOutputSize(parts);
  const available = await checkDiskSpace(tempDir);
  if (available !== null && available < needed) {
    throw new Error(`Insufficient temp disk space (need ${Math.round(needed / 1048576)}MB, have ${Math.round(available / 1048576)}MB)`);
  }

  const renameEnabled = (await configService.get('file_rename_enabled')) === 'true';
  const renameTemplate = (await configService.get('file_rename_template')) || '{title}';
  const finalName = renameEnabled
    ? buildRenamedFilename(renameTemplate, {
        author: book.author, title: book.title, narrator: book.narrator || undefined, asin: book.audibleAsin || undefined,
        year: book.year || undefined, series: book.series || undefined, seriesPart: book.seriesPart || undefined,
      }, '.m4b')
    : `${sanitizeFilename(book.title)}.m4b`;

  const tempOutput = path.join(tempDir, `merge_${requestId}.m4b`);
  const tempFiles = [tempOutput];
  // Refresh the cancel flag in the background; ffmpeg's progress callback reads it synchronously
  const cancelPoll = setInterval(() => { progress.isCancelled().catch(() => {}); }, 2000);
  const stopCancelled = async () => {
    await logger.warn('Merge cancelled by admin — original files left untouched');
    await progress.finish('Cancelled');
    return { success: false, ...CANCELLED_RESULT, folder };
  };
  try {
    const chapters = await analyzeChapterFiles(parts, logger);
    if (chapters.length === 0) throw new Error('Chapter analysis found no usable files');

    if (await progress.isCancelled()) return await stopCancelled();
    await progress.update(0, { label: 'Merging into single M4B', detail: book.title, force: true });
    const result = await mergeChapters(chapters, {
      title: book.title,
      author: book.author,
      narrator: book.narrator || undefined,
      year: book.year || undefined,
      asin: book.audibleAsin || undefined,
      outputPath: tempOutput,
      dirMode,
      onProgress: percent => { progress.update(Math.min(percent, 99)).catch(() => {}); },
      shouldCancel: () => progress.cancelledSync,
    }, logger);
    if (!result.success && result.error?.includes(MERGE_CANCELLED)) return await stopCancelled();
    if (!result.success) throw new Error(`Merge failed: ${result.error}`);
    // Last safe point to stop: nothing in the library has been touched yet
    if (await progress.isCancelled()) return await stopCancelled();
    await progress.update(99, { label: 'Merging into single M4B — swapping files in', cancellable: false, force: true });

    // Series tags (mergeChapters writes the rest); best-effort
    let source = tempOutput;
    if ((await configService.get('metadata_tagging_enabled')) === 'true') {
      const tagged = await tagAudioFileMetadata(tempOutput, {
        title: book.title, author: book.author, narrator: book.narrator || undefined, year: book.year || undefined,
        asin: book.audibleAsin || undefined, series: book.series || undefined, seriesPart: book.seriesPart || undefined,
      });
      if (tagged.success && tagged.taggedFilePath) {
        source = tagged.taggedFilePath;
        tempFiles.push(source);
      }
    }

    // Copy in as .partial, verify, then swap in
    const finalPath = path.join(folder, finalName);
    const partialPath = `${finalPath}.partial`;
    await copyFile(source, partialPath);
    const [srcStat, partialStat] = await Promise.all([fs.stat(source), fs.stat(partialPath)]);
    if (srcStat.size !== partialStat.size) {
      await fs.unlink(partialPath).catch(() => {});
      throw new Error('Copied file size mismatch — originals kept');
    }
    await fs.rename(partialPath, finalPath);
    await fs.chmod(finalPath, fileMode).catch(() => {});
    await logger.info(`Wrote ${finalName} (${Math.round(srcStat.size / 1048576)}MB, ${result.chapterCount} chapters)`);

    // Merged file is in place — remove the parts
    const removed = parts.filter(p => path.resolve(p) !== path.resolve(finalPath));
    for (const part of removed) await fs.unlink(part);
    await logger.info(`Removed ${removed.length} original part file(s)`);

    await prisma.audiobook.update({
      where: { id: book.id },
      data: {
        fileFormat: 'm4b',
        fileSizeBytes: BigInt(srcStat.size),
        filesHash: generateFilesHash([finalPath]) || null,
      },
    });

    await triggerLibraryScan(logger);
    await progress.update(100);
    await progress.finish('Done');
    return { success: true, folder, file: finalName, partsMerged: parts.length, chapterCount: result.chapterCount };
  } finally {
    clearInterval(cancelPoll);
    for (const file of tempFiles) await fs.unlink(file).catch(() => {});
  }
}
