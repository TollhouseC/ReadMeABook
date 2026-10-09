/**
 * Component: Library Merge Service
 * Documentation: documentation/features/chapter-merging.md
 *
 * Merge a library folder's split audio files (m4b/m4a/mp3/…) into one M4B in place.
 * Shared by the per-book "Merge into Single M4B" action and the library-wide merge job.
 * Merges into the temp dir, validates, copies in as .partial, renames, and only then
 * deletes the parts — any failure or cancel leaves the originals untouched.
 */

import fs from 'fs/promises';
import path from 'path';
import { prisma } from '../db';
import type { RMABLogger } from '../utils/logger';
import { getConfigService } from './config.service';
import { analyzeChapterFiles, checkDiskSpace, estimateOutputSize, mergeChapters, MERGE_CANCELLED, probeAudioFile } from '../utils/chapter-merger';
import { tagAudioFileMetadata } from '../utils/metadata-tagger';
import { buildRenamedFilename } from '../utils/path-template.util';
import { copyFile } from '../utils/copy-file';
import { generateFilesHash } from '../utils/files-hash';
import { AUDIO_EXTENSIONS, CHAPTER_MERGE_FORMATS } from '../constants/audio-formats';
import { isAudiobookshelfBackend, syncFileChaptersToABS } from './abs-chapter-sync';

export interface MergeBookMeta {
  title: string;
  author: string;
  narrator?: string;
  year?: number;
  asin?: string;
  series?: string;
  seriesPart?: string;
}

/** Runtime tolerance vs Audible: max(3%, 2 minutes). */
const RUNTIME_TOLERANCE_RATIO = 0.03;
const RUNTIME_TOLERANCE_MS = 2 * 60 * 1000;

export type PartsCheck =
  | { ok: true; parts: string[]; format: string }
  | { ok: false; reason: 'single_file' | 'mixed_formats' | 'unsupported_format'; detail: string };

