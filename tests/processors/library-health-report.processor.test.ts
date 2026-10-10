/**
 * Component: Library Health Report Processor Tests
 * Documentation: documentation/backend/services/jobs.md
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  merge: vi.fn(), organize: vi.fn(), layout: vi.fn(), match: vi.fn(), chapters: vi.fn(),
  info: vi.fn(), warn: vi.fn(),
}));

vi.mock('@/lib/utils/logger', () => ({ RMABLogger: { forJob: () => ({ info: mocks.info, warn: mocks.warn }) } }));
vi.mock('@/lib/processors/merge-library.processor', () => ({ processMergeLibrary: mocks.merge }));
vi.mock('@/lib/processors/organize-library.processor', () => ({ processOrganizeLibrary: mocks.organize }));
vi.mock('@/lib/processors/fix-library-layout.processor', () => ({ processFixLibraryLayout: mocks.layout }));
vi.mock('@/lib/processors/match-library.processor', () => ({ processMatchLibrary: mocks.match }));
vi.mock('@/lib/processors/fix-chapters.processor', () => ({ processFixChapters: mocks.chapters }));

const logged = () => mocks.info.mock.calls.map(c => c[0] as string);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.merge.mockResolvedValue({ checked: 1260, would_clean: 17, files_to_remove: 21, single_file: 1224 });
  mocks.organize.mockResolvedValue({ books: 1258, would_move: 0, in_place: 1258 });
  mocks.layout.mockResolvedValue({ nested: 0 });
  mocks.match.mockResolvedValue({ checked: 1260, would_rematch: 3, wrong_audio: 1, other_edition: 91, ok: 3 });
  mocks.chapters.mockImplementation(async (p: { mode: string }) => (p.mode === 'report' ? { checked: 1259, would_fix: 2, kept: 900 } : { checked: 1200 }));
});

describe('processLibraryHealthReport', () => {
  it('runs every check in report mode into one log, with a summary', async () => {
    const { processLibraryHealthReport } = await import('@/lib/processors/library-health-report.processor');
    const result = await processLibraryHealthReport({ jobId: 'job-h' });

    expect(mocks.merge).toHaveBeenCalledWith({ mode: 'report', jobId: 'job-h' });
    expect(mocks.organize).toHaveBeenCalledWith({ mode: 'report', jobId: 'job-h' });
    expect(mocks.layout).toHaveBeenCalledWith({ mode: 'report', jobId: 'job-h' });
    expect(mocks.match).toHaveBeenCalledWith({ mode: 'report', jobId: 'job-h' });
    expect(mocks.chapters).toHaveBeenCalledWith({ mode: 'report', jobId: 'job-h' });
    expect(mocks.chapters).toHaveBeenCalledWith({ mode: 'sync_report', jobId: 'job-h' });

    const lines = logged();
    expect(lines).toContain('===== Library Merge (report only) =====');
    expect(lines).toContain('===== Summary =====');
    expect(lines).toContain('Library Merge: would clean 17, files to remove 21 (1260 checked)');
    expect(lines).toContain('Library Organize: nothing to do');
    expect(lines).toContain('Library Match Check: would rematch 3, wrong audio 1 (1260 checked)');
    expect(lines).toContain('Chapter Sync: nothing to do (1200 checked)');
    expect(result).toMatchObject({ success: true, checks: { merge: { would_clean: 17 } } });
  });

  it('keeps going when one check fails', async () => {
    mocks.organize.mockRejectedValue(new Error('boom'));
    const { processLibraryHealthReport } = await import('@/lib/processors/library-health-report.processor');
    const result = await processLibraryHealthReport({ jobId: 'job-f' });

    expect(mocks.match).toHaveBeenCalled();
    expect(logged()).toContain('Library Organize: FAILED — boom');
    expect(result.checks.organize).toEqual({ error: 'boom' });
  });

  it('stops after a check is cancelled', async () => {
    mocks.organize.mockResolvedValue({ books: 10, cancelled: true });
    const { processLibraryHealthReport } = await import('@/lib/processors/library-health-report.processor');
    const result = await processLibraryHealthReport({ jobId: 'job-c' });

    expect(mocks.layout).not.toHaveBeenCalled();
    expect(mocks.match).not.toHaveBeenCalled();
    expect(result).toMatchObject({ cancelled: true });
    expect(logged()).toContain('Cancelled by admin — remaining checks skipped');
  });
});
