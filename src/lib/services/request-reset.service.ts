/**
 * Component: Request Reset — Retire Current Download
 * Documentation: documentation/admin-features/request-deletion.md
 *
 * When an admin resets a request (usually because it grabbed the wrong release), the
 * release attached to it is blacklisted for that book so automatic searches never pick it
 * again, and ReadMeABook stops tracking it so it can't finish and import over the new pick.
 * - Unfinished download → removed from the client with its partial files.
 * - Finished download → left in the client so private-tracker seeding isn't cut short.
 * - Shared series/author pack → left alone (other requests are importing from it).
 */

import { prisma } from '../db';
import type { RMABLogger } from '../utils/logger';
import { blacklistRelease } from '../utils/release-blacklist';
import { CLIENT_PROTOCOL_MAP, type DownloadClientType } from '../interfaces/download-client.interface';

export interface RetireDownloadResult {
  /** Release blacklisted for this book */
  blacklisted: boolean;
  removedFromClient: boolean;
  keptSeeding: boolean;
  /** Part of a pack other requests share — torrent and monitoring left as-is */
  sharedPack: boolean;
  releaseTitle?: string;
}

const FINISHED_STATUSES = ['seeding', 'completed'];

export async function retireCurrentDownload(
  requestId: string,
  audiobookId: string,
  logger?: RMABLogger
): Promise<RetireDownloadResult> {
  const result: RetireDownloadResult = { blacklisted: false, removedFromClient: false, keptSeeding: false, sharedPack: false };

  const download = await prisma.downloadHistory.findFirst({
    where: { requestId, selected: true },
    orderBy: { createdAt: 'desc' },
  });
  if (!download || download.downloadStatus === 'blacklisted') return result;

  const releaseTitle = download.torrentName || 'unknown release';
  result.releaseTitle = releaseTitle;

  await blacklistRelease({
    audiobookId,
    title: releaseTitle,
    indexerName: download.indexerName,
    infoHash: download.torrentHash,
    releaseUrl: download.torrentUrl,
    sizeBytes: download.torrentSizeBytes,
    reason: 'reset',
  });
  result.blacklisted = true;

  const clientId = download.downloadClientId || download.torrentHash || download.nzbId;

  // Shared pack torrent: other requests import from it — don't stop or remove it
  if (Array.isArray(download.packFiles) && clientId) {
    const others = await prisma.downloadHistory.count({
      where: { downloadClientId: clientId, id: { not: download.id } },
    });
    if (others > 0) {
      result.sharedPack = true;
      await logger?.info(`"${releaseTitle}" is a pack shared with other requests — blacklisted for this book, torrent left running`);
      return result;
    }
  }

  // Stop the monitor before the torrent disappears (it exits quietly on 'blacklisted')
  await prisma.downloadHistory.update({
    where: { id: download.id },
    data: { downloadStatus: 'blacklisted', downloadError: 'Reset by admin' },
  });

  const clientType = (download.downloadClient || 'qbittorrent') as DownloadClientType | 'direct';
  if (!clientId || clientType === 'direct') return result;

  try {
    const { getConfigService } = await import('./config.service');
    const { getDownloadClientManager } = await import('./download-client-manager.service');
    const protocol = CLIENT_PROTOCOL_MAP[clientType as DownloadClientType] || 'torrent';
    const client = await getDownloadClientManager(getConfigService()).getClientServiceForProtocol(protocol as 'torrent' | 'usenet');
    if (!client) return result;

    const info = await client.getDownload(clientId).catch(() => null);
    if (!info) return result; // already gone from the client

    const finished = info.progress >= 1 || FINISHED_STATUSES.includes(String(info.status));
    if (finished) {
      result.keptSeeding = client.protocol === 'torrent';
      await logger?.info(`"${releaseTitle}" already finished — left in ${client.clientType}${result.keptSeeding ? ' to keep seeding' : ''}`);
    } else {
      await client.deleteDownload(clientId, true);
      result.removedFromClient = true;
      await logger?.info(`Removed unfinished download "${releaseTitle}" from ${client.clientType}`);
    }
  } catch (error) {
    await logger?.warn(`Could not clean up "${releaseTitle}" in the download client: ${error instanceof Error ? error.message : String(error)}`);
  }

  return result;
}
