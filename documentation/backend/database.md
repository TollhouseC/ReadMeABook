# Database Schema

**Status:** ✅ Implemented

PostgreSQL database storing users, audiobooks, requests, downloads, configuration, and jobs.

**Setup:** Automatically created on container startup via `prisma db push` (syncs schema directly to DB without migration files).

## Tables

### Users
- `id` (UUID PK), `plex_id` (unique), `plex_username`, `plex_email`, `role` ('user'|'admin')
- `is_setup_admin` (bool, default false) - First admin created during setup, role protected from changes
- `avatar_url`, `auth_token` (encrypted), `created_at`, `updated_at`, `last_login_at`
- **Plex Home profile tracking:**
  - `plex_home_user_id` (string, nullable) - Profile ID from Plex Home (null = main account, set = home profile)
- **Request approval control:**
  - `auto_approve_requests` (bool, nullable, default null) - Per-user override for request approval
    - `null` = Use global setting (Configuration.auto_approve_requests)
    - `true` = Always auto-approve this user's requests
    - `false` = Always require admin approval for this user's requests
- **BookDate per-user preferences:**
  - `bookdate_library_scope` ('full'|'rated', default 'full') - Library scope for recommendations
  - `bookdate_custom_prompt` (text, optional, max 1000 chars) - Custom preferences for AI
  - `bookdate_onboarding_complete` (bool, default false) - Whether user has completed BookDate onboarding
- Indexes: `plex_id`, `role`

### Audible_Cache
- `id` (UUID PK), `asin` (unique, Audible ID), `title`, `author`, `narrator`, `description`
- `cover_art_url`, `cached_cover_path` (local thumbnail path), `duration_minutes`, `release_date`, `rating`, `genres` (JSONB)
- **Discovery:** `is_popular` (bool), `is_new_release` (bool), `popular_rank`, `new_release_rank`
- `last_synced_at`, `created_at`, `updated_at`
- Indexes: `asin`, `title`, `author`, `is_popular`, `is_new_release`, `popular_rank`, `new_release_rank`
- **Purpose:** Cached Audible metadata (popular/new releases), thumbnails stored locally in `/app/cache/thumbnails`

### Plex_Library (Library Cache)
- `id` (UUID PK), `plex_guid` (unique, external ID from Plex or Audiobookshelf), `plex_rating_key`
- `title`, `author`, `narrator`, `summary`, `duration` (milliseconds), `year`, `user_rating` (0-10 scale)
- **Universal identifiers:** `asin` (Audible ASIN), `isbn` (ISBN-10 or ISBN-13)
- `file_path`, `thumb_url`, `cached_library_cover_path` (local cached cover path), `plex_library_id`, `added_at`
- `last_scanned_at`, `created_at`, `updated_at`
- Indexes: `plex_guid`, `title`, `author`, `plex_library_id`, `asin`, `isbn`
- **Purpose:** Universal library cache for both Plex and Audiobookshelf backends
- **ASIN/ISBN fields:** Enable accurate matching across backends
  - **Plex:** ASIN extracted from Plex GUID (e.g., `com.plexapp.agents.audible://B00ABC123`) + stored in dedicated field
  - **Audiobookshelf:** ASIN/ISBN retrieved directly from ABS metadata + stored in dedicated fields
  - **Matching:** Prioritizes exact ASIN/ISBN matches (100% confidence) before fuzzy title/author matching
- **Cached cover path:** Local path to cached library cover (e.g., `/app/cache/library/{hash}.jpg`), populated during scans

