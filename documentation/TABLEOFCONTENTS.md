# Documentation Table of Contents

**Purpose:** Quick navigation for AI to locate relevant documentation without reading all files.

## Authentication & Users
- **Plex OAuth, JWT sessions, RBAC** → [backend/services/auth.md](backend/services/auth.md)
- **Local admin authentication, password change** → [backend/services/auth.md](backend/services/auth.md)
- **Admin-generated login token per user (URL-login)** → [backend/services/auth.md](backend/services/auth.md)
- **Route protection, auth guards** → [frontend/routing-auth.md](frontend/routing-auth.md)
- **Login page UI/UX** → [frontend/pages/login.md](frontend/pages/login.md)

## Configuration & Setup
- **First-time setup wizard** → [setup-wizard.md](setup-wizard.md)
- **Settings management, encryption** → [backend/services/config.md](backend/services/config.md)
- **Settings UI (modular architecture, all tabs)** → [settings-pages.md](settings-pages.md)
- **Settings architecture refactoring (Jan 2026)** → [settings-pages.md](settings-pages.md#architecture-refactored-jan-2026)
- **Audiobook organization templates** → [settings-pages.md](settings-pages.md#audiobook-organization-template), [phase3/file-organization.md](phase3/file-organization.md#target-structure)
- **Setup middleware & status check** → [backend/middleware.md](backend/middleware.md)
- **Environment variables, PUBLIC_URL, OAuth configuration** → [backend/services/environment.md](backend/services/environment.md)

## Database & Data Models
- **PostgreSQL schema, tables, relationships** → [backend/database.md](backend/database.md)
- **Prisma ORM, migrations** → [backend/database.md](backend/database.md)

## Plex Integration
- **OAuth, library scanning, fuzzy matching** → [integrations/plex.md](integrations/plex.md)
- **Availability status, plexGuid linking** → [integrations/plex.md](integrations/plex.md)

## Audiobookshelf Integration
- **ABS API client, library scanning** → `src/lib/services/audiobookshelf/api.ts`
- **ABS library service** → `src/lib/services/library/AudiobookshelfLibraryService.ts`
- **Backend mode selection (Plex vs ABS)** → [backend/services/config.md](backend/services/config.md)
- **File hash matching for accurate ASIN** → [fixes/file-hash-matching.md](fixes/file-hash-matching.md)
- **"In library" for another edition you own (re-issued ASINs, title + author)** → [integrations/audible.md](integrations/audible.md#unified-matching-audiobook-matcherts)
- **Library Match Check: wrong ABS matches (length/title/shared ASIN), re-match, wrong-audio detection** → [features/library-match.md](features/library-match.md)
- **OIDC authentication** → [backend/services/auth.md](backend/services/auth.md)

## Reading Shelves (Goodreads, Hardcover)
- **Goodreads shelf sync (RSS feeds)** → [backend/services/goodreads-sync.md](backend/services/goodreads-sync.md)
- **Hardcover shelf sync (GraphQL API)** → [backend/services/hardcover-sync.md](backend/services/hardcover-sync.md)
- **Shared sync core (Audible lookup, request creation)** → [backend/services/goodreads-sync.md](backend/services/goodreads-sync.md#shared-sync-core)
- **Combined shelves API, GenericShelf** → [backend/services/goodreads-sync.md](backend/services/goodreads-sync.md)
- **Hook factory (createShelfHooks)** → [backend/services/goodreads-sync.md](backend/services/goodreads-sync.md#hook-factory)
- **Adding a new shelf provider** → [backend/services/goodreads-sync.md](backend/services/goodreads-sync.md#adding-a-new-provider)

## Watched Lists (Series & Authors)
- **Auto-request new releases from watched series/authors** → [features/watched-lists.md](features/watched-lists.md)
- **Duplicate versions (dramatized, full cast, other narrators) — one per book** → [features/watched-lists.md](features/watched-lists.md#duplicate-versions)
- **Alternate versions opt-in (admin approval, own series in library)** → [features/watched-lists.md](features/watched-lists.md#alternate-versions-per-series-opt-in)
- **Upcoming releases list, pre-orders held until release day** → [features/watched-lists.md](features/watched-lists.md#upcoming-releases--pre-orders)
- **Archived Audible series ("[ARCHIVED]", empty page) → watches/links moved to the replacement** → [features/watched-lists.md](features/watched-lists.md#archived-audible-series)

## Audible Integration
- **Web scraping (popular, new releases)** → [integrations/audible.md](integrations/audible.md)
- **Database caching, real-time matching** → [integrations/audible.md](integrations/audible.md)
- **Book covers API for login page** → [frontend/pages/login.md](frontend/pages/login.md)

## E-book Support (First-Class)
- **First-class ebook requests, separate tracking** → [integrations/ebook-sidecar.md](integrations/ebook-sidecar.md)
- **Multi-source ebook downloads (Anna's Archive + Indexer Search)** → [integrations/ebook-sidecar.md](integrations/ebook-sidecar.md)
- **Ebook indexer search (Prowlarr with ebook categories)** → [integrations/ebook-sidecar.md](integrations/ebook-sidecar.md#flow-indexer-search)
- **ASIN-based matching, format selection** → [integrations/ebook-sidecar.md](integrations/ebook-sidecar.md)
- **Ebook ranking algorithm (unified with audiobooks)** → [phase3/ranking-algorithm.md](phase3/ranking-algorithm.md#ebook-torrent-ranking)
- **Direct HTTP downloads from Anna's Archive** → [integrations/ebook-sidecar.md](integrations/ebook-sidecar.md)
- **Ebook delete behavior (files only, torrents seed)** → [integrations/ebook-sidecar.md](integrations/ebook-sidecar.md#delete-behavior)
- **Ebook settings (3-section UI)** → [settings-pages.md](settings-pages.md#e-book-sidecar)
- **Indexer categories (audiobook/ebook tabs)** → [settings-pages.md](settings-pages.md#indexer-categories-tabbed)

## Automation Pipeline
- **Full pipeline overview** → [phase3/README.md](phase3/README.md)
- **Search via Prowlarr (torrents + NZBs)** → [phase3/prowlarr.md](phase3/prowlarr.md)
- **Torrent ranking/selection** → [phase3/ranking-algorithm.md](phase3/ranking-algorithm.md)
- **Release language filter (English default)** → [phase3/ranking-algorithm.md](phase3/ranking-algorithm.md#release-language-filter)
- **Wrong series book guard (Book 4 for a book 1 request)** → [phase3/ranking-algorithm.md](phase3/ranking-algorithm.md#series-book-number-guard)
- **Multi-download-client support (qBittorrent, Transmission, SABnzbd, NZBGet)** → [phase3/download-clients.md](phase3/download-clients.md)
- **qBittorrent integration (torrents)** → [phase3/qbittorrent.md](phase3/qbittorrent.md)
- **SABnzbd integration (Usenet/NZB)** → [phase3/sabnzbd.md](phase3/sabnzbd.md)
- **File organization, seeding** → [phase3/file-organization.md](phase3/file-organization.md)
- **Chapter merging (auto-merge to M4B)** → [features/chapter-merging.md](features/chapter-merging.md)
- **Chapter sources (Audnexus/embedded), merge already-imported split books** → [features/chapter-merging.md](features/chapter-merging.md)
- **Library layout guard: book never nested inside another book (import + library job)** → [phase3/file-organization.md](phase3/file-organization.md#library-layout-guard)
- **Library Organize job: one folder per author, series kept together, author spelling matching** → [phase3/file-organization.md](phase3/file-organization.md#library-organize-one-folder-per-author-series-together)
- **Shared torrent download folders, multi-book import guard** → [phase3/file-organization.md](phase3/file-organization.md#shared-download-folders--multi-book-guard)
- **Scan safety: grace period, relink by ASIN, restore wrongly cancelled requests** → [backend/services/jobs.md](backend/services/jobs.md)
- **Job progress bars, clean cancel, live job log in the web UI** → [backend/services/jobs.md](backend/services/jobs.md#live-progress--cancel-long-jobs)
- **Library-wide merge of split books (report/apply, runtime-verified), 2-file import merges** → [features/chapter-merging.md](features/chapter-merging.md)
- **Single MP3 → M4B (Library Merge, per book, optional on import)** → [features/chapter-merging.md](features/chapter-merging.md#v8---single-mp3--m4b-2026-10-10)
- **Sync fixed chapters to Audiobookshelf (automatic + catch-up job)** → [features/chapter-merging.md](features/chapter-merging.md)
- **Fix chapters from Audnexus (every import, per book, library-wide report/apply)** → [features/chapter-merging.md](features/chapter-merging.md#v5---fix-chapters-on-single-file-books-2026-10-08)
- **Series & author packs (grab multi-book packs after 24h, partial download, fill out series)** → [features/series-packs.md](features/series-packs.md)

## Background Jobs
- **Bull queue, processors, retry logic** → [backend/services/jobs.md](backend/services/jobs.md)
- **Stalled downloads (24h no progress → blacklist + re-search)** → [backend/services/scheduler.md](backend/services/scheduler.md#stalled-download-detection)
- **Scheduled/recurring jobs (cron)** → [backend/services/scheduler.md](backend/services/scheduler.md)
- **Library scan without the 12h missing-item wait (Library Scan (No Wait))** → [backend/services/jobs.md](backend/services/jobs.md)
- **Library Health Report (all library checks, Report Only, one log, monthly)** → [backend/services/jobs.md](backend/services/jobs.md)
- **Job types:** search, download monitor, organize, Plex scan, cleanup, retries

## Logging
- **Centralized logging (RMABLogger)** → [backend/services/logging.md](backend/services/logging.md)
- **LOG_LEVEL configuration** → [backend/services/logging.md](backend/services/logging.md)
- **Job-aware database persistence** → [backend/services/logging.md](backend/services/logging.md)

## Notifications
- **Notification backends (Discord, Pushover)** → [backend/services/notifications.md](backend/services/notifications.md)
- **Event types, triggers, message formatting** → [backend/services/notifications.md](backend/services/notifications.md)
- **Notification settings UI** → [settings-pages.md](settings-pages.md)

## Frontend Components
- **Component catalog (cards, badges, forms)** → [frontend/components.md](frontend/components.md)
- **RequestCard, StatusBadge, ProgressBar** → [frontend/components.md](frontend/components.md)
- **Pages: home, search, requests, profile** → [frontend/components.md](frontend/components.md)
- **Home page sections (per-user, configurable)** → [features/home-sections.md](features/home-sections.md)

## BookDate (AI Recommendations)
- **AI-powered recommendations, swipe interface** → [features/bookdate.md](features/bookdate.md)
- **Configuration, OpenAI/Claude integration** → [features/bookdate.md](features/bookdate.md)
- **Library scopes (full, rated, favorites)** → [features/bookdate.md](features/bookdate.md)
- **Pick my favorites (book selection modal)** → [features/bookdate.md](features/bookdate.md)
- **Setup wizard integration, settings** → [features/bookdate.md](features/bookdate.md)
- **Card stack animations (3-card stack, swipe animations)** → [features/bookdate-animations.md](features/bookdate-animations.md)
- **Library thumbnail caching** → [features/library-thumbnail-cache.md](features/library-thumbnail-cache.md)

## Admin Features
- **Dashboard (metrics, downloads, requests)** → [admin-dashboard.md](admin-dashboard.md)
- **Bulk import (scan folders, match Audible, batch import)** → [features/bulk-import.md](features/bulk-import.md)
- **Jobs management UI** → [backend/services/scheduler.md](backend/services/scheduler.md)
- **Request deletion (soft delete, seeding awareness)** → [admin-features/request-deletion.md](admin-features/request-deletion.md)
- **Request approval system, auto-approve settings** → [admin-features/request-approval.md](admin-features/request-approval.md)

## Fixes & Improvements
- **File hash-based library matching (ABS)** → [fixes/file-hash-matching.md](fixes/file-hash-matching.md)
- **Accurate ASIN matching for RMAB-organized content** → [fixes/file-hash-matching.md](fixes/file-hash-matching.md)

## Deployment
- **Docker Compose setup (multi-container)** → [deployment/docker.md](deployment/docker.md)
- **Unified container (all-in-one)** → [deployment/unified.md](deployment/unified.md)
- **Environment variables, volumes** → [deployment/docker.md](deployment/docker.md)
- **Volume mapping (download clients)** → [deployment/volume-mapping.md](deployment/volume-mapping.md)
- **Database setup (Prisma), migrations** → [deployment/docker.md](deployment/docker.md)

## Testing
- **Backend unit test framework, scripts** [testing.md](testing.md)

## Feature-Specific Lookups
**"How do I add a new audiobook?"** → [integrations/audible.md](integrations/audible.md) (scraping), [phase3/README.md](phase3/README.md) (automation)
**"How do I configure multiple download clients?"** → [phase3/download-clients.md](phase3/download-clients.md)
**"How do torrent downloads work?"** → [phase3/qbittorrent.md](phase3/qbittorrent.md), [backend/services/jobs.md](backend/services/jobs.md)
**"How do Usenet/NZB downloads work?"** → [phase3/sabnzbd.md](phase3/sabnzbd.md), [phase3/download-clients.md](phase3/download-clients.md), [backend/services/jobs.md](backend/services/jobs.md)
**"Can I use both qBittorrent and SABnzbd?"** → [phase3/download-clients.md](phase3/download-clients.md)
**"How do I use NZBGet instead of SABnzbd?"** → [phase3/download-clients.md](phase3/download-clients.md)
**"How do I use Transmission instead of qBittorrent?"** → [phase3/download-clients.md](phase3/download-clients.md)
**"How do I set different download paths per client?"** → [phase3/download-clients.md](phase3/download-clients.md#per-client-custom-download-path)
**"How does Plex matching work?"** → [integrations/plex.md](integrations/plex.md)
**"How does e-book support work?"** → [integrations/ebook-sidecar.md](integrations/ebook-sidecar.md)
**"How do I enable e-book downloads?"** → [integrations/ebook-sidecar.md](integrations/ebook-sidecar.md), [settings-pages.md](settings-pages.md#e-book-sidecar)
**"How do I configure ebook sources (Anna's Archive vs Indexer)?"** → [settings-pages.md](settings-pages.md#e-book-sidecar)
**"How does ebook indexer search work?"** → [integrations/ebook-sidecar.md](integrations/ebook-sidecar.md#flow-indexer-search)
**"How do I configure ebook categories per indexer?"** → [settings-pages.md](settings-pages.md#indexer-categories-tabbed)
**"How does ebook ranking work?"** → [phase3/ranking-algorithm.md](phase3/ranking-algorithm.md#ebook-torrent-ranking)
**"What happens when I delete an ebook request?"** → [integrations/ebook-sidecar.md](integrations/ebook-sidecar.md#delete-behavior)
**"Why do ebook requests have an orange badge?"** → [integrations/ebook-sidecar.md](integrations/ebook-sidecar.md#ui-representation)
**"How do scheduled jobs work?"** → [backend/services/scheduler.md](backend/services/scheduler.md)
**"How do I configure external services?"** → [setup-wizard.md](setup-wizard.md), [settings-pages.md](settings-pages.md)
**"What's the database schema?"** → [backend/database.md](backend/database.md)
**"How does authentication work?"** → [backend/services/auth.md](backend/services/auth.md)
**"How do I change my password?"** → [backend/services/auth.md](backend/services/auth.md) (local users only - accessed via user menu in header)
**"How do I delete requests?"** → [admin-features/request-deletion.md](admin-features/request-deletion.md)
**"How do I approve/deny user requests?"** → [admin-features/request-approval.md](admin-features/request-approval.md)
**"How do I enable auto-approve for requests?"** → [admin-features/request-approval.md](admin-features/request-approval.md)
**"How do I customize audiobook folder organization?"** → [settings-pages.md](settings-pages.md#audiobook-organization-template), [phase3/file-organization.md](phase3/file-organization.md#target-structure)
**"How do I deploy?"** → [deployment/docker.md](deployment/docker.md) (multi-container), [deployment/unified.md](deployment/unified.md) (all-in-one)
**"How do I use the unified container?"** → [deployment/unified.md](deployment/unified.md)
**"Why can't RMAB find my downloaded files?"** → [deployment/volume-mapping.md](deployment/volume-mapping.md)
**"How do I set up volume mapping for qBittorrent/Transmission/SABnzbd/NZBGet?"** → [deployment/volume-mapping.md](deployment/volume-mapping.md)
**"OAuth redirects to localhost / PUBLIC_URL not working"** → [backend/services/environment.md](backend/services/environment.md)
**"What environment variables do I need?"** → [backend/services/environment.md](backend/services/environment.md)
**"How does chapter merging work?"** → [features/chapter-merging.md](features/chapter-merging.md)
**"How does logging work?"** → [backend/services/logging.md](backend/services/logging.md)
**"How do BookDate card stack animations work?"** → [features/bookdate-animations.md](features/bookdate-animations.md)
**"How does Audiobookshelf integration work?"** → `src/lib/services/audiobookshelf/api.ts`, `src/lib/services/library/AudiobookshelfLibraryService.ts`
**"How do I use OIDC/Authentik/Keycloak?"** → [backend/services/auth.md](backend/services/auth.md)
**"How do I switch from Plex to Audiobookshelf?"** → Setup wizard (re-run setup with different backend mode)
**"How does library thumbnail caching work?"** → [features/library-thumbnail-cache.md](features/library-thumbnail-cache.md)
**"Why do BookDate library books show placeholders?"** → [features/library-thumbnail-cache.md](features/library-thumbnail-cache.md)
**"How does file hash matching work?"** → [fixes/file-hash-matching.md](fixes/file-hash-matching.md)
**"Why is ABS matching the wrong book?"** → [fixes/file-hash-matching.md](fixes/file-hash-matching.md) (file hash prevents false positives)
**"How do I customize my home page?"** → [features/home-sections.md](features/home-sections.md)
**"How do Audible categories work?"** → [features/home-sections.md](features/home-sections.md)
**"How do I add category sections to the home page?"** → [features/home-sections.md](features/home-sections.md)
**"How do Goodreads shelves work?"** → [backend/services/goodreads-sync.md](backend/services/goodreads-sync.md)
**"How do Hardcover shelves work?"** → [backend/services/hardcover-sync.md](backend/services/hardcover-sync.md)
**"How do I add a new shelf provider?"** → [backend/services/goodreads-sync.md](backend/services/goodreads-sync.md#adding-a-new-provider)
**"How does the shelf sync core work?"** → [backend/services/goodreads-sync.md](backend/services/goodreads-sync.md#shared-sync-core)
**"How does bulk import work?"** → [features/bulk-import.md](features/bulk-import.md)
**"How do I import multiple audiobooks at once?"** → [features/bulk-import.md](features/bulk-import.md)
**"How does the bulk import scanner detect audiobooks?"** → [features/bulk-import.md](features/bulk-import.md)
