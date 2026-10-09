# Library Match Check

**Status:** ✅ Implemented | Finds Audiobookshelf items matched to the wrong Audible book; re-matches confident ones

## Overview
Old imports (e.g. from Plex) get fuzzy-matched by Audiobookshelf, sometimes to the wrong book (Wild Cards 27 → "Wild Cards I", The Last Hero → "Equal Rites"). This job checks every item and fixes or reports bad matches. Audiobookshelf backend only.

## Key Details
- **Job:** `match_library` (`src/lib/processors/match-library.processor.ts`); Jobs page "Library Match Check (Report Only)" / "(Apply)" (`library_match_report|apply`, off by default; progress/cancel/live log).
- **Data:** ABS `/libraries/{id}/items` (title, authorName, asin, `media.duration`, `relPath`). Audible runtimes of all matched ASINs via `AudibleService.getProductsByAsins` (catalog `/1.0/catalog/products?asins=…`, 50 per call). Audible search (`search`) only for suspects; 1 call/s (`matchTiming.delayMs`).
- **Suspect** (`findSuspects`, `src/lib/services/library-match.service.ts`):
  - `no_asin`
  - `length`: audio vs Audible runtime off by > max(10 min, 5%)
  - `title`: ABS title vs folder name similarity < 0.6 (folder variants: full, part after last " - "; brackets/"Unabridged"/leading article ignored)
  - `shared_asin`: same ASIN on folders with different titles
  - Skipped: alternate versions (Graphic Audio, dramatized, full cast, first drafts, non-canon, abridged, `{…}`).
- **Candidates** (`scoreCandidates`): search `"<folder title> <first author of author folder>"` (series prefix "Series 03 - " dropped), fallback title only; top 10. Score = title×2 + author (shares a person, `author-identity.ts`) + length (ok 1.5 / close 0.5). Length ok ≤ max(5 min, 3%), off > max(10 min, 5%).
- **Decision** (`decideMatch`):
  - Candidate with title ≥ 0.8 + author + length ok → `confident` (or `ok` if it's the current ASIN). Apply → `triggerABSItemMatch(itemId, asin)` (`POST /items/{id}/match`, `overrideDefaults`) — rewrites that item's metadata (and `metadata.json` with "Store metadata with item").
  - Title + author match but length doesn't, and another book by the author (or the current match, whose title doesn't fit the folder) has the audio's length → `wrong_audio` ("re-download"; e.g. Poppy War 03 holding book 2, HWFwM 1 holding book 4). Never re-matched.
  - Otherwise → `unsure` with top 3 candidates (title, author, ASIN, length) — fix with Match in ABS.
- **Result:** `{ checked, suspects, ok, would_rematch, rematched, unsure, wrong_audio, failed }`.

## Related: [phase3/file-organization.md](../phase3/file-organization.md) (Library Organize), [features/chapter-merging.md](chapter-merging.md) (Library Merge), [backend/services/jobs.md](../backend/services/jobs.md)