### Audiobooks
- `id` (UUID PK), `audible_asin` (nullable), `title`, `author`, `narrator`, `description`
- `cover_art_url`, `file_path`, `file_format`, `file_size_bytes`
- `plex_guid` (nullable), `plex_library_id` (nullable), `abs_item_id` (nullable), `abs_matched_at` (nullable; ABS item matched to the requested edition after import — [file-organization.md](../phase3/file-organization.md#import-edition-match-audiobookshelf))
- `files_hash` (nullable) - SHA256 hash of sorted audio filenames for library matching
- `version_label` (nullable) - alternate-version label (e.g. "Dramatized Adaptation"); appended to series + title at import (see [features/watched-lists.md](../features/watched-lists.md))
- `status` ('requested'|'downloading'|'processing'|'completed'|'failed')
- `created_at`, `updated_at`, `completed_at`
- Indexes: `audible_asin`, `plex_guid`, `abs_item_id`, `files_hash`, `title`, `author`, `status`
- **Purpose:** User-requested audiobooks only (created on request)
- **File Hash Matching:** `files_hash` enables 100% accurate ASIN matching for RMAB-organized content in ABS library scans (see: [fixes/file-hash-matching.md](../fixes/file-hash-matching.md))

### Requests
- `id` (UUID PK), `user_id` (FK), `audiobook_id` (FK)
- `status` ('pending'|'searching'|'downloading'|'processing'|'downloaded'|'available'|'failed'|'cancelled'|'awaiting_search'|'awaiting_import'|'warn'|'awaiting_approval'|'denied')
  - **Approval flow:** awaiting_approval → (approve) → pending → searching → downloading → processing → downloaded → available
  - **Denial flow:** awaiting_approval → (deny) → denied
  - **awaiting_approval** - Request pending admin approval (only if auto-approve disabled)
  - **denied** - Request rejected by admin (terminal state)
  - **pending** - Request approved and queued for processing
- `progress` (0-100), `priority`, `error_message`
- `search_attempts`, `download_attempts`, `import_attempts`, `max_import_retries` (default 5)
- `last_search_at`, `last_import_at`, `created_at`, `updated_at`, `completed_at`
- `last_pack_search_at` — throttles series/author pack searches to ~daily (see [features/series-packs.md](../features/series-packs.md))
- Unique: `(user_id, audiobook_id)`
- Indexes: `user_id`, `audiobook_id`, `status`, `created_at DESC`

### Download_History
- `id` (UUID PK), `request_id` (FK), `indexer_name`, `torrent_name`, `torrent_hash`
- `torrent_size_bytes`, `magnet_link`, `torrent_url`, `seeders`, `leechers`
- `quality_score`, `selected` (bool), `download_client`, `download_client_id`
- `download_status` ('queued'|'downloading'|'completed'|'failed'|'stalled'|'blacklisted')
- `download_error`, `started_at`, `completed_at`, `created_at`
- `stall_check_progress` (float 0–1), `stall_checked_at` — baseline for check_stalled_downloads (see services/scheduler.md)
- `pack_files` (JSON string[]), `pack_type` ('series'|'author') — this request's book files inside a shared series/author pack torrent (see [features/series-packs.md](../features/series-packs.md))
- Indexes: `request_id`, `selected`, `created_at DESC`

### Watched_Series
- `id` (UUID PK), `user_id` (FK → users, cascade), `series_asin`, `series_title`, `cover_art_url`, `last_checked_at`, `created_at`, `updated_at`
- `allow_alternate_versions` (bool, default false) - also request other versions of each book, pending admin approval (see [features/watched-lists.md](../features/watched-lists.md))
- Unique: (`user_id`, `series_asin`)

### Upcoming_Releases
- Future-dated books from watched series/authors; rebuilt by `check_watched_lists`. Fields: asin, title, author, series?, series_part?, cover_art_url?, release_date (DATE), source_type (series|author), source_asin, last_seen_at. Unique (asin, source_asin). See [features/watched-lists.md](../features/watched-lists.md#upcoming-releases--pre-orders).

### Blacklisted_Releases
- `id` (UUID PK), `audiobook_id` (FK → audiobooks, cascade), `title`, `indexer_name`, `info_hash` (lowercase), `release_url` (indexer page URL / guid), `size_bytes`, `reason` ('stalled'), `created_at`
- Scoped to the audiobook (not the request) so entries survive re-requests
- Excluded from automatic search via `release-blacklist.ts` (see services/scheduler.md)
- Indexes: `audiobook_id`, `info_hash`

### Configuration
- `id` (UUID PK), `key` (unique), `value`, `encrypted` (bool), `category`, `description`
- `created_at`, `updated_at`
- Indexes: `key`, `category`
- Example keys: `plex.server_url`, `plex.auth_token`, `indexer.prowlarr_url`, `download_client.qbittorrent_password`, `paths.downloads`, `setup.completed`, `auto_approve_requests`
- **Request approval:**
  - `auto_approve_requests` (value: 'true'|'false') - Global setting for auto-approving requests
  - If 'true' and User.autoApproveRequests is null, requests auto-approved
  - If not 'true' and User.autoApproveRequests is null, requests require admin approval

### Jobs
- `id` (UUID PK), `bull_job_id`, `request_id` (FK nullable)
- `type` ('search_indexers'|'monitor_download'|'organize_files'|'scan_plex'|'match_plex'|'plex_library_scan'|'plex_recently_added_check'|'audible_refresh'|'retry_missing_torrents'|'retry_failed_imports'|'cleanup_seeded_torrents'|'monitor_rss_feeds')
- `status` ('pending'|'active'|'completed'|'failed'|'delayed'|'stuck')
- `priority`, `attempts`, `max_attempts` (default 3)
- `payload` (JSONB), `result` (JSONB), `error_message`, `stack_trace`
- `started_at`, `completed_at`, `created_at`, `updated_at`
- Indexes: `request_id`, `type`, `status`, `created_at DESC`

### Job_Events
- `id` (UUID PK), `job_id` (FK → Jobs, CASCADE delete)
- `level` ('info'|'warn'|'error')
- `context` (processor name: OrganizeFiles, FileOrganizer, MonitorDownload, etc.)
- `message` (event description)
- `metadata` (JSONB, optional structured data)
- `created_at` (timestamp)
- Indexes: `job_id`, `created_at`
- **Purpose:** Store detailed event logs for job operations (shown in admin logs UI)

## Relationships

- User → Requests (1:many)
- Audiobook → Requests (1:many)
- Request → Download History (1:many)
- Request → Jobs (1:many, nullable)
- Job → Job Events (1:many, CASCADE delete)

## Setup Strategy

**Approach:** Schema sync via `prisma db push`
- Prisma schema is source of truth
- On startup: sync schema → database
- Idempotent (safe to run multiple times)
- No migration files needed
- Generates Prisma client after sync

## ORM: Prisma 6.x

- Type-safe queries
- Auto-generated types
- Connection pooling
- Client output: `src/generated/prisma`

## Security

**Encryption at Rest (AES-256):**
- User auth tokens
- API keys/passwords in Configuration
- Download client credentials

**SQL Injection:** Parameterized queries only via ORM

**Access Control:** Row-level (users see only their requests), admins have full access

## Tech Stack

- PostgreSQL 16+
- Prisma 6.x
- `prisma db push` (schema sync)
- Node.js crypto (encryption)
