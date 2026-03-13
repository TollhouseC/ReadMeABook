-- AlterTable - Add sessions_invalidated_at column for immediate session revocation
ALTER TABLE "users" ADD COLUMN "sessions_invalidated_at" TIMESTAMPTZ;
