/**
 * M6 platform console accounts with mandatory TOTP. The TOTP secrets are
 * fixed DEVELOPMENT values (documented in the README) so a developer can add
 * them to an authenticator app once; never reuse them anywhere real.
 */
import * as argon2 from 'argon2';
import { createHash } from 'node:crypto';
import type { PlatformRole, PrismaClient } from '../../src/generated/prisma/client.js';
import { platformKeyMaterial, SecretCipher } from '../../src/common/crypto/secret-box.js';
import { hashRecoveryCode, TOTP_PURPOSE } from '../../src/modules/platform/platform-auth.service.js';

export const PLATFORM_PASSWORD = 'Admin1234!';

export const PLATFORM_USERS: { email: string; fullName: string; role: PlatformRole; totpSecret: string }[] = [
  { email: 'admin@devstrike.ng', fullName: 'Devstrike Admin', role: 'SUPER_ADMIN', totpSecret: 'DEVSTRIKEADMINTOTPSECRET234567AB' },
  { email: 'ops@devstrike.ng', fullName: 'Kemi Adebayo', role: 'OPERATIONS', totpSecret: 'DEVSTRIKEOPSTOTPSECRET234567ABCD' },
  { email: 'support@devstrike.ng', fullName: 'Ifeanyi Obi', role: 'SUPPORT', totpSecret: 'DEVSTRIKESUPPORTTOTPSECRET234567' },
  { email: 'finance@devstrike.ng', fullName: 'Halima Yusuf', role: 'FINANCE', totpSecret: 'DEVSTRIKEFINANCETOTPSECRET234567' },
  { email: 'sales@devstrike.ng', fullName: 'Tobi Ogunleye', role: 'SALES_READONLY', totpSecret: 'DEVSTRIKESALESTOTPSECRET234567AB' },
];

/** Dev recovery codes of admin@devstrike.ng: adm0-0001 ... adm0-0010 (restored on every seed). */
export const ADMIN_RECOVERY_CODES = Array.from({ length: 10 }, (_, i) => `adm0-${String(i + 1).padStart(4, '0')}`);

export const PENDING_INVITE = { email: 'newhire@devstrike.ng', fullName: 'Zainab Bello', role: 'SUPPORT' as PlatformRole, token: 'dev-invite-newhire-0001' };

export async function seedPlatformUsers(prisma: PrismaClient, argonOptions: argon2.HashOptions): Promise<void> {
  const env = process.env;
  const cipher = new SecretCipher(platformKeyMaterial({ PLATFORM_DATA_KEY: env.PLATFORM_DATA_KEY?.trim() || undefined, GUEST_DATA_KEY: env.GUEST_DATA_KEY ?? '' }));
  const refreshSecret = env.JWT_REFRESH_SECRET ?? '';
  const passwordHash = String(await argon2.hash(PLATFORM_PASSWORD, argonOptions));
  for (const u of PLATFORM_USERS) {
    const row = await prisma.platformUser.upsert({
      where: { email: u.email },
      create: { email: u.email, fullName: u.fullName, passwordHash, role: u.role },
      update: { fullName: u.fullName, passwordHash, role: u.role, isActive: true, failedAttempts: 0, lockedUntil: null, ipAllowlist: [] },
    });
    await prisma.platformUser.update({
      where: { id: row.id },
      data: { totpSecretEnc: cipher.seal(u.totpSecret, `${TOTP_PURPOSE}:${row.id}`), totpPendingSecretEnc: null, mfaEnabledAt: row.mfaEnabledAt ?? new Date() },
    });
    if (u.role === 'SUPER_ADMIN' && refreshSecret) {
      await prisma.platformRecoveryCode.deleteMany({ where: { platformUserId: row.id } });
      await prisma.platformRecoveryCode.createMany({ data: ADMIN_RECOVERY_CODES.map((c) => ({ platformUserId: row.id, codeHash: hashRecoveryCode(refreshSecret, c) })) });
    }
  }
  const admin = await prisma.platformUser.findUniqueOrThrow({ where: { email: 'admin@devstrike.ng' } });
  await prisma.platformUser.upsert({
    where: { email: PENDING_INVITE.email },
    create: {
      email: PENDING_INVITE.email, fullName: PENDING_INVITE.fullName, role: PENDING_INVITE.role, passwordHash: '!invited',
      inviteTokenHash: createHash('sha256').update(`invite:${PENDING_INVITE.token}`).digest('hex'),
      inviteExpiresAt: new Date(Date.now() + 7 * 86_400_000), invitedById: admin.id,
    },
    update: {},
  });
  console.log(`  platform users: ${PLATFORM_USERS.map((u) => `${u.email} (${u.role})`).join(', ')}; invite pending for ${PENDING_INVITE.email} (token ${PENDING_INVITE.token})`);
}
