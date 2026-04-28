/**
 * Component: Ignored Audiobooks Utility
 * Documentation: documentation/features/ignored-audiobooks.md
 *
 * Shared utility for annotating audiobook lists with global ignore status.
 * Uses a single bulk query for the full ignore list, then annotates in-memory.
 */

import { prisma } from '@/lib/db';

/**
 * Annotate an array of audiobook objects with `isIgnored: boolean`.
 * Checks the server-wide ignore list — userId param retained for API compatibility.
 */
export async function annotateWithIgnoreStatus<T extends { asin: string }>(
  audiobooks: T[],
  _userId?: string
): Promise<(T & { isIgnored: boolean })[]> {
  if (audiobooks.length === 0) {
    return audiobooks.map((book) => ({ ...book, isIgnored: false }));
  }

  const ignoredEntries = await prisma.ignoredAudiobook.findMany({
    select: { asin: true },
  });

  const ignoredAsinSet = new Set(ignoredEntries.map((e) => e.asin));

  return audiobooks.map((book) => ({
    ...book,
    isIgnored: ignoredAsinSet.has(book.asin),
  }));
}
