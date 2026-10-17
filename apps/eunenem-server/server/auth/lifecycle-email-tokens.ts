import { createHmac, timingSafeEqual } from 'node:crypto';
import { LIFECYCLE_EMAIL_TYPES, type LifecycleEmailType } from '../../../../src/adapters/email/lifecycle-email-preferences.postgres.js';

type PreferenceClaims = { userId: string; tenantId: string; type?: LifecycleEmailType };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function createLifecycleEmailTokens(secret: string, clock: () => Date = () => new Date()) {
  if (secret.length < 32) throw new Error('Lifecycle token signing key must be at least 32 characters');
  const mac = (value: string) => createHmac('sha256', secret).update(`lifecycle-email-v1:${value}`).digest();
  const sign = (scope: string, claims: object) => {
    const payload = Buffer.from(JSON.stringify({ ...claims, scope, exp: Math.floor(clock().getTime() / 1000) + 30 * 86400 })).toString('base64url');
    return `${payload}.${mac(payload).toString('base64url')}`;
  };
  const verify = (token: string, scope: string): Record<string, unknown> | null => {
    if (token.length > 2048) return null;
    try {
      const [payload, signature, extra] = token.split('.');
      if (!payload || !signature || extra !== undefined) return null;
      const actual = Buffer.from(signature, 'base64url');
      const expected = mac(payload);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (data.scope !== scope || typeof data.exp !== 'number' || data.exp <= clock().getTime() / 1000) return null;
      return data;
    } catch { return null; }
  };
  return {
    signPreferenceToken: (claims: PreferenceClaims) => sign('preferences', claims),
    verifyPreferenceToken(token: string): PreferenceClaims | null {
      const data = verify(token, 'preferences');
      if (!data || typeof data.userId !== 'string' || !UUID.test(data.userId) || typeof data.tenantId !== 'string' || !UUID.test(data.tenantId)) return null;
      if (data.type !== undefined && !LIFECYCLE_EMAIL_TYPES.includes(data.type as LifecycleEmailType)) return null;
      return { userId: data.userId, tenantId: data.tenantId, ...(data.type === undefined ? {} : { type: data.type as LifecycleEmailType }) };
    },
    signFeedbackToken: (deliveryId: string) => sign('feedback', { deliveryId }),
    verifyFeedbackToken(token: string): { deliveryId: string } | null {
      const data = verify(token, 'feedback');
      return data && typeof data.deliveryId === 'string' && UUID.test(data.deliveryId) ? { deliveryId: data.deliveryId } : null;
    },
  };
}
export type LifecycleEmailTokens = ReturnType<typeof createLifecycleEmailTokens>;
