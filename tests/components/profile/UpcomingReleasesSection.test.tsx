/**
 * Component: Upcoming Releases Section Tests
 * Documentation: documentation/features/watched-lists.md
 */

// @vitest-environment jsdom

import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  upcoming: [] as any[],
  series: [] as any[],
  authors: [] as any[],
}));

vi.mock('@/lib/hooks/useUpcomingReleases', () => ({
  useUpcomingReleases: () => ({ upcoming: state.upcoming, isLoading: false }),
}));
vi.mock('@/lib/hooks/useWatchedSeries', () => ({ useWatchedSeries: () => ({ series: state.series }) }));
vi.mock('@/lib/hooks/useWatchedAuthors', () => ({ useWatchedAuthors: () => ({ authors: state.authors }) }));

import { UpcomingReleasesSection } from '@/components/profile/UpcomingReleasesSection';

describe('UpcomingReleasesSection', () => {
  beforeEach(() => {
    state.upcoming = [];
    state.series = [{ seriesAsin: 'S1' }];
    state.authors = [];
  });

  it('lists title, series number, author and date', () => {
    state.upcoming = [{
      asin: 'B1', title: 'Dead of Night', author: 'Glen Cook', series: 'Chronicles of the Black Company',
      seriesPart: '12', coverArtUrl: null, releaseDate: '2026-11-03',
    }];
    render(<UpcomingReleasesSection />);

    expect(screen.getByText('Upcoming Releases')).toBeInTheDocument();
    expect(screen.getByText('Dead of Night')).toBeInTheDocument();
    expect(screen.getByText(/Chronicles of the Black Company #12/)).toBeInTheDocument();
    expect(screen.getByText('Glen Cook')).toBeInTheDocument();
    expect(screen.getByText('Nov 3, 2026', { exact: false })).toBeInTheDocument();
  });

  it('explains the empty state when watching but nothing is upcoming', () => {
    render(<UpcomingReleasesSection />);
    expect(screen.getByText(/No upcoming releases found/)).toBeInTheDocument();
  });

  it('renders nothing when the user watches no series or authors', () => {
    state.series = [];
    const { container } = render(<UpcomingReleasesSection />);
    expect(container).toBeEmptyDOMElement();
  });
});
