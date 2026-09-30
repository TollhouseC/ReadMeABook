# Watched Lists (Series & Authors)

**Status:** ✅ Implemented | Auto-request new releases from watched series/authors, one version per book by default

## Overview
Users watch an Audible series or author; a nightly job scrapes it and auto-requests books not yet on the server. Multiple versions of the same book (dramatized, full cast, other narrators) are collapsed to one unless a watched series opts into alternate versions (admin-approved, imported as their own series).

## Key Details
- **Job:** `check_watched_lists` — daily midnight; also triggered immediately when a user adds a watch or enables alternate versions (`addCheckWatchedItemJob`).
- **Flow (per series/author):** scrape (`scrapeSeriesPage` / author search) → `deduplicateAndCollectGroups` (same recording re-listings) → `planVersionRequests` (versions of the same book) → `createRequestForUser`.
- **Series scraping** supports both Audible layouts (legacy `.productListItem` and `<adbl-product-row>`) — see [integrations/audible.md](../integrations/audible.md).

## Duplicate Versions
- **Two dedup layers:**
  1. `deduplicate-audiobooks.ts` — same *recording* (title + narrator + duration). Collapses publisher re-listings (e.g. US/UK editions).
  2. `book-versions.ts` — same *work* (all versions). Catches dramatizations, full-cast, abridged, other narrators.
- **Work key:** title with version markers stripped (in brackets or as a subtitle: dramatized/dramatization, full cast, abridged, unabridged, edition, version, audio/radio drama, graphic audio) but the real subtitle kept, + primary author. "Halo: The Fall of Reach" ≠ "Halo: Ghosts of Onyx".
- **Split parts:** "N of M" part markers are stripped too — `(Part 1 of 2)`, `(1 of 3)`, `[Book 2 of 3]`, `(Pt. 1/2)`, trailing `, Part 1 of 2` — so a production split into parts (e.g. GraphicAudio "Golden Son (Part 1 of 2) (Dramatized Adaptation)") groups with the standard "Golden Son". A bare "Part 2" is kept (can be a separate book).
- **Fixed (2026-09-30):** split dramatization parts were keyed as separate books (the "N of M" marker stayed in the key), so each was auto-requested despite the standard version being owned.
- **Preferred version:** standard narration (no dramatized/full-cast/abridged marker, incl. "Full Cast" narrator) → highest rating → listing order.
- **Planner** (`src/lib/services/watched-lists-versions.ts`, pure) — per work:

| Situation | Alternates OFF (default) | Alternates ON |
|---|---|---|
| This ASIN in library | skip (owned) | skip (owned) |
| This ASIN has active request | skip (requested) | skip (requested) |
| No version exists, preferred version | request | request |
| No version exists, other version | skip (duplicate version) | request, admin approval, labelled |
| Another version owned/requested | skip (duplicate version) | request, admin approval, labelled |

- **"Owned"** = ASIN in `plex_library`, works-table sibling ASIN in library, OR a library item with the same work key by the same primary author (`getOwnedWorkKeys` — catches a copy under an ASIN not in the listing).
- **"Requested"** = active audiobook request, any user (`getRequestedAsins`; excludes failed/warn/cancelled/denied, so those retry).
- **Authors** always use alternates OFF (opt-in is per series).

## Alternate Versions (per-series opt-in)
- **Field:** `watched_series.allow_alternate_versions` (bool, default false). Toggle in Profile → Watched Series card.
- **API:** `PATCH /api/user/watched-series/[id]` `{ allowAlternateVersions: boolean }` (owner only). Enabling triggers an immediate check.
- **Requests:** `createRequestForUser(userId, input, { forceApproval: true, versionLabel })` → always `awaiting_approval` (even admins / auto-approve users) + `request_pending_approval` notification. Admin approval card shows "Alternate version · <label>".
- **Version label** (`audiobooks.version_label`): intrinsic marker ("Dramatized Adaptation", "Full Cast", "Abridged"), else "Narrated by <first narrator>", else "Alternate Version". The preferred version requested because another version exists stays unlabelled (main series) unless intrinsically non-standard.
- **Import:** `applyVersionLabel()` in `organize()` / `organizeEbook()` → series "Series (Label)" and title "Title (Label)" (title unchanged if it already contains the label). Affects folder path, embedded tags (SERIES/show), merged filename, rename template — so Audiobookshelf shows it as its own series and same-title narration variants can't share a folder.

## Stats (job result)
`seriesChecked`, `authorsChecked`, `booksFound`, `requestsCreated`, `skippedOwned`, `skippedExisting`, `skippedDuplicateVersion`, `alternateVersionsQueued`, `errors`. Each duplicate-version skip is logged with title + ASIN.

## API
| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/user/watched-series` | List (incl. `allowAlternateVersions`) |
| POST | `/api/user/watched-series` | Watch `{ seriesAsin, seriesTitle, coverArtUrl? }` |
| PATCH | `/api/user/watched-series/[id]` | Update `{ allowAlternateVersions }` |
| DELETE | `/api/user/watched-series/[id]` | Unwatch |
| GET/POST | `/api/user/watched-authors` | List / watch authors |

## Files
- Service: `src/lib/services/watched-lists.service.ts`
- Version planner: `src/lib/services/watched-lists-versions.ts`
- Version detection + labelling: `src/lib/utils/book-versions.ts`
- Processor: `src/lib/processors/check-watched-lists.processor.ts`
- UI: `src/components/profile/WatchedListsSection.tsx`, `src/components/ui/WatchButton.tsx`
- Hooks: `src/lib/hooks/useWatchedSeries.ts`, `src/lib/hooks/useWatchedAuthors.ts`

## Related
[integrations/audible.md](../integrations/audible.md), [admin-features/request-approval.md](../admin-features/request-approval.md), [phase3/file-organization.md](../phase3/file-organization.md)
