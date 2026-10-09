/**
 * Component: Library Match Check Processor Tests
 * Documentation: documentation/features/library-match.md
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getABSLibraryItems: vi.fn(),
  triggerABSItemMatch: vi.fn(),
  getProductsByAsins: vi.fn(),
  search: vi.fn(),
  configGet: vi.fn(),
  getBackendMode: vi.fn(),
}));

vi.mock('@/lib/services/audiobookshelf/api', () => ({
  getABSLibraryItems: mocks.getABSLibraryItems,
  triggerABSItemMatch: mocks.triggerABSItemMatch,
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

  it('re-matches confident items in Audiobookshelf on apply', async () => {
    const result = await run('apply');
    expect(mocks.triggerABSItemMatch).toHaveBeenCalledWith('bad', 'B0LH');
    expect(result).toMatchObject({ rematched: 1 });
  });

  it('does nothing on the Plex backend', async () => {
    mocks.getBackendMode.mockResolvedValue('plex');
    expect(await run('apply')).toMatchObject({ checked: 0 });
    expect(mocks.getABSLibraryItems).not.toHaveBeenCalled();
  });
});
