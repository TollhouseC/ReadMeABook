/**
 * Component: Library Folder Lookup & Removal Tests
 * Documentation: documentation/backend/services/reported-issues.md
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const absMock = vi.hoisted(() => ({ getABSItem: vi.fn() }));
vi.mock('@/lib/services/audiobookshelf/api', () => absMock);

import { removeBookFolder, resolveLibraryFolder } from '@/lib/services/library-folder';

let lib: string;
const TEMPLATE = '{author}/{title}';
const mk = async (...parts: string[]) => {
  const dir = path.join(lib, ...parts);
  await fs.mkdir(dir, { recursive: true });
  return dir;
};
const file = (dir: string, name: string) => fs.writeFile(path.join(dir, name), 'x');

beforeEach(async () => {
  vi.clearAllMocks();
  lib = await fs.mkdtemp(path.join(os.tmpdir(), 'rmab-libfolder-'));
});
afterEach(async () => {
  await fs.rm(lib, { recursive: true, force: true });
});

describe('resolveLibraryFolder', () => {
  it('prefers the recorded path, then the Audiobookshelf item, then the template', async () => {
    const recorded = await mk('Shirtaloon, Travis Deverell', 'HWFwM', 'HWFwM 2');
    const moved = await mk('Terry Pratchett', 'Discworld', 'A Hat Full of Sky');
    const templated = await mk('Glen Cook', 'Shadows Linger');
    absMock.getABSItem.mockResolvedValue({ relPath: 'Terry Pratchett/Discworld/A Hat Full of Sky', isFile: false });

    expect(await resolveLibraryFolder({ title: 'HWFwM 2', author: 'X', filePath: recorded, absItemId: 'li' }, lib, TEMPLATE)).toBe(recorded);
    expect(await resolveLibraryFolder({ title: 'A Hat Full of Sky', author: 'Terry Pratchett', absItemId: 'li' }, lib, TEMPLATE)).toBe(moved);
    expect(await resolveLibraryFolder({ title: 'Shadows Linger', author: 'Glen Cook' }, lib, TEMPLATE)).toBe(templated);
    expect(await resolveLibraryFolder({ title: 'Missing', author: 'Nobody' }, lib, TEMPLATE)).toBeNull();
  });

  it('ignores a recorded file path by using its folder, and paths outside the library', async () => {
    const dir = await mk('A', 'Book');
    expect(await resolveLibraryFolder({ title: 'Other', author: 'Z', filePath: path.join(dir, 'Book.m4b') }, lib, TEMPLATE)).toBe(dir);
    expect(await resolveLibraryFolder({ title: 'Other', author: 'Z', filePath: os.tmpdir() }, lib, TEMPLATE)).toBeNull();
  });
});

describe('removeBookFolder', () => {
  it('deletes a single book folder, disc folders included', async () => {
    const book = await mk('Glen Cook', 'Black Company', 'Shadows Linger');
    await file(book, 'Shadows Linger.m4b');
    await file(await mk('Glen Cook', 'Black Company', 'Shadows Linger', 'CD1'), 'track.mp3');

    await removeBookFolder(book, lib);

    await expect(fs.stat(book)).rejects.toThrow();
    expect(await fs.readdir(path.join(lib, 'Glen Cook', 'Black Company'))).toEqual([]);
  });

  it('refuses author folders and folders holding other books', async () => {
    const series = await mk('Lucy Score', 'Bootleg Springs');
    await file(await mk('Lucy Score', 'Bootleg Springs', 'Gin Fling'), 'Gin Fling.m4b');

    await expect(removeBookFolder(path.join(lib, 'Lucy Score'), lib)).rejects.toThrow(/not a book folder/);
    await expect(removeBookFolder(series, lib)).rejects.toThrow(/contains other books \(Gin Fling\)/);
    expect(await fs.readdir(series)).toEqual(['Gin Fling']);
  });
});
