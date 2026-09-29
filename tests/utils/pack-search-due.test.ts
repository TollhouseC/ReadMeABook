/**
 * Component: Pack Search Scheduling Tests
 * Documentation: documentation/features/series-packs.md
 */

import { describe, expect, it } from 'vitest';
import { isPackSearchDue } from '@/lib/utils/pack-search-due';

const HOUR = 60 * 60 * 1000;
const now = new Date('2026-09-29T12:00:00Z');
const ago = (hours: number) => new Date(now.getTime() - hours * HOUR);

describe('isPackSearchDue', () => {
  it('waits until the request has searched for 24h', () => {
    expect(isPackSearchDue({ createdAt: ago(23), lastPackSearchAt: null }, now)).toBe(false);
    expect(isPackSearchDue({ createdAt: ago(24), lastPackSearchAt: null }, now)).toBe(true);
  });

  it('allows about one pack search per day per request', () => {
    expect(isPackSearchDue({ createdAt: ago(100), lastPackSearchAt: ago(19) }, now)).toBe(false);
    expect(isPackSearchDue({ createdAt: ago(100), lastPackSearchAt: ago(20) }, now)).toBe(true);
  });
});
