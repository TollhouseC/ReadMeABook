/**
 * Component: Download Lookup Tests
 * Documentation: documentation/phase3/download-clients.md
 */

import { describe, expect, it, vi } from 'vitest';
import { findExistingDownload, locateDownload, pickRelease, sameRelease } from '@/lib/services/download-lookup';

const RELEASE = 'Star Wars - Survivors Quest (NMR) 2004 MP3';
const job = (id: string, name: string, status: string, extra: Record<string, unknown> = {}) =>
  ({ id, name, status, progress: 0, size: 0, bytesDownloaded: 0, downloadSpeed: 0, eta: 0, category: 'rmab', ...extra }) as any;
const client = (overrides: Record<string, unknown> = {}) =>
  ({ clientType: 'sabnzbd', protocol: 'usenet', getDownload: vi.fn().mockResolvedValue(null), findDownloadByName: vi.fn().mockResolvedValue(null), ...overrides }) as any;

describe('sameRelease', () => {
  it('matches the same release despite punctuation, case, .nzb and shortened names', () => {
    expect(sameRelease(RELEASE, 'star.wars.-.survivors.quest.(nmr).2004.mp3.nzb')).toBe(true);
    expect(sameRelease(RELEASE, 'Star Wars - Survivors Quest (NMR')).toBe(true);
    expect(sameRelease(RELEASE, 'Star Wars - Outbound Flight')).toBe(false);
    expect(sameRelease('Book', 'Book 2 extended edition')).toBe(false); // short prefixes never match
    expect(sameRelease(RELEASE, '')).toBe(false);
  });

  it('prefers a live job over a failed one', () => {
    expect(pickRelease([job('a', RELEASE, 'failed'), job('b', RELEASE, 'completed')], RELEASE)?.id).toBe('b');
    expect(pickRelease([job('a', RELEASE, 'failed')], RELEASE)?.id).toBe('a');
  });
});

describe('locateDownload', () => {
  it('uses the saved ID when the client still knows it', async () => {
    const c = client({ getDownload: vi.fn().mockResolvedValue(job('old', RELEASE, 'downloading')) });
    expect(await locateDownload(c, 'old', RELEASE)).toMatchObject({ id: 'old' });
    expect(c.findDownloadByName).not.toHaveBeenCalled();
  });

  it('follows the job under its new ID when it was retried in the client', async () => {
    const c = client({ findDownloadByName: vi.fn().mockResolvedValue(job('new', RELEASE, 'completed')) });
    const log = { info: vi.fn(), warn: vi.fn() };
    expect(await locateDownload(c, 'old', RELEASE, log)).toMatchObject({ id: 'new', info: { status: 'completed' } });
    expect(c.findDownloadByName).toHaveBeenCalledWith(RELEASE, { includeHistory: true });
    expect(log.warn.mock.calls[0][0]).toContain('under ID new');
  });

  it('is not found without a release name or a client that can search by name', async () => {
    expect(await locateDownload(client(), 'old', null)).toBeNull();
    expect(await locateDownload(client({ findDownloadByName: undefined }), 'old', RELEASE)).toBeNull();
  });
});

describe('findExistingDownload', () => {
  it('finds a queued copy by default and ignores failed jobs', async () => {
    const c = client({ findDownloadByName: vi.fn().mockResolvedValue(job('q', RELEASE, 'downloading')) });
    expect((await findExistingDownload(c, RELEASE))?.id).toBe('q');
    expect(c.findDownloadByName).toHaveBeenCalledWith(RELEASE, { includeHistory: false });

    c.findDownloadByName.mockResolvedValue(job('f', RELEASE, 'failed'));
    expect(await findExistingDownload(c, RELEASE)).toBeNull();
  });

  it('reuses a finished copy only when it completed recently', async () => {
    const c = client({ findDownloadByName: vi.fn().mockResolvedValue(job('h', RELEASE, 'completed', { completedAt: new Date(Date.now() - 3600_000) })) });
    expect((await findExistingDownload(c, RELEASE, { maxAgeMs: 86_400_000 }))?.id).toBe('h');

    c.findDownloadByName.mockResolvedValue(job('h', RELEASE, 'completed', { completedAt: new Date(Date.now() - 5 * 86_400_000) }));
    expect(await findExistingDownload(c, RELEASE, { maxAgeMs: 86_400_000 })).toBeNull();
  });
});
