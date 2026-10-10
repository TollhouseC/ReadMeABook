/**
 * Component: Library Match Check Processor Tests
 * Documentation: documentation/features/library-match.md
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getABSLibraryItems: vi.fn(),
  triggerABSItemMatch: vi.fn(),
  getABSItem: vi.fn(),
  getProductsByAsins: vi.fn(),
  search: vi.fn(),
  configGet: vi.fn(),
  getBackendMode: vi.fn(),
}));

vi.mock('@/lib/services/audiobookshelf/api', () => ({
  getABSLibraryItems: mocks.getABSLibraryItems,
  triggerABSItemMatch: mocks.triggerABSItemMatch,
  getABSItem: mocks.getABSItem,
}));
vi.mock('@/lib/integrations/audible.service', () => ({
  getAudibleService: () => ({ getProductsByAsins: mocks.getProductsByAsins, search: mocks.search }),
}));
vi.mock('@/lib/services/config.service', () => ({
  getConfigService: () => ({ get: mocks.configGet, getBackendMode: mocks.getBackendMode }),
}));

const absItem = (id: string, relPath: string, title: string, asin: string | undefined, hours: number) => ({
  id, relPath, isFile: false, media: { duration: hours * 3600, metadata: { title, authorName: 'Terry Pratchett', asin } },
});

async function run(mode: 'report' | 'apply') {
  const { processMatchLibrary, matchTiming } = await import('@/lib/processors/match-library.processor');
  matchTiming.delayMs = 0;
  return processMatchLibrary({ mode });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getBackendMode.mockResolvedValue('audiobookshelf');
  mocks.configGet.mockResolvedValue('lib-1');
  mocks.getABSLibraryItems.mockResolvedValue([
    absItem('good', 'Terry Pratchett/Discworld/Mort', 'Mort', 'B0MORT', 7.5),
    absItem('bad', 'Terry Pratchett/Discworld/The Last Hero', 'Equal Rites', 'B0ER', 4.43),
  ]);
  mocks.getProductsByAsins.mockResolvedValue([
    { asin: 'B0MORT', title: 'Mort', author: 'Terry Pratchett', durationMinutes: 450 },
    { asin: 'B0ER', title: 'Equal Rites', author: 'Terry Pratchett', durationMinutes: 450 },
  ]);
  mocks.search.mockResolvedValue({ results: [
    { asin: 'B0LH', title: 'The Last Hero', author: 'Terry Pratchett', durationMinutes: 266 },
    { asin: 'B0ER', title: 'Equal Rites', author: 'Terry Pratchett', durationMinutes: 450 },
  ] });
});

describe('processMatchLibrary', () => {
  it('reports a wrong match without changing it, searching only suspects', async () => {
    const result = await run('report');

    expect(mocks.getProductsByAsins).toHaveBeenCalledWith(['B0MORT', 'B0ER']);
    expect(mocks.search).toHaveBeenCalledTimes(1);
    expect(mocks.search).toHaveBeenCalledWith('The Last Hero Terry Pratchett');
    expect(result).toMatchObject({ checked: 2, suspects: 1, would_rematch: 1, rematched: 0 });
    expect(mocks.triggerABSItemMatch).not.toHaveBeenCalled();
  });

  it('re-matches confident items in Audiobookshelf on apply, replacing the existing details', async () => {
    mocks.triggerABSItemMatch.mockResolvedValue({ updated: true, asin: 'B0LH' });
    const result = await run('apply');
    expect(mocks.triggerABSItemMatch).toHaveBeenCalledWith('bad', 'B0LH', { overrideDetails: true, overrideCover: true, throwOnError: true });
    expect(result).toMatchObject({ rematched: 1, failed: 0 });
  });

  it('reports a match Audiobookshelf did not apply instead of counting it as done', async () => {
    mocks.triggerABSItemMatch.mockResolvedValue({ updated: false, asin: 'B0ER' });
    expect(await run('apply')).toMatchObject({ rematched: 0, failed: 1 });

    mocks.triggerABSItemMatch.mockRejectedValue(new Error('ABS API error: 500'));
    expect(await run('apply')).toMatchObject({ rematched: 0, failed: 1 });
  });

  it('skips items with no audio (an ebook in the audiobook library)', async () => {
    mocks.getABSLibraryItems.mockResolvedValue([
      { id: 'epub', relPath: 'Ali Hazelwood/Love, Theoretically', isFile: false, media: { metadata: { title: 'Love, Theoretically', authorName: 'Ali Hazelwood' } } },
    ]);
    const result = await run('apply');
    expect(result).toMatchObject({ suspects: 0, rematched: 0 });
    expect(mocks.search).not.toHaveBeenCalled();
    expect(mocks.triggerABSItemMatch).not.toHaveBeenCalled();
  });

  it('names a file Audiobookshelf lists twice instead of calling it too much audio', async () => {
    const file = '/audiobooks/Terry Pratchett/Discworld/Mort/Mort.m4b';
    mocks.getABSLibraryItems.mockResolvedValue([absItem('dup', 'Terry Pratchett/Discworld/Mort', 'Mort', 'B0MORT', 15)]);
    mocks.search.mockResolvedValue({ results: [{ asin: 'B0MORT', title: 'Mort', author: 'Terry Pratchett', durationMinutes: 450 }] });
    mocks.getABSItem.mockResolvedValue({ media: { audioFiles: [{ metadata: { path: file } }, { metadata: { path: file } }] } });

    const result = await run('report');

    expect(mocks.getABSItem).toHaveBeenCalledWith('dup');
    expect(result).toMatchObject({ duplicate_tracks: 1, too_long: 0 });
  });

  it('does nothing on the Plex backend', async () => {
    mocks.getBackendMode.mockResolvedValue('plex');
    expect(await run('apply')).toMatchObject({ checked: 0 });
    expect(mocks.getABSLibraryItems).not.toHaveBeenCalled();
  });
});
