/**
 * Component: Search Packs Processor
 * Documentation: documentation/features/series-packs.md
 *
 * Runs a series/author pack search for one request (queued by search-indexers when a
 * series book's individual search keeps failing past 24h).
 */

import { RMABLogger } from '../utils/logger';

export interface SearchPacksPayload {
  jobId?: string;
  requestId: string;
}

export async function processSearchPacks(payload: SearchPacksPayload): Promise<any> {
  const logger = RMABLogger.forJob(payload.jobId, 'SearchPacks');
  const { runPackSearch } = await import('../services/pack-search.service');

  const result = await runPackSearch(payload.requestId, logger);
  logger.info(`Pack search for request ${payload.requestId}: ${result.status}${result.reason ? ` (${result.reason})` : ''}`);

  return { success: true, requestId: payload.requestId, ...result };
}
