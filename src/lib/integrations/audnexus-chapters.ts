/**
 * Component: Audnexus Chapter Lookup
 * Documentation: documentation/features/chapter-merging.md
 *
 * Fetches a book's official chapter list (titles + offsets) from Audnexus.
 * Returns null on any failure so callers can fall back to other chapter sources.
 */

import axios from 'axios';
import { AUDIBLE_REGIONS } from '../types/audible';
import type { AudibleRegion } from '../types/audible';

export interface AudnexusChapter {
  title: string;
  startOffsetMs: number;
  lengthMs: number;
}

export interface AudnexusChapterData {
  chapters: AudnexusChapter[];
  runtimeLengthMs: number;
  isAccurate: boolean;
}

async function resolveRegionParam(region?: AudibleRegion): Promise<string> {
  try {
    const resolved = region ?? (await (await import('../services/config.service')).getConfigService().getAudibleRegion());
    return AUDIBLE_REGIONS[resolved]?.audnexusParam ?? 'us';
  } catch {
    return 'us';
  }
}

export async function fetchAudnexusChapters(
  asin: string,
  region?: AudibleRegion
): Promise<AudnexusChapterData | null> {
  try {
    const { data } = await axios.get(`https://api.audnex.us/books/${asin}/chapters`, {
      params: { region: await resolveRegionParam(region) },
      timeout: 10000,
      headers: { 'User-Agent': 'ReadMeABook/1.0' },
    });

    if (!Array.isArray(data?.chapters) || data.chapters.length === 0 || !data.runtimeLengthMs) {
      return null;
    }

    return {
      chapters: data.chapters.map((c: any) => ({
        title: String(c.title ?? '').trim(),
        startOffsetMs: Number(c.startOffsetMs) || 0,
        lengthMs: Number(c.lengthMs) || 0,
      })),
      runtimeLengthMs: Number(data.runtimeLengthMs),
      isAccurate: data.isAccurate === true,
    };
  } catch {
    return null;
  }
}
