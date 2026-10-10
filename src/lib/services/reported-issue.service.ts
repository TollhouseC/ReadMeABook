/**
 * Component: Reported Issue Service
 * Documentation: documentation/backend/services/reported-issues.md
 *
 * Handles user-reported problems with available audiobooks.
 * Supports dismiss (admin closes) and replace (admin picks new torrent) workflows.
 * A book counts as in the library the same way the book page decides it: exact ASIN, an
 * Audible edition of it (works table), or another edition with the same title + author. The
 * report is linked to that library item so Replace removes the right files — also for books
 * never requested through ReadMeABook.
 */

import { prisma } from '@/lib/db';
import { findPlexMatch } from '@/lib/utils/audiobook-matcher';
import { getSiblingAsins } from '@/lib/services/works.service';
import { findOwnedEdition } from '@/lib/utils/edition-match';
import { RMABLogger } from '@/lib/utils/logger';

const logger = RMABLogger.create('ReportedIssue');

/** The library item for this book: exact ASIN → Audible edition grouping → same title + author. */
export async function findLibraryCopy(asin: string, title: string, author: string): Promise<{ plexGuid: string; asin: string | null } | null> {
  const exact = await findPlexMatch({ asin, title, author });
  if (exact) return { plexGuid: exact.plexGuid, asin };

  try {
    const siblings = (await getSiblingAsins([asin])).get(asin) ?? [];
    if (siblings.length > 0) {
      const sibling = await prisma.plexLibrary.findFirst({ where: { asin: { in: siblings } }, select: { plexGuid: true, asin: true } });
      if (sibling) return sibling;
    }
  } catch {
    // works table lookup is best-effort
  }

  const owned = await findOwnedEdition({ asin, title, author });
  return owned ? { plexGuid: owned.plexGuid, asin: owned.asin } : null;
}

/**
 * Report an issue with an available audiobook
 */
