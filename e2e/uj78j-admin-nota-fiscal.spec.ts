/**
 * aperture-uj78j — página admin da prévia da NFS-e mensal
 * (/admin/pagamentos/nota-fiscal), em 1440×900 e 375×812.
 *
 * SÓ roda pelo runner efêmero (e2e/support/uj78j-nfse-ephemeral-run.mjs), que
 * sobe um Postgres exclusivo e dá aos servidores NFSE_* com um e-CNPJ de teste
 * gerado na hora. Antes de semear, o spec confere a identidade do banco.
 *
 * Prova pela interface: o valor do mês é o da Receita (bordas de SP e
 * cancelamento no mês seguinte), o XML exibido valida no XSD oficial e tem
 * assinatura XMLDsig que confere, mês negativo não gera DPS, não existe
 * ação de envio, segredos do certificado não chegam ao navegador e quem não é
 * admin não vê a página.
 */
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { sql } from 'kysely';
import { mesAnterior, mesAtualSP } from '../apps/eunenem-server/pages/lib/notaFiscalMes.js';
import { createDatabase, type Database } from '../src/adapters/database.js';
import { validateDps } from '../tests/helpers/nfse-xsd.js';
import { ReceitaLedgerSeed } from '../tests/helpers/receita-ledger-seed.js';
import { verificarAssinaturaDps } from '../tests/helpers/xmldsig-verify.js';
import { expect, test } from './fixtures.js';
import { browserCookieFor, mintMagicLinkSession } from './magic-link-auth.js';
import { seedCampanhaOwner } from './repasse-seed.js';

const DEV_DB_PORT = '54320';
const CNPJ = '11222333000181';

// Credenciais ficam em memória; sem trace/vídeo com cookie de sessão.
test.use({ trace: 'off', video: 'off' });

function brl(cents: number): RegExp {
  const texto = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
    .format(cents / 100)
    .replace(/\u00a0/g, ' ');
  return new RegExp(texto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '[\\s\\u00a0]'));
}

/** Primeiro instante do mês em SP (UTC−3, sem horário de verão desde 2019). */
const inicioSP = (mes: string, dia = 1, hhmm = '00:00') =>
  new Date(`${mes}-${String(dia).padStart(2, '0')}T${hhmm}:00-03:00`);

function proximoMes(mes: string): string {
  const [a, m] = mes.split('-').map(Number) as [number, number];
  return m === 12 ? `${a + 1}-01` : `${a}-${String(m + 1).padStart(2, '0')}`;
}

async function semOverflow(page: Page, onde: string) {
  const g = await page.evaluate(() => ({
    viewport: window.innerWidth,
    documento: document.documentElement.scrollWidth,
  }));
  expect(g.documento, `sem overflow horizontal em ${onde}`).toBeLessThanOrEqual(g.viewport);
}

/** Trechos que, se aparecerem no navegador, são vazamento do certificado. */
function segredos(): string[] {
  const senha = process.env.NFSE_CERT_PASSWORD ?? '';
  const pfx = process.env.NFSE_CERT_BASE64 ?? '';
  expect(senha, 'runner precisa passar a senha de teste').not.toBe('');
  expect(pfx.length).toBeGreaterThan(500);
  return [senha, ...[0, 300, 900, pfx.length - 60].map((i) => pfx.slice(i, i + 48))];
}

