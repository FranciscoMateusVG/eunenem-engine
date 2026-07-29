/**
 * Deterministic passwordless authentication for Playwright fixtures.
 *
 * The local E2E server deliberately boots without SMTP, so its BetterAuth
 * instance does not register the magic-link plugin. This helper constructs the
 * real engine auth factory against the SAME E2E database, captures the URL that
 * would have been emailed, and consumes it through `auth.handler`. The returned
 * signed BetterAuth cookie is then accepted by the spawned server, whose
 * `auth.me` query exercises the production OAuth/magic-link orphan self-heal
 * and provisions `usuarios` + the default campanha.
 *
 * No password is created, no `credential` account row is inserted, and no
 * engine-native session is minted. Fixed fixture identities are cached for the
 * duration of one Playwright process so the shared 5-send magic-link budget is
 * not consumed once per spec. On a fresh process we clear ONLY this E2E email's
 * budget row before the first send so repeated local/CI runs are deterministic.
 */

import type { Database } from '../src/adapters/database.js';
import { ID_PLATAFORMA_EUNENEM } from '../src/adapters/plataforma/repository.memory.js';
import { criarAuth } from '../src/adapters/usuario/criar-auth.js';

const DEFAULT_BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3002';
const DEFAULT_SECRET =
  process.env.BETTER_AUTH_SECRET ?? 'e2e-test-secret-must-be-at-least-32-chars-long-ok';

export interface MagicLinkCookie {
  readonly name: string;
  /** Exact Set-Cookie value emitted by BetterAuth (already wire-encoded). */
  readonly value: string;
  readonly header: string;
}

export interface MagicLinkSession {
  readonly email: string;
  readonly userId: string;
  readonly cookie: MagicLinkCookie;
}

interface MintMagicLinkSessionInput {
  readonly email: string;
  readonly name: string;
  readonly baseURL?: string;
}

const sessionCache = new Map<string, MagicLinkSession>();

function cacheKey(baseURL: string, email: string): string {
  return `${new URL(baseURL).origin}|${email.trim().toLowerCase()}`;
}

function extractSessionCookie(response: Response): MagicLinkCookie {
  const setCookies = response.headers.getSetCookie();
  const raw = setCookies.find((value) => /^(?:__Secure-)?better-auth\.session_token=/.test(value));
  if (!raw) {
    throw new Error(
      `magic-link E2E verify emitted no session cookie (status=${response.status}, set-cookie=${JSON.stringify(setCookies)})`,
    );
  }

  const pair = raw.slice(0, raw.indexOf(';'));
  const separator = pair.indexOf('=');
  if (separator <= 0) throw new Error(`magic-link E2E emitted malformed Set-Cookie: ${raw}`);
  const name = pair.slice(0, separator);
  const value = pair.slice(separator + 1);
  return { name, value, header: `${name}=${value}` };
}

function unwrapTrpcData(body: unknown): unknown {
  if (typeof body !== 'object' || body === null) return undefined;
  const result = (body as { result?: { data?: unknown } }).result;
  const data = result?.data;
  if (typeof data === 'object' && data !== null && 'json' in data) {
    return (data as { json?: unknown }).json;
  }
  return data;
}

/**
 * Mint (or process-locally reuse) a signed BetterAuth magic-link session and
 * force the running server to execute its real auth.me self-heal before
 * returning. Caller owns `db`; this helper never destroys it.
 */
