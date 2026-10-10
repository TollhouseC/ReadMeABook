# File Organization System

**Status:** ✅ Implemented

Copies completed downloads to standardized directory structure for Plex. Automatically tags audio files with correct metadata. Originals kept for seeding, cleaned up by scheduled job after requirements met.

## Target Structure

Target directory read from database config `media_dir` (configurable in setup wizard and settings).

**Template-based organization:**
- Config key: `audiobook_path_template`
- Default: `{author}/{title} {asin}`
- Variables: `{author}`, `{title}`, `{narrator}`, `{asin}`, `{year}`
- Optional variables (narrator, asin, year) are removed if not available

**Examples:**
```
Template: {author}/{title} {asin}
Result: Douglas Adams/The Hitchhiker's Guide to the Galaxy B0009JKV9W/

Template: {author}/{title} ({year})
Result: Douglas Adams/The Hitchhiker's Guide to the Galaxy (2005)/

Template: {author}/{narrator}/{title}
Result: Douglas Adams/Stephen Fry/The Hitchhiker's Guide to the Galaxy/
```

**Legacy behavior (hardcoded):**
- With year and ASIN: `Book Title (Year) ASIN`
- With ASIN only: `Book Title ASIN`
- With year only: `Book Title (Year)`
- Fallback: `Book Title`

**Rationale:** Template system allows customization for different metadata agent configurations and user preferences while maintaining backward compatibility.

## Library Layout Guard
- **Why:** Audiobookshelf treats everything under a folder containing audio as ONE book. A series named like a book stored without a series (e.g. "The Academy" book 1 at `Author/The Academy/`) made book 2 land at `Author/The Academy/The Thoroughbreds/` → ABS merged it into book 1 → RMAB cancelled the request as removed.
- **On import** (`resolveCollisionFreeTarget` in `src/lib/utils/library-layout.ts`, called by `organize()`):
  - Target inside an existing book folder → that book's top-level files move to `<folder>/<folder name>/` first (`moveBookIntoOwnSubfolder`); `OrganizationResult.movedExisting` → organize processor updates `Audiobook.filePath`.
  - Target folder already holds other books in subfolders → import into `<target>/<folder name>/`.
  - Disc folders (`CD1`, `Disc 2`, `Part 3`) are not separate books.
- **Library-wide:** Jobs page → "Library Layout Check (Report Only)" / "Library Layout Fix (Apply)" (`library_layout_report|apply` → `fix_library_layout` job, `src/lib/processors/fix-library-layout.processor.ts`). `findNestedBooks` lists book folders containing other books; apply moves the outer book down, updates `filePath`, triggers scan.

## Library Organize (one folder per author, series together)
- **Why:** the same author ended up in several folders: Audible spellings vs Audiobookshelf/`metadata.json` (`Shirtaloon, Travis Deverell` vs `Travis Deverell Shirtaloon`), comma spacing/order (`Lucy Score,Claire Kingsley`), initials (`William H. Gass`), and co-written series whose books list different author combinations (Bootleg Springs). External organizers (audiobook-organizer) made it worse.
- **Author identity** (`src/lib/utils/author-identity.ts`): person = set of name words (lowercase, accents/punctuation removed, 1-letter initials dropped). `"Last, First"` (2 comma parts, first one word) = one person; else `,` `&` `and` `;` split people. `authorSetKey`, `sharesPerson`, `seriesKey` (drops leading "The"). `SpellingRegistry`: ReadMeABook records weight 3, Audiobookshelf metadata + folder names weight 1; ties prefer `A, B` over `A,B`.
- **Plan** (`src/lib/services/library-organize.service.ts`, pure): only moves book folders, never renames them.
  - Author folder → canonical spelling of the book's authors. Series groups = same series key connected by a shared person (Halo by different authors stays separate); key = the series folder the book already sits in (`Author/Series/Book`), else Audible's series name (so books Audible files under different series but kept in one folder — Ender Saga / Formic Wars — stay together). A group with several author combinations goes under its **lead person** (on most books; ties: listed first more often, then alphabetical).
  - **Anthologies:** 3+ authors (metadata or folder name, `ANTHOLOGY_AUTHORS`) → never moved and never link authors into a group (in The Horus Heresy anthologies chained every author into one group under Graham McNeill). Counted in the summary line.
  - Series folder (template contains `{series}`) → added when missing; group's most common existing spelling (`Sun Eater` / `The Sun Eater` merged). Deeper middle paths untouched.
  - Never moved: alternate versions (`versionLabel`, Graphic Audio, dramatized, full cast, first drafts, non-canon, `{…}`), books outside an author folder, metadata author sharing nobody with the folder (bad ABS match → "check its match"), targets inside the book itself, two books → one target.
