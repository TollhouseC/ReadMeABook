/**
 * Component: Reported Issue Service Tests
 * Documentation: documentation/backend/services/reported-issues.md
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaMock } from '../helpers/prisma';

const prismaMock = createPrismaMock() as ReturnType<typeof createPrismaMock> & Record<string, any>;
(prismaMock as any).reportedIssue = { findFirst: vi.fn(), create: vi.fn(), findUnique: vi.fn(), update: vi.fn() };

const mocks = vi.hoisted(() => ({
  findPlexMatch: vi.fn(), getSiblingAsins: vi.fn(), findOwnedEdition: vi.fn(),
  resolveLibraryFolder: vi.fn(), removeBookFolder: vi.fn(), deleteABSItem: vi.fn(), absItemIdsForAsin: vi.fn(),
  addDownloadJob: vi.fn(), addNotificationJob: vi.fn(), get: vi.fn(), getBackendMode: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ prisma: prismaMock }));
vi.mock('@/lib/utils/audiobook-matcher', () => ({ findPlexMatch: mocks.findPlexMatch }));
vi.mock('@/lib/services/works.service', () => ({ getSiblingAsins: mocks.getSiblingAsins }));
vi.mock('@/lib/utils/edition-match', () => ({ findOwnedEdition: mocks.findOwnedEdition }));
vi.mock('@/lib/services/library-folder', () => ({
  resolveLibraryFolder: mocks.resolveLibraryFolder, removeBookFolder: mocks.removeBookFolder,
  absItemIdsForAsin: mocks.absItemIdsForAsin, templateFolder: () => '/Audiobooks/Audio/Author/Book',
}));
vi.mock('@/lib/services/audiobookshelf/api', () => ({ deleteABSItem: mocks.deleteABSItem }));
vi.mock('@/lib/services/config.service', () => ({ getConfigService: () => ({ get: mocks.get, getBackendMode: mocks.getBackendMode }) }));
vi.mock('@/lib/services/job-queue.service', () => ({
  getJobQueueService: () => ({ addDownloadJob: mocks.addDownloadJob, addNotificationJob: mocks.addNotificationJob }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getBackendMode.mockResolvedValue('audiobookshelf');
  mocks.get.mockResolvedValue(null);
  mocks.findPlexMatch.mockResolvedValue(null);
  mocks.getSiblingAsins.mockResolvedValue(new Map());
  mocks.findOwnedEdition.mockResolvedValue(null);
  mocks.absItemIdsForAsin.mockResolvedValue([]);
  prismaMock.configuration.findUnique.mockResolvedValue(null);
  prismaMock.configuration.upsert.mockResolvedValue({});
  prismaMock.reportedIssue.findFirst.mockResolvedValue(null);
  prismaMock.reportedIssue.create.mockResolvedValue({ id: 'iss-1', reporter: { plexUsername: 'u' } });
});

describe('reportIssue', () => {
  it('accepts a book owned under another ASIN and links the report to that library item', async () => {
    mocks.findOwnedEdition.mockResolvedValue({ asin: 'B09M8XKBMY', plexGuid: 'li-hat', title: 'A Hat Full of Sky', author: 'Terry Pratchett' });
    prismaMock.audiobook.findFirst.mockResolvedValue(null);
    prismaMock.audiobook.create.mockResolvedValue({ id: 'ab-hat', title: 'A Hat Full of Sky', author: 'Terry Pratchett', absItemId: null, plexGuid: null });
    prismaMock.audiobook.update.mockResolvedValue({ id: 'ab-hat', title: 'A Hat Full of Sky', author: 'Terry Pratchett', absItemId: 'li-hat' });

    const { reportIssue } = await import('@/lib/services/reported-issue.service');
    await reportIssue('B0C6R9GXJF', 'user-1', 'Only 2h playable', { title: 'A Hat Full of Sky', author: 'Terry Pratchett' });

    expect(prismaMock.audiobook.update).toHaveBeenCalledWith({ where: { id: 'ab-hat' }, data: { absItemId: 'li-hat' } });
    expect(prismaMock.reportedIssue.create).toHaveBeenCalledWith(expect.objectContaining({
      data: { audiobookId: 'ab-hat', reporterId: 'user-1', reason: 'Only 2h playable' },
    }));
  });

  it('finds the library copy through an Audible edition grouping', async () => {
    mocks.getSiblingAsins.mockResolvedValue(new Map([['B0NEW', ['B0OLD']]]));
    prismaMock.plexLibrary.findFirst.mockResolvedValue({ plexGuid: 'li-old', asin: 'B0OLD' });
    const { findLibraryCopy } = await import('@/lib/services/reported-issue.service');
    expect(await findLibraryCopy('B0NEW', 'Book', 'Author')).toEqual({ plexGuid: 'li-old', asin: 'B0OLD' });
  });

  it('still refuses a book that is not in the library at all', async () => {
    const { reportIssue, ReportedIssueError } = await import('@/lib/services/reported-issue.service');
    await expect(reportIssue('B0NONE', 'user-1', 'x', { title: 'Nope', author: 'Nobody' })).rejects.toBeInstanceOf(ReportedIssueError);
  });
});

describe('replaceAudiobook — book never requested in ReadMeABook', () => {
  beforeEach(() => {
    prismaMock.reportedIssue.findUnique.mockResolvedValue({
      id: 'iss-1', status: 'open',
      audiobook: { id: 'ab-hat', title: 'A Hat Full of Sky', author: 'Terry Pratchett', audibleAsin: 'B0C6R9GXJF', coverArtUrl: null, narrator: null, plexGuid: null, absItemId: 'li-hat', filePath: null },
    });
    prismaMock.request.findFirst.mockResolvedValue(null);
    prismaMock.plexLibrary.deleteMany.mockResolvedValue({ count: 1 });
    prismaMock.audiobook.update.mockResolvedValue({});
    prismaMock.request.create.mockResolvedValue({ id: 'req-new' });
    prismaMock.reportedIssue.update.mockResolvedValue({});
    mocks.get.mockImplementation(async (key: string) => (key === 'media_dir' ? '/Audiobooks/Audio' : null));
  });

  it('deletes the book folder found from its Audiobookshelf item, then the item, then re-requests', async () => {
    mocks.resolveLibraryFolder.mockResolvedValue('/Audiobooks/Audio/Terry Pratchett/Discworld/A Hat Full of Sky');

    const { replaceAudiobook } = await import('@/lib/services/reported-issue.service');
    await replaceAudiobook('iss-1', 'admin-1', { title: 'A Hat Full of Sky [M4B]' });

    expect(mocks.resolveLibraryFolder).toHaveBeenCalledWith(expect.objectContaining({ absItemId: 'li-hat' }), '/Audiobooks/Audio', expect.any(String), expect.anything());
    expect(mocks.removeBookFolder).toHaveBeenCalledWith('/Audiobooks/Audio/Terry Pratchett/Discworld/A Hat Full of Sky', '/Audiobooks/Audio', expect.anything());
    expect(mocks.deleteABSItem).toHaveBeenCalledWith('li-hat');
    expect(mocks.addDownloadJob).toHaveBeenCalledWith('req-new', expect.objectContaining({ id: 'ab-hat' }), { title: 'A Hat Full of Sky [M4B]' });
  });

  it('still downloads the replacement when the old folder is not found, and records it for the Health Report', async () => {
    mocks.resolveLibraryFolder.mockResolvedValue(null);
    mocks.absItemIdsForAsin.mockResolvedValue(['li-old-thrawn']);

    const { replaceAudiobook } = await import('@/lib/services/reported-issue.service');
    await replaceAudiobook('iss-1', 'admin-1', { title: 'A Hat Full of Sky [M4B]' });

    expect(mocks.removeBookFolder).not.toHaveBeenCalled();
    expect(mocks.addDownloadJob).toHaveBeenCalled();
    const saved = JSON.parse(prismaMock.configuration.upsert.mock.calls[0][0].create.value);
    expect(saved).toEqual([expect.objectContaining({
      audiobookId: 'ab-hat', title: 'A Hat Full of Sky', source: 'replace', itemIds: ['li-hat', 'li-old-thrawn'],
      reason: expect.stringContaining('no folder found'),
    })]);
  });

  it('keeps the Audiobookshelf item when the folder was found but not safe to delete', async () => {
    mocks.resolveLibraryFolder.mockResolvedValue('/Audiobooks/Audio/Terry Pratchett/Discworld');
    mocks.removeBookFolder.mockRejectedValue(new Error('Refusing to delete: it contains other books'));

    const { replaceAudiobook } = await import('@/lib/services/reported-issue.service');
    await replaceAudiobook('iss-1', 'admin-1', { title: 'x' });

    expect(mocks.deleteABSItem).not.toHaveBeenCalled();
    expect(mocks.addDownloadJob).toHaveBeenCalled();
    expect(prismaMock.configuration.upsert).toHaveBeenCalled();
  });
});
