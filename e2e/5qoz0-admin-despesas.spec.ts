/**
 * aperture-5qoz0 PR3 — aba Despesas (/admin/pagamentos/despesas) pela interface.
 *
 * SÓ roda contra o Postgres efêmero do runner do 9bpre:
 *   node --import tsx e2e/support/9bpre-ephemeral-run.mjs e2e/5qoz0-admin-despesas.spec.ts
 * Confere a identidade do banco antes de semear; nunca usa o banco de
 * desenvolvimento (localhost:54320).
 *
 * LEITURA PURA: fixtures sintéticas diretas no banco efêmero (pagamentos via
 * tests/helpers/receita-ledger-seed.ts; tarifas no shape do sync do PR1),
 * provadas em Postgres real por tests/integration/despesas-painel.postgres.test.ts.
 * Nenhuma chamada a provedor.
 */
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { sql } from 'kysely';
import {
  addDays,
  localDateInSaoPaulo,
  mesAtual,
  semanaAtual,
} from '../apps/eunenem-server/pages/lib/receitaPeriodo.js';
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
      .replace(/[\s ]/g, '[\\s\\u00a0]'),
  );
}

function sp(data: string, hora: string): Date {
  return new Date(`${data}T${hora}-03:00`);
}

async function semOverflow(page: Page, onde: string) {
  const g = await page.evaluate(() => ({
    viewport: window.innerWidth,
    documento: document.documentElement.scrollWidth,
  }));
  expect(g.documento, `sem overflow horizontal em ${onde}`).toBeLessThanOrEqual(g.viewport);
}

async function kpisSemSobreposicao(page: Page) {
  const problemas = await page
    .locator('[data-testid="despesas-kpi-valor"]')
    .evaluateAll((valores) =>
      valores.flatMap((valor) => {
        const coluna = valor.parentElement;
        if (!coluna) return ['indicador sem coluna'];
        const limite = coluna.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(valor);
        const fora = Array.from(range.getClientRects()).some(
          (rect) => rect.left < limite.left - 1 || rect.right > limite.right + 1,
        );
        return fora || valor.scrollWidth > valor.clientWidth + 1 ? [valor.textContent] : [];
      }),
    );
  expect(problemas, 'valores e avisos precisam caber na própria coluna').toEqual([]);
}

