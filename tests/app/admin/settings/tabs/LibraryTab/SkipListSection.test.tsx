/**
 * Component: Library Skip List Settings Section Tests
 * Documentation: documentation/backend/services/jobs.md
 */

// @vitest-environment jsdom

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({ authenticatedFetcher: vi.fn(), fetchJSON: vi.fn() }));
vi.mock('@/lib/utils/api', () => apiMock);

import { SkipListSection } from '@/app/admin/settings/tabs/LibraryTab/SkipListSection';

const renderSection = () =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <SkipListSection />
    </SWRConfig>
  );

describe('SkipListSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.authenticatedFetcher.mockResolvedValue({ text: 'A/B | match | kept', entries: 1, errors: [] });
  });

  it('shows the saved list and saves a pasted replacement, listing ignored lines', async () => {
    apiMock.fetchJSON.mockResolvedValue({ text: 'A/B | match | kept\nC/D | nope', entries: 1, errors: ['Line 2: checks must be match, chapters, merge or all (got "nope")'] });
    renderSection();

    const box = await screen.findByLabelText('Skip list');
    expect(box).toHaveValue('A/B | match | kept');
    expect(screen.getByText(/1 book skipped/)).toBeInTheDocument();

    fireEvent.change(box, { target: { value: 'A/B | match | kept\nC/D | nope' } });
    fireEvent.click(screen.getByText('Save skip list'));

    await waitFor(() => expect(apiMock.fetchJSON).toHaveBeenCalledWith('/api/admin/settings/library-skip-list', {
      method: 'PUT', body: JSON.stringify({ text: 'A/B | match | kept\nC/D | nope' }),
    }));
    expect(await screen.findByText(/Line 2: checks must be/)).toBeInTheDocument();
  });

  it('keeps Save disabled until the list changes', async () => {
    renderSection();
    await screen.findByLabelText('Skip list');
    expect(screen.getByText('Save skip list')).toBeDisabled();
  });
});
