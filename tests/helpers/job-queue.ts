/**
 * Component: Job Queue Mock Factory
 * Documentation: documentation/backend/services/jobs.md
 */

import { vi } from 'vitest';

export const createJobQueueMock = () => ({
  addSearchJob: vi.fn(),
  addDownloadJob: vi.fn(),
  addMonitorJob: vi.fn(),
  addOrganizeJob: vi.fn(),
  addPlexScanJob: vi.fn(),
  addPlexMatchJob: vi.fn(),
  addPlexRecentlyAddedJob: vi.fn(),
  addMonitorRssFeedsJob: vi.fn(),
  addAudibleRefreshJob: vi.fn(),
  addRetryMissingTorrentsJob: vi.fn(),
  addRetryFailedImportsJob: vi.fn(),
  addCleanupSeededTorrentsJob: vi.fn(),
  addCheckStalledDownloadsJob: vi.fn(),
  addSearchEbookJob: vi.fn(),
  addNotificationJob: vi.fn().mockResolvedValue(undefined),
  hasQueuedJob: vi.fn().mockResolvedValue(false),
});
