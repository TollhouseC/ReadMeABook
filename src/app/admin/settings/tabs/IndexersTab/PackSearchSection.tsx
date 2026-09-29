/**
 * Component: Series & Author Packs Settings Section
 * Documentation: documentation/features/series-packs.md
 *
 * Self-contained (saves immediately) so it doesn't depend on the tab's Save button.
 */

'use client';

import React, { useState } from 'react';
import useSWR from 'swr';
import { authenticatedFetcher, fetchJSON } from '@/lib/utils/api';

type AuthorPackMode = 'disabled' | 'log_only' | 'enabled';

interface PackSearchSettings {
  enabled: boolean;
  authorPackMode: AuthorPackMode;
}

const AUTHOR_MODE_OPTIONS: { value: AuthorPackMode; label: string; description: string }[] = [
  { value: 'log_only', label: 'Log only (testing)', description: 'Evaluate author collections and log what would be grabbed, but never download them.' },
  { value: 'enabled', label: 'Enabled', description: 'Grab author collections and import only the requested series from them.' },
  { value: 'disabled', label: 'Disabled', description: 'Never search author collections.' },
];

export function PackSearchSection() {
  const { data, mutate } = useSWR<PackSearchSettings>('/api/admin/settings/pack-search', authenticatedFetcher);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (update: Partial<PackSearchSettings>) => {
    if (!data) return;
    setSaving(true);
    setError(null);
    mutate({ ...data, ...update }, false);
    try {
      const saved = await fetchJSON('/api/admin/settings/pack-search', {
        method: 'PUT',
        body: JSON.stringify(update),
      });
      mutate(saved, false);
    } catch (err) {
      mutate();
      setError(err instanceof Error ? err.message : 'Failed to save pack search settings');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border-t border-gray-200 dark:border-gray-700 pt-6">
      <div className="mb-4">
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">
          Series &amp; Author Packs
        </h3>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          When a book in a series has no usable individual release after 24 hours, also search for
          multi-book packs. A pack is only grabbed after its file list is checked to contain the book;
          only the requested series&apos; books are downloaded (qBittorrent) and imported.
        </p>
      </div>

      {!data ? (
        <div className="h-16 rounded-lg bg-gray-100 dark:bg-gray-800 animate-pulse" />
      ) : (
        <div className="space-y-4">
          <label className="flex items-start gap-3 cursor-pointer">
            <button
              type="button"
              role="switch"
              aria-checked={data.enabled}
              aria-label="Search for series packs"
              disabled={saving}
              onClick={() => save({ enabled: !data.enabled })}
              className="relative inline-flex h-5 w-10 flex-shrink-0 items-center rounded-full transition-colors mt-0.5 disabled:opacity-60"
              style={{ backgroundColor: data.enabled ? '#3b82f6' : '#d1d5db' }}
            >
              <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${data.enabled ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
            <span>
              <span className="block text-sm font-medium text-gray-900 dark:text-gray-100">Search for series packs</span>
              <span className="block text-xs text-gray-500 dark:text-gray-400">
                e.g. &quot;Mistborn Complete Series&quot;. Imports every book of the series in the pack
                (missing books are requested automatically for auto-approved users).
              </span>
            </span>
          </label>

          <fieldset disabled={!data.enabled || saving} className={!data.enabled ? 'opacity-50' : ''}>
            <legend className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-2">Author collections</legend>
            <div className="space-y-2">
              {AUTHOR_MODE_OPTIONS.map(option => (
                <label key={option.value} className="flex items-start gap-3 p-3 border border-gray-200 dark:border-gray-700 rounded-lg cursor-pointer">
                  <input
                    type="radio"
                    name="authorPackMode"
                    value={option.value}
                    checked={data.authorPackMode === option.value}
                    onChange={() => save({ authorPackMode: option.value })}
                    className="mt-1"
                  />
                  <span>
                    <span className="block text-sm text-gray-900 dark:text-gray-100">{option.label}</span>
                    <span className="block text-xs text-gray-500 dark:text-gray-400">{option.description}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        </div>
      )}
    </div>
  );
}
