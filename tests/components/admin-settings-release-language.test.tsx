/**
 * Component: Release Language Settings Section Tests
 * Documentation: documentation/phase3/ranking-algorithm.md
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
  const { ReleaseLanguageSection } = await import('@/app/admin/settings/tabs/IndexersTab/ReleaseLanguageSection');
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ReleaseLanguageSection />
    </SWRConfig>
  );
}

describe('ReleaseLanguageSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticatedFetcher.mockResolvedValue({ language: 'english' });
    mocks.fetchJSON.mockImplementation(async (_url: string, init: any) => JSON.parse(init.body));
  });

  it('shows English selected by default and saves a change immediately', async () => {
    await renderSection();

    const select = await screen.findByLabelText('Required language');
    expect(select).toHaveValue('english');

    fireEvent.change(select, { target: { value: 'any' } });

    await waitFor(() => expect(mocks.fetchJSON).toHaveBeenCalledWith('/api/admin/settings/release-language', {
      method: 'PUT',
      body: JSON.stringify({ language: 'any' }),
    }));
    expect(select).toHaveValue('any');
  });
});
