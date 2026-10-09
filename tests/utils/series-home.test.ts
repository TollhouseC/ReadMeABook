/**
 * Component: Series Home Tests
 * Documentation: documentation/phase3/file-organization.md
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findLibraryHome } from '@/lib/utils/series-home';

let lib: string;
const mk = (...parts: string[]) => fs.mkdir(path.join(lib, ...parts), { recursive: true });

beforeEach(async () => {
  lib = await fs.mkdtemp(path.join(os.tmpdir(), 'rmab-home-'));
  await mk('Lucy Score', 'Bootleg Springs', 'Moonshine Kiss');
  await mk('Lucy Score', 'Bootleg Springs', 'Whiskey Chaser');
  await mk('Claire Kingsley', 'Bootleg Springs', 'Sidecar Crush');
  await mk('Greg Bear', 'Halo', 'Halo Primordium');
  await mk('William Gass', 'The Tunnel');
  await mk('Shirtaloon, Travis Deverell', 'He Who Fights with Monsters', 'He Who Fights with Monsters 10');
});

afterEach(async () => {
  await fs.rm(lib, { recursive: true, force: true });
});

describe('findLibraryHome', () => {
  it('joins the series under the co-author folder that holds most of it', async () => {
    expect(await findLibraryHome(lib, 'Claire Kingsley, Lucy Score', 'Bootleg Springs')).toEqual({ author: 'Lucy Score', series: 'Bootleg Springs' });
  });

  it('matches author and series spelled differently', async () => {
    expect(await findLibraryHome(lib, 'Travis Deverell Shirtaloon', 'The He Who Fights with Monsters'))
      .toEqual({ author: 'Shirtaloon, Travis Deverell', series: 'He Who Fights with Monsters' });
    expect(await findLibraryHome(lib, 'William H. Gass')).toEqual({ author: 'William Gass' });
  });

  it('returns null when nothing exists or the folder already matches', async () => {
    expect(await findLibraryHome(lib, 'Karen Traviss', 'Halo')).toBeNull(); // Greg Bear's Halo is someone else's
    expect(await findLibraryHome(lib, 'Greg Bear')).toBeNull();
    expect(await findLibraryHome(lib, 'New Author', 'New Series')).toBeNull();
  });
});
