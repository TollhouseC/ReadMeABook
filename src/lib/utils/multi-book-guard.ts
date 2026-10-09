/**
 * Component: Multi-Book Import Guard
 * Documentation: documentation/phase3/file-organization.md
 *
 * A single-book import whose audio adds up to far more than the book's Audible runtime is
 * almost always several books — a whole-series torrent or a folder holding other books.
 * Importing it copied an entire series into one book's folder (HWFwM 10 got books 2–9).
 * Unknown runtime (no ASIN / Audnexus miss) → no check.
 */

import { probeAudioFile } from './chapter-merger';

/** Audio longer than this × the book's runtime is refused. */
export const MULTI_BOOK_RATIO = 1.8;

export interface MultiBookResult {
  totalMs: number;
  expectedMs: number;
}

/** Returns the totals when the files are too long to be one book; null when the import is fine. */
export async function checkMultiBookImport(filePaths: string[], asin?: string | null): Promise<MultiBookResult | null> {
  if (!asin || filePaths.length === 0) return null;

  let minutes: number | null = null;
  try {
    const { getAudibleService } = await import('../integrations/audible.service');
    minutes = await getAudibleService().getRuntime(asin);
  } catch {
    minutes = null;
  }
  if (!minutes) return null;

  const expectedMs = minutes * 60_000;
  const limit = expectedMs * MULTI_BOOK_RATIO;
  let totalMs = 0;
  for (const file of filePaths) {
    try {
      totalMs += (await probeAudioFile(file)).duration || 0;
    } catch {
      // unreadable → contributes nothing
    }
  }
  return totalMs > limit ? { totalMs, expectedMs } : null;
}

const hours = (ms: number) => `${(ms / 3_600_000).toFixed(1)}h`;

export function describeMultiBook(result: MultiBookResult, title: string): string {
  return `Download holds ${hours(result.totalMs)} of audio but "${title}" is ${hours(result.expectedMs)} on Audible — ` +
    'it looks like several books (a series torrent or a shared folder). Not importing; use Manual Import to pick this book\'s files';
}
