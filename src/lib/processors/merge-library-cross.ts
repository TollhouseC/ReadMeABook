/**
 * Component: Library Merge — duplicates across folders
 * Documentation: documentation/features/chapter-merging.md
 *
 * The same book (same ASIN) in two folders — e.g. "Shirtaloon, Travis Deverell/…" and
 * "Travis Deverell Shirtaloon/…" (same author, name order differs). The best complete
 * copy is kept; another folder holding a copy of the same length is removed (its audio,
 * cover and metadata files, then the empty folder). A copy with a different length is
 * never deleted — it's reported as an alert.
 */

import fs from 'fs/promises';
import path from 'path';
import type { RMABLogger } from '../utils/logger';
import { formatDuration } from '../utils/chapter-merger';
import { checkRuntime } from '../services/library-merge.service';
import { listAudioFiles, planFolderCleanup, sameLength, type AudioFileInfo } from '../services/library-dedupe.service';
import { AUDIO_EXTENSIONS } from '../constants/audio-formats';
import { stripVersionMarkers } from '../utils/book-versions';
import type { Candidate } from './fix-chapters.processor';

const FORMAT_PREFERENCE = ['.m4b', '.m4a', '.mp4', '.flac', '.mp3', '.aac'];
/** Non-audio files that belong to a book folder (removed with it) */
const SIDECAR_RE = /^(cover\.(jpe?g|png|webp)|folder\.(jpe?g|png)|metadata\.(json|abs)|desc\.txt|reader\.txt|.*\.(opf|nfo|cue))$/i;

interface FolderCopy {
  candidate: Candidate;
  folder: string;
  files: AudioFileInfo[];
  keep: AudioFileInfo[];
  keptMs: number;
  complete: boolean;
  /** Audio in the folder not explained as a duplicate (blocks deleting the folder) */
  unexplained: number;
}

export interface CrossFolderOutcome {
  /** Folders handled here — the per-folder pass skips them */
  skipFolders: Set<string>;
  foldersRemoved: number;
  foldersToRemove: number;
  alerts: number;
}

const normalizeName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Editions kept on purpose next to the standard one (path or folder names say so). */
const ALTERNATE_EDITION_RE = /graphic\s*audio|dramati[sz](?:ed|ation)|full[\s-]*cast|first\s*drafts?|non[\s-]*canon/i;
const isAlternateEdition = (folder: string) => ALTERNATE_EDITION_RE.test(folder);
/** Title / folder name without edition labels ("[Dramatized Adaptation]"), for comparing books */
const bookKey = (s: string) => normalizeName(stripVersionMarkers(s));
const formatRank = (ext: string) => {
  const i = FORMAT_PREFERENCE.indexOf(ext);
  return i === -1 ? FORMAT_PREFERENCE.length : i;
};

function rankCopy(a: FolderCopy, b: FolderCopy): number {
  const ext = (c: FolderCopy) => path.extname(c.keep[0].path).toLowerCase();
  const size = (c: FolderCopy) => c.keep.reduce((sum, f) => sum + f.size, 0);
  return formatRank(ext(a)) - formatRank(ext(b)) || a.keep.length - b.keep.length || size(b) - size(a);
}

/** Remove a duplicate book folder: its audio + sidecar files, then the folder if empty. */
async function removeBookFolder(folder: string): Promise<void> {
  const entries = await fs.readdir(folder, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isFile()) continue;
    const isAudio = (AUDIO_EXTENSIONS as readonly string[]).includes(path.extname(e.name).toLowerCase());
    if (isAudio || SIDECAR_RE.test(e.name)) await fs.unlink(path.join(folder, e.name));
  }
  await fs.rmdir(folder).catch(() => {}); // only succeeds if nothing else is left
}

