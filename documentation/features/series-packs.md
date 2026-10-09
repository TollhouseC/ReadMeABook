# Series & Author Packs

**Status:** ✅ Implemented | Grab multi-book packs when a series book has no individual release after 24h

## Overview
Some books only exist as part of a pack ("Mistborn Complete Series", "Brandon Sanderson Collection"). When a series book's individual search keeps failing past 24h, RMAB also searches for packs, verifies a pack's real file list contains the book, downloads only the requested series' books from it (qBittorrent), and imports each book separately.

## Flow
1. `search-indexers` fails (no results / no quality match) → if `isPackSearchDue()` (request ≥24h old, last pack search ≥20h ago, audiobook type) → `addSearchPacksJob(requestId)`.
2. `search_packs` job (concurrency 1) → `runPackSearch()` (`src/lib/services/pack-search.service.ts`):
   - Requires: `pack_search_enabled != 'false'`, request `awaiting_search`, audiobook has `series`, torrent client is **qBittorrent** (file lists + partial download). Sets `lastPackSearchAt`.
   - **Series universe** (`pack-sources.ts`): series listing from Audible (`scrapeSeriesPage(seriesAsin)`, ≤4 pages), collapsed to one entry per work (`book-versions.ts`), with positions (`seriesPart`). Always includes the triggering book.
   - **Search:** queries `"<series core> <surname>"`, `"<series core>"`, `"<series>"`, + `"<author>"` if author packs not disabled. Blacklist filtered.
   - **Rank** (`pack-ranking.ts`): see Pre-filter. Top 3 series + top 2 author candidates.
   - **Inspect** each candidate: `addTorrent(url, { stopCondition: 'MetadataReceived' })` (qBit fetches the file list, then stops), poll `getFiles` (≤120s), `matchPackFiles()`:
     - no metadata → delete + blacklist `pack_no_metadata`
     - triggering book not matched → delete + blacklist `pack_missing_book`
     - author pack in `log_only` mode → log "[author packs: log-only] Would grab …" + delete (no blacklist)
     - torrent already used by another download → skip, untouched
   - **Accept:** `planLinks()` (`pack-links.service.ts`) → set file priorities (unwanted 0, wanted 1) → one `DownloadHistory` per linked request (shared `downloadClientId`, own `packFiles`) → requests `downloading` → `resumeTorrent` → one monitor job (triggering request).
3. `monitor-download`: mirrors progress to linked requests; on completion sends each linked request's `packFiles` to `addOrganizeJob(..., selectedFiles)`; on failure fails all linked requests.

## What Gets Imported (planLinks)
| Book in pack | Result |
|---|---|
| Triggering book | Imported |
| Has request in `awaiting_search`/`pending` (any user) | Linked to the pack, imported |
| Has request in another active state | Skipped (already handled) |
| No request, user auto-approved (admin / autoApprove / global) | Request created (`skipAutoSearch`), imported — fills out the series |
| No request, user needs approval | Skipped |
| A version already in the library (work key) | Skipped |
- **Series pack:** every series book found in the pack. **Author pack:** only the requested series' books (other series never matched).
- **Downloaded files:** the linked books' audio + non-audio files in the same folders (covers). Everything else priority 0.

## Pre-filter (pack-ranking.ts, titles only)
- Audio, not ebook formats; ≥100 MB.
- Author: surname + (first name or first initial). Surname alone rejected.
- **Series pack:** all distinctive series-name words + a pack signal (`complete`, `collection`, `box set`, `omnibus`, `anthology`, `trilogy`/`quartet`/`quintet`, `books 1-7`, `1-7`, `vols 1-3`, `all 7`, `7 books`) after stripping series-name words — or size ≥2.5× one book (when runtime known).
- **Author pack:** collection signal (`complete`, `collection`, `works`, `library`, `omnibus`, `N books`, `audiobooks`, `megapack`…) and ≥500 MB.
- Score: seeders (log), `complete` +10, M4B +5, freeleech +3; series +20 (series always rank above author).

