/**
 * Component: Chapter List Builder (Chapter Merging)
 * Documentation: documentation/features/chapter-merging.md
 *
 * Picks the chapter markers for a merged M4B, best source first:
 * 1. Audnexus official chapters — only if marked accurate and the runtime matches
 * 2. Chapters embedded in the source files (e.g. m4b parts), offset per file
 * 3. One chapter per source file
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import type { ChapterFile } from './chapter-merger';
import type { RMABLogger } from './logger';
import { fetchAudnexusChapters, type AudnexusChapterData } from '../integrations/audnexus-chapters';

const execPromise = promisify(exec);

export interface ChapterMarker {
  title: string;
  startMs: number;
  endMs: number;
}

export type ChapterSource = 'audnexus' | 'embedded' | 'per-file';

/** Max allowed difference between Audnexus runtime and the merged audio. */
const RUNTIME_TOLERANCE_MS = 30_000;
const RUNTIME_TOLERANCE_RATIO = 0.005;

export function perFileChapters(files: ChapterFile[]): ChapterMarker[] {
  let start = 0;
  return files.map(file => {
    const marker = { title: file.chapterTitle, startMs: start, endMs: start + file.duration };
    start = marker.endMs;
    return marker;
  });
}

/** Audnexus chapters, or null if not accurate or the runtime doesn't match this recording. */
export function fitAudnexusChapters(data: AudnexusChapterData | null, totalMs: number): ChapterMarker[] | null {
  if (!data?.isAccurate || data.chapters.length === 0) return null;
  const tolerance = Math.max(RUNTIME_TOLERANCE_MS, totalMs * RUNTIME_TOLERANCE_RATIO);
  if (Math.abs(data.runtimeLengthMs - totalMs) > tolerance) return null;

  const sorted = [...data.chapters].sort((a, b) => a.startOffsetMs - b.startOffsetMs);
  return sorted.map((chapter, i) => ({
    title: chapter.title || `Chapter ${i + 1}`,
    startMs: Math.min(chapter.startOffsetMs, totalMs),
    endMs: i + 1 < sorted.length ? Math.min(sorted[i + 1].startOffsetMs, totalMs) : totalMs,
  })).filter(marker => marker.endMs > marker.startMs);
}

/** Chapters embedded in one audio file (ffprobe -show_chapters), relative to that file. */
export async function probeEmbeddedChapters(filePath: string): Promise<ChapterMarker[]> {
  try {
    const { stdout } = await execPromise(
      `ffprobe -v quiet -print_format json -show_chapters "${filePath}"`,
      { timeout: 30000 }
    );
    const chapters = JSON.parse(stdout)?.chapters;
    if (!Array.isArray(chapters)) return [];
    return chapters.map((c: any, i: number) => ({
      title: String(c.tags?.title ?? '').trim() || `Chapter ${i + 1}`,
      startMs: Math.round(parseFloat(c.start_time) * 1000) || 0,
      endMs: Math.round(parseFloat(c.end_time) * 1000) || 0,
    }));
  } catch {
    return [];
  }
}

/**
 * Concatenate per-file embedded chapters, offset by each file's start. Null unless every
 * file has embedded chapters and they add something over one-chapter-per-file.
 */
export function offsetEmbeddedChapters(files: ChapterFile[], embedded: ChapterMarker[][]): ChapterMarker[] | null {
  if (embedded.length !== files.length || embedded.some(list => list.length === 0)) return null;
  const total = embedded.reduce((sum, list) => sum + list.length, 0);
  if (total <= files.length) return null;

  const markers: ChapterMarker[] = [];
  let offset = 0;
  files.forEach((file, i) => {
    for (const chapter of embedded[i]) {
      const startMs = offset + Math.min(chapter.startMs, file.duration);
      const endMs = offset + Math.min(chapter.endMs || file.duration, file.duration);
      if (endMs > startMs) markers.push({ title: chapter.title, startMs, endMs });
    }
    offset += file.duration;
  });
  return markers;
}

export async function buildChapterList(
  files: ChapterFile[],
  options: { asin?: string },
  logger?: RMABLogger
): Promise<{ source: ChapterSource; chapters: ChapterMarker[] }> {
  const totalMs = files.reduce((sum, file) => sum + file.duration, 0);

  if (options.asin) {
    const data = await fetchAudnexusChapters(options.asin);
    const fitted = fitAudnexusChapters(data, totalMs);
    if (fitted) {
      await logger?.info(`Chapter source: Audnexus (${fitted.length} official chapters)`);
      return { source: 'audnexus', chapters: fitted };
    }
    if (data) {
      await logger?.info(
        `Audnexus chapters not used (accurate: ${data.isAccurate}, runtime ${Math.round(data.runtimeLengthMs / 1000)}s vs merged ${Math.round(totalMs / 1000)}s)`
      );
    }
  }

  const embedded = await Promise.all(files.map(file => probeEmbeddedChapters(file.path)));
  const offset = offsetEmbeddedChapters(files, embedded);
  if (offset) {
    await logger?.info(`Chapter source: embedded chapters from ${files.length} files (${offset.length} chapters)`);
    return { source: 'embedded', chapters: offset };
  }

  await logger?.info(`Chapter source: one chapter per file (${files.length} chapters)`);
  return { source: 'per-file', chapters: perFileChapters(files) };
}

/** FFMETADATA1 text for a chapter list. */
export function toFfmetadata(chapters: ChapterMarker[]): string {
  const escape = (title: string) =>
    title.replace(/\\/g, '\\\\').replace(/=/g, '\\=').replace(/;/g, '\\;').replace(/#/g, '\\#').replace(/\n/g, '');

  return chapters.reduce(
    (out, c) => `${out}\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=${c.startMs}\nEND=${c.endMs}\ntitle=${escape(c.title)}\n`,
    ';FFMETADATA1\n'
  );
}