- **Job** `organize_library` (`src/lib/processors/organize-library.processor.ts`; Jobs page "Library Organize (Report Only)" / "(Apply)", `library_organize_report|apply`, off by default; progress/cancel/live log). Template must start with `{author}`. Candidates = `collectCandidates` (ReadMeABook imports + ABS items); metadata from ReadMeABook record (by id/ASIN) else ABS. Recorded folders without audio ignored.
  - Per move blocked when: folder holds another book (non-disc subfolder with audio), target exists and isn't empty, or an ancestor of the target is a book folder.
  - Apply: `mkdir` parent → `rename` (empty leftover target removed first) → `Audiobook.filePath` updated (by old path, audiobook id, `absItemId`) → empty parents removed (`removeEmptyParentDirectories`, boundary media_dir) → undo log `${CONFIG_DIR:-/app/config}/organize-undo/undo-YYYYMMDD-HHMMSS.json` (`[{from,to,title,movedAt}]`, all kept — ~300 bytes per move) → library scan.
- **Import** (`src/lib/utils/series-home.ts` → `findLibraryHome`, used by `organize()` when template starts with `{author}`): an author folder sharing a person with the book that already holds the series (most books) → reuse its author + series folder names; else a folder for exactly these authors spelled differently → reuse it.

## Shared Download Folders & Multi-Book Guard
- **Torrent's own files** (`src/lib/utils/torrent-own-files.ts`, called from `resolveImportSelection` in `organize-files.processor.ts`): torrents from one uploader can share a top folder (`/downloads/Sun Eater (Christopher Ruocchio)/` held 3 single-book torrents) → each import copied every book. Non-pack torrent imports with ≥2 audio files ask the client (`IDownloadClient.getDownloadFiles`, qBittorrent/Transmission/Deluge) for the torrent's files, strip its top folder, and import only those when the folder also holds other audio. Logs `Shared download folder — importing only this torrent's N audio file(s)…`. Client unreachable / torrent removed / no overlap → folder imported as before (warn). Pack selection and explicit `selectedFiles` take precedence.
- **Multi-book guard** (`src/lib/utils/multi-book-guard.ts`, in `FileOrganizer.organize()` after selection + format dedup): total probed audio > **1.8×** the Audible runtime (`MULTI_BOOK_RATIO`) → import refused: `Download holds Xh of audio but "Title" is Yh on Audible — it looks like several books…`. No ASIN/runtime → no check. Catches whole-series torrents for one book (HWFwM 10 imported books 2–10 from `/downloads/He Who Fights with Monsters - Shirtaloon`).

## Process

1. Download completes in `/downloads/[torrent-name]/` or `/downloads/[filename]` (single file)
1b. **Path stored** in `DownloadHistory.downloadPath` (mapped local path) for retry reliability — avoids reconstructing path from `torrentName` which may differ from actual folder name
2. Identify audiobook files (.m4b, .m4a, .mp3, .mp4, .aa, .aax, .flac, .ogg) - supports both directories and single files
3. Read media directory and path template from database config (`media_dir`, `audiobook_path_template`)
4. Apply template to create target path: `[media_dir]/[template result]/`
5. **Copy** files (not move - originals stay for seeding)
6. **Tag metadata** (if enabled) - writes correct title, author, narrator, ASIN to audio files
7. Copy cover art if found, else download from Audible
8. **Generate file hash** - SHA256 of sorted audio filenames for library matching (see: [fixes/file-hash-matching.md](../fixes/file-hash-matching.md))
9. Update request status to `downloaded` and store file hash in `audiobooks.files_hash`
10. **Trigger filesystem scan** (if enabled) - tells Plex/ABS to scan for new files
11. Originals remain until seeding requirements met

