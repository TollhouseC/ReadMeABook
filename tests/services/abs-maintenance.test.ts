/**
 * Component: Audiobookshelf Maintenance Helpers Tests
 * Documentation: documentation/features/library-match.md
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getABSItem: vi.fn(), triggerABSScan: vi.fn(), get: vi.fn(), getBackendMode: vi.fn() }));
vi.mock('@/lib/services/audiobookshelf/api', () => ({ getABSItem: mocks.getABSItem, triggerABSScan: mocks.triggerABSScan }));
vi.mock('@/lib/services/config.service', () => ({ getConfigService: () => ({ get: mocks.get, getBackendMode: mocks.getBackendMode }) }));

import { findDuplicateTracks, forceRescanABS } from '@/lib/services/abs-maintenance';

const track = (path: string) => ({ metadata: { path } });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getBackendMode.mockResolvedValue('audiobookshelf');
  mocks.get.mockResolvedValue('lib-1');
});

describe('findDuplicateTracks', () => {
  it('finds a file listed twice (HWFwM 2 after a folder move)', async () => {
    const file = '/audiobooks/Shirtaloon, Travis Deverell/He Who Fights with Monsters/He Who Fights with Monsters 2/He Who Fights with Monsters 2.mp4';
    mocks.getABSItem.mockResolvedValue({ media: { audioFiles: [track(file), track(file)] } });
    expect(await findDuplicateTracks('li-1')).toEqual([file]);
  });

  it('returns nothing for a normal item', async () => {
    mocks.getABSItem.mockResolvedValue({ media: { audioFiles: [track('/a/1.mp3'), track('/a/2.mp3')] } });
    expect(await findDuplicateTracks('li-2')).toEqual([]);
  });
});

describe('forceRescanABS', () => {
  it('force-scans the configured library', async () => {
    expect(await forceRescanABS()).toBe(true);
    expect(mocks.triggerABSScan).toHaveBeenCalledWith('lib-1', { force: true });
  });

  it('does nothing on Plex', async () => {
    mocks.getBackendMode.mockResolvedValue('plex');
    expect(await forceRescanABS()).toBe(false);
    expect(mocks.triggerABSScan).not.toHaveBeenCalled();
  });
});
