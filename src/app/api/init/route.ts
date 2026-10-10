/**
 * Component: Initialization API Route
 * Documentation: documentation/backend/services/scheduler.md
 *
 * This route is called during server startup to initialize the scheduler
 * and trigger any overdue jobs.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSchedulerService } from '@/lib/services/scheduler.service';
import { runCredentialMigration } from '@/lib/services/credential-migration.service';
import { scheduleStartupRecovery } from '@/lib/services/interrupted-imports';
import { RMABLogger } from '@/lib/utils/logger';

const logger = RMABLogger.create('API.Init');

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    logger.info('Initializing application services...');

    // Run credential migration (encrypts any plaintext credentials)
    await runCredentialMigration();

    // Initialize scheduler service
    const schedulerService = getSchedulerService();
    await schedulerService.start();

    // Imports killed by the restart (request stuck in 'processing') → redo from the finished download
    if (scheduleStartupRecovery(logger)) logger.info('Interrupted import check scheduled');

    logger.info('Application services initialized successfully');

    return NextResponse.json({
      success: true,
      message: 'Application services initialized',
    });
  } catch (error) {
    logger.error('Failed to initialize services', { error: error instanceof Error ? error.message : String(error) });

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to initialize services',
      },
      { status: 500 }
    );
  }
}
