/**
 * Component: Job Type Labels
 * Documentation: documentation/backend/services/jobs.md
 *
 * Human-readable names for job types (client-safe; used by the admin job progress UI).
 */

export const JOB_TYPE_LABELS: Record<string, string> = {
  search_indexers: 'Search Indexers',
  download_torrent: 'Start Download',
  monitor_download: 'Monitor Download',
  organize_files: 'Import Files',
  scan_plex: 'Library Scan',
  plex_library_scan: 'Library Scan',
  plex_recently_added_check: 'Recently Added Check',
  audible_refresh: 'Audible Data Refresh',
  retry_missing_torrents: 'Retry Missing Torrents',
  retry_failed_imports: 'Retry Failed Imports',
  cleanup_seeded_torrents: 'Cleanup Seeded Torrents',
  monitor_rss_feeds: 'Monitor RSS Feeds',
  sync_reading_shelves: 'Sync Reading Shelves',
  check_watched_lists: 'Check Watched Lists',
  check_stalled_downloads: 'Check Stalled Downloads',
  search_packs: 'Pack Search',
  merge_library_book: 'Merge into Single M4B',
  merge_library: 'Library Merge',
  fix_chapters: 'Chapter Check / Fix',
  fix_library_layout: 'Library Layout Check / Fix',
  organize_library: 'Library Organize',
  match_library: 'Library Match Check',
  send_notification: 'Send Notification',
  search_ebook: 'Search Ebook',
  start_direct_download: 'Start Direct Download',
  monitor_direct_download: 'Monitor Direct Download',
};

export function jobTypeLabel(type: string): string {
  return JOB_TYPE_LABELS[type] ?? type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
