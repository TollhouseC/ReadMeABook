# Recurring Jobs Scheduler

**Status:** ✅ Implemented

Manages recurring/scheduled jobs providing automated tasks (Plex scans, Audible refresh) with scheduled (cron) execution and manual triggering.

## Recent Updates

- Config validation before job execution
- Audible refresh persists to database
- Enhanced error handling with clear messages
- Schedule editing UI with toast notifications
- Human-friendly schedule descriptions and editor (preset/custom/advanced modes)
- Real-time cron expression preview

## Scheduled Jobs

1. **plex_library_scan** - Default: every 6 hours, full library scan, disabled by default (enable after setup)
2. **plex_recently_added_check** - Default: every 5 minutes, lightweight polling of top 10 recently added items, enabled by default
3. **audible_refresh** - Default: daily midnight, fetches 200 popular + 200 new releases, stores with rankings, disabled by default
4. **retry_missing_torrents** - Default: daily midnight, re-searches 'awaiting_search' status (limit 50), handles both audiobook and ebook requests, enabled by default. Also recovers requests stranded mid-pipeline by resetting to 'awaiting_search' and re-triggering search: 'downloading' after >2h stale (monitor bumps updatedAt every ≤5 min, so 2h = dead monitor job), and 'processing' after >8h stale (~2x the max chapter-merge time, so a valid in-progress merge is never interrupted) — 'processing' with a finished download (selected `download_history`) and no organize job in Bull goes to 'awaiting_import' + Retry Failed Imports (import redone, no re-download; `recoverInterruptedImports`); only those without a download are searched again. Recovery runs even when nothing awaits search (early return removed 2026-10-10).
5. **retry_failed_imports** - Default: every 6 hours, re-attempts 'awaiting_import' status (limit 50), enabled by default
6. **cleanup_seeded_torrents** - Default: every 30 mins, deletes torrents after seeding requirements met, respects `seeding_time_minutes` config (0 = never), enabled by default
7. **monitor_rss_feeds** - Default: every 15 mins, checks RSS feeds from enabled indexers, matches against 'awaiting_search' requests (audiobook and ebook, limit 100), triggers appropriate search jobs for matches, enabled by default
8. **check_stalled_downloads** - Default: daily noon (`0 12 * * *`), enabled by default. See **Stalled Download Detection** below.
9. **chapter_check_report** / **chapter_check_apply** - "Chapter Check (Report Only)" / "Chapter Fix (Apply)". Disabled by default (monthly `0 4 1 * *` if enabled); meant for Run Now. Queue `fix_chapters` library-wide with `mode` report/apply. See [features/chapter-merging.md](../../features/chapter-merging.md).

## Stalled Download Detection

**Why:** the download monitor never fails a stalled download (stall count only backs off polling, max 5 min) and keeps bumping `updatedAt`, so a dead torrent (no seeders) stays `downloading` forever and escapes the 2h stuck-download recovery.

**Processor:** `src/lib/processors/check-stalled-downloads.processor.ts`
- Scope: `DownloadHistory` with `selected=true`, `downloadStatus='downloading'`, non-`direct` client, request `status='downloading'` and not deleted.
- Per download, reads exact progress (0–1) from the client via `getDownload()`:
  - No baseline → store `stallCheckProgress` + `stallCheckedAt`.
  - Progress grew (> +0.0001) → move baseline forward.
  - No progress AND baseline ≥ 20h old (`MIN_STALL_WINDOW_MS`) → **stalled**: `blacklistRelease()`, mark `downloadStatus='blacklisted'` (before deleting, so the monitor stops quietly), `deleteDownload(id, deleteFiles=true)`, request → `pending` + `addSearchJob` / `addSearchEbookJob`.
  - `paused` / `queued` / `checking` → exempt; baseline cleared so tracking restarts when active.
  - Complete or missing from client → skipped (monitor handles those).
- Net effect: a stalled release is blacklisted 24–48h after it stops moving.

**Blacklist:** `BlacklistedRelease` table (see database.md), scoped to the **audiobook** so it survives re-requests (re-request deletes the old request + its download history). Utility: `src/lib/utils/release-blacklist.ts`.
- `filterBlacklistedResults(audiobookId, results)` runs before ranking in `search-indexers.processor.ts` and the ebook indexer search in `search-ebook.processor.ts`. All results blacklisted → normal "no results" path (`awaiting_search`).
- Match rules (any): info hash; indexer page URL / guid (`releaseUrl` vs `infoUrl`/`guid`); release title + indexer (case/whitespace-insensitive; title alone when entry has no indexer).
- Interactive search is not filtered (admins can still pick a blacklisted release deliberately).

**Monitor guard:** `monitor-download.processor.ts` exits early (`completed: true`) when its `DownloadHistory.downloadStatus === 'blacklisted'`; otherwise the removed torrent's "not found" would eventually mark the re-searched request `failed`.

## Architecture: Bull + Cron

