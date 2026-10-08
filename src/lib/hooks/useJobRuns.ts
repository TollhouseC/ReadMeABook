/**
 * Component: Job Runs Hook (live job progress)
 * Documentation: documentation/backend/services/jobs.md
 */

'use client';

import useSWR from 'swr';
import { authenticatedFetcher, fetchJSON } from '@/lib/utils/api';

export interface JobProgress {
  current: number;
  total: number | null;
  label: string;
  detail?: string;
  cancellable: boolean;
  updatedAt: string;
}

export interface JobRun {
  id: string;
  bullJobId: string | null;
  type: string;
  name: string;
  status: string;
  progress: JobProgress | null;
  cancelRequested: boolean;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  errorMessage: string | null;
  bookTitle: string | null;
}

export const isRunning = (job: Pick<JobRun, 'status'>) => ['active', 'pending', 'delayed', 'stuck'].includes(job.status);

/** Running / just-finished long jobs. Polls every 3s while something runs, else every 30s. */
export function useJobRuns(enabled = true) {
  const { data, error, mutate } = useSWR<{ jobs: JobRun[] }>(
    enabled ? '/api/admin/job-runs' : null,
    authenticatedFetcher,
    { refreshInterval: latest => (latest?.jobs?.some(isRunning) ? 3000 : 30000) }
  );
  return { jobs: data?.jobs ?? [], error, refresh: mutate };
}

export async function cancelJobRun(jobId: string): Promise<{ success: boolean; message: string }> {
  return fetchJSON(`/api/admin/job-runs/${jobId}/cancel`, { method: 'POST' });
}
