-- Migration: Make ignored_audiobooks server-wide (remove per-user scoping)

-- Step 1: Deduplicate — keep the earliest ignore per ASIN, drop per-user duplicates
DELETE FROM "ignored_audiobooks"
WHERE id NOT IN (
  SELECT DISTINCT ON (asin) id
  FROM "ignored_audiobooks"
  ORDER BY asin, created_at ASC
);

-- Step 2: Drop old constraints/indexes that reference user_id
ALTER TABLE "ignored_audiobooks" DROP CONSTRAINT IF EXISTS "ignored_audiobooks_user_id_asin_key";
DROP INDEX IF EXISTS "ignored_audiobooks_user_id_idx";
ALTER TABLE "ignored_audiobooks" DROP CONSTRAINT IF EXISTS "ignored_audiobooks_user_id_fkey";

-- Step 3: Drop user_id column
ALTER TABLE "ignored_audiobooks" DROP COLUMN IF EXISTS "user_id";

-- Step 4: Add unique constraint on asin alone
ALTER TABLE "ignored_audiobooks" ADD CONSTRAINT "ignored_audiobooks_asin_key" UNIQUE ("asin");
