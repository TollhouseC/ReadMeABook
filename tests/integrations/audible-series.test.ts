/**
 * Component: Audible Series Scraping Tests
 * Documentation: documentation/integrations/audible.md
 *
 * Covers both series-page layouts Audible serves: the newer <adbl-product-row>
 * web-component layout and the legacy .productListItem layout.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const audibleServiceMock = vi.hoisted(() => ({
  getRegion: vi.fn(() => 'us'),
  getBaseUrl: vi.fn(() => 'https://www.audible.com'),
  fetch: vi.fn(),
}));

vi.mock('@/lib/integrations/audible.service', () => ({
  getAudibleService: () => audibleServiceMock,
}));

// Mirrors the real markup, trimmed. Includes a Similar Series carousel image that
// must NOT be picked as the series cover.
const NEW_LAYOUT_HTML = `
<html><body>
  <h1>The Dream Harbor</h1>
  <adbl-metadata slot="child-count">3 titles</adbl-metadata>
  <div id="series-titles" class="bc-container">
    <adbl-style-scope>
      <adbl-product-row variant="catalog" series-header="Book 1" placement="base">
        <a href="/pd/The-Pumpkin-Spice-Cafe-Audiobook/B0CK8WL2MT" slot="image">
          <adbl-product-image><img src="https://m.media-amazon.com/images/I/51D2IpoRi2L._SL500_.jpg" /></adbl-product-image>
        </a>
        <h3 slot="title"><a href="/pd/The-Pumpkin-Spice-Cafe-Audiobook/B0CK8WL2MT">The Pumpkin Spice Café</a></h3>
        <h4 slot="subtitle">The Dream Harbour, Book 1</h4>
        <div slot="buy-box"><script type="application/json">{"notMetadata":true}</script></div>
        <script type="application/json">{"authors":[{"name":"Laurie Gilmore","url":"/author/Laurie-Gilmore/B0CDXTJW39"}],"narrators":[{"name":"Regina Reagan","url":"/search?searchNarrator=Regina+Reagan"}],"duration":"7 hrs and 3 mins","language":"English","releaseDate":"2023-10-26","rating":{"value":3.9e0,"count":2486}}</script>
      </adbl-product-row>
      <div class="adbl-mb-3 adbl-mt-2"></div>
      <adbl-product-row variant="catalog" series-header="Book 2" placement="base">
        <a href="/pd/The-Gingerbread-Bakery-Audiobook/B0DKPBW15H" slot="image">
          <adbl-product-image><img src="https://m.media-amazon.com/images/I/gingerbread._SL500_.jpg" /></adbl-product-image>
        </a>
        <h3 slot="title"><a href="/pd/The-Gingerbread-Bakery-Audiobook/B0DKPBW15H">The Gingerbread Bakery</a></h3>
        <script type="application/json">{"authors":[{"name":"Laurie Gilmore","url":"/author/Laurie-Gilmore/B0CDXTJW39"}],"narrators":[{"name":"Savannah Peachwood"},{"name":"Sebastian York"}],"duration":"9 hrs and 8 mins","rating":{"value":4.5,"count":900}}</script>
      </adbl-product-row>
      <adbl-product-row variant="catalog" series-header="Book 3" placement="base">
        <a href="/pd/The-Apple-Pie-Ice-Cream-Parlor-Audiobook/B0H3D13F49" slot="image">
          <adbl-product-image><img src="https://m.media-amazon.com/images/I/applepie._SL500_.jpg" /></adbl-product-image>
        </a>
        <h3 slot="title"><a href="/pd/The-Apple-Pie-Ice-Cream-Parlor-Audiobook/B0H3D13F49">The Apple Pie Ice Cream Parlor</a></h3>
        <script type="application/json">{"authors":[{"name":"Laurie Gilmore","url":"/author/Laurie-Gilmore/B0CDXTJW39"}],"narrators":[{"name":"to be announced"}],"duration":"3 hrs and 12 mins","rating":{"value":0,"count":0}}</script>
      </adbl-product-row>
    </adbl-style-scope>
  </div>
  <adbl-product-carousel id="SeriestoSeries">
    <adbl-product-grid-item>
      <div class="adbl-impression-emitted" data-asin="B0OTHERSER"></div>
      <adbl-metadata slot="title"><a href="/series/Other/B0OTHERSER">Other Series</a></adbl-metadata>
      <img src="https://m.media-amazon.com/images/I/carousel._SL500_.jpg" />
    </adbl-product-grid-item>
  </adbl-product-carousel>
</body></html>
`;

const LEGACY_LAYOUT_HTML = `
<html><body>
  <h1>Cradle</h1>
  <ul>
    <li class="bc-list-item productListItem">
      <div class="bc-row-responsive">
        <img src="https://m.media-amazon.com/images/I/unsouled._SL175_.jpg" />
        <h2>Book 1</h2>
        <h3><a href="/pd/Unsouled-Audiobook/B07GVRN95A">Unsouled</a></h3>
        <span>
          <ul class="bc-list">
            <li class="bc-list-item authorLabel">By: <a href="/author/Will-Wight/B00A1B2C3D">Will Wight</a></li>
            <li class="bc-list-item narratorLabel">Narrated by: <a href="/search?searchNarrator=Travis+Baldree">Travis Baldree</a></li>
            <li class="bc-list-item runtimeLabel">Length: 8 hrs and 20 mins</li>
          </ul>
        </span>
      </div>
    </li>
  </ul>
</body></html>
`;

function mockPage(html: string) {
  audibleServiceMock.fetch.mockResolvedValue({ data: { data: html }, meta: {} });
}

describe('scrapeSeriesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('new <adbl-product-row> layout', () => {
    it('parses every book row with metadata from the embedded JSON', async () => {
      mockPage(NEW_LAYOUT_HTML);
      const { scrapeSeriesPage } = await import('@/lib/integrations/audible-series');

      const detail = await scrapeSeriesPage('B0CKC6CJNL');

      expect(detail).not.toBeNull();
      expect(detail!.books.map(b => b.asin)).toEqual(['B0CK8WL2MT', 'B0DKPBW15H', 'B0H3D13F49']);

      const first = detail!.books[0];
      expect(first).toMatchObject({
        asin: 'B0CK8WL2MT',
        title: 'The Pumpkin Spice Café',
        author: 'Laurie Gilmore',
        authorAsin: 'B0CDXTJW39',
        narrator: 'Regina Reagan',
        coverArtUrl: 'https://m.media-amazon.com/images/I/51D2IpoRi2L._SL500_.jpg',
        rating: 3.9,
        durationMinutes: 423,
        releaseDate: '2023-10-26',
        language: 'English',
      });
    });

    it('reads each book\'s series position from the row header', async () => {
      mockPage(NEW_LAYOUT_HTML);
      const { scrapeSeriesPage } = await import('@/lib/integrations/audible-series');

      const detail = await scrapeSeriesPage('B0CKC6CJNL');

      expect(detail!.books.map(b => b.seriesPart)).toEqual(['1', '2', '3']);
    });

    it('joins multiple narrators', async () => {
      mockPage(NEW_LAYOUT_HTML);
      const { scrapeSeriesPage } = await import('@/lib/integrations/audible-series');

      const detail = await scrapeSeriesPage('B0CKC6CJNL');

      expect(detail!.books[1].narrator).toBe('Savannah Peachwood, Sebastian York');
    });

    it('drops "to be announced" narrators and zero ratings on pre-release titles', async () => {
      mockPage(NEW_LAYOUT_HTML);
      const { scrapeSeriesPage } = await import('@/lib/integrations/audible-series');

      const detail = await scrapeSeriesPage('B0CKC6CJNL');
      const preRelease = detail!.books[2];

      expect(preRelease.narrator).toBe('');
      expect(preRelease.rating).toBeUndefined();
      expect(preRelease.durationMinutes).toBe(192);
    });

    it('keeps bookCount consistent with the header child-count', async () => {
      mockPage(NEW_LAYOUT_HTML);
      const { scrapeSeriesPage } = await import('@/lib/integrations/audible-series');

      const detail = await scrapeSeriesPage('B0CKC6CJNL');

      expect(detail!.bookCount).toBe(3);
      expect(detail!.hasMore).toBe(false);
    });
  });

  describe('legacy .productListItem layout', () => {
    it('still parses legacy list items', async () => {
      mockPage(LEGACY_LAYOUT_HTML);
      const { scrapeSeriesPage } = await import('@/lib/integrations/audible-series');

      const detail = await scrapeSeriesPage('B07GVRN95T');

      expect(detail!.books).toHaveLength(1);
      expect(detail!.books[0]).toMatchObject({
        asin: 'B07GVRN95A',
        title: 'Unsouled',
        author: 'Will Wight',
        narrator: 'Travis Baldree',
        durationMinutes: 500,
        seriesPart: '1',
      });
    });
  });

  describe('parseSeriesPosition', () => {
    it('parses short position labels, including decimals and other languages', async () => {
      const { parseSeriesPosition } = await import('@/lib/integrations/audible-series-rows');
      expect(parseSeriesPosition('Book 1')).toBe('1');
      expect(parseSeriesPosition('Book 10')).toBe('10');
      expect(parseSeriesPosition('Buch 2,5')).toBe('2.5');
      expect(parseSeriesPosition('Book 0.5')).toBe('0.5');
    });

    it('ignores ranges, missing labels, and long text', async () => {
      const { parseSeriesPosition } = await import('@/lib/integrations/audible-series-rows');
      expect(parseSeriesPosition('Books 1-3')).toBeUndefined();
      expect(parseSeriesPosition('')).toBeUndefined();
      expect(parseSeriesPosition(undefined)).toBeUndefined();
      expect(parseSeriesPosition('A very long heading that is clearly a title 2')).toBeUndefined();
    });
  });

  it('returns null when the fetch fails', async () => {
    audibleServiceMock.fetch.mockRejectedValue(new Error('network down'));
    const { scrapeSeriesPage } = await import('@/lib/integrations/audible-series');

    expect(await scrapeSeriesPage('B0CKC6CJNL')).toBeNull();
  });
});

describe('searchForSeries (series search cards)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses the first product row as the cover on new-layout series, not a carousel image', async () => {
    // Search result has no image of its own, so the card cover must come from the
    // series page summary.
    const searchHtml = `
      <html><body>
        <li class="productListItem">
          <span>Series: <a href="/series/The-Dream-Harbour-Audiobooks/B0CKC6CJNL">The Dream Harbor</a></span>
        </li>
      </body></html>`;

    audibleServiceMock.fetch.mockImplementation(async (url: string) => ({
      data: { data: url === '/search' ? searchHtml : NEW_LAYOUT_HTML },
      meta: {},
    }));

    const { searchForSeries } = await import('@/lib/integrations/audible-series');
    const results = await searchForSeries('dream harbor');

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      asin: 'B0CKC6CJNL',
      bookCount: 3,
      coverArtUrl: 'https://m.media-amazon.com/images/I/51D2IpoRi2L._SL500_.jpg',
    });
  });
});
