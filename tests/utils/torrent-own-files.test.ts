/**
 * Component: Torrent Own-Files Selection Tests
 * Documentation: documentation/phase3/file-organization.md
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const clientMock = vi.hoisted(() => ({ getDownloadFiles: vi.fn() }));
const managerMock = vi.hoisted(() => ({ getClientServiceForProtocol: vi.fn() }));

vi.mock('@/lib/services/config.service', () => ({ getConfigService: () => ({}) }));
vi.mock('@/lib/services/download-client-manager.service', () => ({ getDownloadClientManager: () => managerMock }));

import { planOwnFiles, selectTorrentOwnFiles, toImportRelative } from '@/lib/utils/torrent-own-files';

const logger = { info: vi.fn(), warn: vi.fn() };
let root: string;
let shared: string;

async function touch(rel: string) {
  const file = path.join(shared, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, 'x');
}

beforeEach(async () => {
  vi.clearAllMocks();
  managerMock.getClientServiceForProtocol.mockResolvedValue(clientMock);
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'rmab-own-'));
  shared = path.join(root, 'Sun Eater (Christopher Ruocchio)');
  // Three single-book torrents from one uploader, all saved into the same top folder
  await touch('Empire of Silence.m4b');
  await touch('Howling Dark.m4b');
  await touch('Demon in White.m4b');
  await touch('cover.jpg');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const howlingDark = { downloadClient: 'qbittorrent', downloadClientId: 'hash-hd' };

describe('toImportRelative / planOwnFiles', () => {
  it('strips the torrent top folder and splits own vs other files', () => {
    expect(toImportRelative(['Sun Eater (Christopher Ruocchio)/Howling Dark.m4b'], shared)).toEqual(['Howling Dark.m4b']);
    expect(planOwnFiles(
      ['Demon in White.m4b', 'Empire of Silence.m4b', 'Howling Dark.m4b'],
      ['Sun Eater (Christopher Ruocchio)/Howling Dark.m4b', 'Sun Eater (Christopher Ruocchio)/cover.jpg'],
      shared
    )).toEqual({ own: ['Howling Dark.m4b'], others: ['Demon in White.m4b', 'Empire of Silence.m4b'] });
  });
});

describe('selectTorrentOwnFiles', () => {
  it('imports only this torrent\'s files from a shared download folder', async () => {
    clientMock.getDownloadFiles.mockResolvedValue(['Sun Eater (Christopher Ruocchio)/Howling Dark.m4b']);

    const selection = await selectTorrentOwnFiles(shared, howlingDark, logger);

    expect(clientMock.getDownloadFiles).toHaveBeenCalledWith('hash-hd');
    expect(selection).toEqual(['Howling Dark.m4b']);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Shared download folder'));
  });

  it('leaves a folder alone when everything in it belongs to the torrent', async () => {
    clientMock.getDownloadFiles.mockResolvedValue(['Empire of Silence.m4b', 'Howling Dark.m4b', 'Demon in White.m4b'].map(f => `Sun Eater (Christopher Ruocchio)/${f}`));
    expect(await selectTorrentOwnFiles(shared, howlingDark, logger)).toBeUndefined();
  });

  it('falls back to the whole folder when the client has no file list (torrent removed)', async () => {
    clientMock.getDownloadFiles.mockRejectedValue(new Error('not found'));
    expect(await selectTorrentOwnFiles(shared, howlingDark, logger)).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('importing everything'));
  });

  it('falls back when none of the torrent files are in the folder', async () => {
    clientMock.getDownloadFiles.mockResolvedValue(['Other/Thing.m4b']);
    expect(await selectTorrentOwnFiles(shared, howlingDark, logger)).toBeUndefined();
  });

  it('skips usenet downloads and downloads without an id', async () => {
    expect(await selectTorrentOwnFiles(shared, { downloadClient: 'sabnzbd', downloadClientId: 'nzb1' })).toBeUndefined();
    expect(await selectTorrentOwnFiles(shared, { downloadClient: 'qbittorrent' })).toBeUndefined();
    expect(managerMock.getClientServiceForProtocol).not.toHaveBeenCalled();
  });

  it('skips single-file downloads', async () => {
    const single = path.join(shared, 'Howling Dark.m4b');
    expect(await selectTorrentOwnFiles(single, howlingDark)).toBeUndefined();
    expect(managerMock.getClientServiceForProtocol).not.toHaveBeenCalled();
  });
});