## Fuzzy Matching (pack-matcher.ts)
- Candidates per audio file: file name, then each parent folder (nearest first), excluding the torrent's root folder.
- Normalization: case, punctuation, diacritics, apostrophes, `&`→`and`; stopwords ignored (`the`, `a`, `an`, `and`, `of`, `to`, `in`, `on`, `by`, `for`) — "Final Empire" matches "The Final Empire"; number words / multi-letter roman numerals / leading zeros → digits; plurals and one-edit typos (words ≥6 chars) tolerated; numbers must match exactly.
- Title variants: full title, part after series prefix ("Mistborn: The Final Empire" → "Final Empire"), title minus series words; generic-only variants dropped unless the book is named after its series ("Dune").
- **Title match:** ≥80% of a variant's words present (`TITLE_MATCH_THRESHOLD`). Best match = coverage → more matched words (specificity: "Dune Messiah" beats "Dune") → nearest component.
- **Position match (series packs only):** explicit marker required — series name + number ("Mistborn 05") or book keyword ("Book 5", "Vol 5", "#5"). Never a bare number; numbers after chapter/track/disc/part ignored. Title matches always beat position matches.
- **Author packs:** title matches only.
- Matched books < 10 MB dropped (samples/intros).
- Unhelpful names (e.g. only "Disc 1…30") → no match → pack rejected (never guessed).

## Settings
| Key | Values | Default |
|---|---|---|
| `pack_search_enabled` | `true`/`false` | `true` |
| `pack_search_author_mode` | `disabled`/`log_only`/`enabled` | `log_only` |
- UI: Admin Settings → Indexers → "Series & Author Packs" (saves immediately). API: `GET/PUT /api/admin/settings/pack-search` `{ enabled, authorPackMode }`.

## Data
- `requests.last_pack_search_at` — throttle (~daily per request).
- `download_history.pack_files` (JSON string[]) — this request's files, relative to the torrent content root; `download_history.pack_type` — `series`/`author`.
- Rejected packs → `blacklisted_releases` (reasons `pack_missing_book`, `pack_no_metadata`), scoped to the triggering book (a "Books 1-3" pack rejected for book 5 stays eligible for book 2).

## Related Fixes (shipped with this feature)
- **organize():** `selectedFiles` filter now runs **before** the mixed-format dedup (a pack with book 1 m4b / book 3 mp3 previously imported nothing for book 3); selection is separator-agnostic; a local cover is only used if it sits beside the selected files (else Audible cover).
- **search-indexers:** skips if the request is already `downloading`/`processing`/`downloaded`/`available` (a queued search could clobber a pack-linked request).
- **qBittorrent:** `stopCondition` on add; `setFilePriority()`; pause/resume fall back to qBittorrent 5's `/torrents/stop`/`/torrents/start` on 404.
- **Audible series scraping:** `seriesPart` parsed for both layouts (`series-header="Book 1"` / legacy `h2`).

## Fixed: whole pack imported into one book (2026-10-09)
- **Cause:** Retry Failed Imports and the request "retry" action re-ran `organize_files` without `selectedFiles`, so a pack-linked book imported EVERY audio file of the pack (renamed `Title - 01/02/03`; the other books' files were unfinished placeholders from file priority 0 → unreadable). Seen in Sun Eater folders.
- **Fix:** `resolveImportSelection()` in `organize-files.processor.ts` — when no selection is passed, the request's selected `download_history.pack_files` is used; a pack with an empty list is refused (error) instead of imported whole. Covers every caller.
- **Clean-up of affected folders:** Library Merge job (misplaced exact copies of sibling books + unreadable leftovers) — see [chapter-merging.md](chapter-merging.md).

## Limitations
- qBittorrent only (other clients skip pack search).
- Books whose pack folder uses a different title (e.g. UK vs US title) won't match by title; series packs can still match by explicit position.

## Files
`src/lib/services/pack-search.service.ts`, `pack-sources.ts`, `pack-links.service.ts`, `src/lib/utils/pack-matcher.ts`, `pack-ranking.ts`, `pack-search-due.ts`, `src/lib/processors/search-packs.processor.ts`, `src/app/api/admin/settings/pack-search/route.ts`, `src/app/admin/settings/tabs/IndexersTab/PackSearchSection.tsx`

## Related
[features/watched-lists.md](watched-lists.md), [backend/services/scheduler.md](../backend/services/scheduler.md) (blacklist), [phase3/qbittorrent.md](../phase3/qbittorrent.md)