export async function mintMagicLinkSession(
  db: Database,
  input: MintMagicLinkSessionInput,
): Promise<MagicLinkSession> {
  const baseURL = input.baseURL ?? DEFAULT_BASE_URL;
  const normalizedEmail = input.email.trim().toLowerCase();
  const key = cacheKey(baseURL, normalizedEmail);
  const cached = sessionCache.get(key);
  if (cached) return cached;

  // The rate-limit table is production behavior. Clearing only this synthetic
  // E2E identity's email bucket makes repeated test processes deterministic;
  // the in-process cache above still proves a fixed identity does not generate
  // multiple sends during one suite run.
  await db
    .deleteFrom('rate_limit')
    .where('key', '=', `magic-link-email:${normalizedEmail}`)
    .execute();

  let capturedUrl: string | null = null;
  const auth = criarAuth(db, {
    secret: DEFAULT_SECRET,
    baseURL,
    trustedOrigins: [new URL(baseURL).origin],
    useSecureCookies: new URL(baseURL).protocol === 'https:',
    idPlataformaPadrao: ID_PLATAFORMA_EUNENEM,
    sendMagicLink: async ({ url }) => {
      capturedUrl = url;
    },
  });

  const sendResponse = await auth.handler(
    new Request(`${baseURL}/api/auth/sign-in/magic-link`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: new URL(baseURL).origin,
      },
      body: JSON.stringify({ email: normalizedEmail, name: input.name, callbackURL: '/' }),
    }),
  );
  if (!sendResponse.ok) {
    throw new Error(
      `magic-link E2E send failed for ${normalizedEmail}: ${sendResponse.status} ${await sendResponse.text()}`,
    );
  }
  if (!capturedUrl) throw new Error(`magic-link E2E sender was not invoked for ${normalizedEmail}`);

  const verifyResponse = await auth.handler(
    new Request(capturedUrl, { method: 'GET', redirect: 'manual' }),
  );
  if (![200, 302, 303, 307].includes(verifyResponse.status)) {
    throw new Error(
      `magic-link E2E verify failed for ${normalizedEmail}: ${verifyResponse.status} ${await verifyResponse.text()}`,
    );
  }
  const cookie = extractSessionCookie(verifyResponse);

  // This is the composition-root assertion: the running server, not a direct
  // domain helper, resolves the BetterAuth cookie and provisions the orphan via
  // resolverUsuarioAutenticadoOuNull -> provisionarContaUsuarioDominio.
  const meResponse = await fetch(`${baseURL}/api/trpc/auth.me`, {
    headers: { cookie: cookie.header },
  });
  const meBody: unknown = await meResponse.json().catch(() => null);
  const me = unwrapTrpcData(meBody);
  if (!meResponse.ok || typeof me !== 'object' || me === null) {
    throw new Error(
      `magic-link E2E auth.me self-heal failed for ${normalizedEmail}: ${meResponse.status} ${JSON.stringify(meBody)}`,
    );
  }
  const userId = (me as { idUsuario?: unknown }).idUsuario;
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new Error(`magic-link E2E auth.me returned no idUsuario: ${JSON.stringify(me)}`);
  }

  // Fixed E2E identities may retain a credential row from a pre-cusen local
  // run. It is inert after password auth is removed, but deleting it here keeps
  // the synthetic fixture state deterministic and proves no test depends on it.
  await db
    .deleteFrom('accounts')
    .where('user_id', '=', userId)
    .where('provider_id', '=', 'credential')
    .execute();
  const credential = await db
    .selectFrom('accounts')
    .select('id')
    .where('user_id', '=', userId)
    .where('provider_id', '=', 'credential')
    .executeTakeFirst();
  if (credential) {
    throw new Error(
      `magic-link E2E invariant violated: ${normalizedEmail} retained credential account ${credential.id}`,
    );
  }

  const session = { email: normalizedEmail, userId, cookie } satisfies MagicLinkSession;
  sessionCache.set(key, session);
  return session;
}

/** Cookie shape accepted by BrowserContext.addCookies. */
export function browserCookieFor(session: MagicLinkSession, baseURL: string = DEFAULT_BASE_URL) {
  const url = new URL(baseURL);
  return {
    name: session.cookie.name,
    value: session.cookie.value,
    domain: url.hostname,
    path: '/',
    httpOnly: true,
    secure: url.protocol === 'https:',
    sameSite: 'Lax' as const,
  };
}
