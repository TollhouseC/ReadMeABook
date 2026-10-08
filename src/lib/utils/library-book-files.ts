/**
 * Component: Library Book Files Helpers
 * Documentation: documentation/features/chapter-merging.md
 *
 * Locate an imported book's folder in the library and trigger a library rescan.
 * Shared by the merge-library-book and fix-chapters jobs.
 */

import fs from 'fs/promises';
import path from 'path';
import { RMABLogger } from './logger';
import { getConfigService } from '../services/config.service';
import { getLibraryService } from '../services/library';
import { buildAudiobookPath } from './file-organizer';

export interface BookRecord {
  id: string;
  title: string;
  author: string;
  narrator: string | null;
  audibleAsin: string | null;
  year: number | null;
  series: string | null;
  seriesPart: string | null;
  filePath: string | null;
  absItemId: string | null;
}

export async function isDirectory(dir: string | null | undefined): Promise<boolean> {
  if (!dir) return false;
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

export function isInside(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** Library folder: organize's recorded path → Audiobookshelf item path → path template. */
export async function resolveBookFolder(book: BookRecord, mediaDir: string, logger?: RMABLogger): Promise<string | null> {
  const candidates: Array<[string, string | null]> = [['recorded file path', book.filePath]];

  if (book.absItemId) {
    try {
      const { getABSItem } = await import('../services/audiobookshelf/api');
      const item = await getABSItem(book.absItemId);
      candidates.push(['Audiobookshelf item path', item?.path ?? null]);
    } catch (error) {
      await logger?.warn(`Could not read Audiobookshelf item ${book.absItemId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const template = (await getConfigService().get('audiobook_path_template')) || '{author}/{title} {asin}';
  candidates.push(['path template', buildAudiobookPath(mediaDir, template, {
    author: book.author,
    title: book.title,
    narrator: book.narrator || undefined,
    asin: book.audibleAsin || undefined,
    year: book.year || undefined,
    series: book.series || undefined,
    seriesPart: book.seriesPart || undefined,
  })]);

  for (const [source, dir] of candidates) {
    if (dir && isInside(dir, mediaDir) && (await isDirectory(dir))) {
      await logger?.info(`Library folder (${source}): ${dir}`);
      return dir;
    }
  }
  return null;
}

/** Trigger a library scan if the backend's "scan after import" setting is on. */
export async function triggerLibraryScan(logger: RMABLogger): Promise<void> {
  const configService = getConfigService();
  const backendMode = await configService.getBackendMode();
  const scanKey = backendMode === 'audiobookshelf' ? 'audiobookshelf.trigger_scan_after_import' : 'plex.trigger_scan_after_import';
  if ((await configService.get(scanKey)) !== 'true') {
    await logger.info(`Library scan after import is disabled — ${backendMode} will pick up the change on its next scan`);
    return;
  }
  try {
    const libraryId = backendMode === 'audiobookshelf'
      ? await configService.get('audiobookshelf.library_id')
      : await configService.get('plex_audiobook_library_id');
    if (!libraryId) throw new Error('Library ID not configured');
    await (await getLibraryService()).triggerLibraryScan(libraryId);
    await logger.info(`Triggered ${backendMode} library scan`);
  } catch (error) {
    await logger.warn(`Library scan failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