- Repeatable jobs with cron expressions (Bull's built-in scheduler)
- Manual trigger capability
- Job persistence and retry logic
- Admin UI management
- Automatic scheduling/unscheduling when jobs enabled/disabled
- Schedule updates handled by unscheduling old job and scheduling new one

## Human-Friendly Scheduling UI

**Three Modes:**
1. **Common Schedules** - Preset options (every 15min, hourly, daily, weekly, monthly)
2. **Custom Schedule** - Visual builder with dropdowns for minutes/hours/daily/weekly/monthly
3. **Advanced (Cron)** - Raw cron expression for power users

**Features:**
- Human-readable display: "Every 6 hours" instead of "0 */6 * * *"
- Real-time preview of cron expressions
- Visual schedule builder (no cron knowledge required)
- Cron validation before saving
- Shows both human text and cron expression in job list

**Utility Functions** (`src/lib/utils/cron.ts`):
- `cronToHuman(cron)` - Converts cron to readable text
- `customScheduleToCron(schedule)` - Builds cron from visual inputs (auto-converts 24+ hour intervals to daily)
- `cronToCustomSchedule(cron)` - Parses cron to visual inputs
- `isValidCron(cron)` - Validates cron expression

## Cron Expressions

```
* * * * *
│ │ │ │ └─ day of week (0-7)
│ │ │ └─── month (1-12)
│ │ └───── day of month (1-31)
│ └─────── hour (0-23)
└───────── minute (0-59)
```

**Examples:**
- `0 */6 * * *` - Every 6 hours
- `0 0 * * *` - Daily midnight
- `*/30 * * * *` - Every 30 mins

## API Endpoints

**GET /api/admin/jobs** - Get all scheduled jobs (admin auth)

**POST /api/admin/jobs** - Create job (admin auth)
```json
{
  "name": "Daily Audible Refresh",
  "type": "audible_refresh",
  "schedule": "0 0 * * *",
  "enabled": true
}
```

**PUT /api/admin/jobs/:id** - Update job (admin auth)

**DELETE /api/admin/jobs/:id** - Delete job (admin auth)

**POST /api/admin/jobs/:id/trigger** - Manually trigger job (admin auth)

**GET /api/admin/jobs/:id/history?limit=50** - Job execution history (admin auth)

## Data Model

```typescript
interface ScheduledJob {
  id: string;
  name: string;
  type: JobType;
  schedule: string; // cron
  enabled: boolean;
  lastRun: Date | null;
  nextRun: Date | null;
  payload: any;
}
```

## Implementation Details

**Scheduler Service (`scheduler.service.ts`):**
- `start()`: Initializes scheduler, creates default jobs, schedules all enabled jobs
- `scheduleJob()`: Adds job to Bull as repeatable job with cron expression
- `unscheduleJob()`: Removes repeatable job from Bull
- `updateScheduledJob()`: Unschedules old job, updates DB, schedules new job if enabled
- `deleteScheduledJob()`: Unschedules job before deleting from DB

**Job Queue Service (`job-queue.service.ts`):**
- `addRepeatableJob()`: Registers job type with Bull's repeat scheduler
- `removeRepeatableJob()`: Removes job from Bull's repeat scheduler
- Processors for each scheduled job type call `scheduler.triggerJobNow()`
- `setMaxListeners(20)`: Set on both Redis client and Bull queue to accommodate 12 job processors (6 regular + 6 scheduled)

**Flow:**
1. App starts → `scheduler.start()` → schedules all enabled jobs
2. Bull triggers job at cron time → processor calls `triggerJobNow()`
3. `triggerJobNow()` executes job-specific logic (Plex scan, Audible refresh, etc.)
4. Updates `lastRun` timestamp in database

## Audible Refresh Processor

**Implementation:**
1. Fetch 200 popular + 200 new releases (multi-page scraping)
2. Download and cache cover thumbnails locally (stored in `/app/cache/thumbnails`)
3. Wipe and re-populate `AudibleCacheCategory` entries with reserved IDs (`__popular__`, `__new_releases__`) and user-configured category IDs
4. Upsert book metadata in `AudibleCache`, ranked entries in `AudibleCacheCategory`
5. Record sync timestamp (`lastAudibleSync`)
6. Clean up unused thumbnails (removes covers for audiobooks no longer in cache)
7. Perform fuzzy matching (70% threshold) against Plex library
8. Set `plexGuid` when match found (with duplicate protection)
9. Update `availabilityStatus` to 'available' or 'unknown'

**Duplicate PlexGuid Handling:** Since `plexGuid` has UNIQUE constraint, only first match gets assigned to prevent violations.

**Thumbnail Caching:** Downloads cover images from Audible and stores them locally to reduce external requests. Cached thumbnails are served via `/api/cache/thumbnails/[filename]` endpoint. Unused thumbnails are automatically cleaned up after each sync.

## Fixed Issues ✅

- ✅ Jobs running without config validation
- ✅ Default alert() popups → toast notifications
- ✅ No UI for editing schedules → added edit modal
- ✅ Audible data not persisting → saves to database
- ✅ Download progress logging ~500x/s → 10s delay
- ✅ Requests failing permanently (no torrents) → retry system with 'awaiting_search'
- ✅ Requests failing permanently (no files) → retry system with max 5 retries + 'warn' status
- ✅ Failed requests blocking re-requests → allow re-requesting failed/warn/cancelled
- ✅ Files deleted immediately → kept until seeding requirements met
- ✅ No seeding time config → added `seeding_time_minutes`
- ✅ Scheduled jobs not running on schedule → implemented Bull repeatable jobs with cron scheduling
- ✅ MaxListenersExceededWarning → increased maxListeners to 20 on both Redis client and Bull queue
- ✅ Cron expressions not user-friendly → added human-readable descriptions and visual schedule builder
- ✅ Scheduled jobs triggered by timer not appearing in system logs → Job records now created automatically for timer-triggered jobs
- ✅ Scheduled jobs triggered by timer not updating lastRun timestamp → Job queue now updates lastRun when processing timer-triggered jobs
- ✅ Daily cron patterns at non-midnight hours not recognized → Fixed `getIntervalFromCron` to parse any daily time (e.g., "0 4 * * *")
- ✅ "Every 24 hours" interval validation error → Auto-converts 24+ hour intervals to daily schedule (0 0 * * *)

## Tech Stack

- Bull repeatable jobs
- PostgreSQL (scheduled_jobs table)
- Bull/Redis infrastructure
