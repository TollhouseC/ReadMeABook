-- AlterTable: per-watched-series opt-in for alternate versions (admin approval)
ALTER TABLE "watched_series" ADD COLUMN "allow_alternate_versions" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable: alternate-version label applied to series name + folder at import
ALTER TABLE "audiobooks" ADD COLUMN "version_label" TEXT;
