/**
 * Component: Author Link (Audiobook Details Modal)
 * Documentation: documentation/frontend/components.md
 *
 * Author ASIN → author page. No ASIN (Audible hasn't linked the author profile yet)
 * → author search by name. Placeholder credits ("Various", "Full Cast") → plain text.
 * Never persisted, so a book switches to the author page once Audible adds the ASIN.
 */

'use client';

import React from 'react';
import Link from 'next/link';

const PLACEHOLDER_AUTHOR_RE = /^(various( authors)?|full cast|anonymous|unknown( author)?|n\/?a)$/i;

/** Href for an author credit, or null when it shouldn't link. */
export function getAuthorHref(author: string | undefined, authorAsin?: string): string | null {
  if (authorAsin) return `/authors/${authorAsin}`;

  // Search on the primary author only; a combined "A, B" string matches nothing.
  const primary = (author || '').split(',')[0].trim();
  if (!primary || PLACEHOLDER_AUTHOR_RE.test(primary)) return null;
  return `/authors?q=${encodeURIComponent(primary)}`;
}

interface AuthorLinkProps {
  author: string;
  authorAsin?: string;
  onNavigate: () => void;
}

export function AuthorLink({ author, authorAsin, onNavigate }: AuthorLinkProps) {
  const href = getAuthorHref(author, authorAsin);
  if (!href) return <>{author}</>;

  return (
    <Link
      href={href}
      onClick={(e) => {
        e.stopPropagation();
        onNavigate();
      }}
      className="hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors"
    >
      {author}
    </Link>
  );
}
