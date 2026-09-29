/**
 * Component: Watched Lists Version Planner Tests
 * Documentation: documentation/features/watched-lists.md
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaMock } from '../helpers/prisma';
import type { AudibleAudiobook } from '@/lib/integrations/audible.service';
import type { VersionPlanContext } from '@/lib/services/watched-lists-versions';

const prismaMock = createPrismaMock();

vi.mock('@/lib/db', () => ({ prisma: prismaMock }));

const standard: AudibleAudiobook = {
  asin: 'B0STANDARD', title: 'Mistborn: The Final Empire', author: 'Brandon Sanderson',
  narrator: 'Michael Kramer', rating: 4.7,
};
const dramatized: AudibleAudiobook = {
  asin: 'B0DRAMATIZ', title: 'Mistborn: The Final Empire (Dramatized Adaptation)', author: 'Brandon Sanderson',
  narrator: 'Full Cast', rating: 4.8,
};
const otherBook: AudibleAudiobook = {
  asin: 'B0WELLOFAS', title: 'Mistborn: The Well of Ascension', author: 'Brandon Sanderson', narrator: 'Michael Kramer',
};

function ctx(overrides: Partial<VersionPlanContext> = {}): VersionPlanContext {
  return {
    ownedAsins: new Set(),
    ownedWorkKeys: new Set(),
    requestedAsins: new Set(),
    allowAlternateVersions: false,
    ...overrides,
  };
}

async function plan(books: AudibleAudiobook[], context: VersionPlanContext) {
  const { planVersionRequests } = await import('@/lib/services/watched-lists-versions');
  return Object.fromEntries(planVersionRequests(books, context).map(item => [item.book.asin, item]));
}

describe('planVersionRequests — default (alternates off)', () => {
  it('requests only the standard version when no version exists', async () => {
    const result = await plan([dramatized, standard, otherBook], ctx());

    expect(result.B0STANDARD.action).toBe('request');
    expect(result.B0DRAMATIZ.action).toBe('skip_duplicate_version');
    expect(result.B0WELLOFAS.action).toBe('request'); // different book, unaffected
  });

  it('skips every other version when one is already on the server (by ASIN)', async () => {
    const result = await plan([standard, dramatized], ctx({ ownedAsins: new Set(['B0DRAMATIZ']) }));

    expect(result.B0DRAMATIZ.action).toBe('skip_owned');
    expect(result.B0STANDARD.action).toBe('skip_duplicate_version');
  });

  it('skips all versions when the library has the work under an ASIN not in the listing', async () => {
    const { getWorkKey } = await import('@/lib/utils/book-versions');
    const result = await plan([standard, dramatized], ctx({ ownedWorkKeys: new Set([getWorkKey(standard)]) }));

    expect(result.B0STANDARD.action).toBe('skip_duplicate_version');
    expect(result.B0DRAMATIZ.action).toBe('skip_duplicate_version');
  });

  it('skips the other versions when one is already requested', async () => {
    const result = await plan([standard, dramatized], ctx({ requestedAsins: new Set(['B0STANDARD']) }));

    expect(result.B0STANDARD.action).toBe('skip_requested');
    expect(result.B0DRAMATIZ.action).toBe('skip_duplicate_version');
  });
});

describe('planVersionRequests — alternates on', () => {
  it('requests the standard version normally and queues the rest for approval with a label', async () => {
    const result = await plan([dramatized, standard], ctx({ allowAlternateVersions: true }));

    expect(result.B0STANDARD).toMatchObject({ action: 'request' });
    expect(result.B0DRAMATIZ).toMatchObject({ action: 'request_alternate', versionLabel: 'Dramatized Adaptation' });
  });

  it('queues the standard version for approval, unlabelled, when another version is owned', async () => {
    const result = await plan([standard, dramatized], ctx({
      allowAlternateVersions: true,
      ownedAsins: new Set(['B0DRAMATIZ']),
    }));

    expect(result.B0DRAMATIZ.action).toBe('skip_owned');
    expect(result.B0STANDARD).toMatchObject({ action: 'request_alternate', versionLabel: undefined });
  });

  it('labels a second standard narration by its narrator', async () => {
    const jimDale: AudibleAudiobook = { asin: 'B0JIMDALE0', title: "Harry Potter and the Sorcerer's Stone", author: 'J.K. Rowling', narrator: 'Jim Dale', rating: 4.9 };
    const stephenFry: AudibleAudiobook = { asin: 'B0STEPHENF', title: "Harry Potter and the Sorcerer's Stone", author: 'J.K. Rowling', narrator: 'Stephen Fry', rating: 4.8 };

    const result = await plan([jimDale, stephenFry], ctx({ allowAlternateVersions: true }));

    expect(result.B0JIMDALE0.action).toBe('request');
    expect(result.B0STEPHENF).toMatchObject({ action: 'request_alternate', versionLabel: 'Narrated by Stephen Fry' });
  });

  it('never re-requests a version that is owned or already requested', async () => {
    const result = await plan([standard, dramatized], ctx({
      allowAlternateVersions: true,
      ownedAsins: new Set(['B0STANDARD']),
      requestedAsins: new Set(['B0DRAMATIZ']),
    }));

    expect(result.B0STANDARD.action).toBe('skip_owned');
    expect(result.B0DRAMATIZ.action).toBe('skip_requested');
  });
});

describe('getRequestedAsins', () => {
  beforeEach(() => vi.clearAllMocks());

  it('only counts active audiobook requests', async () => {
    prismaMock.audiobook.findMany.mockResolvedValueOnce([{ audibleAsin: 'B0STANDARD' }]);
    const { getRequestedAsins } = await import('@/lib/services/watched-lists-versions');

    const result = await getRequestedAsins(['B0STANDARD', 'B0DRAMATIZ']);

    expect(result).toEqual(new Set(['B0STANDARD']));
    expect(prismaMock.audiobook.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        audibleAsin: { in: ['B0STANDARD', 'B0DRAMATIZ'] },
        requests: {
          some: {
            type: 'audiobook',
            deletedAt: null,
            status: { notIn: ['failed', 'warn', 'cancelled', 'denied'] },
          },
        },
      },
    }));
  });

  it('skips the query for an empty list', async () => {
    const { getRequestedAsins } = await import('@/lib/services/watched-lists-versions');
    expect(await getRequestedAsins([])).toEqual(new Set());
    expect(prismaMock.audiobook.findMany).not.toHaveBeenCalled();
  });
});

describe('getOwnedWorkKeys', () => {
  beforeEach(() => vi.clearAllMocks());

  it('looks up library items by primary author and returns their work keys', async () => {
    prismaMock.plexLibrary.findMany.mockResolvedValueOnce([
      { title: 'Mistborn: The Final Empire (Dramatized Adaptation)', author: 'Brandon Sanderson' },
    ]);
    const { getOwnedWorkKeys } = await import('@/lib/services/watched-lists-versions');
    const { getWorkKey } = await import('@/lib/utils/book-versions');

    const keys = await getOwnedWorkKeys([
      standard,
      { ...otherBook, author: 'Brandon Sanderson, Someone Else' },
    ]);

    expect(prismaMock.plexLibrary.findMany).toHaveBeenCalledWith({
      where: { OR: [{ author: { contains: 'Brandon Sanderson', mode: 'insensitive' } }] },
      select: { title: true, author: true },
    });
    expect(keys.has(getWorkKey(standard))).toBe(true);
  });
});
