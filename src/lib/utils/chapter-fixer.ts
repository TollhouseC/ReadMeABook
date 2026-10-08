/**
 * Component: Chapter Fixer (single-file books)
 * Documentation: documentation/features/chapter-merging.md
 *
 * Replaces a single-file M4B's chapters with Audnexus's official list when that list
 * matches the recording (accurate + runtime within tolerance) and the file's current
 * chapters are clearly worse. Audio is stream-copied (no re-encode); the new file is
 * validated and atomically swapped in, so any failure leaves the original untouched.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import type { RMABLogger } from './logger';
import { probeAudioFile } from './chapter-merger';
import { fitAudnexusChapters, probeEmbeddedChapters, toFfmetadata, type ChapterMarker } from './chapter-list';
import { fetchAudnexusChapters } from '../integrations/audnexus-chapters';

const execFilePromise = promisify(execFile);

/** Containers whose chapters can be rewritten with a stream copy. */
export const CHAPTER_FIX_FORMATS = ['.m4b', '.m4a', '.mp4'];

export type ChapterFixStatus = 'fixed' | 'would_fix' | 'kept' | 'skipped' | 'failed';

export interface ChapterFixResult {
  status: ChapterFixStatus;
  reason: string;
  currentCount: number;
  audnexusCount: number;
  /** Whether Audnexus was queried (callers throttle library-wide runs on this) */
  lookedUp: boolean;
}

const JUNK_TITLE_RE = /^\s*(?:track\s*)?\d+\s*$|\.(?:mp3|m4a|m4b|flac)$/i;
const GENERIC_CHAPTER_RE = /^\s*chapter\s*\d+\s*$/i;

/**
 * Why Audnexus chapters should replace the current ones, or null to keep them.
 * Similar chapters (even plain "Chapter 1, 2, …") are kept — swapping gains nothing.
 */
export function chapterReplacementReason(current: ChapterMarker[], audnexus: ChapterMarker[]): string | null {
  if (current.length <= 1) return `file has ${current.length} chapter(s), Audnexus has ${audnexus.length}`;
  if (current.length < audnexus.length * 0.5) return `only ${current.length} chapters vs ${audnexus.length} on Audnexus`;

  const titles = current.map(c => c.title.trim());
  if (new Set(titles.map(t => t.toLowerCase())).size === 1) return 'every chapter has the same name';

  const audnexusHasRealTitles = audnexus.some(c => !JUNK_TITLE_RE.test(c.title) && !GENERIC_CHAPTER_RE.test(c.title));
  if (titles.every(t => !t || JUNK_TITLE_RE.test(t)) && audnexusHasRealTitles) {
    return 'chapter names are only numbers/file names';
  }
  return null;
}

