/**
 * Component: Library Organize Processor
 * Documentation: documentation/phase3/file-organization.md
 *
 * Library-wide: moves book folders so each author has one folder and each series stays
 * together (plan: library-organize.service.ts). `report` lists the moves; `apply` renames
 * the folders (no copying), updates ReadMeABook's recorded paths, removes folders left
 * empty, writes an undo log (/app/config/organize-undo, all kept — they're tiny) and triggers a
 * library scan. Book folders are never renamed, only moved.
 */

import fs from 'fs/promises';
import path from 'path';
import { prisma } from '../db';
import { RMABLogger } from '../utils/logger';
import { getConfigService } from '../services/config.service';
import type { OrganizeLibraryPayload } from '../services/job-queue.service';
import { createJobProgress, CANCELLED_RESULT } from '../utils/job-progress';
import { triggerLibraryScan } from '../utils/library-book-files';
import { DISC_FOLDER_RE, hasAudioFiles } from '../utils/library-layout';
import { removeEmptyParentDirectories } from '../utils/cleanup-helpers';
import { SpellingRegistry } from '../utils/author-identity';
import { planLibraryOrganize, type OrganizeBook, type PlannedMove } from '../services/library-organize.service';
import { collectCandidates, getMediaDir } from './fix-chapters.processor';

/** ReadMeABook's own records outweigh Audiobookshelf metadata and folder names when picking a spelling */
const RMAB_WEIGHT = 3;

export const getUndoDir = () => path.join(process.env.CONFIG_DIR || '/app/config', 'organize-undo');

/** A book folder: audio at the top or in disc folders (CD1, Disc 2). */
async function holdsBook(folder: string): Promise<boolean> {
  if (await hasAudioFiles(folder)) return true;
  const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.isDirectory() && DISC_FOLDER_RE.test(e.name) && (await hasAudioFiles(path.join(folder, e.name)))) return true;
  }
  return false;
}

/** Why a planned move can't be done safely, or null. */
async function blockReason(move: PlannedMove, mediaDir: string): Promise<string | null> {
  const entries = await fs.readdir(move.from, { withFileTypes: true }).catch(() => null);
  if (!entries) return 'folder no longer exists';
  for (const e of entries) {
    if (e.isDirectory() && !DISC_FOLDER_RE.test(e.name) && (await hasAudioFiles(path.join(move.from, e.name)))) {
      return `contains another book ("${e.name}") — run Library Layout Fix first`;
    }
  }
  const existing = await fs.readdir(move.to).catch(() => null);
  if (existing && existing.length > 0) return `"${move.to}" already exists (a duplicate? see Library Merge)`;
  for (let dir = path.dirname(move.to); path.relative(mediaDir, dir) && !path.relative(mediaDir, dir).startsWith('..'); dir = path.dirname(dir)) {
    if (await hasAudioFiles(dir)) return `"${dir}" is a book folder — it would be nested inside it`;
  }
  return null;
}

