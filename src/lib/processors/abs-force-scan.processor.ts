/**
 * Component: Audiobookshelf Force Re-Scan Processor
 * Documentation: documentation/features/library-match.md
 *
 * Jobs page "Audiobookshelf Force Re-Scan": asks Audiobookshelf to re-read every item of the
 * configured library (POST /libraries/{id}/scan?force=1), using ReadMeABook's stored token.
 */

import { RMABLogger } from '../utils/logger';
import type { AbsForceScanPayload } from '../services/job-queue.service';
import { forceRescanABS } from '../services/abs-maintenance';

export async function processAbsForceScan(payload: AbsForceScanPayload) {
  const logger = RMABLogger.forJob(payload.jobId, 'AbsForceScan');
  const triggered = await forceRescanABS(logger);
  if (!triggered) await logger.info('Backend is not Audiobookshelf — nothing to do');
  return { success: true, triggered };
}
