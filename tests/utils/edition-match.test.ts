/**
 * Component: Other-Edition Library Match Tests
 * Documentation: documentation/integrations/audible.md
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaMock } from '../helpers/prisma';

const prismaMock = createPrismaMock();
vi.mock('@/lib/db', () => ({ prisma: prismaMock }));

const load = () => import('@/lib/utils/edition-match');

const library = [
  { asin: 'B0161R0XBQ', plexGuid: 'g-aom', title: 'Age of Myth', author: 'Michael J. Sullivan' },
  { asin: 'B0LOTR0001', plexGuid: 'g-fotr', title: 'The Fellowship of the Ring', author: 'J. R. R. Tolkien' },
  { asin: 'B0GA000001', plexGuid: 'g-woa', title: 'The Well of Ascension [Dramatized Adaptation]', author: 'Brandon Sanderson' },
];

beforeEach(async () => {
  vi.clearAllMocks();
  prismaMock.plexLibrary.findMany.mockResolvedValue(library);
  (await load()).clearEditionCache();
});

describe('findOwnedEdition', () => {
  it('finds a re-issued edition of a book you own (Age of Myth)', async () => {
    const { findOwnedEdition } = await load();
    expect(await findOwnedEdition({ asin: 'B0DNLG5BW7', title: 'Age of Myth', author: 'Michael J. Sullivan' }))
      .toMatchObject({ asin: 'B0161R0XBQ', plexGuid: 'g-aom' });
  });

  it('ignores punctuation, "Unabridged", leading articles and author spelling', async () => {
    const { findOwnedEdition } = await load();
    expect(await findOwnedEdition({ asin: 'B0NEW00001', title: 'Fellowship of the Ring (Unabridged)', author: 'J.R.R. Tolkien' }))
      .toMatchObject({ asin: 'B0LOTR0001' });
  });

  it('never matches across version types', async () => {
    const { findOwnedEdition } = await load();
    expect(await findOwnedEdition({ asin: 'B09P4915DW', title: 'Age of Myth [Dramatized Adaptation]', author: 'Michael J. Sullivan' })).toBeNull();
    expect(await findOwnedEdition({ asin: 'B0STD00001', title: 'The Well of Ascension', author: 'Brandon Sanderson' })).toBeNull();
  });

  it('needs the same author and a different ASIN', async () => {
    const { findOwnedEdition } = await load();
    expect(await findOwnedEdition({ asin: 'B0OTHER001', title: 'Age of Myth', author: 'Someone Else' })).toBeNull();
    expect(await findOwnedEdition({ asin: 'B0161R0XBQ', title: 'Age of Myth', author: 'Michael J. Sullivan' })).toBeNull();
  });

  it('reads the library once per minute', async () => {
    const { findOwnedEdition } = await load();
    await findOwnedEdition({ asin: 'B1', title: 'Age of Myth', author: 'Michael J. Sullivan' });
    await findOwnedEdition({ asin: 'B2', title: 'Something', author: 'Anyone' });
    expect(prismaMock.plexLibrary.findMany).toHaveBeenCalledTimes(1);
  });
});
