/**
 * Auth-flow smoke script (aperture-ht7sq).
 *
 * Exercises the full lifecycle through the tRPC mount:
 *   1. POST /api/trpc/auth.signUp  (a fresh user, plataforma eunenem)
 *   2. GET  /api/trpc/auth.me      (cookie set, returns user)
 *   3. POST /api/trpc/auth.signOut (cookie cleared)
 *   4. GET  /api/trpc/auth.me      (returns null)
 *   5. POST /api/trpc/auth.signIn  (same credentials)
 *   6. GET  /api/trpc/auth.me      (returns user again)
 *
 * Usage (against a running local server):
 *   tsx apps/eunenem-server/scripts/auth-smoke.ts
 *
 * Env vars (optional):
 *   BASE_URL          — server origin, default http://localhost:3001
 *   ID_PLATAFORMA     — defaults to ID_PLATAFORMA_EUNENEM
 *
 * The script prints each step + final verdict. Exit code 0 on success,
 * 1 on any unexpected response shape.
 *
 * Pre-reqs: engine migrations applied to the same DATABASE_URL the
 * server uses (`pnpm db:migrate` from engine root); server running
 * (`pnpm dev` from apps/eunenem-server). The script uses a random email
 * per run so it can be re-executed without colliding with prior runs.
 */
import { randomBytes } from 'node:crypto';
import { ID_PLATAFORMA_EUNENEM } from '../../../src/index.js';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3001';
const ID_PLATAFORMA = process.env.ID_PLATAFORMA ?? ID_PLATAFORMA_EUNENEM;

const email = `smoke-${randomBytes(4).toString('hex')}@example.com`;
const senha = `smoke-${randomBytes(8).toString('hex')}`;
const nomeExibicao = 'Smoke Test User';

let cookie = '';

interface TRPCResponse<T> {
  readonly result?: { readonly data: T };
  readonly error?: { readonly message: string; readonly data?: { readonly code: string } };
}

async function postProcedure<T>(name: string, input: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}/api/trpc/${name}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(input),
  });
  // Capture cookies for the next call.
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    const [pair] = setCookie.split(';');
    if (pair) {
      const trimmed = pair.trim();
      if (trimmed.endsWith('=')) {
        // Server cleared the cookie (signOut).
        cookie = '';
      } else {
        cookie = trimmed;
      }
    }
  }
  const body = (await res.json()) as TRPCResponse<T>;
  if (body.error) {
    throw new Error(`tRPC ${name} failed: ${body.error.message}`);
  }
  if (!body.result) {
    throw new Error(`tRPC ${name} returned no result: ${JSON.stringify(body)}`);
  }
  return body.result.data;
}

async function queryProcedure<T>(name: string): Promise<T> {
  const url = `${BASE_URL}/api/trpc/${name}?input=${encodeURIComponent(JSON.stringify({}))}`;
  const res = await fetch(url, {
    headers: cookie ? { cookie } : {},
  });
  const body = (await res.json()) as TRPCResponse<T>;
  if (body.error) {
    throw new Error(`tRPC ${name} failed: ${body.error.message}`);
  }
  return body.result?.data as T;
}

function step(label: string): void {
  console.log(`\n${'━'.repeat(60)}`);
  console.log(`▶ ${label}`);
  console.log('━'.repeat(60));
}

async function main() {
  console.log('🔐 eunenem-server auth-flow smoke (aperture-ht7sq)');
  console.log(`   server: ${BASE_URL}`);
  console.log(`   email:  ${email}`);
  console.log(`   plataforma: ${ID_PLATAFORMA}`);

  step('1. signUp + immediate session');
  const signUp = await postProcedure<{ idUsuario: string; idConta: string }>(
    'auth.signUp',
    { email, senha, nomeExibicao, idPlataforma: ID_PLATAFORMA },
  );
  console.log('  idUsuario:', signUp.idUsuario);
  console.log('  idConta:  ', signUp.idConta);
  console.log('  cookie:   ', cookie ? `${cookie.slice(0, 40)}...` : '(none)');
  if (!cookie) throw new Error('signUp did not set a session cookie');

  step('2. me — should return the user we just created');
  const meAfterSignUp = await queryProcedure<{ idUsuario: string; email: string } | null>(
    'auth.me',
  );
  if (!meAfterSignUp) throw new Error('me returned null after signUp');
  console.log('  idUsuario:', meAfterSignUp.idUsuario);
  console.log('  email:    ', meAfterSignUp.email);

  step('3. signOut — clears cookie + revokes session');
  await postProcedure<{ ok: true }>('auth.signOut', {});
  console.log('  cookie after signOut:', cookie || '(cleared)');

  step('4. me — should now return null');
  const meAfterSignOut = await queryProcedure<unknown>('auth.me');
  if (meAfterSignOut !== null) {
    throw new Error(`me returned non-null after signOut: ${JSON.stringify(meAfterSignOut)}`);
  }
  console.log('  null (as expected)');

  step('5. signIn — same credentials, new session');
  const signIn = await postProcedure<{ idUsuario: string }>('auth.signIn', {
    email,
    senha,
    idPlataforma: ID_PLATAFORMA,
  });
  console.log('  idUsuario:', signIn.idUsuario);
  if (signIn.idUsuario !== signUp.idUsuario) {
    throw new Error('signIn returned a different idUsuario than signUp');
  }
  console.log('  cookie:   ', cookie ? `${cookie.slice(0, 40)}...` : '(none)');

  step('6. me — should return the user again');
  const meAfterSignIn = await queryProcedure<{ idUsuario: string } | null>('auth.me');
  if (!meAfterSignIn) throw new Error('me returned null after signIn');
  if (meAfterSignIn.idUsuario !== signUp.idUsuario) {
    throw new Error('me returned wrong idUsuario after signIn');
  }
  console.log('  idUsuario:', meAfterSignIn.idUsuario);

  console.log(`\n${'━'.repeat(60)}`);
  console.log('🎉 SMOKE PASSED — signUp → me → signOut → me → signIn → me all green');
  console.log('━'.repeat(60));
}

main().catch((err) => {
  console.error('\n❌ SMOKE FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
