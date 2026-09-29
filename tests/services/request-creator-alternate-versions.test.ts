/**
 * Component: Request Creator Alternate-Version Tests
 * Documentation: documentation/features/watched-lists.md
 *
 * Tests the forceApproval and versionLabel options of createRequestForUser, used by
 * watched series that opt into alternate versions.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaMock } from '../helpers/prisma';

const prismaMock = createPrismaMock();
const mocks = vi.hoisted(() => ({
  addSearchJob: vi.fn(),
  addNotificationJob: vi.fn(),
  findPlexMatch: vi.fn(),
  getAudiobookDetails: vi.fn(),
  getSiblingAsins: vi.fn(),
  seedAsin: vi.fn(),
}));
const jobQueueMock = { addSearchJob: mocks.addSearchJob, addNotificationJob: mocks.addNotificationJob };

vi.mock('@/lib/db', () => ({ prisma: prismaMock }));
vi.mock('@/lib/utils/logger', () => ({
  RMABLogger: { create: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));
vi.mock('@/lib/utils/audiobook-matcher', () => ({ findPlexMatch: mocks.findPlexMatch }));
vi.mock('@/lib/integrations/audible.service', () => ({
  getAudibleService: () => ({ getAudiobookDetails: mocks.getAudiobookDetails }),
}));
vi.mock('@/lib/services/job-queue.service', () => ({ getJobQueueService: () => jobQueueMock }));
vi.mock('@/lib/services/works.service', () => ({
  getSiblingAsins: mocks.getSiblingAsins,
  seedAsin: mocks.seedAsin,
}));

const BOOK = {
  asin: 'B0DRAMATIZ',
  title: 'Mistborn: The Final Empire (Dramatized Adaptation)',
  author: 'Brandon Sanderson',
};

describe('createRequestForUser — alternate versions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-applied each test: clearAllMocks resets resolved values in this Vitest version
    mocks.addSearchJob.mockResolvedValue(undefined);
    mocks.addNotificationJob.mockResolvedValue(undefined);
    mocks.findPlexMatch.mockResolvedValue(null);
    mocks.getAudiobookDetails.mockResolvedValue(null);
    mocks.getSiblingAsins.mockResolvedValue(new Map());
    mocks.seedAsin.mockResolvedValue(undefined);
    prismaMock.request.findFirst.mockResolvedValue(null);
    prismaMock.audiobook.findFirst.mockResolvedValue(null);
    prismaMock.audiobook.create.mockResolvedValue({ id: 'ab-1', audibleAsin: BOOK.asin, title: BOOK.title, author: BOOK.author, narrator: null });
    prismaMock.request.create.mockImplementation(async ({ data }: any) => ({
      id: 'req-1',
      ...data,
      audiobook: { id: 'ab-1', title: BOOK.title },
      user: { id: 'user-1', plexUsername: 'admin' },
    }));
    prismaMock.ignoredAudiobook.findUnique.mockResolvedValue(null);
    prismaMock.ignoredAudiobook.findFirst.mockResolvedValue(null);
  });

  it('forces admin approval even for an admin (who is normally auto-approved)', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ role: 'admin', autoApproveRequests: null, plexUsername: 'admin' });
    const { createRequestForUser } = await import('@/lib/services/request-creator.service');

    const result = await createRequestForUser('user-1', BOOK, { forceApproval: true, versionLabel: 'Dramatized Adaptation' });

    expect(result.success).toBe(true);
    expect(prismaMock.request.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'awaiting_approval' }),
    }));
    expect(jobQueueMock.addSearchJob).not.toHaveBeenCalled();
    expect(jobQueueMock.addNotificationJob).toHaveBeenCalledWith(
      'request_pending_approval', 'req-1', BOOK.title, BOOK.author, 'admin'
    );
  });

  it('forces approval for a user set to auto-approve', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ role: 'user', autoApproveRequests: true, plexUsername: 'bob' });
    const { createRequestForUser } = await import('@/lib/services/request-creator.service');

    await createRequestForUser('user-1', BOOK, { forceApproval: true });

    expect(prismaMock.request.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'awaiting_approval' }),
    }));
  });

  it('stores the version label on a new audiobook record', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ role: 'admin', autoApproveRequests: null, plexUsername: 'admin' });
    const { createRequestForUser } = await import('@/lib/services/request-creator.service');

    await createRequestForUser('user-1', BOOK, { forceApproval: true, versionLabel: 'Dramatized Adaptation' });

    expect(prismaMock.audiobook.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ audibleAsin: BOOK.asin, versionLabel: 'Dramatized Adaptation' }),
    });
  });

  it('adds the version label to an existing audiobook record', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ role: 'admin', autoApproveRequests: null, plexUsername: 'admin' });
    prismaMock.audiobook.findFirst.mockResolvedValue({
      id: 'ab-1', audibleAsin: BOOK.asin, title: BOOK.title, author: BOOK.author, coverArtUrl: 'x', versionLabel: null,
    });
    prismaMock.audiobook.update.mockResolvedValue({ id: 'ab-1', title: BOOK.title, author: BOOK.author });
    const { createRequestForUser } = await import('@/lib/services/request-creator.service');

    await createRequestForUser('user-1', BOOK, { forceApproval: true, versionLabel: 'Dramatized Adaptation' });

    expect(prismaMock.audiobook.update).toHaveBeenCalledWith({
      where: { id: 'ab-1' },
      data: expect.objectContaining({ versionLabel: 'Dramatized Adaptation' }),
    });
  });

  it('keeps normal behavior without the options (admin auto-approved, no label)', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ role: 'admin', autoApproveRequests: null, plexUsername: 'admin' });
    const { createRequestForUser } = await import('@/lib/services/request-creator.service');

    await createRequestForUser('user-1', BOOK);

    expect(prismaMock.request.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'pending' }),
    }));
    expect(prismaMock.audiobook.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ versionLabel: undefined }),
    });
    expect(jobQueueMock.addSearchJob).toHaveBeenCalled();
  });
});
