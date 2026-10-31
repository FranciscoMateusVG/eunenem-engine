import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { createDatabase } from '../src/adapters/database.js';
import { criarAuth } from '../src/adapters/usuario/criar-auth.js';
import { ID_PLATAFORMA_EUNENEM } from '../src/index.js';
import { expect, test } from './fixtures.js';

test.use({ trace: 'off', video: 'off' });
test('guvaw: first entry on FAQ survives navigation and real signup, immutable on login', async ({
  browser,
  baseURL,
}) => {
  test.skip(!process.env.E2E_9BPRE_CONTAINER, 'isolated ephemeral database only');
  expect(baseURL).toBe('http://localhost:3002');
  if (!baseURL) throw new Error('baseURL required');
  const uri = new URL(process.env.E2E_DATABASE_URL ?? '');
  expect(['localhost', '127.0.0.1']).toContain(uri.hostname);
  expect(uri.port).not.toBe('54320');
  expect(uri.port).toBe(process.env.E2E_9BPRE_DB_PORT);
  const db = createDatabase(uri.toString());
  const ctx = await browser.newContext();
  await ctx.route('**/*', (route) =>
    new URL(route.request().url()).hostname === 'localhost' ? route.continue() : route.abort(),
  );
  try {
    const identity = await sql<{
      name: string;
      oid: string;
    }>`SELECT current_database() AS name,oid::text AS oid FROM pg_database WHERE datname=current_database()`.execute(
      db,
    );
    expect(identity.rows[0]).toEqual({
      name: process.env.E2E_9BPRE_DB_NAME,
      oid: process.env.E2E_9BPRE_DB_OID,
    });
    const page = await ctx.newPage();
    await page.goto(
      `${baseURL}/faq?utm_source=google&utm_medium=cpc&utm_campaign=synthetic&gclid=synthetic-click`,
    );
    await expect
      .poll(async () => (await ctx.cookies()).some((c) => c.name === 'eunenem_first_touch'))
      .toBe(true);
    await page.goto(`${baseURL}/?utm_source=overwrite`);
    let magicUrl = '';
    const auth = criarAuth(db, {
      secret: process.env.BETTER_AUTH_SECRET ?? 'e2e-test-secret-must-be-at-least-32-chars-long-ok',
      baseURL: baseURL,
      trustedOrigins: [baseURL],
      idPlataformaPadrao: ID_PLATAFORMA_EUNENEM,
      useSecureCookies: false,
      sendMagicLink: async ({ url }) => {
        magicUrl = url;
      },
    });
    const email = `guvaw-${randomUUID()}@example.test`;
    const signIn = await auth.handler(
      new Request(`${baseURL}/api/auth/sign-in/magic-link`, {
        method: 'POST',
        headers: { origin: baseURL, 'content-type': 'application/json' },
        body: JSON.stringify({ email, name: 'Synthetic attribution', callbackURL: '/campanhas' }),
      }),
    );
    expect(signIn.status).toBe(200);
    expect(magicUrl).not.toBe('');
    const response = await auth.handler(new Request(magicUrl));
    const pair = response.headers
      .getSetCookie()
      .find((c) => c.includes('session_token='))
      ?.split(';')[0];
    if (!pair) throw new Error('Missing session cookie');
    const separator = pair.indexOf('=');
    await ctx.addCookies([
      { name: pair.slice(0, separator), value: pair.slice(separator + 1), url: baseURL },
    ]);
    await page.goto(`${baseURL}/campanhas`);
    const row = () =>
      db
        .selectFrom('usuarios')
        .select([
          'signup_utm_source',
          'signup_utm_medium',
          'signup_utm_campaign',
          'signup_gclid',
          'signup_landing_path',
        ])
        .where('email', '=', email)
        .executeTakeFirst();
    const expected = {
      signup_utm_source: 'google',
      signup_utm_medium: 'cpc',
      signup_utm_campaign: 'synthetic',
      signup_gclid: 'synthetic-click',
      signup_landing_path: '/faq',
    };
    await expect.poll(row).toEqual(expected);
    // Even a forged later cookie cannot rewrite the already persisted account.
    await ctx.addCookies([
      {
        name: 'eunenem_first_touch',
        value: encodeURIComponent(
          JSON.stringify({
            utm_source: 'other',
            utm_medium: null,
            utm_campaign: null,
            utm_term: null,
            utm_content: null,
            gclid: null,
            gbraid: null,
            wbraid: null,
            referrer: null,
            landing_path: '/',
            captured_at: new Date().toISOString(),
          }),
        ),
        url: baseURL,
      },
    ]);
    await page.goto(`${baseURL}/campanhas`);
    expect(await row()).toEqual(expected);
  } finally {
    await ctx.close();
    await db.destroy();
  }
});
