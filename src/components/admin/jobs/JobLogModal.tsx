/**
 * Component: Job Log Modal (live)
 * Documentation: documentation/backend/services/jobs.md
 *
 * Shows a job's progress and log lines in the browser, refreshing every 2s while the job
 * runs — e.g. the chapter check's "Would fix" list without docker exec.
 */

'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { authenticatedFetcher } from '@/lib/utils/api';
import { cancelJobRun, isRunning, type JobProgress } from '@/lib/hooks/useJobRuns';
import { JobProgressBar } from './JobProgressBar';

interface LogEvent {
  id: string;
  level: string;
  message: string;
  createdAt: string;
}

interface JobSummary {
  id: string;
  name: string;
  status: string;
  progress: JobProgress | null;
  cancelRequested: boolean;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
}

/** Matches the events API page size */
const PAGE_SIZE = 500;

const QUICK_FILTERS = ['Would sync', 'Synced', 'Would fix', 'Fixed', 'Corrupt', 'Nested', 'Moved', 'Failed'];

interface JobLogModalProps {
  /** Job ID or Bull job ID (scheduled jobs' lastRunJobId) */
  jobId: string;
  title?: string;
  onClose: () => void;
}

export function JobLogModal({ jobId, title, onClose }: JobLogModalProps) {
  const [job, setJob] = useState<JobSummary | null>(null);
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const lastSeen = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const load = useCallback(async () => {
    try {
      const after = lastSeen.current ? `?after=${encodeURIComponent(lastSeen.current)}` : '';
      const data = await authenticatedFetcher(`/api/admin/job-runs/${jobId}/events${after}`);
      setJob(data.job);
      if (data.events.length > 0) {
        lastSeen.current = data.events[data.events.length - 1].createdAt;
        setEvents(prev => {
          const seen = new Set(prev.map(e => e.id));
          const fresh = (data.events as LogEvent[]).filter(e => !seen.has(e.id));
          return fresh.length ? [...prev, ...fresh] : prev;
        });
      }
      setError(null);
      return { job: data.job as JobSummary, fullPage: data.events.length >= PAGE_SIZE };
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load the job log');
      return null;
    }
  }, [jobId]);

  // Initial load, then poll while the job is running
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const tick = async () => {
      const result = await load();
      if (stopped || !result) return;
      // More lines waiting (long reports) → fetch right away; running → poll every 2s
      if (result.fullPage) timer = setTimeout(tick, 0);
      else if (isRunning(result.job)) timer = setTimeout(tick, 2000);
    };
    tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Keep following new lines unless the user scrolled up
  useEffect(() => {
    if (stickToBottom.current && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [events, filter]);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return needle ? events.filter(e => e.message.toLowerCase().includes(needle)) : events;
  }, [events, filter]);

  // Always offered while running; the job stops at its next safe point
  const canCancel = job && isRunning(job) && !job.cancelRequested;

  const handleCancel = async () => {
    if (!job) return;
    setCancelling(true);
    try {
      await cancelJobRun(job.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to cancel');
    } finally {
      setCancelling(false);
    }
  };

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${title ?? job?.name ?? 'Job'} log`}
        className="w-full max-w-4xl max-h-[90vh] flex flex-col rounded-xl bg-white dark:bg-gray-900 shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-gray-200 dark:border-gray-700">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 truncate">{title ?? job?.name ?? 'Job log'}</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {job ? `Status: ${job.cancelRequested && isRunning(job) ? 'stopping…' : job.status}` : 'Loading…'}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {canCancel && (
              <button
                onClick={handleCancel}
                disabled={cancelling}
                className="px-3 py-1.5 text-sm font-medium rounded-lg bg-red-50 text-red-700 hover:bg-red-100 dark:bg-red-900/30 dark:text-red-300 disabled:opacity-60"
              >
                {cancelling ? 'Cancelling…' : 'Cancel job'}
              </button>
            )}
            <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {job && (
          <div className="px-5 pt-4">
            <JobProgressBar progress={job.progress} status={job.status} startedAt={job.startedAt} completedAt={job.completedAt} />
            {job.errorMessage && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{job.errorMessage}</p>}
          </div>
        )}

        <div className="px-5 pt-3 flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="Filter log lines…"
            aria-label="Filter log lines"
            className="flex-1 min-w-[12rem] px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
          />
          {QUICK_FILTERS.map(q => (
            <button
              key={q}
              onClick={() => setFilter(filter === q ? '' : q)}
              className={`px-2 py-1 text-xs rounded-full border ${filter === q ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300'}`}
            >
              {q}
            </button>
          ))}
          <span className="text-xs text-gray-500 dark:text-gray-400">{visible.length} / {events.length} lines</span>
        </div>

        <div
          ref={listRef}
          onScroll={e => {
            const el = e.currentTarget;
            stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
          className="m-5 mt-3 flex-1 min-h-[12rem] overflow-y-auto rounded-lg bg-gray-50 dark:bg-gray-950 p-3 font-mono text-xs leading-relaxed"
        >
          {error && <p className="text-red-600 dark:text-red-400">{error}</p>}
          {!error && visible.length === 0 && <p className="text-gray-500">{events.length ? 'No lines match the filter.' : 'No log lines yet.'}</p>}
          {visible.map(e => (
            <div
              key={e.id}
              className={e.level === 'error' ? 'text-red-600 dark:text-red-400' : e.level === 'warn' ? 'text-amber-600 dark:text-amber-400' : 'text-gray-800 dark:text-gray-200'}
            >
              <span className="text-gray-400 dark:text-gray-600 mr-2">{new Date(e.createdAt).toLocaleTimeString()}</span>
              {e.message}
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body
  );
}
