/**
 * Component: Library Match Check Processor
 * Documentation: documentation/features/library-match.md
 *
 * Audiobookshelf only. Checks every item's Audible match (scoring: library-match.service.ts):
 * runtimes for all matched ASINs in batches of 50, then an Audible search (1/s) only for
 * suspects. `report` lists findings; `apply` re-matches confident ones in Audiobookshelf
 * (POST /items/{id}/match with the ASIN — rewrites its metadata, incl. metadata.json).
 * Unsure and wrong-audio items are only reported.
 */

import { RMABLogger } from '../utils/logger';
import { getConfigService } from '../services/config.service';
import type { MatchLibraryPayload } from '../services/job-queue.service';
import { createJobProgress, CANCELLED_RESULT } from '../utils/job-progress';
import {
  decideMatch, findSuspects, folderInfo, formatMinutes, scoreCandidates, searchAuthor, searchTitle,
  type MatchItem, type ScoredCandidate,
} from '../services/library-match.service';

/** Pause between Audible calls (tests set 0) */
export const matchTiming = { delayMs: 1000 };
const BATCH = 50;
const delay = () => new Promise<void>(resolve => setTimeout(resolve, matchTiming.delayMs));

const describe = (c: ScoredCandidate) => `"${c.title}" by ${c.author} (${c.asin}, ${formatMinutes(c.minutes)})`;

function toMatchItem(raw: any): MatchItem {
  const metadata = raw.media?.metadata ?? {};
  return {
    id: raw.id,
    title: metadata.title || '',
    author: metadata.authorName || '',
    asin: metadata.asin || undefined,
    durationSec: typeof raw.media?.duration === 'number' ? raw.media.duration : undefined,
    relPath: raw.relPath || raw.path || '',
    isFile: !!raw.isFile,
  };
}

export async function processMatchLibrary(payload: MatchLibraryPayload) {
  const logger = RMABLogger.forJob(payload.jobId, 'MatchLibrary');
  const apply = payload.mode === 'apply';
  const configService = getConfigService();

  if ((await configService.getBackendMode()) !== 'audiobookshelf') {
    await logger.info('Library Match Check needs the Audiobookshelf backend — nothing to do');
    return { success: true, mode: apply ? 'apply' : 'report', checked: 0 };
  }
  const libraryId = await configService.get('audiobookshelf.library_id');
  if (!libraryId) throw new Error('Audiobookshelf library ID not configured');

  const label = apply ? 'Fixing Audiobookshelf matches' : 'Checking Audiobookshelf matches';
  const progress = createJobProgress(payload.jobId, `${label} — reading library`, { cancellable: true });
  await progress.update(0, { force: true });

  const { getABSLibraryItems, triggerABSItemMatch } = await import('../services/audiobookshelf/api');
  const { getAudibleService } = await import('../integrations/audible.service');
  const audible = getAudibleService();
  const items: MatchItem[] = ((await getABSLibraryItems(libraryId)) || []).map(toMatchItem);

  // Audible runtimes of the current matches, 50 per call
  const asins = [...new Set(items.map(i => i.asin).filter((a): a is string => !!a))];
  const runtimes = new Map<string, number>();
  let cancelled = false;
  for (let i = 0; i < asins.length; i += BATCH) {
    if (await progress.isCancelled()) { cancelled = true; break; }
    await progress.update(0, { detail: `Audible runtimes ${Math.min(i + BATCH, asins.length)}/${asins.length}` });
    for (const product of await audible.getProductsByAsins(asins.slice(i, i + BATCH))) {
      if (product.durationMinutes) runtimes.set(product.asin.toLowerCase(), product.durationMinutes);
    }
    await delay();
  }

  const suspects = cancelled ? [] : findSuspects(items, runtimes);
  await logger.info(
    `Library match ${apply ? '' : '(report only) '}: ${items.length} item(s), ${asins.length} ASIN(s) — ` +
    `${runtimes.size} Audible runtime(s) found; ${suspects.length} suspect match(es) to check`
  );
  await progress.update(0, { total: suspects.length, label, force: true });

  const counts = { ok: 0, rematched: 0, would_rematch: 0, unsure: 0, wrong_audio: 0, failed: 0 };
  for (const [index, suspect] of suspects.entries()) {
    if (await progress.isCancelled()) {
      cancelled = true;
      await logger.warn(`Cancelled by admin after ${index} of ${suspects.length} suspect(s)`);
      break;
    }
    const { folderTitle, folderAuthor } = folderInfo(suspect.item);
    await progress.update(index, { detail: folderTitle });
    const where = `"${suspect.item.relPath}" (Audiobookshelf: "${suspect.item.title || '—'}"${suspect.item.asin ? `, ${suspect.item.asin}` : ''}, audio ${formatMinutes((suspect.item.durationSec ?? 0) / 60)}; ${suspect.reasons.join(', ')})`;

    try {
      const query = `${searchTitle(folderTitle)} ${searchAuthor(folderAuthor)}`.trim();
      let results = (await audible.search(query)).results.slice(0, 10);
      await delay();
      if (results.length === 0 && folderAuthor) {
        results = (await audible.search(searchTitle(folderTitle))).results.slice(0, 10);
        await delay();
      }
      const decision = decideMatch(suspect, scoreCandidates(suspect, results));

      switch (decision.kind) {
        case 'ok':
          counts.ok++;
          break;
        case 'confident':
          if (!apply) {
            counts.would_rematch++;
            await logger.info(`Would re-match ${where} → ${describe(decision.candidate)}`);
          } else {
            await triggerABSItemMatch(suspect.item.id, decision.candidate.asin);
            counts.rematched++;
            await logger.info(`Re-matched ${where} → ${describe(decision.candidate)}`);
          }
          break;
        case 'wrong_audio':
          counts.wrong_audio++;
          await logger.warn(`Wrong audio? ${where}: the folder is "${decision.namedAs.title}" (${formatMinutes(decision.namedAs.minutes)}) but the audio is the length of "${decision.audioMatches}" — re-download it`);
          break;
        case 'unsure':
          counts.unsure++;
          await logger.info(`Check manually ${where}: ${decision.why}${decision.candidates.length
            ? ` — candidates: ${decision.candidates.map((c, i) => `${i + 1}) ${describe(c)}`).join('; ')}` : ''}`);
          break;
      }
    } catch (error) {
      counts.failed++;
      await logger.warn(`Failed to check ${where}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!cancelled) await progress.update(suspects.length);
  await progress.finish(cancelled ? 'Cancelled' : 'Done');
  await logger.info(
    `Library match ${apply ? `complete — re-matched ${counts.rematched}` : `check complete — would re-match ${counts.would_rematch}`}, ` +
    `check manually ${counts.unsure}, wrong audio ${counts.wrong_audio}, match fine after all ${counts.ok}, failed ${counts.failed}`
  );
  return {
    success: true, mode: apply ? 'apply' : 'report', checked: items.length, suspects: suspects.length, ...counts,
    ...(cancelled && CANCELLED_RESULT),
  };
}
