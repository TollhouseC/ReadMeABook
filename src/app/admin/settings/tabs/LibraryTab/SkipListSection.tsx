/**
 * Component: Library Skip List Settings Section
 * Documentation: documentation/backend/services/jobs.md
 *
 * Paste the whole skip list (replaces it). Self-contained: saves with its own button,
 * independent of the tab's Save.
 */

'use client';

import React, { useEffect, useState } from 'react';
import useSWR from 'swr';
import { authenticatedFetcher, fetchJSON } from '@/lib/utils/api';

interface SkipListResponse {
  text: string;
  entries: number;
  errors: string[];
}

const PLACEHOLDER = `# folder (as the report prints it) | checks | note
Chloe Walsh/Boys of Tommen/Binding 13 | match | Part One + Two in one file
asin:B0764LBS4B | match | abridged CD rip, kept`;

export function SkipListSection() {
  const { data, mutate } = useSWR<SkipListResponse>('/api/admin/settings/library-skip-list', authenticatedFetcher);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data) setText(data.text);
  }, [data]);

  const dirty = !!data && text !== data.text;

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      mutate(await fetchJSON('/api/admin/settings/library-skip-list', { method: 'PUT', body: JSON.stringify({ text }) }), false);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save the skip list');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border-t border-gray-200 dark:border-gray-700 pt-6 mt-6">
      <div className="mb-4">
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">Skip List</h3>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Books you checked and decided to keep, left out of Library Match Check, Chapter Check/Sync and Library
          Merge (and so the Health Report). One per line: <code>folder | checks | note</code> — the folder as the report
          prints it, or <code>asin:B0XXXXXXXX</code>; checks are <code>match</code>, <code>chapters</code>,{' '}
          <code>merge</code> or <code>all</code>. Pasting replaces the whole list.
        </p>
      </div>

      {!data ? (
        <div className="h-40 rounded-lg bg-gray-100 dark:bg-gray-800 animate-pulse" />
      ) : (
        <div className="space-y-2">
          <textarea
            aria-label="Skip list"
            value={text}
            onChange={e => { setText(e.target.value); setSaved(false); }}
            placeholder={PLACEHOLDER}
            rows={10}
            spellCheck={false}
            className="w-full px-3 py-2 font-mono text-xs border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
          />
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={save}
              disabled={saving || !dirty}
              className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save skip list'}
            </button>
            <span className="text-sm text-gray-600 dark:text-gray-400">
              {data.entries} book{data.entries === 1 ? '' : 's'} skipped{saved && !dirty ? ' — saved' : ''}
            </span>
          </div>
          {data.errors.length > 0 && (
            <ul className="text-sm text-amber-700 dark:text-amber-400 list-disc pl-5">
              {data.errors.map(e => <li key={e}>{e} — ignored</li>)}
            </ul>
          )}
          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        </div>
      )}
    </div>
  );
}
