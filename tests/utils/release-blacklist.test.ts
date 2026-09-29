/**
 * Component: Release Blacklist Utility Tests
 * Documentation: documentation/backend/services/scheduler.md
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaMock } from '../helpers/prisma';
import type { TorrentResult } from '@/lib/utils/ranking-algorithm';

const prismaMock = createPrismaMock();

vi.mock('@/lib/db', () => ({
  prisma: prismaMock,
}));

function result(overrides: Partial<TorrentResult>): TorrentResult {
  return {
    indexer: 'AudioBook Bay',
    title: 'Wild Side - Elsie Silver [M4B]',
    size: 700_000_000,
    seeders: 1,
    publishDate: new Date('2026-01-01'),
    downloadUrl: 'http://prowlarr/download/1',
    guid: 'guid-1',
    ...overrides,
  };
}

const entry = (overrides: Partial<{ title: string; indexerName: string | null; infoHash: string | null; releaseUrl: string | null }>) => ({
  title: 'Something Else',
  indexerName: null,
  infoHash: null,
  releaseUrl: null,
  ...overrides,
});

describe('isResultBlacklisted', () => {
  it('matches on info hash, case-insensitively', async () => {
    const { isResultBlacklisted } = await import('@/lib/utils/release-blacklist');
    expect(isResultBlacklisted(
      result({ infoHash: 'A280808F236CDA306EEE9F5E0F0592CA3E1EBA2E' }),
      [entry({ infoHash: 'a280808f236cda306eee9f5e0f0592ca3e1eba2e' })]
    )).toBe(true);
  });

  it('matches on indexer page URL or guid', async () => {
    const { isResultBlacklisted } = await import('@/lib/utils/release-blacklist');
    expect(isResultBlacklisted(result({ infoUrl: 'https://abb/page/1' }), [entry({ releaseUrl: 'https://abb/page/1' })])).toBe(true);
    expect(isResultBlacklisted(result({ guid: 'https://abb/page/2' }), [entry({ releaseUrl: 'https://abb/page/2' })])).toBe(true);
  });

  it('matches on title + indexer, ignoring case and extra whitespace', async () => {
    const { isResultBlacklisted } = await import('@/lib/utils/release-blacklist');
    expect(isResultBlacklisted(
      result({}),
      [entry({ title: '  wild side -  elsie silver [m4b] ', indexerName: 'audiobook bay' })]
    )).toBe(true);
  });

  it('does not match the same title from a different indexer', async () => {
    const { isResultBlacklisted } = await import('@/lib/utils/release-blacklist');
    expect(isResultBlacklisted(
      result({}),
      [entry({ title: 'Wild Side - Elsie Silver [M4B]', indexerName: 'LimeTorrents' })]
    )).toBe(false);
  });

  it('matches on title alone when the entry has no indexer', async () => {
    const { isResultBlacklisted } = await import('@/lib/utils/release-blacklist');
    expect(isResultBlacklisted(result({}), [entry({ title: 'Wild Side - Elsie Silver [M4B]' })])).toBe(true);
  });

  it('does not match unrelated releases', async () => {
    const { isResultBlacklisted } = await import('@/lib/utils/release-blacklist');
    expect(isResultBlacklisted(
      result({ infoHash: 'bbbb', infoUrl: 'https://abb/page/9' }),
      [entry({ infoHash: 'aaaa', releaseUrl: 'https://abb/page/1', title: 'Other Book' })]
    )).toBe(false);
  });
});

describe('filterBlacklistedResults', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns results unchanged without an audiobook id', async () => {
    const { filterBlacklistedResults } = await import('@/lib/utils/release-blacklist');
    const results = [result({})];

    const out = await filterBlacklistedResults(undefined, results);

    expect(out).toEqual({ results, removed: 0 });
    expect(prismaMock.blacklistedRelease.findMany).not.toHaveBeenCalled();
  });

  it('removes blacklisted results for the book and reports the count', async () => {
    prismaMock.blacklistedRelease.findMany.mockResolvedValue([
      entry({ title: 'Wild Side - Elsie Silver [M4B]', indexerName: 'AudioBook Bay' }),
    ]);
    const { filterBlacklistedResults } = await import('@/lib/utils/release-blacklist');
    const dead = result({});
    const alive = result({ title: 'Wild Side - Elsie Silver [MP3]', guid: 'guid-2' });

    const out = await filterBlacklistedResults('ab-1', [dead, alive]);

    expect(prismaMock.blacklistedRelease.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { audiobookId: 'ab-1' } })
    );
    expect(out).toEqual({ results: [alive], removed: 1 });
  });
});

describe('blacklistRelease', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stores a lowercase info hash and a BigInt size', async () => {
    const { blacklistRelease } = await import('@/lib/utils/release-blacklist');

    await blacklistRelease({
      audiobookId: 'ab-1',
      title: 'Wild Side',
      indexerName: 'AudioBook Bay',
      infoHash: 'ABCDEF',
      releaseUrl: 'https://abb/page/1',
      sizeBytes: 700,
      reason: 'stalled',
    });

    expect(prismaMock.blacklistedRelease.create).toHaveBeenCalledWith({
      data: {
        audiobookId: 'ab-1',
        title: 'Wild Side',
        indexerName: 'AudioBook Bay',
        infoHash: 'abcdef',
        releaseUrl: 'https://abb/page/1',
        sizeBytes: BigInt(700),
        reason: 'stalled',
      },
    });
  });
});
