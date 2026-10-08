/**
 * Component: Upcoming Releases Section (Profile)
 * Documentation: documentation/features/watched-lists.md
 *
 * Plain list of future releases from the user's watched series and authors:
 * title (series #), author, release date. Pre-orders are requested on release day.
 */

'use client';

import React from 'react';
import { useUpcomingReleases } from '@/lib/hooks/useUpcomingReleases';
import { useWatchedSeries } from '@/lib/hooks/useWatchedSeries';
import { useWatchedAuthors } from '@/lib/hooks/useWatchedAuthors';

function formatDate(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function UpcomingReleasesSection() {
  const { upcoming, isLoading } = useUpcomingReleases();
  const { series } = useWatchedSeries();
  const { authors } = useWatchedAuthors();

  // Nothing watched → nothing to show
  if (series.length === 0 && authors.length === 0) return null;

  return (
    <section>
      <div className="flex items-center gap-3 mb-5">
        <div className="w-1 h-6 bg-gradient-to-b from-amber-500 to-orange-500 rounded-full" />
        <h2 className="text-xl font-bold text-gray-900 dark:text-white">Upcoming Releases</h2>
        {!isLoading && <span className="text-sm text-gray-500 dark:text-gray-400">({upcoming.length})</span>}
      </div>

      {isLoading ? (
        <div className="h-24 rounded-xl bg-gray-100 dark:bg-gray-800 animate-pulse" />
      ) : upcoming.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          No upcoming releases found for your watched series and authors. This list refreshes with the nightly
          watched-list check (and right after you watch something new).
        </p>
      ) : (
        <ul className="rounded-xl bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700/50 divide-y divide-gray-100 dark:divide-gray-700/50">
          {upcoming.map(item => (
            <li key={item.asin} className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                  {item.title}
                  {item.series && (
                    <span className="font-normal text-gray-500 dark:text-gray-400">
                      {' '}({item.series}{item.seriesPart ? ` #${item.seriesPart}` : ''})
                    </span>
                  )}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{item.author}</p>
              </div>
              <time dateTime={item.releaseDate} className="flex-shrink-0 text-sm font-medium text-gray-700 dark:text-gray-300">
                {formatDate(item.releaseDate)}
              </time>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">
        Requested automatically on release day.
      </p>
    </section>
  );
}