export async function reportIssue(
  asin: string,
  reporterId: string,
  reason: string,
  metadata?: { title?: string; author?: string; coverArtUrl?: string }
) {
  // Validate the book is in the library (any edition of it)
  const libraryCopy = await findLibraryCopy(asin, metadata?.title || '', metadata?.author || '');

  if (!libraryCopy) {
    throw new ReportedIssueError('This audiobook is not currently in your library', 404);
  }
  const { getConfigService } = await import('./config.service');
  const onABS = (await getConfigService().getBackendMode()) === 'audiobookshelf';

  // Find or create audiobook record for this ASIN
  let audiobook = await prisma.audiobook.findFirst({
    where: { audibleAsin: asin },
  });

  if (!audiobook) {
    audiobook = await prisma.audiobook.create({
      data: {
        audibleAsin: asin,
        title: metadata?.title || 'Unknown Title',
        author: metadata?.author || 'Unknown Author',
        coverArtUrl: metadata?.coverArtUrl,
        status: 'requested',
      },
    });
    logger.info(`Created audiobook record for ASIN ${asin} to link reported issue`);
  }

  // Link the record to the library item that was found, so Replace deletes the right files
  if (onABS ? !audiobook.absItemId : !audiobook.plexGuid) {
    audiobook = await prisma.audiobook.update({
      where: { id: audiobook.id },
      data: onABS ? { absItemId: libraryCopy.plexGuid } : { plexGuid: libraryCopy.plexGuid },
    });
  }

  // Check for existing open issue
  const existingIssue = await prisma.reportedIssue.findFirst({
    where: {
      audiobookId: audiobook.id,
      status: 'open',
    },
  });

  if (existingIssue) {
    throw new ReportedIssueError('An issue has already been reported for this audiobook', 409);
  }

  const issue = await prisma.reportedIssue.create({
    data: {
      audiobookId: audiobook.id,
      reporterId,
      reason,
    },
    include: {
      audiobook: { select: { title: true, author: true, audibleAsin: true } },
      reporter: { select: { plexUsername: true } },
    },
  });

  logger.info(`Issue reported for "${audiobook.title}" by user ${reporterId}`);

  // Queue notification (non-blocking)
  try {
    const { getJobQueueService } = await import('./job-queue.service');
    const jobQueue = getJobQueueService();
    await jobQueue.addNotificationJob(
      'issue_reported',
      issue.id,
      audiobook.title,
      audiobook.author,
      issue.reporter.plexUsername,
      reason
    );
  } catch (error) {
    logger.error('Failed to queue issue_reported notification', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return issue;
}

/**
 * Dismiss a reported issue (admin action)
 */
export async function dismissIssue(issueId: string, adminUserId: string) {
  const issue = await prisma.reportedIssue.findUnique({
    where: { id: issueId },
  });

  if (!issue) {
    throw new ReportedIssueError('Issue not found', 404);
  }

  if (issue.status !== 'open') {
    throw new ReportedIssueError('Issue is already resolved', 409);
  }

  const updated = await prisma.reportedIssue.update({
    where: { id: issueId },
    data: {
      status: 'dismissed',
      resolvedAt: new Date(),
      resolvedById: adminUserId,
    },
  });

  logger.info(`Issue ${issueId} dismissed by admin ${adminUserId}`);
  return updated;
}

/**
 * Replace audiobook content for a reported issue (atomic admin action):
 * 1. Validate issue is open
 * 2. Delete old content (via request delete or direct library deletion)
 * 3. Create new request + start download with selected torrent
 * 4. Resolve issue as "replaced"
 */
export async function replaceAudiobook(
  issueId: string,
  adminUserId: string,
  torrent: any
) {
  const issue = await prisma.reportedIssue.findUnique({
    where: { id: issueId },
    include: {
      audiobook: {
        select: {
          id: true,
          title: true,
          author: true,
          audibleAsin: true,
          coverArtUrl: true,
          narrator: true,
          plexGuid: true,
          absItemId: true,
          filePath: true,
          year: true,
          series: true,
          seriesPart: true,
        },
      },
    },
  });

  if (!issue) {
    throw new ReportedIssueError('Issue not found', 404);
  }

  if (issue.status !== 'open') {
    throw new ReportedIssueError('Issue is already resolved', 409);
  }

  const audiobook = issue.audiobook;

  // Step 1: Find existing active request for this audiobook
  const existingRequest = await prisma.request.findFirst({
    where: {
      audiobookId: audiobook.id,
      type: 'audiobook',
      deletedAt: null,
    },
    orderBy: { createdAt: 'desc' },
  });

  // Step 2: Delete old content
  if (existingRequest) {
    // Has an RMAB request — use deleteRequest which handles torrent cleanup, files, library backend
    const { deleteRequest } = await import('./request-delete.service');
    const deleteResult = await deleteRequest(existingRequest.id, adminUserId, { deleteMedia: true, source: 'replace' });
    if (!deleteResult.success) {
      logger.warn(`deleteRequest partial failure for ${existingRequest.id}: ${deleteResult.error}`);
      // Continue anyway - we want replacement to proceed
    }
    logger.info(`Deleted existing request ${existingRequest.id} for replacement`);
  } else {
    // No RMAB request — book was added to library outside RMAB
    const { deleteFromLibrary } = await import('./library-item-delete');
    await deleteFromLibrary(audiobook);
    logger.info(`Deleted library content directly for "${audiobook.title}" (no RMAB request)`);
  }

  // Step 3: Reset audiobook record for new request
  await prisma.audiobook.update({
    where: { id: audiobook.id },
    data: {
      status: 'requested',
      plexGuid: null,
      absItemId: null,
      filePath: null,
      fileFormat: null,
      fileSizeBytes: null,
      filesHash: null,
      absMatchedAt: null,
    },
  });

  // Step 4: Create new request + start download (admin-initiated, no approval needed)
  const newRequest = await prisma.request.create({
    data: {
      userId: adminUserId,
      audiobookId: audiobook.id,
      status: 'downloading',
      type: 'audiobook',
      progress: 0,
    },
    include: {
      audiobook: true,
      user: { select: { id: true, plexUsername: true } },
    },
  });

  // Queue download job with selected torrent
  const { getJobQueueService } = await import('./job-queue.service');
  const jobQueue = getJobQueueService();
  await jobQueue.addDownloadJob(
    newRequest.id,
    {
      id: audiobook.id,
      title: audiobook.title,
      author: audiobook.author,
    },
    torrent
  );

  // Step 5: Resolve issue
  await prisma.reportedIssue.update({
    where: { id: issueId },
    data: {
      status: 'replaced',
      resolvedAt: new Date(),
      resolvedById: adminUserId,
    },
  });

  logger.info(`Issue ${issueId} resolved via replacement. New request: ${newRequest.id}`);
  return { issue, request: newRequest };
}

/**
 * Get all open issues with audiobook metadata and reporter info (admin list)
 */
export async function getOpenIssues() {
  return prisma.reportedIssue.findMany({
    where: { status: 'open' },
    include: {
      audiobook: {
        select: {
          id: true,
          title: true,
          author: true,
          coverArtUrl: true,
          audibleAsin: true,
        },
      },
      reporter: {
        select: {
          id: true,
          plexUsername: true,
          avatarUrl: true,
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Batch query for open issues by ASINs (used for enrichment in audiobook-matcher)
 */
export async function getOpenIssuesByAsins(asins: string[]): Promise<Set<string>> {
  if (asins.length === 0) return new Set();

  const issues = await prisma.reportedIssue.findMany({
    where: {
      status: 'open',
      audiobook: {
        audibleAsin: { in: asins },
      },
    },
    select: {
      audiobook: {
        select: { audibleAsin: true },
      },
    },
  });

  return new Set(
    issues
      .map((i) => i.audiobook.audibleAsin)
      .filter((asin): asin is string => asin !== null)
  );
}

/**
 * Custom error class for reported issues
 */
export class ReportedIssueError extends Error {
  constructor(
    message: string,
    public statusCode: number
  ) {
    super(message);
    this.name = 'ReportedIssueError';
  }
}
