/**
 * Component: Multi-Book Import Guard Tests
 * Documentation: documentation/phase3/file-organization.md
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const probeMock = vi.hoisted(() => vi.fn());
const runtimeMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/utils/chapter-merger', () => ({ probeAudioFile: probeMock }));
vi.mock('@/lib/integrations/audible.service', () => ({ getAudibleService: () => ({ getRuntime: runtimeMock }) }));

import { checkMultiBookImport, describeMultiBook } from '@/lib/utils/multi-book-guard';

const H = 3_600_000;

describe('checkMultiBookImport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeMock.mockResolvedValue(25.3 * 60); // HWFwM 10
  });

  it('refuses a series worth of audio for one book', async () => {
    const lengths = [22, 24.7, 22.3, 20.1, 15.8, 18.7, 18.2, 28.1, 25.3];
    lengths.forEach(h => probeMock.mockResolvedValueOnce({ duration: h * H }));

    const result = await checkMultiBookImport(lengths.map((_, i) => `/d/${i}.m4b`), 'B0C1PV6Q7C');

    expect(result).not.toBeNull();
    expect(result!.expectedMs).toBe(25.3 * H);
    expect(describeMultiBook(result!, 'He Who Fights with Monsters 10')).toMatch(/195\.2h of audio .* 25\.3h on Audible/);
  });

  it('allows one book in chapter files, and a slightly long edition', async () => {
    probeMock.mockResolvedValue({ duration: 0.5 * H });
    expect(await checkMultiBookImport(Array.from({ length: 60 }, (_, i) => `/d/${i}.mp3`), 'B0X')).toBeNull(); // 30h
  });

  it('refuses two books sharing a folder', async () => {
    probeMock.mockResolvedValue({ duration: 25 * H });
    expect(await checkMultiBookImport(['/d/a.m4b', '/d/b.m4b'], 'B0X')).not.toBeNull();
  });

  it('skips the check without an ASIN or runtime', async () => {
    expect(await checkMultiBookImport(['/d/a.m4b'], null)).toBeNull();
    runtimeMock.mockResolvedValue(null);
    expect(await checkMultiBookImport(['/d/a.m4b'], 'B0X')).toBeNull();
    expect(probeMock).not.toHaveBeenCalled();
  });
});
