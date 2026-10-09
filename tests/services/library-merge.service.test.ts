/**
 * Component: Library Merge Service Tests
 * Documentation: documentation/features/chapter-merging.md
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtimeMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/integrations/audible.service', () => ({ getAudibleService: () => ({ getRuntime: runtimeMock }) }));
vi.mock('@/lib/db', () => ({ prisma: {} }));

import { checkRuntime, listMergeableParts, needsReencode } from '@/lib/services/library-merge.service';

let dir: string;
const touch = (name: string) => fs.writeFile(path.join(dir, name), 'x');

beforeEach(async () => {
  vi.clearAllMocks();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmab-libmerge-'));
});

describe('listMergeableParts', () => {
  it('returns 2+ same-format parts in natural order, ignoring covers', async () => {
    for (const f of ['Book - 10.mp3', 'Book - 2.mp3', 'Book - 1.mp3', 'cover.jpg']) await touch(f);
    const check = await listMergeableParts(dir);
    expect(check).toEqual({
      ok: true, format: '.mp3',
      parts: ['Book - 1.mp3', 'Book - 2.mp3', 'Book - 10.mp3'].map(f => path.join(dir, f)),
    });
  });

  it('rejects single files, mixed formats and unsupported formats', async () => {
    await touch('Book.m4b');
    expect(await listMergeableParts(dir)).toMatchObject({ ok: false, reason: 'single_file' });
    await touch('extra.mp3');
    expect(await listMergeableParts(dir)).toMatchObject({ ok: false, reason: 'mixed_formats' });

    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'rmab-libmerge-ogg-'));
    for (const f of ['a.ogg', 'b.ogg']) await fs.writeFile(path.join(other, f), 'x');
    expect(await listMergeableParts(other)).toMatchObject({ ok: false, reason: 'unsupported_format' });
  });
});

describe('checkRuntime', () => {
  it('matches within max(3%, 2 min) of the Audible runtime', async () => {
    runtimeMock.mockResolvedValue(600); // 10h
    expect(await checkRuntime(600 * 60_000 + 17 * 60_000, 'B0X')).toEqual({ expectedMs: 36_000_000, matches: true });
    expect((await checkRuntime(600 * 60_000 + 20 * 60_000, 'B0X')).matches).toBe(false);
    expect((await checkRuntime(300 * 60_000, 'B0X')).matches).toBe(false); // half a book
  });

  it('is unknown without an ASIN or runtime', async () => {
    expect(await checkRuntime(1000, null)).toEqual({ expectedMs: null, matches: null });
    runtimeMock.mockResolvedValue(null);
    expect(await checkRuntime(1000, 'B0X')).toEqual({ expectedMs: null, matches: null });
  });
});

describe('needsReencode', () => {
  it('re-encodes everything except m4b/mp4', () => {
    expect(needsReencode('.mp3')).toBe(true);
    expect(needsReencode('.m4a')).toBe(true);
    expect(needsReencode('.m4b')).toBe(false);
  });
});
