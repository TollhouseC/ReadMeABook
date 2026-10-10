/**
 * Component: Series API — archived series handling
 * Documentation: documentation/features/watched-lists.md
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  scrapeSeriesPage: vi.fn(),
  getSavedReplacement: vi.fn(),
  followArchivedSeries: vi.fn(),
}));

vi.mock('@/lib/middleware/auth', () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock('@/lib/integrations/audible-series', () => ({ scrapeSeriesPage: mocks.scrapeSeriesPage }));
vi.mock('@/lib/services/archived-series', () => ({
  isArchivedSeriesTitle: (t?: string) => !!t && t.includes('[ARCHIVED]'),
  getSavedReplacement: mocks.getSavedReplacement,
  followArchivedSeries: mocks.followArchivedSeries,
}));
vi.mock('@/lib/utils/audiobook-matcher', () => ({ enrichAudiobooksWithMatches: vi.fn(async (b: unknown[]) => b) }));
vi.mock('@/lib/utils/deduplicate-audiobooks', () => ({ deduplicateAndCollectGroups: (books: unknown[]) => ({ books, groups: [] }) }));
vi.mock('@/lib/services/works.service', () => ({ persistDedupGroups: vi.fn() }));
vi.mock('@/lib/utils/ignored-audiobooks', () => ({ annotateWithIgnoreStatus: vi.fn(async (b: unknown[]) => b) }));

const OLD = 'B005NBPHB8';
const NEW = { asin: 'B0H363Q436', title: 'Chronicles of the Black Company', from: 'Black Company [ARCHIVED]' };
const req = (body?: unknown) => ({
  nextUrl: new URL(`http://x/api/series/${OLD}?page=1`),
  json: async () => body ?? {},
}) as any;
const params = { params: Promise.resolve({ asin: OLD }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCurrentUser.mockReturnValue({ sub: 'u1' });
  mocks.getSavedReplacement.mockResolvedValue(null);
});

describe('GET /api/series/[asin]', () => {
  it('answers right away for an archived series, without looking for the replacement', async () => {
    mocks.scrapeSeriesPage.mockResolvedValue({ asin: OLD, title: 'Black Company [ARCHIVED]', books: [], bookCount: 0, similarSeries: [], hasMore: false, page: 1 });
    const { GET } = await import('@/app/api/series/[asin]/route');
    const body = await (await GET(req(), params)).json();

    expect(body).toMatchObject({ archived: true, series: { title: 'Black Company [ARCHIVED]', books: [] } });
    expect(mocks.followArchivedSeries).not.toHaveBeenCalled();
  });

  it('redirects instantly to a replacement found earlier', async () => {
    mocks.getSavedReplacement.mockResolvedValue(NEW);
    const { GET } = await import('@/app/api/series/[asin]/route');
    const body = await (await GET(req(), params)).json();

    expect(body).toMatchObject({ movedTo: NEW });
    expect(mocks.scrapeSeriesPage).not.toHaveBeenCalled();
  });
});

describe('POST /api/series/[asin]/replacement', () => {
  it('finds the replacement and reports it', async () => {
    mocks.followArchivedSeries.mockResolvedValue(NEW);
    const { POST } = await import('@/app/api/series/[asin]/replacement/route');
    const body = await (await POST(req({ title: 'Black Company [ARCHIVED]' }), params)).json();

    expect(mocks.followArchivedSeries).toHaveBeenCalledWith(OLD, 'Black Company [ARCHIVED]', expect.anything());
    expect(body).toEqual({ success: true, movedTo: NEW });
  });

  it('returns null when nothing replaced it, and requires a login', async () => {
    mocks.followArchivedSeries.mockResolvedValue(null);
    const { POST } = await import('@/app/api/series/[asin]/replacement/route');
    expect(await (await POST(req({ title: 'X [ARCHIVED]' }), params)).json()).toEqual({ success: true, movedTo: null });

    mocks.getCurrentUser.mockReturnValue(null);
    expect((await POST(req(), params)).status).toBe(401);
  });
});
