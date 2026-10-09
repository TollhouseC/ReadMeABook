/**
 * Component: Library Duplicate Cleanup
 * Documentation: documentation/features/chapter-merging.md
 *
 * Plans which audio files in a book folder are redundant copies of the same book:
 * e.g. the same book as .m4a AND .m4b, two full .m4b copies, a full .m4b next to an
 * old set of split parts, or truncated/unreadable leftovers. Uses the book's Audible
 * runtime to recognise "complete" copies.
 *
 * Only clearly redundant files are removed:
 *   - another complete single-file copy,
 *   - a complete duplicate set of parts (same format + naming, total ≈ runtime),
 *   - unreadable files (only when a readable complete copy is kept).
 * Anything else ("unexplained" audio, which could be a different book) is left in place,
 * and the folder is then not merged.
 */

import fs from 'fs/promises';
import path from 'path';
import { probeAudioFile } from '../utils/chapter-merger';
import { AUDIO_EXTENSIONS } from '../constants/audio-formats';

/** Best → worst for keeping (M4B first: chapters + no conversion needed). */
const FORMAT_PREFERENCE = ['.m4b', '.m4a', '.mp4', '.flac', '.mp3', '.aac'];
const RUNTIME_TOLERANCE_RATIO = 0.03;
const RUNTIME_TOLERANCE_MS = 2 * 60 * 1000;

export interface AudioFileInfo {
  path: string;
  ext: string;
  size: number;
  /** ms; null = unreadable */
  duration: number | null;
}

export interface RemovalItem {
  path: string;
  reason: 'duplicate full copy' | 'duplicate set of parts' | 'unreadable';
}

export interface CleanupPlan {
  /** Files that make up the one copy kept (≥2 → still needs merging) */
  keep: string[];
  remove: RemovalItem[];
  /** Audio not explained as a duplicate — left in place */
  unexplained: string[];
  /** false when no complete copy was found (nothing will be removed) */
  resolved: boolean;
}

const formatRank = (ext: string) => {
  const i = FORMAT_PREFERENCE.indexOf(ext);
  return i === -1 ? FORMAT_PREFERENCE.length : i;
};

export const matchesRuntime = (durationMs: number, expectedMs: number) =>
  Math.abs(durationMs - expectedMs) <= Math.max(RUNTIME_TOLERANCE_MS, expectedMs * RUNTIME_TOLERANCE_RATIO);

/** "Book Title - 03.m4b" / "Book Title - 07.m4b" → same set key; different naming → different set. */
function setKey(file: AudioFileInfo): string {
  const stem = path.basename(file.path, file.ext).toLowerCase().replace(/\d+/g, '#').replace(/[^a-z#]+/g, ' ').trim();
  return `${file.ext}|${stem}`;
}

export async function listAudioFiles(folder: string): Promise<AudioFileInfo[]> {
  const entries = await fs.readdir(folder, { withFileTypes: true });
  const files: AudioFileInfo[] = [];
  for (const e of entries) {
    const ext = path.extname(e.name).toLowerCase();
    if (!e.isFile() || !(AUDIO_EXTENSIONS as readonly string[]).includes(ext)) continue;
    const filePath = path.join(folder, e.name);
    const size = (await fs.stat(filePath)).size;
    let duration: number | null = null;
    try {
      duration = (await probeAudioFile(filePath)).duration || null;
    } catch {
      duration = null;
    }
    files.push({ path: filePath, ext, size, duration });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
}

interface CopyOption {
  files: AudioFileInfo[];
  kind: 'single' | 'set';
}

export function planFolderCleanup(files: AudioFileInfo[], expectedMs: number): CleanupPlan {
  const readable = files.filter(f => f.duration !== null);
  const unreadable = files.filter(f => f.duration === null);

  // Complete copies: single files ≈ runtime, and sets of parts (same format + naming) summing ≈ runtime
  const options: CopyOption[] = readable
    .filter(f => matchesRuntime(f.duration!, expectedMs))
    .map(f => ({ files: [f], kind: 'single' as const }));
  const sets = new Map<string, AudioFileInfo[]>();
  for (const f of readable) {
    if (options.some(o => o.files[0] === f)) continue; // a complete single isn't a part
    const key = setKey(f);
    sets.set(key, [...(sets.get(key) ?? []), f]);
  }
  for (const set of sets.values()) {
    if (set.length >= 2 && matchesRuntime(set.reduce((sum, f) => sum + f.duration!, 0), expectedMs)) {
      options.push({ files: set, kind: 'set' });
    }
  }

  if (options.length === 0) {
    return { keep: [], remove: [], unexplained: files.map(f => f.path), resolved: false };
  }

  // Keep: best format, then a single file over parts, then the larger copy
  const totalSize = (o: CopyOption) => o.files.reduce((sum, f) => sum + f.size, 0);
  options.sort((a, b) =>
    formatRank(a.files[0].ext) - formatRank(b.files[0].ext)
    || (a.kind === b.kind ? 0 : a.kind === 'single' ? -1 : 1)
    || totalSize(b) - totalSize(a));
  const [kept, ...duplicates] = options;

  const keepPaths = new Set(kept.files.map(f => f.path));
  const remove: RemovalItem[] = [];
  for (const dup of duplicates) {
    for (const f of dup.files) {
      if (!keepPaths.has(f.path)) remove.push({ path: f.path, reason: dup.kind === 'single' ? 'duplicate full copy' : 'duplicate set of parts' });
    }
  }
  for (const f of unreadable) remove.push({ path: f.path, reason: 'unreadable' });

  const accounted = new Set([...keepPaths, ...remove.map(r => r.path)]);
  return {
    keep: kept.files.map(f => f.path),
    remove,
    unexplained: files.filter(f => !accounted.has(f.path)).map(f => f.path),
    resolved: true,
  };
}
