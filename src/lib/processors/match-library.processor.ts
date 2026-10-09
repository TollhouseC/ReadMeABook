/**
 * Component: Library Match Check Processor
 * Documentation: documentation/features/library-match.md
 *
 * Audiobookshelf only. Checks every item's Audible match (scoring: library-match.service.ts):
 * runtimes for all matched ASINs in batches of 50, then an Audible search (1/s) only for
 * suspects (a second, title-only search when the first finds nothing usable). `report` lists
 * findings; `apply` re-matches confident ones in Audiobookshelf (POST /items/{id}/match with the
 * ASIN — rewrites its metadata, incl. metadata.json). Everything else is only reported:
 * other edition (fine, summarised), wrong audio, incomplete, too much audio, unsure, not found.
 */

import { RMABLogger } from '../utils/logger';
import { getConfigService } from '../services/config.service';
import type { MatchLibraryPayload } from '../services/job-queue.service';
import { createJobProgress, CANCELLED_RESULT } from '../utils/job-progress';
import { getRequiredReleaseLanguage } from '../utils/release-language';
import type { AudibleAudiobook } from '../integrations/audible.service';
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

  const language = await getRequiredReleaseLanguage();

  // Audible details of the current matches, 50 per call
  const asins = [...new Set(items.map(i => i.asin).filter((a): a is string => !!a))];
  const products = new Map<string, AudibleAudiobook>();
  let cancelled = false;
  for (let i = 0; i < asins.length; i += BATCH) {
    if (await progress.isCancelled()) { cancelled = true; break; }
    await progress.update(0, { detail: `Audible details ${Math.min(i + BATCH, asins.length)}/${asins.length}` });
    for (const product of await audible.getProductsByAsins(asins.slice(i, i + BATCH))) {
      products.set(product.asin.toLowerCase(), product);
    }
    await delay();
  }

  const suspects = cancelled ? [] : findSuspects(items, products);
  await logger.info(
    `Library match ${apply ? '' : '(report only) '}: ${items.length} item(s), ${asins.length} ASIN(s) — ` +
    `${products.size} found on Audible; ${suspects.length} suspect match(es) to check (release language: ${language})`
  );
  await progress.update(0, { total: suspects.length, label, force: true });

  const counts = { ok: 0, other_edition: 0, rematched: 0, would_rematch: 0, wrong_audio: 0, too_short: 0, too_long: 0, unsure: 0, not_found: 0, failed: 0 };
  const editions: string[] = [];
  for (const [index, suspect] of suspects.entries()) {
    if (await progress.isCancelled()) {
      cancelled = true;
      await logger.warn(`Cancelled by admin after ${index} of ${suspects.length} suspect(s)`);
      break;
    }
    const { folderTitle, folderAuthor } = folderInfo(suspect.item);
    await progress.update(index, { detail: folderTitle });
    const audio = formatMinutes((suspect.item.durationSec ?? 0) / 60);
    const where = `"${suspect.item.relPath}" (Audiobookshelf: "${suspect.item.title || '—'}"${suspect.item.asin ? `, ${suspect.item.asin}` : ''}, audio ${audio}; ${suspect.reasons.join(', ')})`;

    try {
      const search = async (query: string) => {
        const found = (await audible.search(query)).results.slice(0, 10);
        await delay();
        return found;
      };
      const title = searchTitle(folderTitle);
      let results = await search(`${title} ${searchAuthor(folderAuthor)}`.trim());
      let decision = decideMatch(suspect, scoreCandidates(suspect, results, language), language);
      // Author spelled differently on Audible (e.g. "- editor") or a thin first search → title only
      if (folderAuthor && (decision.kind === 'not_found' || decision.kind === 'unsure')) {
        results = [...results, ...(await search(title))];
        decision = decideMatch(suspect, scoreCandidates(suspect, results, language), language);
      }

      switch (decision.kind) {
        case 'ok':
          counts.ok++;
          break;
        case 'edition':
          counts.other_edition++;
          editions.push(folderTitle);
          break;
        case 'confident':
          if (!apply) {
            counts.would_rematch++;
            await logger.info(`Would re-match ${where} → ${describe(decision.candidate)} — ${decision.why}`);
          } else {
            await triggerABSItemMatch(suspect.item.id, decision.candidate.asin);
            counts.rematched++;
            await logger.info(`Re-matched ${where} → ${describe(decision.candidate)} — ${decision.why}`);
          }
          break;
        case 'wrong_audio':
          counts.wrong_audio++;
          await logger.warn(`Wrong audio? ${where}: the folder is "${decision.namedAs.title}" (${formatMinutes(decision.namedAs.minutes)}) but the audio is exactly the length of "${decision.audioMatches}" — re-download it`);
          break;
        case 'too_short':
          counts.too_short++;
          await logger.warn(`Incomplete or abridged file? ${where}: audio is ${audio} but "${decision.book.title}" is ${formatMinutes(decision.book.minutes)} — re-download it`);
          break;
        case 'too_long':
          counts.too_long++;
          await logger.warn(`Too much audio ${where}: ${audio} but "${decision.book.title}" is ${formatMinutes(decision.book.minutes)} — duplicate copies or other books in the folder (see Library Merge)`);
          break;
        case 'unsure':
          counts.unsure++;
          await logger.info(`Check manually ${where}: ${decision.why}${decision.candidates.length
            ? ` — editions: ${decision.candidates.map((c, i) => `${i + 1}) ${describe(c)}`).join('; ')}` : ''}`);
          break;
        case 'not_found':
          counts.not_found++;
          await logger.info(`Not found on Audible ${where}${decision.candidates.length
            ? ` — closest: ${decision.candidates.map((c, i) => `${i + 1}) ${describe(c)}`).join('; ')}` : ''}`);
          break;
      }
    } catch (error) {
      counts.failed++;
      await logger.warn(`Failed to check ${where}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (editions.length > 0) {
    await logger.info(`Right book, different edition/narration — left as is (${editions.length}): ${editions.slice(0, 25).join(', ')}${editions.length > 25 ? ', …' : ''}`);
  }
  if (!cancelled) await progress.update(suspects.length);
  await progress.finish(cancelled ? 'Cancelled' : 'Done');
  await logger.info(
    `Library match ${apply ? `complete — re-matched ${counts.rematched}` : `check complete — would re-match ${counts.would_rematch}`}, ` +
    `wrong audio ${counts.wrong_audio}, incomplete ${counts.too_short}, too much audio ${counts.too_long}, check manually ${counts.unsure}, ` +
    `not on Audible ${counts.not_found}, other edition (fine) ${counts.other_edition}, match fine ${counts.ok}, failed ${counts.failed}`
  );
  return {
    success: true, mode: apply ? 'apply' : 'report', checked: items.length, suspects: suspects.length, ...counts,
    ...(cancelled && CANCELLED_RESULT),
  };
}
