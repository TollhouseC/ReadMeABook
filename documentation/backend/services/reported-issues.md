# Reported Issues

**Status:** ✅ Implemented | Users report problems with library books; admins dismiss or replace them

## Overview
"Report issue" on an available book (details modal) creates a `ReportedIssue`; admins see open issues on the admin dashboard and either dismiss it or **Replace** (pick a new release → old copy deleted, new download started).

## Key Details
- **Report** `POST /api/audiobooks/{asin}/report-issue` `{ reason (≤250), title?, author?, coverArtUrl? }` → `reportIssue` (`src/lib/services/reported-issue.service.ts`). 409 if an open issue exists for the book, 404 if not in the library.
- **In library?** (`findLibraryCopy`) — same rules as the book page: exact ASIN (`findPlexMatch`) → Audible edition grouping (works table, `getSiblingAsins` → `plex_library`) → another edition with the same title + shared author, same version type (`findOwnedEdition`). An `Audiobook` record is found/created for the reported ASIN and **linked to the library item found** (`absItemId` on Audiobookshelf, `plexGuid` on Plex) when not already linked.
- **Replace** (`replaceAudiobook`):
  - Book has a ReadMeABook request → `deleteRequest(..., { deleteMedia: true })` (torrents, files, library item).
  - No request (added outside ReadMeABook) → `deleteFromLibrary`: book folder deleted, then ABS/Plex item and `plex_library` rows.
  - Then the record is reset, a new request created (admin, no approval) and `addDownloadJob` queued with the chosen release; issue → `replaced`.
- **Book folder** (`src/lib/services/library-folder.ts`, shared with request delete-with-media): `resolveLibraryFolder` = recorded `filePath` (its folder if a file) → ABS item `media_dir + relPath` (books never requested, folders moved since import) → path template. `removeBookFolder` deletes recursively only a single book's folder: inside `media_dir`, ≥ Author/Book deep, no non-disc subfolder containing audio (refuses author/series folders and folders holding other books); refusal → logged, nothing deleted.
- Notifications: `issue_reported` queued on report.

## Fixed Issues
- **2026-10-10:** reports were refused ("not currently in your library") for books owned under a different ASIN (re-issues, other editions) although the page showed them as in the library; Replace for books never requested in ReadMeABook removed only the ABS item and left the broken files on disk; request delete-with-media found folders by template only (missed moved folders) and removed them without checking they held a single book.

## Related: [admin-features/request-deletion.md](../../admin-features/request-deletion.md), [integrations/audible.md](../../integrations/audible.md) (other-edition matching)
