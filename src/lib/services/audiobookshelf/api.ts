/**
 * Component: Audiobookshelf API Client
 *
 * Provides API methods for interacting with Audiobookshelf:
 * - Library scanning and item fetching
 * - Metadata matching (with ASIN for accurate Audible lookup)
 * - Item management
 */

import { getConfigService } from '../config.service';
import { RMABLogger } from '@/lib/utils/logger';
import { AudibleRegion } from '@/lib/types/audible';

const logger = RMABLogger.create('Audiobookshelf');

/**
 * Map RMAB Audible region to Audiobookshelf provider value
 */
function mapRegionToABSProvider(region: AudibleRegion): string {
  // US uses 'audible' (audible.com), all others use 'audible.{region}'
  return region === 'us' ? 'audible' : `audible.${region}`;
}

interface ABSRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: any;
}

/**
 * Make a request to the Audiobookshelf API
 */
export async function absRequest<T>(endpoint: string, options: ABSRequestOptions = {}): Promise<T> {
  const configService = getConfigService();
  const serverUrl = await configService.get('audiobookshelf.server_url');
  const apiToken = await configService.get('audiobookshelf.api_token');

  if (!serverUrl || !apiToken) {
    throw new Error('Audiobookshelf not configured');
  }

  const url = `${serverUrl.replace(/\/$/, '')}/api${endpoint}`;

  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!response.ok) {
    throw new Error(`ABS API error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

/**
 * Get Audiobookshelf server status/info
 */
export async function getABSServerInfo() {
  return absRequest<{ version: string; name: string }>('/status');
}

/**
 * Get all libraries from Audiobookshelf
 */
export async function getABSLibraries() {
  const result = await absRequest<{ libraries: any[] }>('/libraries');
  return result.libraries;
}

/**
 * Get all items in a library
 */
export async function getABSLibraryItems(libraryId: string) {
  const result = await absRequest<{ results: any[] }>(`/libraries/${libraryId}/items`);
  return result.results;
}

/**
 * Get recently added items in a library
 */
export async function getABSRecentItems(libraryId: string, limit: number) {
  const result = await absRequest<{ results: any[] }>(
    `/libraries/${libraryId}/items?sort=addedAt&desc=1&limit=${limit}`
  );
  return result.results;
}

/**
 * Get a single item by ID
 */
export async function getABSItem(itemId: string) {
  return absRequest<any>(`/items/${itemId}`);
}

/**
 * Search for items in a library
 */
export async function searchABSItems(libraryId: string, query: string) {
  const result = await absRequest<{ book: any[] }>(
    `/libraries/${libraryId}/search?q=${encodeURIComponent(query)}`
  );
  return result.book || [];
}

/**
 * Trigger a library scan (force = re-read every item, not just changed folders)
 * Note: This endpoint returns plain text "OK" instead of JSON
 */
export async function triggerABSScan(libraryId: string, options: { force?: boolean } = {}) {
  const configService = getConfigService();
  const serverUrl = await configService.get('audiobookshelf.server_url');
  const apiToken = await configService.get('audiobookshelf.api_token');

  if (!serverUrl || !apiToken) {
    throw new Error('Audiobookshelf not configured');
  }

  const url = `${serverUrl.replace(/\/$/, '')}/api/libraries/${libraryId}/scan${options.force ? '?force=1' : ''}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`ABS API error: ${response.status} ${response.statusText}`);
  }

  // Endpoint returns plain text "OK", not JSON - don't try to parse it
  await response.text();
}

export interface ABSMatchOptions {
  /** Replace existing details (ABS otherwise only fills empty fields — an item that already
   *  has an ASIN/title would not change at all) */
  overrideDetails?: boolean;
  /** Replace the existing cover too */
  overrideCover?: boolean;
  /** Throw instead of logging and returning null */
  throwOnError?: boolean;
}

export interface ABSMatchResult {
  /** Audiobookshelf reports it changed the item */
  updated: boolean;
  /** ASIN on the item after the match */
  asin?: string;
}

/**
 * Trigger metadata match for a specific library item
 * This tells Audiobookshelf to automatically match and populate metadata from providers
 *
 * @param itemId - The Audiobookshelf item ID
 * @param asin - Optional ASIN for direct Audible matching (100% accurate when provided)
 * @param options - overrideDetails/overrideCover to correct an existing (wrong) match
 * @returns What Audiobookshelf reports (null when the call failed and throwOnError is off)
 */
export async function triggerABSItemMatch(itemId: string, asin?: string, options: ABSMatchOptions = {}): Promise<ABSMatchResult | null> {
  try {
    // Get configured Audible region to use correct ABS provider
    const configService = getConfigService();
    const region = await configService.getAudibleRegion();
    const provider = mapRegionToABSProvider(region);

    const body: any = {
      provider, // Use region-specific Audible provider (e.g., 'audible.ca' for Canada)
    };

    // If we have an ASIN, we can do a direct match with 100% confidence
    if (asin) {
      body.asin = asin;
      body.overrideDefaults = true; // Override defaults since we have exact ASIN match
    }

    if (options.overrideDetails) body.overrideDetails = true;
    if (options.overrideCover) body.overrideCover = true;

    const result = await absRequest<any>(`/items/${itemId}/match`, {
      method: 'POST',
      body,
    });
    return {
      updated: !!result?.updated,
      asin: result?.libraryItem?.media?.metadata?.asin || undefined,
    };
  } catch (error) {
    if (options.throwOnError) throw error;
    // Don't throw - matching is best-effort, scan should continue even if match fails
    logger.error(`Failed to trigger match for item ${itemId}`, { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/**
 * Delete a library item from Audiobookshelf
 * Note: This only removes the item from Audiobookshelf's database, not the actual files
 *
 * @param itemId - The Audiobookshelf item ID to delete
 */
export async function deleteABSItem(itemId: string): Promise<void> {
  const configService = getConfigService();
  const serverUrl = await configService.get('audiobookshelf.server_url');
  const apiToken = await configService.get('audiobookshelf.api_token');

  if (!serverUrl || !apiToken) {
    throw new Error('Audiobookshelf not configured');
  }

  const url = `${serverUrl.replace(/\/$/, '')}/api/items/${itemId}?hard=1`;

  const response = await fetch(url, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${apiToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`ABS API error: ${response.status} ${response.statusText}`);
  }

  logger.info(`Deleted library item ${itemId} from Audiobookshelf`);
}
