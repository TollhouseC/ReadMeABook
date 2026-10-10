/**
 * Component: Single MP3 → M4B Conversion
 * Documentation: documentation/features/chapter-merging.md
 *
 * A book that is one MP3 file gets no chapters (Chapter Fix only handles M4B/M4A/MP4) and
 * was never converted (merging needs 2+ parts). This re-encodes it to AAC/M4B through the
 * same merge pipeline: source bitrate kept (determineOutputBitrate), chapters from Audnexus
 * when its runtime fits, else the MP3's own, else one; the output is validated (length
 * within 2%, start and end decode) before anything replaces the MP3.
 */

import path from 'path';
import { analyzeChapterFiles, mergeChapters } from './chapter-merger';
import type { RMABLogger } from './logger';

export const isMp3 = (file: string) => path.extname(file).toLowerCase() === '.mp3';

/** Rough encode time at ~50× real time (for reports). */
export const estimateConvertMinutes = (durationMs: number) => Math.max(1, Math.round(durationMs / 60_000 / 50));

export interface ConvertMeta {
  title: string;
  author: string;
  narrator?: string;
  year?: number;
  asin?: string;
}

/** Encode one MP3 to an M4B at `outputPath` (temp location). The source is never touched. */
export async function convertMp3ToM4b(
  sourcePath: string,
  meta: ConvertMeta,
  outputPath: string,
  dirMode: number,
  logger?: RMABLogger
): Promise<{ success: boolean; outputPath?: string; error?: string }> {
  const chapters = await analyzeChapterFiles([sourcePath], logger);
  if (chapters.length === 0) return { success: false, error: 'could not read the MP3' };
  const result = await mergeChapters(chapters, { ...meta, outputPath, dirMode }, logger);
  return result.success ? { success: true, outputPath: result.outputPath ?? outputPath } : { success: false, error: result.error };
}
