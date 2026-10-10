-- AlterTable: imported books matched to the requested edition in Audiobookshelf
ALTER TABLE "audiobooks" ADD COLUMN "abs_matched_at" TIMESTAMP(3);
