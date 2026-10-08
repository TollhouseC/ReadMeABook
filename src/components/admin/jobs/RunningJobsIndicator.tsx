/**
 * Component: Running Jobs Indicator (admin header)
 * Documentation: documentation/backend/services/jobs.md
 *
 * Small pill shown to admins on every page while long jobs run; opens a panel with
 * live progress bars, Cancel, and the live log.
 */

'use client';

import React, { useEffect, useRef, useState } from 'react';
import { isRunning, useJobRuns } from '@/lib/hooks/useJobRuns';
import { RunningJobsList } from './RunningJobsList';

export function RunningJobsIndicator() {
  const { jobs, refresh } = useJobRuns();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const running = jobs.filter(isRunning);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      // Clicks inside the log modal (portal) shouldn't close the panel
      const target = e.target as HTMLElement;
      if (containerRef.current?.contains(target) || target.closest('[role="dialog"]')) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  // Nothing running or just finished → no indicator
  if (jobs.length === 0) return null;

  return (
    <div className="relative" ref={containerRef}>
      <button
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-label={`${running.length} job(s) running`}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-full bg-blue-50 text-blue-700 hover:bg-blue-100 dark:bg-blue-900/30 dark:text-blue-300 dark:hover:bg-blue-900/50"
      >
        {running.length > 0 ? (
          <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
        ) : (
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        )}
        <span>{running.length > 0 ? `${running.length} job${running.length === 1 ? '' : 's'} running` : 'Jobs done'}</span>
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-[min(26rem,calc(100vw-2rem))] max-h-[70vh] overflow-y-auto rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-xl p-4 z-50">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Background jobs</h3>
            <a href="/admin/jobs" className="text-xs text-blue-600 dark:text-blue-400 hover:underline">Jobs page</a>
          </div>
          <RunningJobsList jobs={jobs} onChanged={() => refresh()} />
        </div>
      )}
    </div>
  );
}