## Filesystem Scan Triggering

**Status:** ✅ Implemented (Both Backends)

**Purpose:** Trigger Plex/Audiobookshelf to scan filesystem after organizing files, ensuring new books appear immediately for users with disabled filesystem watchers.

**Configuration:**
- Plex: `plex.trigger_scan_after_import` (boolean, default: false)
- Audiobookshelf: `audiobookshelf.trigger_scan_after_import` (boolean, default: false)

**Flow:**
1. Files organized to media directory
2. Request status updated to `downloaded`
3. Check config setting (backend-specific)
4. If enabled: Call `ILibraryService.triggerLibraryScan(libraryId)`
5. Media server scans filesystem (async operation)
6. RMAB's scheduled check eventually detects new book
7. Request status updates to `available`

**Implementation:**
- Uses existing `ILibraryService` abstraction
- `PlexLibraryService.triggerLibraryScan()` → `POST /library/sections/{id}/refresh`
- `AudiobookshelfLibraryService.triggerLibraryScan()` → `POST /api/libraries/{id}/scan`
- Called from `organize-files.processor.ts` after status update
- Backend-agnostic using factory pattern

**Error Handling:**
- Scan failures logged but don't fail organize job
- Graceful degradation: scheduled scans eventually detect the book
- Non-blocking: async operation doesn't delay other jobs

**Use Cases:**
- Users with Plex/ABS filesystem watcher disabled
- Network-mounted media directories with delayed inotify
- Users who prefer manual control over automatic scanning
- Most users keep this disabled (default) and rely on built-in watchers

## Metadata Tagging

**Status:** ✅ Implemented

**Purpose:** Automatically writes correct metadata to audio files during file organization to improve Plex matching accuracy.

**Supported Formats:**
- m4b, m4a, mp4 (AAC audiobooks)
- mp3 (ID3v2 tags)
- flac (Vorbis comment tags)

**Metadata Written:**
- `title` - Book title
- `album` - Book title (PRIMARY field for Plex matching)
- `album_artist` - Author (PRIMARY field for Plex matching)
- `artist` - Author (fallback)
- `composer` - Narrator (standard audiobook field)
- `date` - Year
- `ASIN` - Audible ASIN (custom tag)
  - M4B/M4A/MP4: `----:com.apple.iTunes:ASIN`
  - MP3: Custom ID3v2 tag

**Note:** ASIN is a custom metadata tag and may not appear in standard file properties viewers (Windows/macOS/Linux). Use specialized tools to verify:
```bash
# Verify ASIN metadata with ffprobe
ffprobe -v quiet -print_format json -show_format "audiobook.m4b" | grep -i asin

# Or use exiftool
exiftool "audiobook.m4b" | grep -i asin
```

**Configuration:**
- Key: `metadata_tagging_enabled` (Configuration table)
- Default: `true`
- Configurable in: Setup wizard (Paths step), Admin settings (Paths tab)

