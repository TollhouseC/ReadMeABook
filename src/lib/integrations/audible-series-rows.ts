/**
 * Component: Audible Series Product-Row Parser
 * Documentation: documentation/integrations/audible.md
 *
 * Parses books from Audible's newer series-page layout, where each book is an
 * <adbl-product-row> web component. Audible is rolling this layout out series by
 * series, so pages may use it, the legacy .productListItem layout, or both.
 *
 * Each row exposes title/cover/link as slotted children and embeds the rest of
 * the metadata as JSON:
 *
 *   <adbl-product-row series-header="Book 1">
 *     <a href="/pd/Title-Audiobook/B0CK8WL2MT" slot="image">
 *       <adbl-product-image><img src="..." /></adbl-product-image>
 *     </a>
 *     <h3 slot="title"><a href="/pd/Title-Audiobook/B0CK8WL2MT">Title</a></h3>
 *     <h4 slot="subtitle">Series Name, Book 1</h4>
 *     ...
 *     <script type="application/json">
 *       {"authors":[{"name":"...","url":"/author/Name/B0CDXTJW39"}],
 *        "narrators":[{"name":"...","url":"/search?searchNarrator=..."}],
 *        "duration":"7 hrs and 3 mins","language":"English",
 *        "releaseDate":"2023-10-26","rating":{"value":3.9,"count":2486}}
 *     </script>
 *   </adbl-product-row>
 */

import * as cheerio from 'cheerio';
import type { AudibleAudiobook } from './audible.service';
import { stripPrefixes, type LanguageConfig } from '../constants/language-config';
import { parseRuntime } from '../utils/parse-runtime';

interface ProductRowPerson {
  name?: string;
  url?: string;
}

interface ProductRowMetadata {
  authors?: ProductRowPerson[];
  narrators?: ProductRowPerson[];
  duration?: string;
  language?: string;
  releaseDate?: string;
  rating?: { value?: number; count?: number };
}

// Placeholder Audible shows for unannounced pre-release narrators
const PLACEHOLDER_NAMES = new Set(['to be announced', 'tba']);

/**
 * Read the row's embedded JSON metadata block. Returns null if absent or unparseable.
 */
function readRowMetadata(
  $: cheerio.CheerioAPI,
  $row: cheerio.Cheerio<any>
): ProductRowMetadata | null {
  let metadata: ProductRowMetadata | null = null;
  $row.find('script[type="application/json"]').each((_i, el) => {
    if (metadata) return;
    try {
      const parsed = JSON.parse($(el).html() || '');
      if (parsed && (parsed.authors || parsed.narrators || parsed.duration)) {
        metadata = parsed;
      }
    } catch {
      // Not the metadata block (or malformed) — keep looking
    }
  });
  return metadata;
}

/**
 * Join real person names, dropping pre-release placeholders like "to be announced".
 */
function joinNames(people: ProductRowPerson[] | undefined): string {
  return (people || [])
    .map(p => (p.name || '').trim())
    .filter(name => name && !PLACEHOLDER_NAMES.has(name.toLowerCase()))
    .join(', ');
}

/**
 * Parse all books rendered as <adbl-product-row> on a series page.
 * Returns an empty array for legacy-layout pages (no rows present).
 */
export function parseProductRows(
  $: cheerio.CheerioAPI,
  langConfig: LanguageConfig
): AudibleAudiobook[] {
  const books: AudibleAudiobook[] = [];

  $('adbl-product-row').each((_index, element) => {
    const $row = $(element);

    // ASIN: from the title's product link, then the image link, then any data-asin
    const productHref =
      $row.find('h3[slot="title"] a').attr('href') ||
      $row.find('a[href*="/pd/"]').first().attr('href') ||
      '';
    const asin =
      productHref.match(/\/pd\/[^/]+\/([A-Z0-9]{10})/)?.[1] ||
      $row.find('[data-asin]').first().attr('data-asin') ||
      '';
    if (!asin) return;

    const title = $row.find('h3[slot="title"]').first().text().trim();
    if (!title) return;

    const coverArtUrl =
      $row.find('adbl-product-image img, img').first().attr('src')
        ?.replace(/\._.*_\./, '._SL500_.') || '';

    const metadata = readRowMetadata($, $row);

    const firstAuthor = metadata?.authors?.[0];
    const authorAsin = firstAuthor?.url?.match(/\/author\/[^/]+\/([A-Z0-9]{10})/)?.[1];

    // Audible reports 0 for unrated (e.g. pre-release) titles — treat as no rating
    const ratingValue = metadata?.rating?.value;
    const rating = typeof ratingValue === 'number' && ratingValue > 0 ? ratingValue : undefined;

    books.push({
      asin,
      title,
      author: stripPrefixes(joinNames(metadata?.authors), langConfig.scraping.authorPrefixes),
      authorAsin: authorAsin || undefined,
      narrator: stripPrefixes(joinNames(metadata?.narrators), langConfig.scraping.narratorPrefixes),
      coverArtUrl,
      rating,
      durationMinutes: parseRuntime(metadata?.duration || '', langConfig),
      releaseDate: metadata?.releaseDate || undefined,
      language: metadata?.language || undefined,
    });
  });

  return books;
}