test('uj78j: prévia da NFS-e mensal no admin', async ({ browser, baseURL }, testInfo) => {
  test.skip(
    !process.env.E2E_UJ78J_CONTAINER,
    'roda apenas pelo runner efêmero: node --import tsx e2e/support/uj78j-nfse-ephemeral-run.mjs',
  );
  test.setTimeout(180_000);
  expect(baseURL).toBe('http://localhost:3002');

  // ── Identidade do banco ANTES de qualquer seed ──────────────────────────
  const uri = process.env.E2E_DATABASE_URL ?? '';
  expect(uri, 'E2E_DATABASE_URL explícito é obrigatório').not.toBe('');
  const target = new URL(uri);
  expect(['localhost', '127.0.0.1']).toContain(target.hostname);
  expect(target.port).not.toBe(DEV_DB_PORT);
  expect(target.port).toBe(process.env.E2E_UJ78J_DB_PORT);
  expect(process.env.E2E_UJ78J_CONTAINER).toMatch(/^[0-9a-f]{12}$/);

  const db: Database = createDatabase(uri);
  try {
    const identity = await sql<{ name: string; oid: string }>`
      SELECT current_database() AS name, oid::text AS oid
      FROM pg_database WHERE datname = current_database()
    `.execute(db);
    expect(identity.rows[0]).toEqual({
      name: process.env.E2E_UJ78J_DB_NAME,
      oid: process.env.E2E_UJ78J_DB_OID,
    });
    const fresh = await sql<{ n: number }>`SELECT count(*)::int AS n FROM usuarios`.execute(db);
    expect(fresh.rows[0]?.n, 'banco efêmero precisa começar vazio').toBe(0);

    // ── Fixtures: meses relativos ao relógio real (o servidor usa o mesmo) ─
    const agora = new Date();
    const atual = mesAtualSP(agora);
    const m1 = mesAnterior(atual); // mês fechado padrão da página
    const m2 = mesAnterior(m1);
    const m3 = mesAnterior(m2);
    const m4 = mesAnterior(m3);
    const futuro = proximoMes(atual);

    const seed = new ReceitaLedgerSeed(db);
    const campanha = await seed.campanha();
    // m1, primeiro instante em SP.
    await seed.taxa({ campaignId: campanha, taxaCents: 12_345, criadoEm: inicioSP(m1) });
    // m1, último minuto em SP (já é o dia 1 seguinte em UTC).
    await seed.taxa({
      campaignId: campanha,
      taxaCents: 200,
      criadoEm: new Date(inicioSP(atual).getTime() - 60_000),
    });
    // Primeiro instante do mês corrente em SP: NÃO é m1.
    await seed.taxa({ campaignId: campanha, taxaCents: 4_000, criadoEm: inicioSP(atual) });
    // m2, cancelada em m1: +1000 em m2, −1000 em m1.
    await seed.taxa({
      campaignId: campanha,
      taxaCents: 1_000,
      criadoEm: inicioSP(m2, 10, '12:00'),
      canceladoEm: inicioSP(m1, 10, '12:00'),
      status: 'estornado',
    });
    // m4, cancelada em m3: m3 fica negativo.
    await seed.taxa({
      campaignId: campanha,
      taxaCents: 5_000,
      criadoEm: inicioSP(m4, 10, '12:00'),
      canceladoEm: inicioSP(m3, 10, '12:00'),
      status: 'estornado',
    });
    const VALOR_M1 = 12_345 + 200 - 1_000; // 11545 ⇒ R$ 115,45

    const admin = await mintMagicLinkSession(db, {
      email: 'e2e-admin@e2e.local',
      name: 'E2e Admin',
      baseURL,
    });
    const owner = await seedCampanhaOwner(db, `qauj78j-${randomUUID().slice(0, 8)}@fake.test`);

    const proibidos = segredos();

    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 375, height: 812 },
    ]) {
      const tag = String(viewport.width);
      const context = await browser.newContext({ viewport });
      const pageErrors: string[] = [];
      const respostas: string[] = [];
      await context.route('**/*', (route) => {
        const u = new URL(route.request().url());
        return ['localhost', '127.0.0.1'].includes(u.hostname) ||
          ['data:', 'blob:'].includes(u.protocol)
          ? route.continue()
          : route.abort('blockedbyclient');
      });
      await context.addCookies([browserCookieFor(admin, baseURL)]);
      const page = await context.newPage();
      page.on('pageerror', (e) => pageErrors.push(`${e.name}: ${e.message}`));
      page.on('response', async (r) => {
        if (r.status() >= 500) pageErrors.push(`HTTP ${r.status()} ${new URL(r.url()).pathname}`);
        if (r.url().includes('/api/trpc/')) {
          respostas.push(await r.text().catch(() => ''));
        }
      });

      try {
        // ── (1) Chega pela aba de Pagamentos; mês padrão é o anterior ─────
        await page.goto(`${baseURL}/admin/pagamentos`);
        const aba = page
          .getByRole('navigation', { name: 'Seções de pagamentos' })
          .getByRole('link', { name: 'Nota fiscal (prévia)' });
        await aba.click();
        await expect(page).toHaveURL(/\/admin\/pagamentos\/nota-fiscal/);
        await expect(
          page.getByRole('heading', { name: 'Prévia da NFS-e mensal', level: 1 }),
        ).toBeVisible();
        await expect(page.getByRole('note')).toContainText('Nenhuma nota é emitida');
        await expect(page.getByLabel('Mês de competência')).toHaveValue(m1);

        // ── (2) Valor = Resultado de taxas de m1, com bordas de SP ─────────
        await expect(page.getByTestId('nf-valor')).toHaveText(brl(VALOR_M1));
        await expect(page.getByRole('heading', { name: /^Valor da nota de / })).toBeVisible();

        // ── (3) DPS assinada; o XML exibido valida e a assinatura confere ──
        await expect(page.getByTestId('nf-assinatura')).toContainText('assinada');
        await expect(page.getByTestId('nf-assinatura')).toContainText(CNPJ);
        await expect(page.getByRole('heading', { name: 'XML da DPS (assinado)' })).toBeVisible();
        const xml = (await page.getByTestId('nf-xml').textContent()) ?? '';
        expect(xml).toContain('<vServ>115.45</vServ>');
        expect(validateDps(xml)).toEqual({ ok: true, errors: [] });
        const dsig = verificarAssinaturaDps(xml);
        expect(dsig.digestConfere).toBe(true);
        expect(dsig.assinaturaConfere).toBe(true);
        expect(dsig.certificadoBase64).toBe(process.env.E2E_UJ78J_CERT_B64);
        expect(await page.locator('[data-a-confirmar="true"]').count()).toBeGreaterThan(0);
        await expect(page.locator('tr[data-campo="vServ"]')).toContainText('115.45');

        // ── (4) Não existe ação de envio ───────────────────────────────────
        await expect(
          page.getByRole('button', { name: /emitir|enviar|transmitir|cancelar nota/i }),
        ).toHaveCount(0);

        await page.screenshot({
          path: testInfo.outputPath(`nota-fiscal-${tag}.png`),
          fullPage: true,
        });
        await semOverflow(page, `nota-fiscal ${tag}`);

        // ── (5) Mesmo número na aba Receita para o mesmo mês ───────────────
        const de = `${m1}-01`;
        const ate = `${atual}-01`;
        await page.goto(`${baseURL}/admin/pagamentos/receita?de=${de}&ate=${ate}&g=mes`);
        await expect(page.getByText(brl(VALOR_M1)).first()).toBeVisible();

        // ── (6) Mês negativo: sem DPS ──────────────────────────────────────
        await page.goto(`${baseURL}/admin/pagamentos/nota-fiscal`);
        await page.getByLabel('Mês de competência').fill(m3);
        await page.getByRole('button', { name: 'Ver prévia' }).click();
        await expect(page).toHaveURL(new RegExp(`\\?mes=${m3}$`));
        await expect(page.getByTestId('nf-valor')).toHaveText(brl(-5_000));
        await expect(
          page.getByText('Sem DPS: o resultado de taxas do mês não é positivo'),
        ).toBeVisible();
        await expect(page.locator('li[data-aviso="resultado_nao_positivo"]')).toBeVisible();
        await expect(page.getByTestId('nf-xml')).toHaveCount(0);

        // ── (7) Mês corrente: aviso de mês em andamento ────────────────────
        await page.goto(`${baseURL}/admin/pagamentos/nota-fiscal?mes=${atual}`);
        await expect(page.locator('li[data-aviso="mes_em_andamento"]')).toBeVisible();

        // ── (8) Mês futuro: recusado na UI e ignorado na URL ───────────────
        await page.getByLabel('Mês de competência').fill(futuro);
        await page.getByRole('button', { name: 'Ver prévia' }).click();
        await expect(page.getByRole('alert')).toContainText(`Escolha um mês até ${atual}`);
        await page.goto(`${baseURL}/admin/pagamentos/nota-fiscal?mes=${futuro}`);
        await expect(page.getByLabel('Mês de competência')).toHaveValue(m1);
        await expect(page.getByTestId('nf-valor')).toHaveText(brl(VALOR_M1));

        // ── (9) Segredos: nem no HTML, nem em nenhuma resposta tRPC ────────
        const html = await page.content();
        for (const s of proibidos) {
          expect(html.includes(s), 'HTML contém segredo do certificado').toBe(false);
          for (const corpo of respostas) {
            expect(corpo.includes(s), 'resposta tRPC contém segredo do certificado').toBe(false);
          }
        }
        expect(respostas.some((c) => c.includes('115.45'))).toBe(true);
        expect(pageErrors, 'sem erro de página nem HTTP 5xx').toEqual([]);
      } finally {
        await context.close();
      }
    }

    // ── (10) Quem não é admin: 403 na procedure e a página não abre ────────
    const ownerSession = await mintMagicLinkSession(db, {
      email: owner.email,
      name: 'Dona Uj78j',
      baseURL,
    });
    const context = await browser.newContext();
    try {
      await context.addCookies([browserCookieFor(ownerSession, baseURL)]);
      const input = encodeURIComponent(JSON.stringify({ mes: m1 }));
      const res = await context.request.get(
        `${baseURL}/api/trpc/admin.notaFiscal.previaMensal?input=${input}`,
      );
      expect(res.status()).toBe(403);
      expect(await res.text()).not.toContain('115.45');
      const page = await context.newPage();
      await page.goto(`${baseURL}/admin/pagamentos/nota-fiscal`);
      await page.waitForURL((url) => url.pathname === '/', { timeout: 15_000 });
    } finally {
      await context.close();
    }

    const anon = await browser.newContext();
    try {
      const input = encodeURIComponent(JSON.stringify({ mes: m1 }));
      const res = await anon.request.get(
        `${baseURL}/api/trpc/admin.notaFiscal.previaMensal?input=${input}`,
      );
      expect(res.status()).toBe(401);
    } finally {
      await anon.close();
    }
  } finally {
    await db.destroy();
  }
});
