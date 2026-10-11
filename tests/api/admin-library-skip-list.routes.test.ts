/**
 * Component: Admin Library Skip List API Tests
 * Documentation: documentation/backend/services/jobs.md
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaMock } from '../helpers/prisma';

const prismaMock = createPrismaMock();
const requireAuthMock = vi.hoisted(() => vi.fn());
const requireAdminMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/db', () => ({ prisma: prismaMock }));
vi.mock('@/lib/middleware/auth', () => ({ requireAuth: requireAuthMock, requireAdmin: requireAdminMock }));

const request = (body: unknown) => ({ json: async () => body }) as any;

describe('/api/admin/settings/library-skip-list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireAuthMock.mockImplementation((_req: any, handler: any) => handler({ user: { sub: 'admin-1', role: 'admin' } }));
    requireAdminMock.mockImplementation((_req: any, handler: any) => handler());
    prismaMock.configuration.upsert.mockResolvedValue({});
  });

  it('returns the saved text with its entry count', async () => {
    prismaMock.configuration.findUnique.mockResolvedValue({ value: 'A/B | match | x\n# note' });
    const { GET } = await import('@/app/api/admin/settings/library-skip-list/route');
    expect(await (await GET({} as any)).json()).toEqual({ text: 'A/B | match | x\n# note', entries: 1, errors: [] });
  });

  it('replaces the list and reports lines it will ignore', async () => {
    const { PUT } = await import('@/app/api/admin/settings/library-skip-list/route');
    const res = await PUT(request({ text: 'A/B | match | kept\nC/D | nope' }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.entries).toBe(1);
    expect(body.errors[0]).toContain('Line 2');
    expect(prismaMock.configuration.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: { value: 'A/B | match | kept\nC/D | nope' } }));
  });

  it('rejects a body without text', async () => {
    const { PUT } = await import('@/app/api/admin/settings/library-skip-list/route');
    expect((await PUT(request({ list: [] }))).status).toBe(400);
  });
});
