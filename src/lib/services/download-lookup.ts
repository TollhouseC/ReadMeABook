/**
 * Component: Download Lookup (lost IDs, duplicate adds)
 * Documentation: documentation/phase3/download-clients.md
 *
 * Usenet clients can list a job under a new ID — SABnzbd's own Retry re-adds a failed job
 * with a new nzo_id and drops the old history entry. Monitoring then hit "not found" and the
 * request failed while the download finished, and ReadMeABook's Retry added the NZB again
 * (Survivor's Quest: 4 adds, 3 copies). These helpers find a job by its release name when
 * the saved ID is gone, and find an existing job before adding a second copy.
 */

import type { DownloadInfo, IDownloadClient } from '../interfaces/download-client.interface';

type Log = { info: (msg: string) => unknown; warn: (msg: string) => unknown };

/** "Star.Wars - Survivors Quest (NMR).nzb" → "starwarssurvivorsquestnmr" */
export const releaseKey = (name: string) => name.toLowerCase().replace(/\.nzb$/, '').replace(/[^a-z0-9]+/g, '');

/** Same release: identical key, or one a prefix of the other (clients shorten long names). */
export function sameRelease(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = releaseKey(a || '');
  const kb = releaseKey(b || '');
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  const [short, long] = ka.length < kb.length ? [ka, kb] : [kb, ka];
  return short.length >= 12 && long.startsWith(short);
}

/** Best match among a client's jobs: a live one first, then the newest finished one. */
export function pickRelease(jobs: DownloadInfo[], name: string): DownloadInfo | null {
  const matches = jobs.filter(job => sameRelease(job.name, name));
  return matches.find(job => job.status !== 'failed') ?? matches[0] ?? null;
}

/**
 * The download by its saved ID, or — when the client no longer knows that ID — the job with
 * the same release name (`id` is then the new ID to save).
 */
export async function locateDownload(
  client: IDownloadClient,
  id: string,
  releaseName: string | null | undefined,
  logger?: Log
): Promise<{ info: DownloadInfo; id: string } | null> {
  const info = await client.getDownload(id);
  if (info) return { info, id };
  if (!releaseName || !client.findDownloadByName) return null;

  const found = await client.findDownloadByName(releaseName, { includeHistory: true });
  if (!found || found.id === id) return null;
  await logger?.warn(`${client.clientType} no longer knows download ${id} — found "${found.name}" under ID ${found.id} (re-added/retried in the client?), following that one`);
  return { info: found, id: found.id };
}

/**
 * A job for this release already in the client, so it isn't added twice. Queue only by
 * default; with `maxAgeMs`, also a finished job completed within that time.
 */
export async function findExistingDownload(
  client: IDownloadClient,
  releaseName: string | null | undefined,
  options: { maxAgeMs?: number } = {}
): Promise<DownloadInfo | null> {
  if (!releaseName || !client.findDownloadByName) return null;
  const includeHistory = options.maxAgeMs !== undefined;
  const found = await client.findDownloadByName(releaseName, { includeHistory });
  if (!found || found.status === 'failed') return null;
  if (found.status === 'completed' && includeHistory) {
    const age = found.completedAt ? Date.now() - found.completedAt.getTime() : Infinity;
    if (age > options.maxAgeMs!) return null;
  }
  return found;
}
