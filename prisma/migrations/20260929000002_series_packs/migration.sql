-- AlterTable: throttle series/author pack searches per request
ALTER TABLE "requests" ADD COLUMN "last_pack_search_at" TIMESTAMP(3);

-- AlterTable: per-request book files inside a shared pack torrent
ALTER TABLE "download_history" ADD COLUMN "pack_files" JSONB;
ALTER TABLE "download_history" ADD COLUMN "pack_type" TEXT;