export async function handleCrossFolderDuplicates(
  candidates: Candidate[],
  options: { apply: boolean; logger: RMABLogger; throttle: () => Promise<void> }
): Promise<CrossFolderOutcome> {
  const { apply, logger } = options;
  const outcome: CrossFolderOutcome = { skipFolders: new Set(), foldersRemoved: 0, foldersToRemove: 0, alerts: 0 };

  const byAsin = new Map<string, Candidate[]>();
  for (const c of candidates) {
    if (!c.folder || !c.asin) continue;
    const key = c.asin.toLowerCase();
    const list = byAsin.get(key) ?? [];
    if (!list.some(o => path.resolve(o.folder!) === path.resolve(c.folder!))) list.push(c);
    byAsin.set(key, list);
  }

  for (const group of byAsin.values()) {
    if (group.length < 2) continue;
    const title = group[0].title;
    const { expectedMs } = await checkRuntime(0, group[0].asin);
    await options.throttle();
    if (!expectedMs) {
      outcome.alerts++;
      await logger.warn(`Same book in ${group.length} folders, no Audible runtime to compare — not deleted: "${title}" in ${group.map(c => c.folder).join(' | ')}`);
      group.forEach(c => outcome.skipFolders.add(path.resolve(c.folder!)));
      continue;
    }

    const copies: FolderCopy[] = [];
    for (const candidate of group) {
      const files = await listAudioFiles(candidate.folder!);
      if (files.length === 0) continue;
      const plan = planFolderCleanup(files, expectedMs);
      const keep = files.filter(f => plan.keep.includes(f.path));
      copies.push({
        candidate, folder: candidate.folder!, files, keep,
        keptMs: keep.reduce((sum, f) => sum + (f.duration ?? 0), 0),
        complete: plan.resolved,
        unexplained: plan.unexplained.length,
      });
    }
    const complete = copies.filter(c => c.complete).sort(rankCopy);
    if (complete.length === 0 || copies.length < 2) continue; // per-folder pass reports these

    const best = complete[0];
    const bestTitle = best.candidate.title;
    for (const other of copies) {
      if (other === best) continue;
      outcome.skipFolders.add(path.resolve(other.folder));
      const otherTitle = other.candidate.title;
      const otherTotal = other.files.reduce((sum, f) => sum + (f.duration ?? 0), 0);
      const where = (c: FolderCopy, ms: number) => `"${c.candidate.title}" (${c.folder}, ${formatDuration(ms)})`;

      // Same ASIN but different titles or folder names = two books matched to one ASIN in
      // Audiobookshelf (e.g. "The Poppy War 02" and "03", or a folder whose ABS title was overwritten)
      if (bookKey(otherTitle) !== bookKey(bestTitle) || bookKey(path.basename(other.folder)) !== bookKey(path.basename(best.folder))) {
        outcome.alerts++;
        await logger.warn(`Same ASIN on different books — check their match in Audiobookshelf: ${where(best, best.keptMs)} vs ${where(other, otherTotal)}`);
        continue;
      }
      // Graphic Audio / dramatized / first-draft editions are kept on purpose
      if (isAlternateEdition(other.folder) !== isAlternateEdition(best.folder)) {
        await logger.info(`Alternate version kept: ${where(other, otherTotal)} alongside ${where(best, best.keptMs)}`);
        continue;
      }

      // Whole-folder removal only for a clean same-length copy (nothing else in that folder)
      const sameName = normalizeName(path.basename(other.folder)) === normalizeName(path.basename(best.folder));
      const sameCopy = other.complete && other.unexplained === 0 && sameLength(other.keptMs, best.keptMs) && sameName;
      if (!sameCopy) {
        outcome.alerts++;
        await logger.warn(
          `Another copy of "${title}" with a different length — not deleted: ${other.folder} ` +
          `(${other.files.length} file(s), ${formatDuration(otherTotal)}); keeping ${best.folder} (${formatDuration(best.keptMs)})`
        );
        continue;
      }
      if (!apply) {
        outcome.foldersToRemove++;
        await logger.info(`Would remove duplicate folder of "${title}": ${other.folder} (${other.files.length} file(s), same length) — keeping ${best.folder}`);
        continue;
      }
      await removeBookFolder(other.folder);
      outcome.foldersRemoved++;
      await logger.info(`Removed duplicate folder of "${title}": ${other.folder} — kept ${best.folder}`);
    }
  }

  return outcome;
}
