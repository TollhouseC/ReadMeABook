# Library Match Check

**Status:** ✅ Implemented | Finds Audiobookshelf items matched to the wrong Audible book; re-matches confident ones

## Overview
Old imports (e.g. from Plex) get fuzzy-matched by Audiobookshelf, sometimes to the wrong book (Wild Cards 27 → "Wild Cards I", The Last Hero → "Equal Rites"). This job checks every item and fixes or reports bad matches. Audiobookshelf backend only.

## Key Details
- **Job:** `match_library` (`src/lib/processors/match-library.processor.ts`); Jobs page "Library Match Check (Report Only)" / "(Apply)" (`library_match_report|apply`, off by default; progress/cancel/live log).
- **Same file listed twice** (`findDuplicateTracks`, `src/lib/services/abs-maintenance.ts`): for `too_long` items the ABS item (`GET /items/{id}`) is read; a file appearing more than once in `media.audioFiles` → `duplicate_tracks` ("Audiobookshelf lists the same file twice … remove the item with 'Delete from file system' unchecked, then Scan"; never delete a track — that deletes the file). ABS creates these after folder moves; its scans (even forced) don't remove the extra entry.
- **Force re-scan** (`forceRescanABS` → `POST /libraries/{id}/scan?force=1`, stored token): Jobs page "Audiobookshelf Force Re-Scan" (`abs_force_scan`, manual) and automatically after Library Organize (Apply) moves folders (falls back to the normal scan trigger off Audiobookshelf).
- **No audio** (no `media.duration`: ebook-only item, empty folder) → never checked or re-matched; listed once ("No audio — not checked").
- **Not found** lines show the current (wrong) match: title, author, ASIN, language when not English.
- **Data:** ABS `/libraries/{id}/items` (title, authorName, asin, `media.duration`, `relPath`). Audible runtimes of all matched ASINs via `AudibleService.getProductsByAsins` (catalog `/1.0/catalog/products?asins=…`, 50 per call). Audible search (`search`) only for suspects; 1 call/s (`matchTiming.delayMs`).
- **Suspect** (`findSuspects`, `src/lib/services/library-match.service.ts`):
  - `no_asin`
  - `length`: audio vs Audible runtime off by > max(10 min, 5%)
  - `title`: ABS title vs folder name similarity < 0.6 (folder variants: full, part after last " - "; brackets/"Unabridged"/leading article ignored)
  - `shared_asin`: same ASIN on folders with different titles
  - Skipped: alternate versions (Graphic Audio, dramatized, full cast, first drafts, non-canon, abridged, `{…}`).
- **Candidates** (`scoreCandidates`): search `"<folder title> <first author of author folder>"` (series prefix "Series 03 - " dropped); second title-only search when the first gives nothing usable; top 10 each, plus the current match. Kept only when in the release language (`release_language`; Audible `language`, no translator role, else title markers) and a real edition (summaries/guides/adapted/illustrated/abridged/dramatized/full cast/radio drama dropped unless the folder says so or the audio fits within max(2 min, 0.5%)). Score = title×2 + author (shares a person; roles like "- editor" ignored) + length (ok 1.5 / close 0.5). Title compare also uses the candidate's main title (before ":" / "("). Length ok ≤ max(5 min, 3%), off > max(10 min, 5%).
- **Decision** (`decideMatch`) — editions of the folder's book = candidates with title ≥ 0.8 + author, closest length first:
  - An edition fits the length → `ok` if it's the current match, else `confident` (re-match).
  - Folder's book known but the audio is exactly another book's length (sibling by the author, or the current match whose title doesn't fit the folder) → `wrong_audio` (e.g. Poppy War 03 holding book 2). Exception: a sibling coincidence (ABS's own match/title fits the folder) where the audio also fits an edition range of the folder's book → `unsure` ("another edition, or the wrong book?", e.g. Alcatraz 4h52 = a Bastille edition).
  - Current match is another-language edition → `confident` (English edition, closest length).
  - Right book, audio/runtime ratio 0.7–1.43 → `edition` (fine: another narration/recording; summarised in one line, not listed). Current match is a different book → `confident` to the folder's book.
  - Ratio ≤ 0.55 → `too_short` (incomplete/abridged file — re-download); ≥ 1.8 → `too_long` (duplicate copies, several books in one file, or Audible only sells a shorter edition). Exactly 2× / ½ (±4%, `isDoubleOrHalf`) → message adds "bad length header, broken file or doubled content" + a `docker exec … ffmpeg -f null` command printing each file's decoded length (folder = media_dir + ABS relPath).
  - `too_long` single-file books: chapters probed (`analyzeChapters`): 2–12 chapters each ≥ half the book → "chapters look like separate books" (box set, with start times); chapter number restarting at ≤1 after ≥5, or the first title repeating → "numbering starts over at H:MM:SS — probably the book twice". Several audio files → count shown.
  - Otherwise → `unsure` (editions listed); no title+author match at all → `not_found` (e.g. novellas only sold in collections).
  - No audio length (no ASIN) → `confident` to the folder's book.
- Apply re-matches `confident` only: `triggerABSItemMatch(itemId, asin)` (`POST /items/{id}/match`, `overrideDefaults`) — rewrites that item's metadata (and `metadata.json` with "Store metadata with item").
- **Result:** `{ checked, suspects, ok, other_edition, would_rematch, rematched, wrong_audio, too_short, too_long, unsure, not_found, failed }`.

## Related: [phase3/file-organization.md](../phase3/file-organization.md) (Library Organize), [features/chapter-merging.md](chapter-merging.md) (Library Merge), [backend/services/jobs.md](../backend/services/jobs.md)