async function hasCoverStream(filePath: string): Promise<boolean> {
  try {
    const { stdout } = await execFilePromise('ffprobe', [
      '-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=index', '-of', 'csv=p=0', filePath,
    ], { timeout: 30000 });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/** Stream-copy the file with a new chapter list, validate, and swap it in place. */
export async function rewriteChapters(filePath: string, chapters: ChapterMarker[], durationMs: number): Promise<void> {
  const tempDir = process.env.TEMP_DIR || '/tmp/readmeabook';
  await fs.mkdir(tempDir, { recursive: true });
  const metadataFile = path.join(tempDir, `chapters_fix_${Date.now()}.txt`);
  const outputFile = `${filePath}.rmab-tmp`; // same folder → atomic rename; not an audio extension

  try {
    await fs.writeFile(metadataFile, toFfmetadata(chapters));
    const cover = await hasCoverStream(filePath);
    await execFilePromise('ffmpeg', [
      '-y', '-i', filePath, '-i', metadataFile,
      '-map', '0:a', ...(cover ? ['-map', '0:v'] : []),
      '-map_metadata', '0', '-map_chapters', '1',
      '-c', 'copy', ...(cover ? ['-disposition:v:0', 'attached_pic'] : []),
      '-movflags', '+faststart', '-f', 'mp4', outputFile,
    ], { timeout: 15 * 60 * 1000, maxBuffer: 10 * 1024 * 1024 });

    const [probe, written] = await Promise.all([probeAudioFile(outputFile), probeEmbeddedChapters(outputFile)]);
    if (Math.abs(probe.duration - durationMs) > Math.max(5000, durationMs * 0.01)) {
      throw new Error(`duration changed (${Math.round(durationMs / 1000)}s → ${Math.round(probe.duration / 1000)}s)`);
    }
    if (written.length !== chapters.length) {
      throw new Error(`wrote ${written.length} chapters, expected ${chapters.length}`);
    }

    const { mode } = await fs.stat(filePath);
    await fs.chmod(outputFile, mode).catch(() => {});
    await fs.rename(outputFile, filePath);
  } finally {
    await fs.unlink(metadataFile).catch(() => {});
    await fs.unlink(outputFile).catch(() => {});
  }
}

/**
 * Check one single-file book and (when `apply`) replace its chapters if Audnexus is better.
 * Never throws — failures are reported in the result.
 */
export async function fixChaptersIfBetter(
  filePath: string,
  asin: string | null | undefined,
  options: { apply: boolean; logger?: RMABLogger }
): Promise<ChapterFixResult> {
  const result = (status: ChapterFixStatus, reason: string, currentCount = 0, audnexusCount = 0, lookedUp = false): ChapterFixResult =>
    ({ status, reason, currentCount, audnexusCount, lookedUp });

  if (!asin) return result('skipped', 'no ASIN');
  if (!CHAPTER_FIX_FORMATS.includes(path.extname(filePath).toLowerCase())) {
    return result('skipped', `unsupported format ${path.extname(filePath)}`);
  }

  try {
    const [probe, current] = await Promise.all([probeAudioFile(filePath), probeEmbeddedChapters(filePath)]);
    const data = await fetchAudnexusChapters(asin);
    const audnexus = fitAudnexusChapters(data, probe.duration);
    if (!audnexus) {
      const why = !data ? 'no Audnexus chapter data' : !data.isAccurate ? 'Audnexus chapters not marked accurate'
        : `runtime mismatch (file ${Math.round(probe.duration / 1000)}s vs Audnexus ${Math.round(data.runtimeLengthMs / 1000)}s)`;
      return result('skipped', why, current.length, data?.chapters.length ?? 0, true);
    }

    const reason = chapterReplacementReason(current, audnexus);
    if (!reason) return result('kept', 'current chapters are fine', current.length, audnexus.length, true);
    if (!options.apply) return result('would_fix', reason, current.length, audnexus.length, true);

    await rewriteChapters(filePath, audnexus, probe.duration);
    await options.logger?.info(`Replaced chapters with Audnexus (${current.length} → ${audnexus.length}): ${path.basename(filePath)} — ${reason}`);
    return result('fixed', reason, current.length, audnexus.length, true);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await options.logger?.warn(`Chapter fix failed for ${path.basename(filePath)}: ${message}`);
    return result('failed', message, 0, 0, true);
  }
}

/** The single chapter-fixable audio file in a folder, or null with why not. */
export async function findSingleAudioFile(
  folder: string,
  audioExtensions: readonly string[]
): Promise<{ file: string | null; reason?: string }> {
  const entries = await fs.readdir(folder, { withFileTypes: true });
  const audio = entries.filter(e => e.isFile() && audioExtensions.includes(path.extname(e.name).toLowerCase()));
  if (audio.length !== 1) return { file: null, reason: `${audio.length} audio files (merge first)` };
  const file = path.join(folder, audio[0].name);
  if (!CHAPTER_FIX_FORMATS.includes(path.extname(file).toLowerCase())) {
    return { file: null, reason: `unsupported format ${path.extname(file)}` };
  }
  return { file };
}
