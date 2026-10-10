/**
 * Component: Source File Fetch (NZB downloads)
 * Documentation: documentation/phase3/download-clients.md
 *
 * Fetches an NZB from a Prowlarr download link. The Prowlarr API key header is needed by
 * Prowlarr itself (some indexers 403 without it when Prowlarr proxies), but when Prowlarr
 * is set to *redirect* an indexer's downloads, the key must not follow the redirect: the
 * indexer (e.g. NZBFinder) reads X-Api-Key as its own key and answers 403. So redirects are
 * followed by hand and headers go only to the original host; a 401/403 is retried once
 * without headers; errors name the host that refused.
 */

import axios from 'axios';

const MAX_REDIRECTS = 5;

export class SourceFetchError extends Error {
  constructor(message: string, readonly status?: number, readonly host?: string) {
    super(message);
    this.name = 'SourceFetchError';
  }
}

export interface FetchedSourceFile {
  data: Buffer;
  headers: Record<string, any>;
  finalUrl: string;
  redirects: number;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

async function fetchOnce(
  url: string,
  headers: Record<string, string> | undefined,
  options: { httpsAgent?: unknown; timeout: number }
): Promise<FetchedSourceFile> {
  const originHost = hostOf(url);
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const response = await axios.get(current, {
      responseType: 'arraybuffer',
      timeout: options.timeout,
      maxRedirects: 0,
      validateStatus: () => true,
      headers: hostOf(current) === originHost ? headers : undefined,
      httpsAgent: current.startsWith('https') ? (options.httpsAgent as any) : undefined,
    });
    const status = response.status ?? 200;
    const location = response.headers?.location;
    if (status >= 300 && status < 400 && location) {
      current = new URL(location, current).toString();
      continue;
    }
    if (status >= 400) {
      const host = hostOf(current);
      throw new SourceFetchError(`HTTP ${status} from ${host}${hop > 0 ? ` (after redirect from ${originHost})` : ''}`, status, host);
    }
    return { data: Buffer.from(response.data ?? []), headers: response.headers ?? {}, finalUrl: current, redirects: hop };
  }
  throw new SourceFetchError(`Too many redirects from ${originHost}`);
}

/** GET a file, sending `headers` only to the URL's own host, retrying a 401/403 once without them. */
export async function fetchSourceFile(
  url: string,
  options: { headers?: Record<string, string>; httpsAgent?: unknown; timeout?: number } = {}
): Promise<FetchedSourceFile> {
  const settings = { httpsAgent: options.httpsAgent, timeout: options.timeout ?? 30000 };
  const hasHeaders = !!options.headers && Object.keys(options.headers).length > 0;
  try {
    return await fetchOnce(url, hasHeaders ? options.headers : undefined, settings);
  } catch (error) {
    if (hasHeaders && error instanceof SourceFetchError && (error.status === 401 || error.status === 403)) {
      return fetchOnce(url, undefined, settings);
    }
    throw error;
  }
}
