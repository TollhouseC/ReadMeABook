/**
 * Component: Source File Fetch Tests
 * Documentation: documentation/phase3/download-clients.md
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const axiosMock = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('axios', () => ({ default: axiosMock, ...axiosMock }));

import { fetchSourceFile, SourceFetchError } from '@/lib/utils/fetch-source-file';

const PROWLARR = 'http://10.0.0.100:9696/12/download?apikey=k&link=abc&file=Mad+Mabel';
const NZBFINDER = 'https://nzbfinder.ws/api/v1/getnzb?id=1&apikey=indexer';
const KEY = { 'X-Api-Key': 'prowlarr-key' };
const ok = (body = 'nzb') => ({ status: 200, data: Buffer.from(body), headers: { 'content-disposition': 'attachment; filename="Mad.Mabel.nzb"' } });
const redirect = (location: string) => ({ status: 301, data: Buffer.alloc(0), headers: { location } });
const denied = (status = 403) => ({ status, data: Buffer.alloc(0), headers: {} });

beforeEach(() => axiosMock.get.mockReset());

describe('fetchSourceFile', () => {
  it('does not send the Prowlarr key to the indexer Prowlarr redirects to (NZBFinder)', async () => {
    axiosMock.get.mockResolvedValueOnce(redirect(NZBFINDER)).mockResolvedValueOnce(ok());

    const result = await fetchSourceFile(PROWLARR, { headers: KEY });

    expect(axiosMock.get.mock.calls[0][0]).toBe(PROWLARR);
    expect(axiosMock.get.mock.calls[0][1].headers).toEqual(KEY);
    expect(axiosMock.get.mock.calls[1][0]).toBe(NZBFINDER);
    expect(axiosMock.get.mock.calls[1][1].headers).toBeUndefined();
    expect(result).toMatchObject({ finalUrl: NZBFINDER, redirects: 1 });
    expect(result.data.toString()).toBe('nzb');
  });

  it('still sends the key when Prowlarr serves the file itself', async () => {
    axiosMock.get.mockResolvedValueOnce(ok());
    await fetchSourceFile(PROWLARR, { headers: KEY });
    expect(axiosMock.get).toHaveBeenCalledTimes(1);
    expect(axiosMock.get.mock.calls[0][1]).toMatchObject({ headers: KEY, maxRedirects: 0 });
  });

  it('retries once without the key after a 403', async () => {
    axiosMock.get.mockResolvedValueOnce(denied()).mockResolvedValueOnce(ok());
    const result = await fetchSourceFile(PROWLARR, { headers: KEY });
    expect(axiosMock.get).toHaveBeenCalledTimes(2);
    expect(axiosMock.get.mock.calls[1][1].headers).toBeUndefined();
    expect(result.redirects).toBe(0);
  });

  it('names the host that refused', async () => {
    axiosMock.get.mockResolvedValue(redirect(NZBFINDER));
    axiosMock.get.mockResolvedValueOnce(redirect(NZBFINDER)).mockResolvedValueOnce(denied())
      .mockResolvedValueOnce(redirect(NZBFINDER)).mockResolvedValueOnce(denied());

    const error = await fetchSourceFile(PROWLARR, { headers: KEY }).catch(e => e);

    expect(error).toBeInstanceOf(SourceFetchError);
    expect(error.message).toBe('HTTP 403 from nzbfinder.ws (after redirect from 10.0.0.100:9696)');
    expect(error.message).not.toContain('apikey');
  });

  it('treats a response without a status as OK (plain mocks / old clients)', async () => {
    axiosMock.get.mockResolvedValueOnce({ data: Buffer.from('x'), headers: {} });
    expect((await fetchSourceFile('https://example.com/book.nzb')).data.toString()).toBe('x');
  });
});
