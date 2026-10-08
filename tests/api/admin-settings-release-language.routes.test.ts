/**
 * Component: Admin Release Language Settings API Tests
 * Documentation: documentation/phase3/ranking-algorithm.md
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const requireAuthMock = vi.hoisted(() => vi.fn());
const requireAdminMock = vi.hoisted(() => vi.fn());
const configServiceMock = vi.hoisted(() => ({ get: vi.fn(), setMany: vi.fn() }));

vi.mock('@/lib/middleware/auth', () => ({ requireAuth: requireAuthMock, requireAdmin: requireAdminMock }));
vi.mock('@/lib/services/config.service', () => ({ getConfigService: () => configServiceMock }));

describe('Admin release language route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireAuthMock.mockImplementation((_req: any, handler: any) => handler({ user: { sub: 'admin-1', role: 'admin' } }));
    requireAdminMock.mockImplementation((_req: any, handler: any) => handler());
  });

  it('defaults to English when unset', async () => {
    configServiceMock.get.mockResolvedValue(null);
    const { GET } = await import('@/app/api/admin/settings/release-language/route');
    expect(await (await GET({} as any)).json()).toEqual({ language: 'english' });
  });

  it('saves a valid language', async () => {
    const { PUT } = await import('@/app/api/admin/settings/release-language/route');
    const response = await PUT({ json: async () => ({ language: 'any' }) } as any);

    expect(await response.json()).toEqual({ language: 'any' });
    expect(configServiceMock.setMany).toHaveBeenCalledWith([expect.objectContaining({ key: 'release_language', value: 'any' })]);
  });

  it('rejects an unknown language', async () => {
    const { PUT } = await import('@/app/api/admin/settings/release-language/route');
    const response = await PUT({ json: async () => ({ language: 'klingon' }) } as any);

    expect(response.status).toBe(400);
    expect(configServiceMock.setMany).not.toHaveBeenCalled();
  });
});
