/**
 * Component: Release Language Settings Section
 * Documentation: documentation/phase3/ranking-algorithm.md
 *
 * Self-contained (saves immediately) so it doesn't depend on the tab's Save button.
 */

'use client';

import React, { useState } from 'react';
import useSWR from 'swr';
import { authenticatedFetcher, fetchJSON } from '@/lib/utils/api';
import { RELEASE_LANGUAGES, type RequiredLanguage } from '@/lib/constants/release-languages';

const label = (language: string) => language.charAt(0).toUpperCase() + language.slice(1);

export function ReleaseLanguageSection() {
  const { data, mutate } = useSWR<{ language: RequiredLanguage }>('/api/admin/settings/release-language', authenticatedFetcher);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (language: RequiredLanguage) => {
    setSaving(true);
    setError(null);
    mutate({ language }, false);
    try {
      mutate(await fetchJSON('/api/admin/settings/release-language', {
        method: 'PUT',
        body: JSON.stringify({ language }),
      }), false);
    } catch (err) {
      mutate();
      setError(err instanceof Error ? err.message : 'Failed to save release language');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border-t border-gray-200 dark:border-gray-700 pt-6">
      <div className="mb-4">
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">Release Language</h3>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Hide indexer releases tagged with a different language (e.g. &quot;[GER]&quot;, &quot;Hörbuch&quot;,
          &quot;German Edition&quot;) from automatic and interactive searches, for every user. Releases with
          no language tag are always allowed, since most English releases aren&apos;t labelled.
        </p>
      </div>

      {!data ? (
        <div className="h-10 w-64 rounded-lg bg-gray-100 dark:bg-gray-800 animate-pulse" />
      ) : (
        <div className="space-y-2">
          <label htmlFor="release-language" className="block text-sm font-medium text-gray-900 dark:text-gray-100">
            Required language
          </label>
          <select
            id="release-language"
            value={data.language}
            disabled={saving}
            onChange={e => save(e.target.value as RequiredLanguage)}
            className="w-64 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 disabled:opacity-60"
          >
            {RELEASE_LANGUAGES.map(language => (
              <option key={language} value={language}>{label(language)}</option>
            ))}
            <option value="any">Any language (no filtering)</option>
          </select>
          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        </div>
      )}
    </div>
  );
}
