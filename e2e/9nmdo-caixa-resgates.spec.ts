/**
 * aperture-9nmdo — saídas do Fluxo de caixa == resgates da tela /admin/repasses
 * no mesmo período, pela interface.
 *
 * SÓ roda contra o Postgres efêmero do runner do 9bpre:
 *   node --import tsx e2e/support/9bpre-ephemeral-run.mjs e2e/9nmdo-caixa-resgates.spec.ts
 * Confere a identidade do banco antes de semear; nunca usa o banco de
 * desenvolvimento (localhost:54320).
 *
 * LEITURA PURA: repasses sintéticos direto no banco efêmero, em cada status
 * (provados em Postgres real por tests/integration/admin-caixa.postgres.test.ts,
 * C4/C10/C11). Nenhuma chamada a provedor, nada é aprovado nem enviado.
 */
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { sql } from 'kysely';
import { addDays, localDateInSaoPaulo } from '../apps/eunenem-server/pages/lib/receitaPeriodo.js';
import { createDatabase, type Database } from '../src/adapters/database.js';
import { ReceitaLedgerSeed } from '../tests/helpers/receita-ledger-seed.js';
import { expect, test } from './fixtures.js';
import { browserCookieFor, mintMagicLinkSession } from './magic-link-auth.js';

const DEV_DB_PORT = '54320';

test.use({ trace: 'off', video: 'off' });

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
function brl(cents: number): RegExp {
  return new RegExp(
    BRL.format(cents / 100)
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/[\s ]/g, '[\\s\\u00a0]'),
  );
}

async function semOverflow(page: Page, onde: string) {
  const g = await page.evaluate(() => ({
    viewport: window.innerWidth,
    documento: document.documentElement.scrollWidth,
  }));
  expect(g.documento, `sem overflow horizontal em ${onde}`).toBeLessThanOrEqual(g.viewport);
}

