/**
 * Component: Torrent Own-Files Selection
 * Documentation: documentation/phase3/file-organization.md
 *
 * Torrents from one uploader often share a top folder ("Sun Eater (Christopher Ruocchio)"),
 * so the client saves several books into ONE directory. Importing that directory copied
 * every book into each book's folder. This asks the download client which files belong to
 * THIS torrent and returns them as the import selection — only when the folder also holds
 * audio from elsewhere. If the client can't say (torrent removed, client offline), the
 * import proceeds as before and the multi-book guard is the safety net.
 */

import fs from 'fs/promises';
import path from 'path';
import { AUDIO_EXTENSIONS } from '../constants/audio-formats';
import { CLIENT_PROTOCOL_MAP, type DownloadClientType } from '../interfaces/download-client.interface';

export interface TorrentDownloadRef {
  downloadClient?: string | null;
  downloadClientId?: string | null;
  torrentHash?: string | null;
}

interface ImportLogger {
  info(message: string): unknown;
  warn(message: string): unknown;
}

const isAudio = (file: string) => (AUDIO_EXTENSIONS as readonly string[]).includes(path.extname(file).toLowerCase());
const toPosix = (p: string) => p.replace(/\\/g, '/');

/** Audio files under a folder, as '/'-separated paths relative to it ([] for a file or missing path). */
export async function listAudioRelative(dir: string, base = ''): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(path.join(dir, base), { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listAudioRelative(dir, rel));
    else if (entry.isFile() && isAudio(entry.name)) files.push(rel);
  }
  return files;
}

/**
 * Torrent file names include the torrent's top folder ("Root/Book.m4b"); the import path IS
 * that folder, so strip it to get paths relative to the import path.
 */
export function toImportRelative(torrentFiles: string[], downloadPath: string): string[] {
  const root = path.basename(toPosix(downloadPath));
  return torrentFiles.map((name) => {
    const parts = toPosix(name).split('/').filter(Boolean);
    return (parts.length > 1 && parts[0] === root ? parts.slice(1) : parts).join('/');
  });
}

export interface OwnFilesPlan {
  /** This torrent's audio files present in the folder */
  own: string[];
  /** Audio in the folder that isn't part of this torrent */
  others: string[];
}

export function planOwnFiles(onDisk: string[], torrentFiles: string[], downloadPath: string): OwnFilesPlan {
  const torrentAudio = new Set(toImportRelative(torrentFiles, downloadPath).filter(isAudio));
  return {
    own: onDisk.filter((f) => torrentAudio.has(f)),
    others: onDisk.filter((f) => !torrentAudio.has(f)),
  };
}

async function fetchTorrentFiles(id: string): Promise<string[] | null> {
  try {
    const { getConfigService } = await import('../services/config.service');
    const { getDownloadClientManager } = await import('../services/download-client-manager.service');
    const client = await getDownloadClientManager(getConfigService()).getClientServiceForProtocol('torrent');
    if (!client?.getDownloadFiles) return null;
    const files = await client.getDownloadFiles(id);
    return files.length > 0 ? files : null;
  } catch {
    return null;
  }
}

/**
 * Import selection limited to this torrent's own files, or undefined to import the folder
 * as-is (not a torrent, nothing else in the folder, or the file list is unavailable).
 */
export async function selectTorrentOwnFiles(
  downloadPath: string,
  download: TorrentDownloadRef,
  logger?: ImportLogger
): Promise<string[] | undefined> {
  const clientType = download.downloadClient || (download.torrentHash ? 'qbittorrent' : '');
  const id = download.downloadClientId || download.torrentHash;
  if (!id || CLIENT_PROTOCOL_MAP[clientType as DownloadClientType] !== 'torrent') return undefined;

  const onDisk = await listAudioRelative(downloadPath);
  if (onDisk.length < 2) return undefined;

  const torrentFiles = await fetchTorrentFiles(id);
  if (!torrentFiles) {
    logger?.warn(`Couldn't read this torrent's file list from the download client — importing everything in ${downloadPath}`);
    return undefined;
  }

  const plan = planOwnFiles(onDisk, torrentFiles, downloadPath);
  if (plan.others.length === 0) return undefined;
  if (plan.own.length === 0) {
    logger?.warn(`None of this torrent's files were found in ${downloadPath} — importing the folder as-is`);
    return undefined;
  }

  logger?.info(
    `Shared download folder — importing only this torrent's ${plan.own.length} audio file(s), ` +
    `ignoring ${plan.others.length} from other downloads (e.g. "${plan.others[0]}")`
  );
  return plan.own;
}
