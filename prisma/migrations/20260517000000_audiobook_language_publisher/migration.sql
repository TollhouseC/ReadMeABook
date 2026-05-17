-- Migration: Add language and publisher columns to audiobooks table
-- These fields are sourced from the Audible catalog API and displayed in the details modal.

ALTER TABLE "audiobooks" ADD COLUMN IF NOT EXISTS "language" TEXT;
ALTER TABLE "audiobooks" ADD COLUMN IF NOT EXISTS "publisher" TEXT;
