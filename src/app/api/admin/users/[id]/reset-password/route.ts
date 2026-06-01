/**
 * Component: Admin Reset User Password API
 * Documentation: documentation/admin-dashboard.md
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireAdmin, AuthenticatedRequest } from '@/lib/middleware/auth';
import { prisma } from '@/lib/db';
import bcrypt from 'bcrypt';
import { getEncryptionService } from '@/lib/services/encryption.service';
import { RMABLogger } from '@/lib/utils/logger';

const logger = RMABLogger.create('API.Admin.Users.ResetPassword');

/**
 * POST /api/admin/users/[id]/reset-password
 * Admin-only: set a new password for a local user without knowing the current one.
 *
 * Use case: user forgot their password, admin gave them a one-time login link,
 * but change-password requires the current password — this endpoint bypasses that.
 *
 * Security:
 * - Admin only (requireAdmin middleware)
 * - Only works for local users (authProvider = 'local')
 * - Setup admin password cannot be reset (protected account)
 * - Uses identical bcrypt + AES-256 storage as registration / change-password
 * - No passwords are logged — only user IDs and usernames
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  return requireAuth(request, async (req: AuthenticatedRequest) => {
    return requireAdmin(req, async () => {
      try {
        const { id } = await params;
        const body = await request.json();
        const { newPassword } = body;

        // Validate input
        if (!newPassword) {
          return NextResponse.json(
            { success: false, error: 'New password is required' },
            { status: 400 }
          );
        }

        const allowWeakPassword = process.env.ALLOW_WEAK_PASSWORD === 'true';
        if (!allowWeakPassword && newPassword.length < 8) {
          return NextResponse.json(
            { success: false, error: 'Password must be at least 8 characters' },
            { status: 400 }
          );
        }

        // Fetch target user
        const targetUser = await prisma.user.findUnique({
          where: { id },
          select: {
            id: true,
            plexUsername: true,
            authProvider: true,
            isSetupAdmin: true,
            deletedAt: true,
          },
        });

        if (!targetUser) {
          return NextResponse.json(
            { success: false, error: 'User not found' },
            { status: 404 }
          );
        }

        if (targetUser.deletedAt) {
          return NextResponse.json(
            { success: false, error: 'Cannot modify a deleted user' },
            { status: 403 }
          );
        }

        // Only local users have a password managed by this app
        if (targetUser.authProvider !== 'local') {
          return NextResponse.json(
            {
              success: false,
              error: `Cannot reset password for ${targetUser.authProvider} users — their credentials are managed externally`,
            },
            { status: 403 }
          );
        }

        // Protect the setup admin account
        if (targetUser.isSetupAdmin) {
          return NextResponse.json(
            { success: false, error: 'Cannot reset the setup admin password via this endpoint' },
            { status: 403 }
          );
        }

        // Hash and encrypt using the same pattern as registration / change-password
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        const encryptionService = getEncryptionService();
        const encryptedHash = encryptionService.encrypt(hashedPassword);

        await prisma.user.update({
          where: { id },
          data: {
            authToken: encryptedHash,
            updatedAt: new Date(),
          },
        });

        logger.info('Admin reset password for user', {
          adminId: req.user!.sub,
          targetUserId: targetUser.id,
          targetUsername: targetUser.plexUsername,
        });

        return NextResponse.json({
          success: true,
          message: `Password reset successfully for ${targetUser.plexUsername}`,
        });
      } catch (error) {
        logger.error('Failed to reset user password', {
          error: error instanceof Error ? error.message : String(error),
        });
        return NextResponse.json(
          { success: false, error: 'Failed to reset password' },
          { status: 500 }
        );
      }
    });
  });
}
