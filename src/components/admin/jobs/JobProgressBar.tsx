/**
 * Component: Job Progress Bar
 * Documentation: documentation/backend/services/jobs.md
 */

'use client';

import React from 'react';
import type { JobProgress } from '@/lib/hooks/useJobRuns';

function elapsed(from: string | null, to: string | null): string {
  if (!from) return '';
  const seconds = Math.max(0, Math.round(((to ? new Date(to) : new Date()).getTime() - new Date(from).getTime()) / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
}

interface JobProgressBarProps {
  progress: JobProgress | null;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
}

export function JobProgressBar({ progress, status, startedAt, completedAt }: JobProgressBarProps) {
  const total = progress?.total ?? null;
  const current = progress?.current ?? 0;
  const percent = total && total > 0 ? Math.min(100, Math.round((current / total) * 100)) : null;
  const finished = ['completed', 'failed', 'cancelled'].includes(status);
  const barColor = status === 'failed' ? 'bg-red-500' : status === 'cancelled' ? 'bg-gray-400' : finished ? 'bg-green-500' : 'bg-blue-500';
  const width = finished ? 100 : percent ?? 0;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2 text-xs text-gray-600 dark:text-gray-400">
        <span className="truncate">{progress?.label ?? (status === 'pending' ? 'Queued' : 'Running')}</span>
        <span className="flex-shrink-0 tabular-nums">
          {total ? `${current.toLocaleString()} / ${total.toLocaleString()}` : ''}
          {percent !== null && ` · ${percent}%`}
          {startedAt && ` · ${elapsed(startedAt, completedAt)}`}
        </span>
      </div>
      <div
        className="h-2 w-full rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        aria-label={progress?.label ?? 'Job progress'}
      >
        {percent === null && !finished ? (
          <div className="h-full w-1/3 rounded-full bg-blue-500 animate-pulse" />
        ) : (
          <div className={`h-full rounded-full transition-all duration-500 ${barColor}`} style={{ width: `${width}%` }} />
        )}
      </div>
      {progress?.detail && (
        <p className="text-xs text-gray-500 dark:text-gray-400 truncate" title={progress.detail}>{progress.detail}</p>
      )}
    </div>
  );
}