test('5qoz0: Despesas — KPIs por provedor, cobertura pendente e não vinculadas', async ({
  browser,
  baseURL,
}, testInfo) => {
  test.skip(
    !process.env.E2E_9BPRE_CONTAINER,
    'roda apenas pelo runner efêmero: node --import tsx e2e/support/9bpre-ephemeral-run.mjs e2e/5qoz0-admin-despesas.spec.ts',
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
    const fresh = await sql<{ n: number }>`SELECT count(*)::int AS n FROM pagamentos`.execute(db);
    expect(fresh.rows[0]?.n, 'banco efêmero precisa começar vazio').toBe(0);

    const agora = new Date();
    const hoje = localDateInSaoPaulo(agora);
    const mes = mesAtual(agora);
    const semana = semanaAtual(agora);
    test.skip(agora < sp(mes.de, '02:00:00'), 'primeira hora do mês: fixtures cairiam no futuro');

    const seed = new ReceitaLedgerSeed(db);
    const campanha = await seed.campanha();
    const tarifa = async (
      provider: 'stripe' | 'inter',
      cents: number,
      em: Date,
      paymentId: string | null,
    ) => {
      await sql`
        INSERT INTO provider_fee_events
          (provider, account_ref, environment, external_ref, payment_id, amount_cents,
           currency, occurred_at, observed_at, source)
        VALUES (${provider}, 'acct_e2e', 'test', ${`e2e-${randomUUID()}`}, ${paymentId}::uuid,
          ${cents}, 'brl', ${em}, ${agora}, 'e2e')
      `.execute(db);
    };
    const sync = async (paymentId: string, status: 'pending' | 'confirmed' | 'failed') => {
      await sql`
        INSERT INTO provider_fee_sync (payment_id, status, attempts, next_attempt_at, updated_at)
        VALUES (${paymentId}::uuid, ${status}, 1, ${agora}, ${new Date(agora.getTime() - 60_000)})
      `.execute(db);
    };

    // Meses anteriores: uma tarifa Stripe e uma Inter por mês (série visível).
    let deMes = mes.de;
    for (let k = 1; k <= 11; k++) {
      deMes = `${addDays(deMes, -1).slice(0, 8)}01`;
      const dia = sp(addDays(deMes, 9), '12:00:00');
      const cartao = await seed.pagamento({
        campaignId: campanha,
        taxaCents: 500,
        criadoEm: dia,
        provedor: 'stripe',
      });
      await tarifa('stripe', 3_000 + k * 400, dia, cartao.idPagamento);
      // O sync confirma no mesmo passo em que grava a tarifa.
      await sync(cartao.idPagamento, 'confirmed');
      const pix = await seed.pagamento({
        campaignId: campanha,
        taxaCents: 300,
        criadoEm: dia,
        provedor: 'inter',
      });
      await tarifa('inter', 99 * (k + 5), dia, pix.idPagamento);
    }

    // Mês atual, dentro da semana corrente quando possível.
    const diaAtual = sp(semana.de > mes.de ? semana.de : mes.de, '03:00:00');
    const confirmado = await seed.pagamento({
      campaignId: campanha,
      taxaCents: 500,
      criadoEm: diaAtual,
      provedor: 'stripe',
    });
    await sync(confirmado.idPagamento, 'confirmed');
    await tarifa('stripe', 467, diaAtual, confirmado.idPagamento);
    const pixAtual = await seed.pagamento({
      campaignId: campanha,
      taxaCents: 300,
      criadoEm: diaAtual,
      provedor: 'inter',
    });
    await tarifa('inter', 99, diaAtual, pixAtual.idPagamento);
    // Dois pendentes (um sem linha de sync) e um falho, sem tarifa: nunca R$ 0.
    const pendente = await seed.pagamento({
      campaignId: campanha,
      taxaCents: 500,
      criadoEm: diaAtual,
      provedor: 'stripe',
    });
    await sync(pendente.idPagamento, 'pending');
    await seed.pagamento({
      campaignId: campanha,
      taxaCents: 500,
      criadoEm: diaAtual,
      provedor: 'stripe',
    });
    const falho = await seed.pagamento({
      campaignId: campanha,
      taxaCents: 500,
      criadoEm: diaAtual,
      provedor: 'stripe',
    });
    await sync(falho.idPagamento, 'failed');
    // Tarifa Inter sem vínculo: visível, fora do total.
    await tarifa('inter', 150, diaAtual, null);

    const session = await mintMagicLinkSession(db, {
      email: 'e2e-admin@e2e.local',
      name: 'E2e Admin',
      baseURL,
    });

    for (const viewport of [
      { width: 1280, height: 1400 },
      { width: 1536, height: 1200 },
      { width: 1920, height: 1200 },
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
        const resposta = await page.goto(`${baseURL}/admin/pagamentos/despesas`);
        expect(resposta?.status()).toBe(200);
        await expect(page.getByRole('heading', { level: 1, name: 'Despesas' })).toBeVisible();
        await expect(page.getByRole('link', { name: 'Despesas' })).toHaveAttribute(
          'aria-current',
          'page',
        );
        await expect(page.getByRole('link', { name: 'Receita EuNeném' })).toBeVisible();

        const kpiMes = page.getByTestId('despesas-kpi-mes');
        await expect(kpiMes.getByTestId('despesas-kpi-stripe')).toContainText(brl(467));
        await expect(kpiMes.getByTestId('despesas-kpi-inter')).toContainText(brl(99));
        await expect(kpiMes.getByTestId('despesas-kpi-total')).toContainText(brl(566));
        await expect(kpiMes.getByTestId('despesas-kpi-stripe-cobertura')).toHaveText(
          '1 confirmada · 2 pendentes · 1 falha',
        );
        await expect(page.getByTestId('despesas-kpi-mes-nao-vinculadas')).toContainText(
          /1 tarifa · R\$[\s ]1,50 \(fora do total\)/,
        );
        await expect(page.getByTestId('despesas-mes')).toHaveCount(12);
        // Inter: os PIX desde 01/09/2026 (setembro e o mês atual) têm tarifa vinculada.
        await expect(page.getByTestId('despesas-cobertura-inter')).toContainText(
          '2 confirmadas · nenhuma pendente',
        );
        // Stripe tem pendência no mês: subtotal marcado, total incompleto.
        await expect(
          kpiMes.getByTestId('despesas-kpi-stripe').getByTestId('despesas-kpi-valor'),
        ).toContainText('observados');
        await expect(
          kpiMes.getByTestId('despesas-kpi-total').getByTestId('despesas-kpi-valor'),
        ).toContainText('observados · incompleto');
        await expect(
          page.locator('[data-testid="despesas-mes"][data-parcial="true"]'),
        ).toHaveAttribute('data-completo', 'false');
        expect(hoje >= mes.de).toBe(true);

        await page.screenshot({ path: testInfo.outputPath(`despesas-${tag}.png`), fullPage: true });
        await semOverflow(page, `/admin/pagamentos/despesas ${tag}`);
        await kpisSemSobreposicao(page);
        // Valores maiores e estados extensos também precisam caber sem invadir o vizinho.
        await page.getByTestId('despesas-kpi-valor').evaluateAll((valores) => {
          for (const valor of valores) {
            if (valor.firstChild) valor.firstChild.textContent = 'R$ 9.999.999.999,99';
          }
        });
        await kpisSemSobreposicao(page);
        expect(erros).toEqual([]);
      } finally {
        await context.close();
      }
    }
  } finally {
    await db.destroy();
  }
});
