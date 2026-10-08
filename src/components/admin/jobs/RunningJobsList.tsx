/**
 * Component: Running Jobs List
 * Documentation: documentation/backend/services/jobs.md
 *
 * Long jobs with live progress bars, Cancel, and a link to the live log.
 * Used in the admin header indicator and on the Jobs page.
 */

'use client';

import React, { useState } from 'react';
import { cancelJobRun, isRunning, type JobRun } from '@/lib/hooks/useJobRuns';
import { JobProgressBar } from './JobProgressBar';
import { JobLogModal } from './JobLogModal';

const STATUS_STYLES: Record<string, string> = {
  active: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  pending: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
  completed: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  cancelled: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400',
};

const statusLabel = (job: JobRun) =>
  job.cancelRequested && isRunning(job) ? 'stopping…' : job.status === 'active' ? 'running' : job.status === 'pending' ? 'queued' : job.status;

interface RunningJobsListProps {
  jobs: JobRun[];
  onChanged?: () => void;
  emptyMessage?: string;
}

export function RunningJobsList({ jobs, onChanged, emptyMessage = 'No long-running jobs right now.' }: RunningJobsListProps) {
  const [logJob, setLogJob] = useState<JobRun | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const cancel = async (job: JobRun) => {
    setBusy(job.id);
    try {
      const result = await cancelJobRun(job.id);
      setMessage(result.message);
      onChanged?.();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to cancel');
    } finally {
      setBusy(null);
    }
  };

  if (jobs.length === 0) return <p className="text-sm text-gray-500 dark:text-gray-400">{emptyMessage}</p>;

  return (
    <div className="space-y-3">
      {message && <p className="text-xs text-gray-600 dark:text-gray-300">{message}</p>}
      {jobs.map(job => {
        const cancellable = isRunning(job) && !job.cancelRequested && (job.status !== 'active' || job.progress?.cancellable);
        return (
          <div key={job.id} className="rounded-lg border border-gray-200 dark:border-gray-700 p-3 space-y-2">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{job.name}</p>
                {job.bookTitle && <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{job.bookTitle}</p>}
              </div>
              <span className={`flex-shrink-0 px-2 py-0.5 text-xs font-medium rounded-full ${STATUS_STYLES[job.status] ?? STATUS_STYLES.pending}`}>
                {statusLabel(job)}
              </span>
            </div>
            <JobProgressBar progress={job.progress} status={job.status} startedAt={job.startedAt} completedAt={job.completedAt} />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setLogJob(job)}
                className="px-2.5 py-1 text-xs font-medium rounded-md text-blue-700 hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-blue-900/30"
              >
                View log
              </button>
              {cancellable && (
                <button
                  onClick={() => cancel(job)}
                  disabled={busy === job.id}
                  className="px-2.5 py-1 text-xs font-medium rounded-md text-red-700 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-900/30 disabled:opacity-60"
                >
                  {busy === job.id ? 'Cancelling…' : job.status === 'active' ? 'Cancel' : 'Remove from queue'}
                </button>
              )}
            </div>
          </div>
        );
      })}
      {logJob && (
        <JobLogModal
          jobId={logJob.id}
          title={`${logJob.name}${logJob.bookTitle ? ` — ${logJob.bookTitle}` : ''}`}
          onClose={() => {
            setLogJob(null);
            onChanged?.();
          }}
        />
      )}
    </div>
  );
}
