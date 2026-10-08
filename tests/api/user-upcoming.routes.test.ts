/**
 * Component: Upcoming Releases API Route Tests
 * Documentation: documentation/features/watched-lists.md
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireAuthMock = vi.hoisted(() => vi.fn());
const getUpcomingMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/middleware/auth', () => ({ requireAuth: requireAuthMock }));
vi.mock('@/lib/services/upcoming-releases.service', () => ({ getUpcomingReleasesForUser: getUpcomingMock }));

describe('GET /api/user/upcoming', () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the current user's upcoming releases", async () => {
    requireAuthMock.mockImplementation((_req: any, handler: any) => handler({ user: { id: 'user-1' } }));
    getUpcomingMock.mockResolvedValue([{ asin: 'B1', title: 'Soon', releaseDate: '2026-11-01' }]);

    const { GET } = await import('@/app/api/user/upcoming/route');
    const payload = await (await GET({} as any)).json();

    expect(getUpcomingMock).toHaveBeenCalledWith('user-1');
    expect(payload).toEqual({ success: true, upcoming: [{ asin: 'B1', title: 'Soon', releaseDate: '2026-11-01' }] });
  });

  it('rejects unauthenticated requests', async () => {
    requireAuthMock.mockImplementation((_req: any, handler: any) => handler({ user: null }));
    const { GET } = await import('@/app/api/user/upcoming/route');
    expect((await GET({} as any)).status).toBe(401);
  });
});
