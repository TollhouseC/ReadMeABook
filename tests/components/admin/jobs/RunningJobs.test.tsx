/**
 * Component: Running Jobs Indicator / Log Modal Tests
 * Documentation: documentation/backend/services/jobs.md
 */

// @vitest-environment jsdom

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ jobs: [] as any[] }));
const apiMocks = vi.hoisted(() => ({ authenticatedFetcher: vi.fn(), fetchJSON: vi.fn() }));

vi.mock('@/lib/utils/api', () => apiMocks);
vi.mock('swr', () => ({
  default: (key: string | null) => ({ data: key ? { jobs: state.jobs } : undefined, error: undefined, mutate: vi.fn() }),
}));

import { RunningJobsIndicator } from '@/components/admin/jobs/RunningJobsIndicator';
import { JobLogModal } from '@/components/admin/jobs/JobLogModal';

const chapterJob = {
  id: 'j1', bullJobId: 'b1', type: 'fix_chapters', name: 'Chapter Check / Fix', status: 'active',
  progress: { current: 412, total: 1520, label: 'Checking chapters', detail: 'Embrace', cancellable: true, updatedAt: '' },
  cancelRequested: false, startedAt: new Date().toISOString(), completedAt: null, createdAt: '', errorMessage: null, bookTitle: null,
};

describe('RunningJobsIndicator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.jobs = [];
  });

  it('is hidden when nothing is running', () => {
    const { container } = render(<RunningJobsIndicator />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows running jobs with progress and a working Cancel button', async () => {
    state.jobs = [chapterJob];
    apiMocks.fetchJSON.mockResolvedValue({ success: true, message: 'Stopping at the next safe point' });
    render(<RunningJobsIndicator />);

    fireEvent.click(screen.getByRole('button', { name: '1 job(s) running' }));
    expect(screen.getByText('Chapter Check / Fix')).toBeInTheDocument();
    expect(screen.getByText(/412 \/ 1,520 · 27%/)).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '27');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(apiMocks.fetchJSON).toHaveBeenCalledWith('/api/admin/job-runs/j1/cancel', { method: 'POST' }));
    expect(await screen.findByText('Stopping at the next safe point')).toBeInTheDocument();
  });

  it('hides Cancel once a job is past its cancellable stage', () => {
    state.jobs = [{ ...chapterJob, type: 'plex_library_scan', name: 'Library Scan', progress: { ...chapterJob.progress, cancellable: false } }];
    render(<RunningJobsIndicator />);
    fireEvent.click(screen.getByRole('button', { name: '1 job(s) running' }));
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });
});

describe('JobLogModal', () => {
  it('shows log lines and filters them (e.g. the chapter report)', async () => {
    apiMocks.authenticatedFetcher.mockResolvedValue({
      job: { ...chapterJob, status: 'completed', progress: { ...chapterJob.progress, current: 1520 } },
      events: [
        { id: 'e1', level: 'info', message: 'Chapter check (report only): 1520 book(s) to check', createdAt: '2026-10-09T12:00:00Z' },
        { id: 'e2', level: 'info', message: 'Would fix "Embrace": 1 → 30 chapters', createdAt: '2026-10-09T12:00:01Z' },
        { id: 'e3', level: 'warn', message: 'Corrupt (unplayable) "X": /a/x.m4b — moov atom not found', createdAt: '2026-10-09T12:00:02Z' },
      ],
    });
    render(<JobLogModal jobId="b1" title="Chapter Check (Report Only) — last run" onClose={vi.fn()} />);

    expect(await screen.findByText(/Would fix "Embrace"/)).toBeInTheDocument();
    expect(apiMocks.authenticatedFetcher).toHaveBeenCalledWith('/api/admin/job-runs/b1/events');

    fireEvent.click(screen.getByRole('button', { name: 'Would fix' }));
    expect(screen.queryByText(/moov atom/)).toBeNull();
    expect(screen.getByText('1 / 3 lines')).toBeInTheDocument();
  });
});
