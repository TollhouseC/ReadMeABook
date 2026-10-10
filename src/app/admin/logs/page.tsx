/**
 * Component: Admin System Logs Page
 * Documentation: documentation/admin-dashboard.md
 */

'use client';

import { useState } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import { authenticatedFetcher } from '@/lib/utils/api';

interface JobEvent {
  id: string;
  level: string;
  context: string;
  message: string;
  metadata: any;
  createdAt: string;
}

interface Log {
  id: string;
  bullJobId: string | null;
  type: string;
  status: string;
  priority: number;
  attempts: number;
  maxAttempts: number;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  result: any;
  events: JobEvent[];
  request: {
    id: string;
    audiobook: {
      title: string;
      author: string;
    } | null;
    user: {
      plexUsername: string;
    };
  } | null;
}

interface LogsData {
  logs: Log[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

function StatusBadge({ status }: { status: string }) {
  const config: Record<string, { dot: string; text: string; bg: string }> = {
    completed: { dot: 'bg-emerald-500', text: 'text-emerald-700 dark:text-emerald-400', bg: 'bg-emerald-500/10' },
    failed: { dot: 'bg-red-500', text: 'text-red-700 dark:text-red-400', bg: 'bg-red-500/10' },
    active: { dot: 'bg-blue-500', text: 'text-blue-700 dark:text-blue-400', bg: 'bg-blue-500/10' },
    pending: { dot: 'bg-amber-500', text: 'text-amber-700 dark:text-amber-400', bg: 'bg-amber-500/10' },
    delayed: { dot: 'bg-orange-500', text: 'text-orange-700 dark:text-orange-400', bg: 'bg-orange-500/10' },
    stuck: { dot: 'bg-purple-500', text: 'text-purple-700 dark:text-purple-400', bg: 'bg-purple-500/10' },
  };
  const c = config[status] ?? { dot: 'bg-gray-400', text: 'text-gray-600 dark:text-gray-400', bg: 'bg-gray-500/10' };

  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium ${c.bg} ${c.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${c.dot}`} />
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

function LogDetails({ log }: { log: Log }) {
  return (
    <div className="space-y-4">
      {log.bullJobId && (
        <div className="flex flex-wrap gap-1.5 items-baseline">
          <span className="text-xs font-medium text-gray-500 dark:text-gray-400">Bull Job ID:</span>
          <span className="text-xs text-gray-700 dark:text-gray-300 font-mono break-all">{log.bullJobId}</span>
        </div>
      )}

      {log.events.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide mb-2">
            Event Log
          </h4>
          <div className="space-y-px max-h-72 sm:max-h-96 overflow-y-auto bg-gray-950 dark:bg-black/60 rounded-xl p-3 font-mono text-xs">
            {log.events.map((event) => {
              const timestamp = new Date(event.createdAt).toISOString().split('T')[1].split('.')[0];
              const levelColor = event.level === 'error'
                ? 'text-red-400'
                : event.level === 'warn'
                ? 'text-amber-400'
                : 'text-emerald-400';

              return (
                <div key={event.id} className="text-gray-300 leading-relaxed">
                  <span className={levelColor}>[{event.context}]</span>
                  {' '}
                  <span className="break-words">{event.message}</span>
                  <span className="text-gray-500 ml-2">{timestamp}</span>
                  {event.metadata && Object.keys(event.metadata).length > 0 && (
                    <pre className="ml-4 mt-1 text-gray-400 text-xs overflow-x-auto">
                      {JSON.stringify(event.metadata, null, 2)}
                    </pre>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {log.result && Object.keys(log.result).length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide mb-2">
            Job Result
          </h4>
          <pre className="p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-xl text-xs text-blue-900 dark:text-blue-300 font-mono overflow-x-auto max-h-48">
            {JSON.stringify(log.result, null, 2)}
          </pre>
        </div>
      )}

      {log.errorMessage && (
        <div>
          <h4 className="text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide mb-2">
            Error
          </h4>
          <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl text-xs text-red-700 dark:text-red-300 font-mono whitespace-pre-wrap break-words">
            {log.errorMessage}
          </div>
        </div>
      )}
    </div>
  );
}

function formatDuration(startedAt: string | null, completedAt: string | null) {
  if (!startedAt) return 'N/A';
  if (!completedAt) return 'Running…';
  const durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  const seconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function formatType(type: string) {
  return type.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
}

function formatDateShort(dateStr: string) {
  const d = new Date(dateStr);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
    d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function AdminLogsPage() {
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [expandedLog, setExpandedLog] = useState<string | null>(null);

  const { data, error } = useSWR<LogsData>(
    `/api/admin/logs?page=${page}&limit=50&status=${statusFilter}&type=${typeFilter}`,
    authenticatedFetcher,
    { refreshInterval: 10000 }
  );

  const isLoading = !data && !error;

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-8">
        <div className="max-w-7xl mx-auto">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-8">
        <div className="max-w-7xl mx-auto">
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
            <h3 className="text-sm font-medium text-red-800 dark:text-red-200">Error Loading Logs</h3>
            <p className="text-sm text-red-700 dark:text-red-300 mt-1">
              {error?.message || 'Failed to load system logs'}
            </p>
          </div>
        </div>
      </div>
    );
  }

  const logs = data?.logs || [];
  const pagination = data?.pagination;
  const hasDetails = (log: Log) => log.events.length > 0 || !!log.errorMessage || !!log.bullJobId || (log.result && Object.keys(log.result).length > 0);

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8">

        {/* Header — stacks on mobile, row on sm+ */}
        <div className="sticky top-0 z-10 mb-6 sm:mb-8 bg-gray-50 dark:bg-gray-900 py-4 -mx-4 px-4 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8 border-b border-gray-200 dark:border-gray-800">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 dark:text-gray-100">
                System Logs
              </h1>
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                View background jobs and system activity
              </p>
            </div>
            <Link
              href="/admin"
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-900 dark:text-gray-100 rounded-lg transition-colors text-sm font-medium self-start sm:self-auto flex-shrink-0"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
              </svg>
              <span>Back to Dashboard</span>
            </Link>
          </div>
        </div>

        {/* Filters — full-width stacked on mobile */}
        <div className="mb-6 grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
          <div>
            <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1.5">
              Status
            </label>
            <select
              value={statusFilter}
              onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
              className="w-full px-3 py-2.5 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
            >
              <option value="all">All Statuses</option>
              <option value="pending">Pending</option>
              <option value="active">Active</option>
              <option value="completed">Completed</option>
              <option value="failed">Failed</option>
              <option value="delayed">Delayed</option>
              <option value="stuck">Stuck</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1.5">
              Job Type
            </label>
            <select
              value={typeFilter}
              onChange={(e) => { setTypeFilter(e.target.value); setPage(1); }}
              className="w-full px-3 py-2.5 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
            >
              <option value="all">All Types</option>
              <option value="search_indexers">Search Indexers</option>
              <option value="download_torrent">Download Torrent</option>
              <option value="monitor_download">Monitor Download</option>
              <option value="organize_files">Organize Files</option>
              <option value="scan_plex">Library Scan</option>
              <option value="match_plex">Library Match</option>
              <option value="plex_library_scan">Library Scan (Scheduled)</option>
              <option value="plex_recently_added_check">Recently Added Check</option>
              <option value="audible_refresh">Audible Refresh</option>
              <option value="retry_missing_torrents">Retry Missing Torrents</option>
              <option value="retry_failed_imports">Retry Failed Imports</option>
              <option value="cleanup_seeded_torrents">Cleanup Seeded Torrents</option>
              <option value="monitor_rss_feeds">Monitor RSS Feeds</option>
              <option value="check_stalled_downloads">Check Stalled Downloads</option>
              <option value="merge_library_book">Merge Library Book</option>
              <option value="fix_chapters">Fix Chapters</option>
              <option value="fix_library_layout">Fix Library Layout</option>
              <option value="merge_library">Library Merge</option>
              <option value="organize_library">Library Organize</option>
              <option value="match_library">Library Match Check</option>
              <option value="library_health_report">Library Health Report</option>
              <option value="abs_force_scan">Audiobookshelf Force Re-Scan</option>
            </select>
          </div>
        </div>

        {/* Mobile card list — hidden on sm+ */}
        <div className="space-y-3 sm:hidden">
          {logs.map((log) => (
            <div
              key={log.id}
              className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden"
            >
              {/* Card header */}
              <div className="px-4 py-3">
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div className="font-semibold text-gray-900 dark:text-gray-100 text-sm leading-snug">
                    {formatType(log.type)}
                  </div>
                  <StatusBadge status={log.status} />
                </div>

                {/* Related item */}
                {log.request?.audiobook ? (
                  <div className="text-sm mb-2">
                    <div className="text-gray-700 dark:text-gray-300 font-medium leading-snug">
                      {log.request.audiobook.title}
                    </div>
                    <div className="text-gray-500 dark:text-gray-400 text-xs">
                      by {log.request.audiobook.author} &middot; {log.request.user.plexUsername}
                    </div>
                  </div>
                ) : (
                  <div className="text-xs text-gray-500 dark:text-gray-400 mb-2">System job</div>
                )}

                {/* Meta row */}
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
                  <span>{formatDateShort(log.createdAt)}</span>
                  <span>Duration: {formatDuration(log.startedAt, log.completedAt)}</span>
                  <span>Attempts: {log.attempts}/{log.maxAttempts}</span>
                </div>
              </div>

              {/* Expandable details */}
              {hasDetails(log) && (
                <>
                  <button
                    onClick={() => setExpandedLog(expandedLog === log.id ? null : log.id)}
                    className="w-full flex items-center justify-between px-4 py-2.5 border-t border-gray-100 dark:border-gray-700/60 text-xs font-medium text-blue-600 dark:text-blue-400 hover:bg-gray-50 dark:hover:bg-gray-700/40 transition-colors"
                  >
                    <span>{expandedLog === log.id ? 'Hide Details' : 'Show Details'}</span>
                    <svg
                      className={`w-4 h-4 transition-transform duration-200 ${expandedLog === log.id ? 'rotate-180' : ''}`}
                      fill="none" stroke="currentColor" viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                  {expandedLog === log.id && (
                    <div className="px-4 pb-4 pt-3 bg-gray-50 dark:bg-gray-900/50 border-t border-gray-100 dark:border-gray-700/60">
                      <LogDetails log={log} />
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
          {logs.length === 0 && (
            <div className="text-center py-12">
              <p className="text-gray-500 dark:text-gray-400">No logs found</p>
            </div>
          )}
        </div>

        {/* Desktop table — hidden on mobile */}
        <div className="hidden sm:block bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-900">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Time
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Type
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Status
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Related Item
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Duration
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Attempts
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                {logs.map((log) => (
                  <>
                    <tr key={log.id} className="hover:bg-gray-50 dark:hover:bg-gray-700">
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">
                        {new Date(log.createdAt).toLocaleString()}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                          {formatType(log.type)}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <StatusBadge status={log.status} />
                      </td>
                      <td className="px-6 py-4">
                        {log.request?.audiobook ? (
                          <div className="text-sm">
                            <div className="font-medium text-gray-900 dark:text-gray-100">
                              {log.request.audiobook.title}
                            </div>
                            <div className="text-gray-500 dark:text-gray-400">
                              by {log.request.audiobook.author}
                            </div>
                            <div className="text-xs text-gray-400 dark:text-gray-500">
                              User: {log.request.user.plexUsername}
                            </div>
                          </div>
                        ) : (
                          <span className="text-sm text-gray-500 dark:text-gray-400">System job</span>
                        )}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                        {formatDuration(log.startedAt, log.completedAt)}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-400">
                        {log.attempts}/{log.maxAttempts}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                        {hasDetails(log) && (
                          <button
                            onClick={() => setExpandedLog(expandedLog === log.id ? null : log.id)}
                            className="text-blue-600 hover:text-blue-900 dark:text-blue-400 dark:hover:text-blue-300"
                          >
                            {expandedLog === log.id ? 'Hide Details' : 'Show Details'}
                          </button>
                        )}
                      </td>
                    </tr>
                    {expandedLog === log.id && (
                      <tr>
                        <td colSpan={7} className="px-6 py-4 bg-gray-50 dark:bg-gray-900">
                          <LogDetails log={log} />
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>

          {logs.length === 0 && (
            <div className="text-center py-12">
              <p className="text-gray-500 dark:text-gray-400">No logs found</p>
            </div>
          )}
        </div>

        {/* Pagination */}
        {pagination && pagination.totalPages > 1 && (
          <div className="mt-6 flex flex-col sm:flex-row items-center gap-3 sm:justify-between">
            <div className="text-sm text-gray-600 dark:text-gray-400 order-2 sm:order-1">
              Page {pagination.page} of {pagination.totalPages}
              <span className="hidden sm:inline"> ({pagination.total} total logs)</span>
            </div>
            <div className="flex gap-2 order-1 sm:order-2">
              <button
                onClick={() => setPage(page - 1)}
                disabled={page === 1}
                className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
                Previous
              </button>
              <button
                onClick={() => setPage(page + 1)}
                disabled={page === pagination.totalPages}
                className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Next
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
            </div>
          </div>
        )}

        {/* Info Box */}
        <div className="mt-6 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
          <h3 className="text-sm font-medium text-blue-800 dark:text-blue-200 mb-2">
            About System Logs
          </h3>
          <ul className="text-sm text-blue-700 dark:text-blue-300 space-y-1">
            <li>• Logs are automatically refreshed every 10 seconds</li>
            <li>• Tap &quot;Show Details&quot; to view event logs, job results, and errors</li>
            <li>• Event logs show all internal operations with timestamps</li>
            <li>• Jobs are retried automatically based on their max attempts setting</li>
            <li>• Use filters to find specific job types or statuses</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
