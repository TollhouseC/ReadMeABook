/**
 * Component: Upcoming Releases Hook
 * Documentation: documentation/features/watched-lists.md
 */

'use client';

import useSWR from 'swr';
import { useAuth } from '@/contexts/AuthContext';
import { fetchWithAuth } from '@/lib/utils/api';

export interface UpcomingReleaseItem {
  asin: string;
  title: string;
  author: string;
  series: string | null;
  seriesPart: string | null;
  coverArtUrl: string | null;
  releaseDate: string; // YYYY-MM-DD
}

const fetcher = (url: string) => fetchWithAuth(url).then((res) => res.json());

export function useUpcomingReleases() {
  const { accessToken } = useAuth();
  const { data, error, isLoading } = useSWR(
    accessToken ? '/api/user/upcoming' : null,
    fetcher,
    { refreshInterval: 300000 }
  );

  return {
    upcoming: (data?.upcoming || []) as UpcomingReleaseItem[],
    isLoading,
    error,
  };
}
