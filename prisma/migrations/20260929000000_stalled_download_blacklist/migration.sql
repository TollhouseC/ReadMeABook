-- AlterTable: stalled-download detection baseline
ALTER TABLE "download_history" ADD COLUMN "stall_check_progress" DOUBLE PRECISION;
ALTER TABLE "download_history" ADD COLUMN "stall_checked_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "blacklisted_releases" (
    "id" TEXT NOT NULL,
    "audiobook_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "indexer_name" TEXT,
    "info_hash" TEXT,
    "release_url" TEXT,
    "size_bytes" BIGINT,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blacklisted_releases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "blacklisted_releases_audiobook_id_idx" ON "blacklisted_releases"("audiobook_id");

-- CreateIndex
CREATE INDEX "blacklisted_releases_info_hash_idx" ON "blacklisted_releases"("info_hash");

-- AddForeignKey
ALTER TABLE "blacklisted_releases" ADD CONSTRAINT "blacklisted_releases_audiobook_id_fkey" FOREIGN KEY ("audiobook_id") REFERENCES "audiobooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
