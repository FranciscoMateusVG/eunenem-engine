import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import {
  addDays,
  addMonthsToMonthStart,
  localDateInSaoPaulo,
  startOfMonth,
} from '../apps/eunenem-server/pages/lib/receitaPeriodo.js';
import { createDatabase } from '../src/adapters/database.js';
import { ID_PLATAFORMA_EUNENEM } from '../src/index.js';
import { expect, test } from './fixtures.js';
import { browserCookieFor, mintMagicLinkSession } from './magic-link-auth.js';

test.use({ trace: 'off', video: 'off' });
test('pxmdy: admin-only real, meses 3/6/12, semanas e screenshots', async ({
  browser,
  baseURL,
}, testInfo) => {
  test.skip(!process.env.E2E_9BPRE_CONTAINER, 'requires isolated 9bpre ephemeral runner');
  test.setTimeout(120000);
  expect(baseURL).toBe('http://localhost:3002');
  const uri = process.env.E2E_DATABASE_URL ?? '';
  const target = new URL(uri);
  expect(['localhost', '127.0.0.1']).toContain(target.hostname);
  expect(target.port).not.toBe('54320');
  expect(target.port).toBe(process.env.E2E_9BPRE_DB_PORT);
  const db = createDatabase(uri);
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
    const fresh = await db
      .selectFrom('usuarios')
      .select(({ fn }) => fn.countAll().as('n'))
      .executeTakeFirstOrThrow();
    expect(Number(fresh.n)).toBe(0);
    const hoje = localDateInSaoPaulo(new Date());
    const month = startOfMonth(hoje);
    for (let i = 0; i < 12; i++)
      for (let j = 0; j <= i; j++) {
        const id = randomUUID();
        const day = addDays(
          addMonthsToMonthStart(month, i - 11),
          Math.min(j, Number(hoje.slice(-2)) - 1),
        );
        await db
          .insertInto('usuarios')
          .values({
            id,
            id_conta: randomUUID(),
            id_plataforma: ID_PLATAFORMA_EUNENEM,
            email: `${id}@customer.invalid`,
            nome_exibicao: 'Cliente sintético visual',
            slug: id.slice(0, 30),
            criado_em: new Date(`${day}T03:00:00Z`),
          })
          .execute();
      }
    // Same exclusion as the report: names containing sintético would be excluded.
    await db.updateTable('usuarios').set({ nome_exibicao: 'Cliente visual' }).execute();
    const admin = await mintMagicLinkSession(db, {
      email: 'e2e-admin@e2e.local',
      name: 'Admin',
      baseURL,
    });
    const normal = await mintMagicLinkSession(db, {
      email: 'ordinary@e2e.local',
      name: 'Usuário comum',
      baseURL,
    });
    for (const [session, status] of [
      [null, 401],
      [normal, 403],
    ] as const) {
      const ctx = await browser.newContext();
      try {
        if (session) await ctx.addCookies([browserCookieFor(session, baseURL)]);
        expect((await ctx.request.get(`${baseURL}/api/trpc/admin.estatisticas`)).status()).toBe(
          status,
        );
        const page = await ctx.newPage();
        await page.goto(`${baseURL}/admin/estatisticas`);
        await expect(page.getByTestId('estatisticas-total')).toHaveCount(0);
      } finally {
        await ctx.close();
      }
    }
    for (const width of [1280, 375]) {
      const ctx = await browser.newContext({ viewport: { width, height: 1000 } });
      try {
        await ctx.route('**/*', (route) => {
          const u = new URL(route.request().url());
          return ['localhost', '127.0.0.1'].includes(u.hostname) ? route.continue() : route.abort();
        });
        await ctx.addCookies([browserCookieFor(admin, baseURL)]);
        const page = await ctx.newPage();
        await page.goto(`${baseURL}/admin/estatisticas`);
        await expect(
          page.getByRole('heading', { name: 'Estatísticas', exact: true }),
        ).toBeVisible();
        await expect(page.getByTestId('estatisticas-total')).toHaveText('78');
        const select = page.getByRole('combobox', { name: 'Período mensal' });
        await expect(select).toHaveValue('3');
        await expect(page.getByTestId('estatisticas-semana')).toHaveCount(12);
        for (const n of [3, 6, 12]) {
          await select.selectOption(String(n));
          await expect(page.getByTestId('estatisticas-mes')).toHaveCount(n);
        }
        await select.selectOption('3');
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`pxmdy-${width}.png`), fullPage: true });
      } finally {
        await ctx.close();
      }
    }
  } finally {
    await db.destroy();
  }
});
