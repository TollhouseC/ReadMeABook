-- AlterTable: live progress + clean cancel for long-running jobs
ALTER TABLE "jobs" ADD COLUMN "progress" JSONB;
ALTER TABLE "jobs" ADD COLUMN "cancel_requested" BOOLEAN NOT NULL DEFAULT false;