/** Top-level audio files of a folder, if they can be merged (≥2, same supported format). */
export async function listMergeableParts(folder: string): Promise<PartsCheck> {
  const entries = await fs.readdir(folder, { withFileTypes: true });
  const audio = entries
    .filter(e => e.isFile() && (AUDIO_EXTENSIONS as readonly string[]).includes(path.extname(e.name).toLowerCase()))
    .map(e => path.join(folder, e.name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (audio.length < 2) return { ok: false, reason: 'single_file', detail: `${audio.length} audio file(s)` };
  const formats = new Set(audio.map(p => path.extname(p).toLowerCase()));
  if (formats.size > 1) return { ok: false, reason: 'mixed_formats', detail: [...formats].join(', ') };
  const format = [...formats][0];
  if (!(CHAPTER_MERGE_FORMATS as readonly string[]).includes(format)) {
    return { ok: false, reason: 'unsupported_format', detail: format };
  }
  return { ok: true, parts: audio, format };
}

/** Total duration of the parts (ms). */
export async function totalDurationMs(parts: string[]): Promise<number> {
  let total = 0;
  for (const part of parts) total += (await probeAudioFile(part)).duration;
  return total;
}

/**
 * Compare a total duration with the book's Audible runtime. `expectedMs` null = unknown
 * (no ASIN / lookup failed). Catches folders holding a different book or a partial set.
 */
export async function checkRuntime(totalMs: number, asin?: string | null): Promise<{ expectedMs: number | null; matches: boolean | null }> {
  if (!asin) return { expectedMs: null, matches: null };
  try {
    const { getAudibleService } = await import('../integrations/audible.service');
    const minutes = await getAudibleService().getRuntime(asin);
    if (!minutes) return { expectedMs: null, matches: null };
    const expectedMs = minutes * 60 * 1000;
    const tolerance = Math.max(RUNTIME_TOLERANCE_MS, expectedMs * RUNTIME_TOLERANCE_RATIO);
    return { expectedMs, matches: Math.abs(totalMs - expectedMs) <= tolerance };
  } catch {
    return { expectedMs: null, matches: null };
  }
}

export const needsReencode = (format: string) => format !== '.m4b' && format !== '.mp4';

function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim().replace(/^\.+|\.+$/g, '').slice(0, 200);
}

export interface MergeFolderOptions {
  folder: string;
  parts: string[];
  meta: MergeBookMeta;
  /** ReadMeABook audiobook record to update (file info), if any */
  audiobookId?: string;
  /** Audiobookshelf item to receive the merged chapters, if any */
  absItemId?: string;
  logger?: RMABLogger;
  /** Unique temp file stem */
  tempName: string;
  onProgress?: (percent: number) => void;
  /** Sync check polled while ffmpeg runs */
  shouldCancel?: () => boolean;
  /** Async check at the last safe point before the library is touched */
  isCancelled?: () => Promise<boolean>;
  /** Called when the (uninterruptible) swap starts */
  onSwap?: () => Promise<void> | void;
}

export type MergeFolderResult =
  | { status: 'merged'; finalPath: string; finalName: string; chapterCount: number; sizeBytes: number }
  | { status: 'cancelled' };

export async function mergeFolderInPlace(opts: MergeFolderOptions): Promise<MergeFolderResult> {
  const { folder, parts, meta, logger } = opts;
  const configService = getConfigService();
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
    ? buildRenamedFilename(renameTemplate, { ...meta }, '.m4b')
    : `${sanitizeFilename(meta.title)}.m4b`;

  const tempOutput = path.join(tempDir, `merge_${opts.tempName}.m4b`);
  const tempFiles = [tempOutput];
  try {
    const chapters = await analyzeChapterFiles(parts, logger);
    if (chapters.length === 0) throw new Error('Chapter analysis found no usable files');
    if (await opts.isCancelled?.()) return { status: 'cancelled' };

    const result = await mergeChapters(chapters, {
      title: meta.title,
      author: meta.author,
      narrator: meta.narrator,
      year: meta.year,
      asin: meta.asin,
      outputPath: tempOutput,
      dirMode,
      onProgress: opts.onProgress,
      shouldCancel: opts.shouldCancel,
    }, logger);
    if (!result.success && result.error?.includes(MERGE_CANCELLED)) return { status: 'cancelled' };
    if (!result.success) throw new Error(`Merge failed: ${result.error}`);
    // Last safe point to stop: nothing in the library has been touched yet
    if (await opts.isCancelled?.()) return { status: 'cancelled' };
    await opts.onSwap?.();

    // Series tags (mergeChapters writes the rest); best-effort
    let source = tempOutput;
    if ((await configService.get('metadata_tagging_enabled')) === 'true') {
      const tagged = await tagAudioFileMetadata(tempOutput, meta);
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
    await logger?.info(`Wrote ${finalName} (${Math.round(srcStat.size / 1048576)}MB, ${result.chapterCount} chapters)`);

    // Merged file is in place — remove the parts
    const removed = parts.filter(p => path.resolve(p) !== path.resolve(finalPath));
    for (const part of removed) await fs.unlink(part);
    await logger?.info(`Removed ${removed.length} original part file(s)`);

    if (opts.audiobookId) {
      await prisma.audiobook.update({
        where: { id: opts.audiobookId },
        data: { fileFormat: 'm4b', fileSizeBytes: BigInt(srcStat.size), filesHash: generateFilesHash([finalPath]) || null },
      });
    }
    // ABS keeps its own chapter list (metadata.json wins on rescan) — give it the merged file's
    if (opts.absItemId && (await isAudiobookshelfBackend())) await syncFileChaptersToABS(opts.absItemId, finalPath, logger);

    return { status: 'merged', finalPath, finalName, chapterCount: result.chapterCount ?? 0, sizeBytes: srcStat.size };
  } finally {
    for (const file of tempFiles) await fs.unlink(file).catch(() => {});
  }
}
