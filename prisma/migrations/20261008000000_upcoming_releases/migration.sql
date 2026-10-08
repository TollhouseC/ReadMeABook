-- CreateTable: future-dated books from watched series/authors (upcoming releases list)
CREATE TABLE "upcoming_releases" (
    "id" TEXT NOT NULL,
    "asin" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "series" TEXT,
    "series_part" TEXT,
    "cover_art_url" TEXT,
    "release_date" DATE NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_asin" TEXT NOT NULL,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "upcoming_releases_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "upcoming_releases_asin_source_asin_key" ON "upcoming_releases"("asin", "source_asin");
CREATE INDEX "upcoming_releases_source_asin_idx" ON "upcoming_releases"("source_asin");
CREATE INDEX "upcoming_releases_release_date_idx" ON "upcoming_releases"("release_date");
