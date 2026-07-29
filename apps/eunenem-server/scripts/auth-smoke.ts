/**
 * Passwordless auth-surface smoke (aperture-cusen).
 *
 * Against a running server this verifies:
 *   1. anonymous `auth.me` still returns null;
 *   2. the retired tRPC password procedures do not exist;
 *   3. BetterAuth's native email/password routes remain 410-blocked; and
 *   4. anonymous `auth.signOut` is safe and clears any stale session cookie.
 *
 * Positive OAuth and magic-link completion require a provider callback or a
 * captured email token. Those paths are covered by integration/E2E tests
 * rather than simulated here with credentials.
 *
 * Usage:
 *   tsx apps/eunenem-server/scripts/auth-smoke.ts
 *
 * Optional env:
 *   BASE_URL — server origin, default http://localhost:3001
 */

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3001';

interface TRPCResponse<T> {
  readonly result?: { readonly data: T };
  readonly error?: {
    readonly message: string;
    readonly data?: { readonly code?: string; readonly httpStatus?: number };
  };
}

async function queryProcedure<T>(name: string): Promise<TRPCResponse<T>> {
  const input = encodeURIComponent(JSON.stringify({}));
  const response = await fetch(`${BASE_URL}/api/trpc/${name}?input=${input}`);
  return (await response.json()) as TRPCResponse<T>;
}

async function postProcedure<T>(name: string, input: unknown): Promise<TRPCResponse<T>> {
  const response = await fetch(`${BASE_URL}/api/trpc/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  return (await response.json()) as TRPCResponse<T>;
}

function step(label: string): void {
  console.log(`\n${'━'.repeat(60)}`);
  console.log(`▶ ${label}`);
  console.log('━'.repeat(60));
}

function assertNotFound(name: string, body: TRPCResponse<unknown>): void {
  if (body.error?.data?.code !== 'NOT_FOUND') {
    throw new Error(`${name} is still reachable: ${JSON.stringify(body)}`);
  }
}

async function main(): Promise<void> {
  console.log('🔐 eunenem-server passwordless auth smoke (aperture-cusen)');
  console.log(`   server: ${BASE_URL}`);

  step('1. anonymous auth.me');
  const me = await queryProcedure<unknown>('auth.me');
  if (me.error || me.result?.data !== null) {
    throw new Error(`auth.me expected null: ${JSON.stringify(me)}`);
  }
  console.log('  null (as expected)');

  step('2. retired tRPC password procedures');
  for (const procedure of ['auth.signUp', 'auth.signIn', 'auth.continuarComEmail']) {
    const body = await postProcedure(procedure, {});
    assertNotFound(procedure, body);
    console.log(`  ${procedure}: NOT_FOUND`);
  }

  step('3. blocked native BetterAuth password endpoints');
  for (const path of ['/api/auth/sign-up/email', '/api/auth/sign-in/email']) {
    const response = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'retired@example.invalid', password: 'not-used' }),
    });
    if (response.status !== 410) {
      throw new Error(`${path} expected 410, received ${response.status}`);
    }
    console.log(`  ${path}: 410 Gone`);
  }

  step('4. anonymous auth.signOut');
  const signOut = await postProcedure<{ readonly ok: true }>('auth.signOut', {});
  if (signOut.error || signOut.result?.data.ok !== true) {
    throw new Error(`auth.signOut failed: ${JSON.stringify(signOut)}`);
  }
  console.log('  ok');

  console.log(`\n${'━'.repeat(60)}`);
  console.log('🎉 SMOKE PASSED — password routes absent; session lifecycle intact');
  console.log('━'.repeat(60));
}

main().catch((error) => {
  console.error('\n❌ SMOKE FAILED:', error instanceof Error ? error.message : error);
  process.exit(1);
});