test('9nmdo: saídas do caixa == resgates aceitos pelo banco na tela de resgates', async ({
  browser,
  baseURL,
}, testInfo) => {
  test.skip(
    !process.env.E2E_9BPRE_CONTAINER,
    'roda apenas pelo runner efêmero: node --import tsx e2e/support/9bpre-ephemeral-run.mjs e2e/9nmdo-caixa-resgates.spec.ts',
  );
  test.setTimeout(180_000);
  expect(baseURL).toBe('http://localhost:3002');

  const uri = process.env.E2E_DATABASE_URL ?? '';
  expect(uri, 'E2E_DATABASE_URL explícito é obrigatório').not.toBe('');
  const target = new URL(uri);
  expect(['localhost', '127.0.0.1']).toContain(target.hostname);
  expect(target.port).not.toBe(DEV_DB_PORT);
  expect(target.port).toBe(process.env.E2E_9BPRE_DB_PORT);
  expect(process.env.E2E_9BPRE_CONTAINER).toMatch(/^[0-9a-f]{12}$/);

  const db: Database = createDatabase(uri);
  try {
    const identity = await sql<{ name: string; oid: string }>`
      SELECT current_database() AS name, oid::text AS oid
      FROM pg_database WHERE datname = current_database()
    `.execute(db);
    expect(identity.rows[0]).toEqual({
      name: process.env.E2E_9BPRE_DB_NAME,
      oid: process.env.E2E_9BPRE_DB_OID,
    });
    const fresh = await sql<{
      n: number;
    }>`SELECT count(*)::int AS n FROM repasses_recebedor`.execute(db);
    expect(fresh.rows[0]?.n, 'banco efêmero precisa começar vazio').toBe(0);

    // Período: os últimos 10 dias até ontem (SP), longe da virada do dia.
    const hoje = localDateInSaoPaulo(new Date());
    const de = addDays(hoje, -10);
    const ate = hoje; // exclusivo
    const em = (dia: string) => new Date(`${dia}T12:00:00-03:00`);

    const seed = new ReceitaLedgerSeed(db);
    const campanha = await seed.campanha();
    const repasse = async (
      status: string,
      cents: number,
      extra: { inter?: string; ref?: string; enviadoEm?: Date; aprovadoEm?: Date | null } = {},
    ) => {
      const id = randomUUID();
      await sql`
        INSERT INTO repasses_recebedor
          (id, id_campanha, amount_cents, status, solicitado_em, aprovado_em,
           inter_codigo_solicitacao, bank_transfer_ref, enviado_ao_banco_em)
        VALUES (${id}::uuid, ${campanha}::uuid, ${cents}, ${status}, ${em(de)},
          ${extra.aprovadoEm === undefined ? em(de) : extra.aprovadoEm},
          ${extra.inter ?? null}, ${extra.ref ?? null}, ${extra.enviadoEm ?? null})
      `.execute(db);
      return id;
    };
    // Aceitos pelo banco no período: saída.
    await repasse('enviado_ao_banco', 12_345, { inter: 'e2e-1', enviadoEm: em(addDays(de, 2)) });
    await repasse('pago', 6_789, { inter: 'e2e-2', enviadoEm: em(addDays(de, 3)) });
    await repasse('aprovado', 1_000, { ref: 'TED-E2E', aprovadoEm: em(addDays(de, 4)) });
    // Fora: antes do período, não aceitos, cancelado.
    await repasse('enviado_ao_banco', 99_999, { inter: 'e2e-3', enviadoEm: em(addDays(de, -1)) });
    await repasse('falhou', 5_555);
    await repasse('aprovado', 4_444);
    await repasse('verificando', 3_333, { inter: 'e2e-4' });
    await repasse('cancelado', 2_222);
    const totalSaidas = 12_345 + 6_789 + 1_000;

    const session = await mintMagicLinkSession(db, {
      email: 'e2e-admin@e2e.local',
      name: 'E2e Admin',
      baseURL,
    });

    for (const viewport of [
      { width: 1280, height: 1200 },
      { width: 375, height: 812 },
    ]) {
      const tag = String(viewport.width);
      const context = await browser.newContext({ viewport });
      const erros: string[] = [];
      await context.route('**/*', (route) => {
        const u = new URL(route.request().url());
        return ['localhost', '127.0.0.1'].includes(u.hostname) ||
          ['data:', 'blob:'].includes(u.protocol)
          ? route.continue()
          : route.abort('blockedbyclient');
      });
      await context.addCookies([browserCookieFor(session, baseURL)]);
      const page = await context.newPage();
      page.on('pageerror', (e) => erros.push(`${e.name}: ${e.message}`));
      page.on('response', (r) => {
        if (r.status() >= 500) erros.push(`HTTP ${r.status()} ${new URL(r.url()).pathname}`);
      });
      page.on('console', (e) => {
        if (e.type() === 'error' && !e.text().includes('ERR_BLOCKED_BY_CLIENT'))
          erros.push(e.text());
      });
      try {
        // 1. Fluxo de caixa no período.
        const qs = new URLSearchParams({ de, ate, g: 'dia' });
        expect((await page.goto(`${baseURL}/admin/pagamentos/caixa?${qs}`))?.status()).toBe(200);
        const saiu = page.getByText('3 resgate(s) aceito(s) pelo banco').locator('..');
        await expect(saiu).toContainText('Saiu');
        await expect(saiu).toContainText(brl(totalSaidas));
        const tabelaCaixa = page.getByTestId('resgates-efetuados');
        await expect(tabelaCaixa.locator('tbody tr')).toHaveCount(4); // 3 + total
        await expect(tabelaCaixa).toContainText(brl(totalSaidas));
        await expect(tabelaCaixa).toContainText('Manual · TED-E2E');
        await expect(tabelaCaixa).not.toContainText(brl(99_999));
        const linhasCaixa = await tabelaCaixa.locator('tbody tr').allInnerTexts();
        await page.screenshot({ path: testInfo.outputPath(`caixa-${tag}.png`), fullPage: true });
        await semOverflow(page, `caixa ${tag}`);

        // 2. Mesmo período na tela de resgates, pelo link do caixa.
        await page.getByRole('link', { name: 'ver na tela de resgates →' }).click();
        await expect(page).toHaveURL(new RegExp(`/admin/repasses\\?de=${de}&ate=${ate}$`));
        const tabelaResgates = page.getByTestId('resgates-efetuados');
        await expect(tabelaResgates.locator('tbody tr')).toHaveCount(4);
        await expect(tabelaResgates.locator('tbody tr').last()).toContainText(brl(totalSaidas));
        await expect(page.getByTestId('resgates-efetuados-total')).toContainText(brl(totalSaidas));
        // Linha a linha igual ao caixa (mesma consulta, mesma tabela).
        expect(await tabelaResgates.locator('tbody tr').allInnerTexts()).toEqual(linhasCaixa);
        // O formulário mostra o último dia incluído; limpar tira o filtro.
        await expect(page.getByLabel('Até (inclusive)')).toHaveValue(addDays(ate, -1));
        await page.screenshot({ path: testInfo.outputPath(`resgates-${tag}.png`), fullPage: true });
        await semOverflow(page, `resgates ${tag}`);
        await page.getByRole('button', { name: 'Limpar período' }).click();
        await expect(page.getByTestId('resgates-efetuados')).toHaveCount(0);
        await expect(page).toHaveURL(/\/admin\/repasses$/);

        // 3. Filtro aplicado à mão na tela de resgates dá o mesmo total.
        await page.getByLabel('Aceitos pelo banco de').fill(de);
        await page.getByLabel('Até (inclusive)').fill(addDays(ate, -1));
        await page.getByRole('button', { name: 'Filtrar período' }).click();
        await expect(
          page.getByTestId('resgates-efetuados').locator('tbody tr').last(),
        ).toContainText(brl(totalSaidas));
        expect(erros).toEqual([]);
      } finally {
        await context.close();
      }
    }
  } finally {
    await db.destroy();
  }
});
