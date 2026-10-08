/**
 * Component: Library Layout Guard Tests
 * Documentation: documentation/phase3/file-organization.md
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { findNestedBooks, moveBookIntoOwnSubfolder, resolveCollisionFreeTarget } from '@/lib/utils/library-layout';

let media: string;
const author = () => path.join(media, 'Elin Hilderbrand, Shelby Cunningham');

async function put(rel: string, content = 'x') {
  const full = path.join(media, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
}
const ls = async (rel: string) => (await fs.readdir(path.join(media, rel))).sort();

beforeEach(async () => {
  media = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'rmab-layout-')), 'Audio');
  await fs.mkdir(media, { recursive: true });
});

describe('resolveCollisionFreeTarget', () => {
  it('moves book 1 into its own folder when book 2 would land inside it (The Academy case)', async () => {
    await put('Elin Hilderbrand, Shelby Cunningham/The Academy/The Academy.m4b');
    await put('Elin Hilderbrand, Shelby Cunningham/The Academy/cover.jpg');

    const target = path.join(author(), 'The Academy', 'The Thoroughbreds');
    const result = await resolveCollisionFreeTarget(media, target);

    expect(result.targetPath).toBe(path.resolve(target));
    expect(result.movedExisting).toEqual({
      from: path.join(author(), 'The Academy'),
      to: path.join(author(), 'The Academy', 'The Academy'),
    });
    expect(await ls('Elin Hilderbrand, Shelby Cunningham/The Academy')).toEqual(['The Academy']);
    expect(await ls('Elin Hilderbrand, Shelby Cunningham/The Academy/The Academy')).toEqual(['The Academy.m4b', 'cover.jpg']);
  });

  it('puts a book into its own subfolder when its folder is already a series folder (book 1 arriving last)', async () => {
    await put('Christopher Ruocchio/Sun Eater/Howling Dark/Howling Dark.m4b');
    await put('Christopher Ruocchio/Sun Eater/Demon in White/Demon in White.m4b');

    const target = path.join(media, 'Christopher Ruocchio', 'Sun Eater');
    const result = await resolveCollisionFreeTarget(media, target);

    expect(result.targetPath).toBe(path.join(media, 'Christopher Ruocchio', 'Sun Eater', 'Sun Eater'));
    expect(result.movedExisting).toBeUndefined();
  });

  it('leaves normal series paths alone, and treats disc folders as the same book', async () => {
    await put('Christopher Ruocchio/Sun Eater/Howling Dark/Howling Dark.m4b');
    const normal = path.join(media, 'Christopher Ruocchio', 'Sun Eater', 'Empire of Silence');
    expect(await resolveCollisionFreeTarget(media, normal)).toEqual({ targetPath: path.resolve(normal), movedExisting: undefined });

    await put('Author/Big Book/CD1/01.mp3');
    await put('Author/Big Book/CD2/01.mp3');
    const reimport = path.join(media, 'Author', 'Big Book');
    expect((await resolveCollisionFreeTarget(media, reimport)).targetPath).toBe(path.resolve(reimport));
  });
});

describe('findNestedBooks / moveBookIntoOwnSubfolder', () => {
  it('finds book folders that contain other books, ignoring disc folders', async () => {
    await put('A/The Academy/The Academy.m4b');
    await put('A/The Academy/The Thoroughbreds/The Thoroughbreds.m4b');
    await put('B/Series/Book One/one.m4b');
    await put('C/Big Book/01.mp3');
    await put('C/Big Book/Disc 2/02.mp3');

    expect(await findNestedBooks(media)).toEqual([
      { outer: path.join(media, 'A', 'The Academy'), inner: [path.join(media, 'A', 'The Academy', 'The Thoroughbreds')] },
    ]);
  });

  it('moves only the outer book\'s files, leaving nested books in place', async () => {
    await put('A/The Academy/The Academy.m4b');
    await put('A/The Academy/The Thoroughbreds/The Thoroughbreds.m4b');

    const to = await moveBookIntoOwnSubfolder(path.join(media, 'A', 'The Academy'));

    expect(to).toBe(path.join(media, 'A', 'The Academy', 'The Academy'));
    expect(await ls('A/The Academy')).toEqual(['The Academy', 'The Thoroughbreds']);
    expect(await findNestedBooks(media)).toEqual([]);
  });
});
