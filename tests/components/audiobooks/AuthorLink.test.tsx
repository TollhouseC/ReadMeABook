/**
 * Component: Author Link Tests
 * Documentation: documentation/frontend/components.md
 */

// @vitest-environment jsdom

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AuthorLink, getAuthorHref } from '@/components/audiobooks/AuthorLink';

describe('getAuthorHref', () => {
  it('links to the author page when the author ASIN is known', () => {
    expect(getAuthorHref('Laurie Gilmore', 'B0CDXTJW39')).toBe('/authors/B0CDXTJW39');
  });

  it('falls back to the author search when Audible has no author ASIN', () => {
    expect(getAuthorHref('Brandon Sanderson')).toBe('/authors?q=Brandon%20Sanderson');
    expect(getAuthorHref('Glen Cook', undefined)).toBe('/authors?q=Glen%20Cook');
  });

  it('searches on the primary author of a combined credit', () => {
    expect(getAuthorHref('Neil Gaiman, Terry Pratchett')).toBe('/authors?q=Neil%20Gaiman');
  });

  it('does not link placeholder credits or empty authors', () => {
    for (const name of ['Various', 'Various Authors', 'Full Cast', 'Anonymous', 'Unknown', '', '  ']) {
      expect(getAuthorHref(name)).toBeNull();
    }
  });
});

describe('AuthorLink', () => {
  it('renders a search link and closes the modal on click', () => {
    const onNavigate = vi.fn();
    render(<AuthorLink author="Glen Cook" onNavigate={onNavigate} />);

    const link = screen.getByRole('link', { name: 'Glen Cook' });
    expect(link.getAttribute('href')).toBe('/authors?q=Glen%20Cook');
    fireEvent.click(link);
    expect(onNavigate).toHaveBeenCalled();
  });

  it('renders plain text for a placeholder credit', () => {
    render(<AuthorLink author="Various" onNavigate={vi.fn()} />);

    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('Various')).toBeTruthy();
  });
});
