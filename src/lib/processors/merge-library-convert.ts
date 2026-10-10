/**
 * Component: Library Merge — single MP3 → M4B
 * Documentation: documentation/features/chapter-merging.md
 *
 * For a book folder holding exactly one MP3: report lists it with an estimated encode time;
 * apply converts it in place via mergeFolderInPlace (temp encode → validate → .partial →
 * swap → MP3 removed → record + Audiobookshelf chapters updated). Cancel leaves the MP3.
 */

import fs from 'fs/promises';
import path from 'path';
import type { RMABLogger } from '../utils/logger';
import type { JobProgressReporter } from '../utils/job-progress';
import { AUDIO_EXTENSIONS } from '../constants/audio-formats';
import { formatDuration, probeAudioFile } from '../utils/chapter-merger';
import { mergeFolderInPlace } from '../services/library-merge.service';
import { estimateConvertMinutes, isMp3 } from '../utils/mp3-convert';
import type { Candidate } from './fix-chapters.processor';

export type SingleFileOutcome = 'not_mp3' | 'would_convert' | 'converted' | 'cancelled' | 'unreadable';

export async function handleSingleMp3(params: {
  candidate: Candidate;
  folder: string;
  apply: boolean;
  index: number;
  logger: RMABLogger;
  progress: JobProgressReporter;
}): Promise<SingleFileOutcome> {
  const { candidate, folder, apply, index, logger, progress } = params;
  const entries = await fs.readdir(folder, { withFileTypes: true });
  const audio = entries.filter(e => e.isFile() && (AUDIO_EXTENSIONS as readonly string[]).includes(path.extname(e.name).toLowerCase()));
  if (audio.length !== 1 || !isMp3(audio[0].name)) return 'not_mp3';

  const file = path.join(folder, audio[0].name);
  let durationMs = 0;
  try {
    durationMs = (await probeAudioFile(file)).duration;
  } catch {
    await logger.warn(`Can't convert "${candidate.title}": ${audio[0].name} is unreadable — re-download it`);
    return 'unreadable';
  }
  const summary = `${audio[0].name} (${formatDuration(durationMs)}) → M4B — re-encode MP3 → AAC, about ${estimateConvertMinutes(durationMs)} min`;

  if (!apply) {
    await logger.info(`Would convert "${candidate.title}": ${summary}`);
    return 'would_convert';
  }

  await logger.info(`Converting "${candidate.title}": ${summary}`);
  const result = await mergeFolderInPlace({
    folder,
    parts: [file],
    meta: {
      title: candidate.title, author: candidate.author || 'Unknown Author', narrator: candidate.narrator,
      year: candidate.year, asin: candidate.asin, series: candidate.series, seriesPart: candidate.seriesPart,
    },
    audiobookId: candidate.audiobookId,
    absItemId: candidate.absItemId,
    logger,
    tempName: `convert_${index}_${Date.now()}`,
    onProgress: percent => { progress.update(index, { detail: `${candidate.title} — converting ${percent}%` }).catch(() => {}); },
    shouldCancel: () => progress.cancelledSync,
    isCancelled: () => progress.isCancelled({ fresh: true }),
    onSwap: () => progress.update(index, { detail: `${candidate.title} — swapping files in`, cancellable: false, force: true }),
  });
  if (result.status === 'cancelled') {
    await logger.warn(`Cancelled by admin during "${candidate.title}" — the MP3 was left untouched`);
    return 'cancelled';
  }
  await logger.info(`Converted "${candidate.title}" → ${result.finalName} (${result.chapterCount} chapters)`);
  return 'converted';
}