async function writeUndoLog(moves: Array<PlannedMove & { movedAt: string }>, logger: RMABLogger): Promise<void> {
  try {
    const dir = getUndoDir();
    await fs.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const file = path.join(dir, `undo-${stamp}.json`);
    await fs.writeFile(file, JSON.stringify(moves.map(({ from, to, title, movedAt }) => ({ from, to, title, movedAt })), null, 2));
    await logger.info(`Undo log: ${file}`);
  } catch (error) {
    await logger.warn(`Could not write the undo log: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function processOrganizeLibrary(payload: OrganizeLibraryPayload) {
  const logger = RMABLogger.forJob(payload.jobId, 'OrganizeLibrary');
  const apply = payload.mode === 'apply';
  const label = apply ? 'Organizing library folders' : 'Checking library folders';
  const configService = getConfigService();
  const mediaDir = await getMediaDir();
  const template = ((await configService.get('audiobook_path_template')) || '{author}/{title} {asin}').trim();
  const dirMode = parseInt((await configService.get('dir_chmod')) || '775', 8);

  if (!template.startsWith('{author}')) {
    await logger.info(`Path template "${template}" doesn't start with {author} — nothing to organize`);
    return { success: true, mode: apply ? 'apply' : 'report', moved: 0, would_move: 0 };
  }

  const progress = createJobProgress(payload.jobId, `${label} — finding books`, { cancellable: true });
  await progress.update(0, { force: true });

  const candidates = (await collectCandidates(mediaDir, logger)).filter(c => c.folder);
  const records = await prisma.audiobook.findMany({
    select: { id: true, audibleAsin: true, author: true, series: true, versionLabel: true },
  });
  const byId = new Map(records.map(r => [r.id, r]));
  const byAsin = new Map(records.filter(r => r.audibleAsin).map(r => [r.audibleAsin!.toLowerCase(), r]));

  const registry = new SpellingRegistry();
  for (const r of records) registry.add(r.author, RMAB_WEIGHT);

  const books: OrganizeBook[] = [];
  const absItemByFolder = new Map<string, { absItemId?: string; audiobookId?: string }>();
  let empty = 0;
  for (const [index, c] of candidates.entries()) {
    if (index % 50 === 0) await progress.update(0, { detail: `Reading folders (${index}/${candidates.length})` });
    if (!(await holdsBook(c.folder!))) {
      empty++;
      continue;
    }
    const record = (c.audiobookId && byId.get(c.audiobookId)) || byAsin.get(c.asin.toLowerCase());
    const author = record?.author || c.author;
    registry.add(c.author);
    registry.add(path.relative(mediaDir, c.folder!).split(/[\\/]/)[0]);
    books.push({ folder: c.folder!, title: c.title, author, series: record?.series || c.series, alternate: !!record?.versionLabel });
    absItemByFolder.set(path.resolve(c.folder!), { absItemId: c.absItemId, audiobookId: c.audiobookId ?? record?.id });
  }

  const plan = planLibraryOrganize(books, { mediaDir, useSeriesFolder: template.includes('{series}'), registry });
  await logger.info(
    `Library organize ${apply ? '' : '(report only) '}: ${books.length} book folder(s) — ${plan.moves.length} to move, ` +
    `${plan.inPlace} already in place${plan.anthologies ? `, ${plan.anthologies} anthology/3+ author book(s) left where they are` : ''}` +
    `${empty ? `, ${empty} recorded folder(s) without audio ignored` : ''}`
  );
  for (const s of plan.skipped) await logger.info(`Left alone "${s.title}" (${s.folder}): ${s.reason}`);
  await progress.update(0, { total: plan.moves.length, label, force: true });

  let moved = 0;
  let blocked = 0;
  let failed = 0;
  let cancelled = false;
  const done: Array<PlannedMove & { movedAt: string }> = [];
  for (const [index, move] of plan.moves.entries()) {
    if (await progress.isCancelled()) {
      cancelled = true;
      await logger.warn(`Cancelled by admin after ${index} of ${plan.moves.length} move(s)`);
      break;
    }
    await progress.update(index, { detail: move.title });
    const reason = await blockReason(move, mediaDir);
    if (reason) {
      blocked++;
      await logger.warn(`Can't move "${move.title}" (${move.from}): ${reason}`);
      continue;
    }
    if (!apply) {
      await logger.info(`Would move "${move.title}": ${move.from} → ${move.to} (${move.reason})`);
      continue;
    }
    try {
      await fs.mkdir(path.dirname(move.to), { recursive: true, mode: dirMode });
      await fs.rmdir(move.to).catch(() => {}); // empty leftover folder at the target
      await fs.rename(move.from, move.to);
      const links = absItemByFolder.get(path.resolve(move.from));
      await prisma.audiobook.updateMany({ where: { filePath: move.from }, data: { filePath: move.to } });
      if (links?.audiobookId) await prisma.audiobook.updateMany({ where: { id: links.audiobookId }, data: { filePath: move.to } });
      if (links?.absItemId) await prisma.audiobook.updateMany({ where: { absItemId: links.absItemId }, data: { filePath: move.to } });
      await removeEmptyParentDirectories(move.from, { boundaryPath: mediaDir });
      done.push({ ...move, movedAt: new Date().toISOString() });
      moved++;
      await logger.info(`Moved "${move.title}": ${move.from} → ${move.to} (${move.reason})`);
    } catch (error) {
      failed++;
      await logger.warn(`Failed to move "${move.title}" (${move.from}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (done.length > 0) await writeUndoLog(done, logger);
  if (!cancelled) await progress.update(plan.moves.length);
  await progress.finish(cancelled ? 'Cancelled' : 'Done');
  const wouldMove = plan.moves.length - blocked;
  await logger.info(apply
    ? `Library organize complete — moved ${moved}, couldn't move ${blocked}, failed ${failed}, left alone ${plan.skipped.length}`
    : `Library organize check complete — would move ${wouldMove}, couldn't move ${blocked}, left alone ${plan.skipped.length}`);
  if (moved > 0) await triggerLibraryScan(logger);
  return {
    success: true, mode: apply ? 'apply' : 'report', books: books.length, in_place: plan.inPlace,
    moved, would_move: apply ? 0 : wouldMove, blocked, failed, left_alone: plan.skipped.length,
    ...(cancelled && CANCELLED_RESULT),
  };
}