**Implementation:**
- Uses ffmpeg with `-codec copy` (no re-encoding, metadata only)
- Fast (no audio transcoding)
- Lossless (original audio preserved)
- Runs after file copy, before cover art download
- Non-blocking (errors don't fail file organization)
- Logs success/failure per file

**Benefits:**
- Fixes torrents with missing/incorrect metadata
- Ensures Plex can match audiobooks correctly
- Writes metadata from Audible/Audnexus (known accurate)
- Prevents "[Various Albums]" and other metadata issues
- Embeds ASIN directly in audio files for better identification and matching

**Tech Stack:**
- ffmpeg (system dependency - included in Docker image)
- `src/lib/utils/metadata-tagger.ts` - Tagging utility
- Integrated into `src/lib/utils/file-organizer.ts`

**Requirements:**
- ffmpeg must be installed in the container
- **Multi-container setup** (`Dockerfile`): Added at line 56 via `apk add ffmpeg`
- **Unified setup** (`dockerfile.unified`): Added at line 16 via `apt-get install ffmpeg`
- **Verify installation:**
  - Multi-container: `docker exec readmeabook ffmpeg -version`
  - Unified: `docker exec readmeabook-unified ffmpeg -version`

## Seeding Support

**Config:** `seeding_time_minutes` (0 = unlimited, never cleanup)

**Cleanup Job:** `cleanup_seeded_torrents` (every 30 mins)
1. Find requests with status 'available' or soft-deleted (orphaned downloads)
2. Query qBittorrent for actual `seeding_time` field
3. **CRITICAL: Check if torrent hash is shared by other active requests**
   - If yes → Skip torrent deletion, only hard-delete the soft-deleted request record
   - If no → Delete torrent + files
4. Delete torrent + files only after seeding requirement met
5. Respects config (0 = never cleanup)

**Shared Torrent Protection:**
When user deletes and re-requests the same audiobook:
- Both requests share the same torrent hash (same files)
- Cleanup finds old soft-deleted request
- Before deleting torrent, checks if any active (non-deleted) request uses same hash
- If found → Keeps torrent, only removes soft-deleted database record
- Prevents deleting source files for active requests during chapter merging

## Interface

```typescript
interface OrganizationResult {
  success: boolean;
  targetPath: string;
  filesMovedCount: number;
  errors: string[];
  audioFiles: string[];
  coverArtFile?: string;
}

async function organize(
  downloadPath: string,
  audiobook: {title: string, author: string, year?: number, coverArtUrl?: string, asin?: string}
): Promise<OrganizationResult>;
```

## Path Sanitization

- Remove invalid chars: `<>:"/\|?*`
- Trim dots/spaces
- Collapse multiple spaces
- Limit to 200 chars
- Example: `Author: The <Best>! Book?` → `Author The Best! Book`

## Configuration

- **Media directory:** Read from database config key `media_dir` (set in setup wizard or settings)
- **Path template:** Read from database config key `audiobook_path_template` (default: `{author}/{title} {asin}`)
- **Metadata tagging:** `metadata_tagging_enabled` (boolean, default: true)
- **Chapter merging:** `chapter_merging_enabled` (boolean, default: false)
- **Fallback:** `/media/audiobooks` if media_dir not configured
- **Temp directory:** `/tmp/readmeabook` (or `TEMP_DIR` env var)

## Fixed Issues ✅

**1. EPERM errors** - Fixed with stream-based copy (`pipeline` + `createReadStream`/`createWriteStream`) instead of `fs.copyFile()` which uses `copy_file_range()` — a syscall that returns EPERM on cross-export NFS4 and some FUSE mounts
**2. Immediate deletion** - Changed to copy-only, scheduled cleanup after seeding
**3. Files moved not copied** - Now copies to support seeding
**4. Single file downloads** - Now supports files directly in downloads folder (not just directories)
**5. Hardcoded media path** - Now reads `media_dir` from database config instead of hardcoded `/media/audiobooks`
**6. Invalid URL error for cached cover art** - Fixed by detecting local cached thumbnails (`/api/cache/thumbnails/*`) and copying from `/app/cache/thumbnails/` instead of attempting HTTP download
**8. Leftover file blocking an import** - A file already at the target with the same name was always skipped ("already exists"), so a broken/half-written leftover kept the new download out. Now: same size → skip (an earlier attempt copied it); different size → replaced, writing `<name>.partial` then renaming so a failed copy never destroys the old file
**7. Several books imported into one book folder** - Shared torrent folders now import only the torrent's files; >1.8× runtime imports refused (see Shared Download Folders & Multi-Book Guard)

## Tech Stack

- Node.js `fs/promises`
- `path` module
- axios (cover art download)
