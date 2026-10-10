/**
 * Component: Library Health Report Processor
 * Documentation: documentation/backend/services/jobs.md
 *
 * Runs every library check in Report Only mode, one after another, into ONE job log
 * (sections headed "===== <check> (report only) =====") and ends with a one-line-per-check
 * summary — meant to be scheduled monthly and read (or pasted for review) in one go.
 * Never changes anything: it calls the same processors as the individual Report Only jobs,
 * which stay available for debugging and for applying fixes one at a time. Also lists old
 * copies Replace couldn't delete (library-leftovers). A failing check
 * is reported and the rest still run; cancelling stops after the current check.
 */

import { RMABLogger } from '../utils/logger';
import { CANCELLED_RESULT } from '../utils/job-progress';
import type { LibraryHealthReportPayload } from '../services/job-queue.service';

type CheckResult = Record<string, unknown> | null | undefined;

interface Check {
  key: string;
  name: string;
  run: (jobId?: string) => Promise<CheckResult>;
}

export const HEALTH_CHECKS: Check[] = [
  {
    key: 'merge', name: 'Library Merge',
    run: async (jobId) => (await import('./merge-library.processor')).processMergeLibrary({ mode: 'report', jobId }),
  },
  {
    key: 'organize', name: 'Library Organize',
    run: async (jobId) => (await import('./organize-library.processor')).processOrganizeLibrary({ mode: 'report', jobId }),
  },
  {
    key: 'layout', name: 'Library Layout',
    run: async (jobId) => (await import('./fix-library-layout.processor')).processFixLibraryLayout({ mode: 'report', jobId }),
  },
  {
    key: 'match', name: 'Library Match Check',
    run: async (jobId) => (await import('./match-library.processor')).processMatchLibrary({ mode: 'report', jobId }),
  },
  {
    key: 'chapters', name: 'Chapter Check',
    run: async (jobId) => (await import('./fix-chapters.processor')).processFixChapters({ mode: 'report', jobId }),
  },
  {
    key: 'chapter_sync', name: 'Chapter Sync',
    run: async (jobId) => (await import('./fix-chapters.processor')).processFixChapters({ mode: 'sync_report', jobId }),
  },
  {
    // Old copies Replace / delete-with-media couldn't remove (the new download went ahead)
    key: 'leftovers', name: 'Replace Leftovers',
    run: async (jobId) => (await import('../services/library-leftovers')).checkLeftovers(RMABLogger.forJob(jobId, 'LibraryLeftovers')),
  },
];

/** Counts that are just "how many were looked at / fine" — left out of the summary. */
const QUIET_KEYS = new Set([
  'checked', 'books', 'suspects', 'in_place', 'kept', 'ok', 'other_edition', 'skipped', 'not_single_file',
  'single_file', 'no_runtime', 'already_synced', 'in_sync', 'unchanged',
]);

/** "would_clean: 17, files_to_remove: 21" — the numbers worth acting on; "nothing to do" otherwise. */
export function summarizeCheck(result: CheckResult): string {
  if (!result) return 'no result';
  const parts = Object.entries(result)
    .filter(([key, value]) => typeof value === 'number' && value > 0 && !QUIET_KEYS.has(key))
    .map(([key, value]) => `${key.replace(/_/g, ' ')} ${value}`);
  const looked = typeof result.checked === 'number' ? ` (${result.checked} checked)` : '';
  return parts.length ? `${parts.join(', ')}${looked}` : `nothing to do${looked}`;
}

export async function processLibraryHealthReport(payload: LibraryHealthReportPayload) {
  const logger = RMABLogger.forJob(payload.jobId, 'LibraryHealthReport');
  const results: Record<string, CheckResult | { error: string }> = {};
  const summary: string[] = [];
  let cancelled = false;

  await logger.info(`Library health report: ${HEALTH_CHECKS.map(c => c.name).join(', ')} — report only, nothing is changed`);

  for (const check of HEALTH_CHECKS) {
    await logger.info(`===== ${check.name} (report only) =====`);
    try {
      const result = await check.run(payload.jobId);
      results[check.key] = result;
      summary.push(`${check.name}: ${summarizeCheck(result)}`);
      if (result && (result as { cancelled?: boolean }).cancelled) {
        cancelled = true;
        summary.push('Cancelled by admin — remaining checks skipped');
        break;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results[check.key] = { error: message };
      summary.push(`${check.name}: FAILED — ${message}`);
      await logger.warn(`${check.name} failed: ${message}`);
    }
  }

  await logger.info('===== Summary =====');
  for (const line of summary) await logger.info(line);
  return { success: true, checks: results, ...(cancelled && CANCELLED_RESULT) };
}
