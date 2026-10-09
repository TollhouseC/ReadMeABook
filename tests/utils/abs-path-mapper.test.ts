/**
 * Component: Audiobookshelf Path Mapper Tests
 * Documentation: documentation/features/chapter-merging.md
 */

import { describe, expect, it } from 'vitest';
import { learnPrefixMappings, localPathCandidates, mountMappingsFromRelPaths, resolveLocalPath } from '@/lib/utils/abs-path-mapper';

describe('learnPrefixMappings', () => {
  it('derives the mount prefixes from known path pairs, most common first', () => {
    expect(learnPrefixMappings([
      { absPath: '/audiobooks/Bal Khabra/Off the Ice/Embrace', localPath: '/Audiobooks/Audio/Bal Khabra/Off the Ice/Embrace' },
      { absPath: '/audiobooks/Glen Cook/They Cry', localPath: '/Audiobooks/Audio/Glen Cook/They Cry' },
      { absPath: '/books/X/Y', localPath: '/data/X/Y' },
    ])).toEqual([
      { from: '/audiobooks', to: '/Audiobooks/Audio' },
      { from: '/books', to: '/data' },
    ]);
  });

  it('ignores identical mounts and pairs with nothing in common', () => {
    expect(learnPrefixMappings([
      { absPath: '/Audiobooks/Audio/A/B', localPath: '/Audiobooks/Audio/A/B' },
      { absPath: '/x/Book One', localPath: '/y/Book Two' },
    ])).toEqual([]);
  });
});

describe('mountMappingsFromRelPaths', () => {
  it('learns only the real mount, ignoring pairs that point at another copy of the book', () => {
    expect(mountMappingsFromRelPaths([
      { absPath: '/audiobooks/Glen Cook/They Cry', relPath: 'Glen Cook/They Cry', localPath: '/Audiobooks/Audio/Glen Cook/They Cry' },
      // RMAB record points at the "Last, First" folder; ABS item is the "First Last" copy
      {
        absPath: '/audiobooks/Travis Deverell Shirtaloon/HWFwM/HWFwM 10', relPath: 'Travis Deverell Shirtaloon/HWFwM/HWFwM 10',
        localPath: '/Audiobooks/Audio/Shirtaloon, Travis Deverell/HWFwM/HWFwM 10',
      },
      { absPath: '/audiobooks/A/B', localPath: '/Audiobooks/Audio/A/B' }, // no relPath
    ])).toEqual([{ from: '/audiobooks', to: '/Audiobooks/Audio' }]);
  });
});

describe('localPathCandidates / resolveLocalPath', () => {
  const mediaDir = '/Audiobooks/Audio';
  const item = { path: '/audiobooks/Glen Cook/They Cry', relPath: 'Glen Cook/They Cry' };

  it('tries the path as-is, then media_dir + relPath, then learned mappings — inside media_dir only', () => {
    expect(localPathCandidates(item, mediaDir, [{ from: '/audiobooks', to: '/Audiobooks/Audio' }])).toEqual([
      '/Audiobooks/Audio/Glen Cook/They Cry',
    ]);
    // media_dir is a subfolder of what ABS calls its root: relPath join is wrong, the mapping is right
    expect(localPathCandidates(
      { path: '/abs/Audio/Glen Cook/They Cry', relPath: 'Audio/Glen Cook/They Cry' },
      mediaDir,
      [{ from: '/abs', to: '/Audiobooks' }],
    )).toEqual(['/Audiobooks/Audio/Audio/Glen Cook/They Cry', '/Audiobooks/Audio/Glen Cook/They Cry']);
  });

  it('returns the first candidate that exists', async () => {
    const existing = new Set(['/Audiobooks/Audio/Glen Cook/They Cry']);
    expect(await resolveLocalPath(item, mediaDir, [], async p => existing.has(p))).toBe('/Audiobooks/Audio/Glen Cook/They Cry');
    expect(await resolveLocalPath({ path: '/elsewhere/Book' }, mediaDir, [], async () => true)).toBeNull();
  });
});
