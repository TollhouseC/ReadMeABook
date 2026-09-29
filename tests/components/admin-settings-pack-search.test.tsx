/**
 * Component: Series & Author Packs Settings Section Tests
 * Documentation: documentation/features/series-packs.md
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';

const mocks = vi.hoisted(() => ({
  authenticatedFetcher: vi.fn(),
  fetchJSON: vi.fn(),
}));

vi.mock('@/lib/utils/api', () => ({
  authenticatedFetcher: mocks.authenticatedFetcher,
  fetchJSON: mocks.fetchJSON,
}));

async function renderSection() {
  const { PackSearchSection } = await import('@/app/admin/settings/tabs/IndexersTab/PackSearchSection');
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <PackSearchSection />
    </SWRConfig>
  );
}

describe('PackSearchSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticatedFetcher.mockResolvedValue({ enabled: true, authorPackMode: 'log_only' });
    mocks.fetchJSON.mockImplementation(async (_url: string, init: any) => ({
      enabled: true,
      authorPackMode: 'log_only',
      ...JSON.parse(init.body),
    }));
  });

  it('shows current settings with author packs in log-only mode by default', async () => {
    await renderSection();

    const toggle = await screen.findByRole('switch', { name: 'Search for series packs' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: /Log only/ })).toBeChecked();
  });

  it('saves immediately when series packs are toggled off', async () => {
    await renderSection();

    fireEvent.click(await screen.findByRole('switch', { name: 'Search for series packs' }));

    await waitFor(() => expect(mocks.fetchJSON).toHaveBeenCalledWith('/api/admin/settings/pack-search', {
      method: 'PUT',
      body: JSON.stringify({ enabled: false }),
    }));
  });

  it('saves the author collection mode', async () => {
    await renderSection();

    fireEvent.click(await screen.findByRole('radio', { name: /^Enabled/ }));

    await waitFor(() => expect(mocks.fetchJSON).toHaveBeenCalledWith('/api/admin/settings/pack-search', {
      method: 'PUT',
      body: JSON.stringify({ authorPackMode: 'enabled' }),
    }));
  });

  it('shows an error and reloads when saving fails', async () => {
    mocks.fetchJSON.mockRejectedValue(new Error('Server error'));
    await renderSection();

    fireEvent.click(await screen.findByRole('switch', { name: 'Search for series packs' }));

    expect(await screen.findByText('Server error')).toBeInTheDocument();
  });
});
