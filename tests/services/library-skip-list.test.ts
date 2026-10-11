/**
 * Component: Library Skip List Tests
 * Documentation: documentation/backend/services/jobs.md
 */

import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaMock } from '../helpers/prisma';

const prismaMock = createPrismaMock();
vi.mock('@/lib/db', () => ({ prisma: prismaMock }));

const load = () => import('@/lib/services/library-skip-list');

const LIST = `# ReadMeABook skip list
Chloe Walsh/Boys of Tommen/Binding 13 | match | Part One + Two in one file
/Michael Crichton/Disclosure/ | match, chapters | unabridged
asin:b0764lbs4b | all | abridged CD rip, kept
Some/Book | sometimes | bad check
 | match | no folder
`;

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.configuration.findUnique.mockResolvedValue({ value: LIST });
});

describe('parseSkipList', () => {
  it('reads folders, asin: lines and check lists; reports bad lines', async () => {
    const { parseSkipList } = await load();
    const { entries, errors } = parseSkipList(LIST);

    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ folder: 'chloe walsh/boys of tommen/binding 13', asin: null, note: 'Part One + Two in one file', line: 2 });
    expect([...entries[1].checks]).toEqual(['match', 'chapters']);
    expect(entries[1].folder).toBe('michael crichton/disclosure');
    expect(entries[2]).toMatchObject({ folder: null, asin: 'B0764LBS4B' });
    expect([...entries[2].checks]).toEqual(['match', 'chapters', 'merge']);
    expect(errors).toEqual([
      'Line 5: checks must be match, chapters, merge or all (got "sometimes")',
      'Line 6: no folder or asin:',
    ]);
  });
});

describe('applySkipList', () => {
  it('drops the books the list covers for that check only, and logs them', async () => {
    const { applySkipList } = await load();
    const log = { info: vi.fn() };
    const books = [
      { relPath: 'Chloe Walsh/Boys of Tommen/Binding 13', asin: 'B07LBMZL88', title: 'Binding 13' },
      { relPath: 'michael crichton/disclosure', asin: 'B002V9XB90', title: 'Disclosure' },
      { relPath: 'Dan Abnett/The Horus Heresy/Horus Rising', asin: 'B0764LBS4B', title: 'Horus Rising' },
      { relPath: 'Brandon Sanderson/Mistborn', asin: 'B0X', title: 'Mistborn' },
    ];

    const match = await applySkipList(books, 'match', b => b, log);
    expect(match.kept.map(b => b.title)).toEqual(['Mistborn']);
    expect(match.skipped).toBe(3);
    expect(log.info).toHaveBeenCalledWith('Skipped by your list (3): Binding 13, Disclosure, Horus Rising');

    const merge = await applySkipList(books, 'merge', b => b, log);
    expect(merge.kept.map(b => b.title)).toEqual(['Binding 13', 'Disclosure', 'Mistborn']); // only the asin: line has merge
  });

  it('skips nothing (and logs nothing) without a list or when the list cannot be read', async () => {
    const { applySkipList } = await load();
    const log = { info: vi.fn() };
    prismaMock.configuration.findUnique.mockResolvedValue(null);
    expect((await applySkipList([{ title: 'A', relPath: 'A/B' }], 'match', b => b, log)).kept).toHaveLength(1);
    prismaMock.configuration.findUnique.mockRejectedValue(new Error('db down'));
    expect((await applySkipList([{ title: 'A', relPath: 'A/B' }], 'match', b => b, log)).kept).toHaveLength(1);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('identifies job candidates by their folder relative to the library', async () => {
    const { candidateSkipInfo } = await load();
    const lib = path.join(path.sep, 'Audiobooks', 'Audio');
    const info = candidateSkipInfo(lib);
    expect(info({ title: 'B13', asin: 'B0', folder: path.join(lib, 'Chloe Walsh', 'Boys of Tommen', 'Binding 13') }).relPath).toBe('Chloe Walsh/Boys of Tommen/Binding 13');
    expect(info({ title: 'Solo', asin: 'B1', file: path.join(lib, 'Author', 'Solo', 'Solo.m4b') }).relPath).toBe('Author/Solo');
    expect(info({ title: 'Outside', asin: 'B2', folder: path.join(path.sep, 'elsewhere') }).relPath).toBeNull();
  });
});

describe('saveSkipListText', () => {
  it('stores the text as is and returns what was parsed', async () => {
    prismaMock.configuration.upsert.mockResolvedValue({});
    const { saveSkipListText } = await load();
    const parsed = await saveSkipListText(LIST);
    expect(prismaMock.configuration.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { key: 'library_skip_list' }, update: { value: LIST } }));
    expect(parsed.entries).toHaveLength(3);
    expect(parsed.errors).toHaveLength(2);
  });
});
