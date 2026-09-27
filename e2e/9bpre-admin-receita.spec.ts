/**
 * aperture-9bpre — jornada única do admin: Pagamentos → usuário → campanha →
 * página pública → aba Receita EuNeném → drilldown, em 1440×900 e 375×812.
 *
 * SÓ roda contra o Postgres efêmero do runner
 * (e2e/support/9bpre-ephemeral-run.mjs). Antes de qualquer seed confere a
 * identidade do banco; sem ela o teste aborta. Nunca cai no banco de
 * desenvolvimento (localhost:54320).
 *
 * LEITURA PURA pela interface: nenhuma ação financeira. Escritas são apenas
 * fixtures sintéticas diretas no banco efêmero.
 */
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { sql } from 'kysely';
import { addDays, mesAtual } from '../apps/eunenem-server/pages/lib/receitaPeriodo.js';
import { createDatabase, type Database } from '../src/adapters/database.js';
import { PagamentoRepositoryPostgres } from '../src/adapters/pagamentos/repository.postgres.js';
import { UsuarioRepositoryPostgres } from '../src/adapters/usuario/repository.postgres.js';
import { ID_PLATAFORMA_EUNENEM } from '../src/index.js';
import { expect, test } from './fixtures.js';
import { browserCookieFor, mintMagicLinkSession } from './magic-link-auth.js';
import { seedCampanhaOwner } from './repasse-seed.js';

const DEV_DB_PORT = '54320';
const CAMPANHAS_EXTRAS = 55;

// Credenciais ficam em memória; sem trace/vídeo com cookie de sessão.
test.use({ trace: 'off', video: 'off' });

function brl(cents: number): RegExp {
  const texto = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
    .format(cents / 100)
    .replace(/\u00a0/g, ' ');
  // Aceita espaço comum ou NBSP entre "R$" e o número.
  return new RegExp(texto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '[\\s\\u00a0]'));
}

interface TaxaSeed {
  readonly campaignId: string;
  readonly taxaCents: number;
  readonly criadoEm: Date;
  readonly canceladoEm?: Date;
  readonly status?: 'aprovado' | 'estornado';
  readonly provedor?: 'stripe' | 'inter' | null;
}

async function seedTaxa(db: Database, input: TaxaSeed): Promise<string> {
  // biome-ignore lint/suspicious/noExplicitAny: fixture cruza vários BCs
  const anyDb = db as any;
  const idPagamento = randomUUID();
  const idContribuicao = randomUUID();
  const idItem = randomUUID();
  const provedor = input.provedor === undefined ? 'stripe' : input.provedor;
  // Composição válida para o agregado Pagamento: taxa cobrada sobre o presente.
  const contribuicaoCents = input.taxaCents * 10;
  // TransacaoExterna completa (o agregado exige status, valor e data).
  const transacaoExterna =
    provedor === null
      ? null
      : JSON.stringify({
          id: `ext-${idPagamento}`,
          provedor,
          status: 'aprovado',
          amountCents: contribuicaoCents + input.taxaCents + 0,
          criadaEm: input.criadoEm.toISOString(),
          statusBruto: 'paid',
        });
  await anyDb
    .insertInto('opcoes_contribuicao')
    .values({ id: idContribuicao, campanha_id: input.campaignId, tipo: 'presente' })
    .execute();
  await anyDb
    .insertInto('contribuicoes')
    .values({
      id: idContribuicao,
      campanha_id: input.campaignId,
      id_opcao_contribuicao: idContribuicao,
      nome: 'presente sintético 9bpre',
      valor: contribuicaoCents,
    })
    .execute();
  await sql`
    INSERT INTO pagamentos (
      id, status, criado_em, atualizado_em, intencao_id, intencao_id_campanha,
      intencao_metodo, intencao_criada_em,
      intencao_total_contribution_cents, intencao_total_fee_cents,
      intencao_total_receiver_cents, intencao_total_surcharge_cents,
      intencao_total_paid_cents, transacao_externa
    ) VALUES (
      ${idPagamento}::uuid, ${input.status ?? 'aprovado'}, ${input.criadoEm}, ${input.criadoEm},
      ${randomUUID()}::uuid, ${input.campaignId}::uuid, 'pix', ${input.criadoEm},
      ${contribuicaoCents}, ${input.taxaCents}, ${contribuicaoCents}, 0,
      ${contribuicaoCents + input.taxaCents},
      ${transacaoExterna}::jsonb
    )
  `.execute(db);
  await anyDb
    .insertInto('intencao_items')
    .values({
      id: idItem,
      id_pagamento: idPagamento,
      id_intencao_pagamento: idPagamento,
      position: 0,
      tipo: 'contribuicao',
      id_contribuicao: idContribuicao,
      quantidade: 1,
      contribution_unit_amount_cents: contribuicaoCents,
      fee_unit_amount_cents: input.taxaCents,
      receiver_unit_amount_cents: contribuicaoCents,
      line_contribution_amount_cents: contribuicaoCents,
      line_fee_amount_cents: input.taxaCents,
      line_receiver_amount_cents: contribuicaoCents,
      surcharge_amount_cents: null,
      criado_em: input.criadoEm,
    })
    .execute();
  await anyDb
    .insertInto('lancamentos_financeiros')
    .values({
      id: randomUUID(),
      id_pagamento: idPagamento,
      id_item_pagamento: idItem,
      id_contribuicao: idContribuicao,
      id_campanha: null,
      tipo: 'credito_receita_plataforma',
      amount_cents: input.taxaCents,
      criado_em: input.criadoEm,
      transferido_em: null,
      cancelado_em: input.canceladoEm ?? null,
      id_repasse: null,
    })
    .execute();
  return idPagamento;
}

async function semOverflow(page: Page, onde: string) {
  const g = await page.evaluate(() => ({
    viewport: window.innerWidth,
    documento: document.documentElement.scrollWidth,
  }));
  expect(g.documento, `sem overflow horizontal do documento em ${onde}`).toBeLessThanOrEqual(
    g.viewport,
  );
}

test('9bpre: pagamentos, administradores, campanha pública e Receita EuNeném', async ({
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(180_000);
  expect(baseURL).toBe('http://localhost:3002');

  // ── Identidade do banco ANTES de qualquer seed ──────────────────────────
  const uri = process.env.E2E_DATABASE_URL ?? '';
  expect(uri, 'E2E_DATABASE_URL explícito é obrigatório').not.toBe('');
  const target = new URL(uri);
  expect(['localhost', '127.0.0.1']).toContain(target.hostname);
  expect(target.port).not.toBe(DEV_DB_PORT);
  expect(target.port).toBe(process.env.E2E_9BPRE_DB_PORT);
  expect(process.env.E2E_9BPRE_CONTAINER).toMatch(/^[0-9a-f]{12}$/);
  expect(process.env.E2E_9BPRE_DB_OID).toMatch(/^\d+$/);

  const db = createDatabase(uri);
  try {
    const identity = await sql<{ name: string; oid: string }>`
      SELECT current_database() AS name, oid::text AS oid
      FROM pg_database WHERE datname = current_database()
    `.execute(db);
    expect(identity.rows[0]).toEqual({
      name: process.env.E2E_9BPRE_DB_NAME,
      oid: process.env.E2E_9BPRE_DB_OID,
    });
    // Os servidores nativos receberam a MESMA URI: suas conexões pg-boss já
    // precisam estar neste banco exclusivo.
    await expect
      .poll(async () => {
        const r = await sql<{ n: number }>`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND application_name LIKE '%boss%'
        `.execute(db);
        return r.rows[0]?.n ?? 0;
      })
      .toBeGreaterThanOrEqual(3);
    const fresh = await sql<{ n: number }>`SELECT count(*)::int AS n FROM usuarios`.execute(db);
    expect(fresh.rows[0]?.n, 'banco efêmero precisa começar vazio').toBe(0);

    // ── Fixtures sintéticas ───────────────────────────────────────────────
    const owner = await seedCampanhaOwner(db, 'qa9bpre-owner@fake.test');
    const usuario = await new UsuarioRepositoryPostgres(db).findUsuarioByEmail(
      ID_PLATAFORMA_EUNENEM as never,
      owner.email,
    );
    if (!usuario) throw new Error('fixture_owner_ausente');

    // Cinco administradores SEM cadastro, com ids que ordenam antes da dona:
    // os 5 exibidos não são elegíveis; o link público vem da sexta conta.
    const semCadastro = Array.from(
      { length: 5 },
      (_, i) => `00000000-0000-4000-8000-00000000000${i + 1}`,
    );
    for (const idConta of semCadastro) {
      await sql`
        INSERT INTO campanha_administradores (campanha_id, id_usuario)
        VALUES (${owner.idCampanha}::uuid, ${idConta}::uuid)
      `.execute(db);
    }

    const agora = new Date();
    const mes = mesAtual(agora);
    const inicioDoMes = new Date(`${mes.de}T04:00:00Z`); // 01:00 em SP
    const mesPassado = mesAtual(new Date(`${addDays(mes.de, -1)}T15:00:00Z`));
    const tresMesesAtras = mesAtual(new Date(`${addDays(mes.de, -70)}T15:00:00Z`));

    // Taxa antiga, cancelada no mês passado ⇒ mês passado com resultado −100,00.
    const pagamentoEstornado = await seedTaxa(db, {
      campaignId: owner.idCampanha,
      taxaCents: 10_000,
      criadoEm: new Date(`${addDays(tresMesesAtras.de, 9)}T15:00:00Z`),
      canceladoEm: new Date(`${addDays(mesPassado.de, 9)}T15:00:00Z`),
      status: 'estornado',
    });
    // Taxa de agora: é o pagamento mais recente da tabela.
    const pagamentoRecente = await seedTaxa(db, {
      campaignId: owner.idCampanha,
      taxaCents: 5_000,
      criadoEm: agora,
      provedor: null,
    });
    for (let i = 0; i < CAMPANHAS_EXTRAS; i++) {
      const id = randomUUID();
      await sql`
        INSERT INTO campanhas (id, id_plataforma, titulo)
        VALUES (${id}::uuid, ${ID_PLATAFORMA_EUNENEM}, ${`Campanha sintética ${i + 1}`})
      `.execute(db);
      await seedTaxa(db, { campaignId: id, taxaCents: 100, criadoEm: inicioDoMes });
    }
    // A fixture precisa ser um Pagamento que o domínio aceita, senão as telas
    // vizinhas (detalhe do pagamento, pagamentos da campanha) falham por causa
    // do dado sintético e não do produto.
    const pagamentos = new PagamentoRepositoryPostgres(db);
    expect((await pagamentos.findById(pagamentoRecente as never))?.status).toBe('aprovado');
    expect((await pagamentos.findById(pagamentoEstornado as never))?.status).toBe('estornado');
    const TOTAL_MES = 5_000 + CAMPANHAS_EXTRAS * 100;
    const TOTAL_REGISTRADAS = 10_000 + TOTAL_MES;

    let session: Awaited<ReturnType<typeof mintMagicLinkSession>>;
    try {
      session = await mintMagicLinkSession(db, {
        email: 'e2e-admin@e2e.local',
        name: 'E2e Admin',
        baseURL,
      });
    } catch {
      throw new Error('fixture_admin_local_falhou_sem_valores_de_auth_no_log');
    }

    const publica = `/pagina/${owner.slug}/c/${owner.idCampanha}`;

    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 375, height: 812 },
    ]) {
      const tag = String(viewport.width);
      const context = await browser.newContext({ viewport });
      const consoleErrors: string[] = [];
      const pageErrors: string[] = [];
      await context.route('**/*', (route) => {
        const u = new URL(route.request().url());
        return ['localhost', '127.0.0.1'].includes(u.hostname) ||
          ['data:', 'blob:'].includes(u.protocol)
          ? route.continue()
          : route.abort('blockedbyclient');
      });
      await context.addCookies([browserCookieFor(session, baseURL)]);
      const page = await context.newPage();
      page.on('pageerror', (e) => pageErrors.push(`${e.name}: ${e.message}`));
      // Só caminho e status: nomeia a procedure que falhou sem registrar corpo.
      page.on('response', (r) => {
        if (r.status() >= 500) {
          consoleErrors.push(`HTTP ${r.status()} ${new URL(r.url()).pathname}`);
        }
      });
      page.on('console', (e) => {
        if (e.type() === 'error' && !e.text().includes('ERR_BLOCKED_BY_CLIENT')) {
          consoleErrors.push(e.text());
        }
      });

      try {
        // ── (1) Pagamentos: coluna Usuário e links distintos ───────────────
        const resposta = await page.goto(`${baseURL}/admin/pagamentos`);
        expect(resposta?.status()).toBe(200);
        await expect(
          page.getByRole('navigation', { name: 'Seções de pagamentos' }).getByRole('link', {
            name: 'Pagamentos',
            exact: true,
          }),
        ).toHaveAttribute('aria-current', 'page');
        await expect(
          page.getByRole('columnheader', { name: 'Usuário (administradores)' }),
        ).toBeVisible();

        const linha = page.locator('tbody tr').filter({ hasText: pagamentoRecente });
        await expect(linha).toHaveCount(1);
        await expect(linha.getByText('sem cadastro nesta plataforma')).toHaveCount(5);
        await expect(linha.locator('a[href^="/admin/usuario/"]')).toHaveCount(0);
        const maisAdmins = linha.getByRole('link', { name: '+1 · ver os 6 administradores' });
        await expect(maisAdmins).toHaveAttribute('href', `/admin/campanha/${owner.idCampanha}`);
        // Nenhum dos 5 exibidos é elegível, e mesmo assim o link público existe.
        await expect(linha.getByRole('link', { name: /Abrir campanha pública/ })).toHaveAttribute(
          'href',
          publica,
        );
        await page.screenshot({
          path: testInfo.outputPath(`pagamentos-${tag}.png`),
          fullPage: true,
        });
        await semOverflow(page, `/admin/pagamentos ${tag}`);

        // ── (2) Ver pagamento continua levando ao pagamento ────────────────
        await linha.getByRole('link', { name: 'Ver pagamento' }).click();
        await expect(page).toHaveURL(new RegExp(`/admin/pagamento/${pagamentoRecente}$`));
        await expect(page.locator('article').first()).toBeVisible();
        await page.goBack();
        await expect(linha).toHaveCount(1);

        // ── (3) Detalhe da campanha: lista COMPLETA de administradores ─────
        await maisAdmins.click();
        await expect(page).toHaveURL(new RegExp(`/admin/campanha/${owner.idCampanha}$`));
        const secao = page.locator('section[aria-labelledby="administradores-title"]');
        await expect(secao.getByRole('heading', { name: 'administradores (6)' })).toBeVisible();
        await expect(secao.locator('ul > li')).toHaveCount(6);
        await expect(secao.getByText('sem cadastro nesta plataforma')).toHaveCount(5);
        await page.screenshot({
          path: testInfo.outputPath(`campanha-${tag}.png`),
          fullPage: true,
        });
        await semOverflow(page, `/admin/campanha ${tag}`);

        // ── (4) Campanha pública abre em nova aba, no caminho canônico ─────
        const [popup] = await Promise.all([
          context.waitForEvent('page'),
          secao.getByRole('link', { name: /Abrir campanha pública/ }).click(),
        ]);
        await popup.waitForLoadState('domcontentloaded');
        expect(new URL(popup.url()).pathname).toBe(publica);
        expect((await context.request.get(`${baseURL}${publica}`)).status()).toBe(200);
        await popup.waitForLoadState('networkidle');
        await expect(popup.getByText('página não encontrada')).toHaveCount(0);
        // Controle: o marcador de "não encontrada" é detectável quando existe.
        await popup.goto(`${baseURL}/pagina/nao-existe-9bpre/c/${owner.idCampanha}`);
        await expect(popup.getByText('página não encontrada')).toBeVisible();
        await popup.close();

        // ── (5) Administradora com cadastro leva ao detalhe do usuário ─────
        await secao.locator(`a[href="/admin/usuario/${usuario.idConta}"]`).click();
        await expect(page).toHaveURL(new RegExp(`/admin/usuario/${usuario.idConta}$`));
        await expect(page.getByText(owner.email).first()).toBeVisible();

        // ── (6) Aba Receita EuNeném, por link ──────────────────────────────
        await page.goto(`${baseURL}/admin/pagamentos`);
        await page
          .getByRole('navigation', { name: 'Seções de pagamentos' })
          .getByRole('link', { name: 'Receita EuNeném' })
          .click();
        await expect(page).toHaveURL(/\/admin\/pagamentos\/receita$/);
        await expect(
          page.getByRole('heading', { level: 1, name: 'Receita EuNeném (taxa da plataforma)' }),
        ).toBeVisible();
        await expect(page.getByText('O que esta tela não mostra')).toBeVisible();
        await expect(page.locator('body')).not.toContainText(/lucro|l[ií]quid/i);

        const cards = page.locator('section[aria-labelledby="receita-cards-title"] article');
        await expect(cards).toHaveCount(3);
        const cardMes = cards.filter({ hasText: 'Mês atual' });
        await expect(cardMes).toContainText(brl(TOTAL_MES));
        const cardPeriodo = cards.filter({ hasText: 'Período escolhido' });
        await expect(cardPeriodo).toContainText(brl(TOTAL_REGISTRADAS));
        await expect(cardPeriodo).toContainText(brl(10_000));
        await expect(cardPeriodo).toContainText(brl(TOTAL_REGISTRADAS - 10_000));

        // Mês passado: só cancelamento ⇒ resultado negativo no gráfico e na tabela.
        const colunaNegativa = page.locator('button[aria-label*="Resultado de taxas -R$"]');
        await expect(colunaNegativa).toHaveCount(1);
        const barra = colunaNegativa.locator('span.bg-amber-700');
        await expect(barra).toBeVisible();
        const caixaBarra = await barra.boundingBox();
        const caixaBase = await page
          .locator('[role="group"][aria-label^="Gráfico"] > span.border-ink-mute')
          .boundingBox();
        expect(caixaBarra?.height ?? 0).toBeGreaterThan(4);
        // A barra de cancelamento começa na linha de base e desce.
        expect(Math.abs((caixaBarra?.y ?? 0) - (caixaBase?.y ?? -99))).toBeLessThanOrEqual(1.5);
        const tabelaSerie = page.locator('table').filter({ hasText: 'Mesmos valores do gráfico' });
        await expect(tabelaSerie.locator('tbody tr').filter({ hasText: brl(-10_000) })).toHaveCount(
          1,
        );
        await expect(tabelaSerie.locator('tfoot')).toContainText(brl(TOTAL_REGISTRADAS - 10_000));

        // Provedor ausente aparece nomeado.
        await expect(page.locator('section[aria-labelledby="receita-meio-title"]')).toContainText(
          'provedor não registrado',
        );
        // 56 campanhas, todas na lista (≤ 100): sem truncamento.
        await expect(
          page.locator('section[aria-labelledby="receita-campanhas-title"]'),
        ).toContainText(`Todas as campanhas (${CAMPANHAS_EXTRAS + 1})`);
        // A lista começa recolhida; os totais não dependem do que está visível.
        const porCampanha = page.locator('section[aria-labelledby="receita-campanhas-title"]');
        await expect(porCampanha.locator('tbody tr')).toHaveCount(10);
        await expect(porCampanha.locator('tfoot')).toContainText(brl(TOTAL_REGISTRADAS - 10_000));
        await porCampanha
          .getByRole('button', { name: `Mostrar as ${CAMPANHAS_EXTRAS + 1} campanhas da lista` })
          .click();
        await expect(porCampanha.locator('tbody tr')).toHaveCount(CAMPANHAS_EXTRAS + 1);
        await porCampanha.getByRole('button', { name: 'Mostrar só as 10 primeiras' }).click();
        await expect(porCampanha.locator('tbody tr')).toHaveCount(10);

        await page.screenshot({
          path: testInfo.outputPath(`receita-mes-${tag}.png`),
          fullPage: true,
        });
        await page
          .locator('figure')
          .first()
          .screenshot({ path: testInfo.outputPath(`receita-grafico-${tag}.png`) });
        await semOverflow(page, `/admin/pagamentos/receita ${tag}`);

        // ── (7) Teclado: uma parada de tabulação, setas percorrem ──────────
        const grafico = page.locator('[role="group"][aria-label^="Gráfico"]');
        await expect(grafico.locator('button[tabindex="0"]')).toHaveCount(1);
        // Parte de uma coluna conhecida: o ponteiro pode ter passado pelo
        // gráfico em passos anteriores e mudado a coluna ativa.
        await grafico.locator('button').last().focus();
        await expect(grafico.locator('button[tabindex="0"]')).toHaveCount(1);
        const primeiro = await page.evaluate(() =>
          document.activeElement?.getAttribute('aria-label'),
        );
        await page.keyboard.press('ArrowLeft');
        const segundo = await page.evaluate(() =>
          document.activeElement?.getAttribute('aria-label'),
        );
        expect(segundo).not.toBe(primeiro);
        expect(segundo).toContain('Taxas registradas');
        await page.keyboard.press('End');
        await expect(grafico.locator('button').last()).toBeFocused();
        await page.keyboard.press('Home');
        await expect(grafico.locator('button').first()).toBeFocused();

        // ── (8) Troca de granularidade ─────────────────────────────────────
        const filtro = page.getByRole('form', { name: 'Período da receita' });
        await filtro.getByRole('button', { name: 'Semana', exact: true }).click();
        await expect(page).toHaveURL(/g=semana/);
        await expect(filtro.getByRole('button', { name: 'Semana', exact: true })).toHaveAttribute(
          'aria-pressed',
          'true',
        );
        await expect(tabelaSerie).toContainText('por semana');
        await expect(tabelaSerie.locator('tbody tr').first()).toContainText('semana de');
        // Mesmo período, outra grade: os totais não mudam.
        await expect(cardPeriodo).toContainText(brl(TOTAL_REGISTRADAS));
        await expect(tabelaSerie.locator('tfoot')).toContainText(brl(TOTAL_REGISTRADAS - 10_000));
        await page.screenshot({
          path: testInfo.outputPath(`receita-semana-${tag}.png`),
          fullPage: true,
        });
        await semOverflow(page, `receita por semana ${tag}`);

        // ── (9) Drilldown paginado, com consistência distinta declarada ────
        const drill = page.locator('section[aria-labelledby="receita-drilldown-title"]');
        await drill.getByRole('button', { name: 'Abrir lista paginada' }).click();
        await expect(drill).toContainText('lida separadamente do painel');
        await expect(drill).toContainText(`página 1 · ${CAMPANHAS_EXTRAS + 1} campanha(s)`);
        await expect(drill.locator('tbody tr')).toHaveCount(50);
        await drill.getByRole('button', { name: 'Próxima' }).click();
        await expect(drill).toContainText('página 2');
        await expect(drill.locator('tbody tr')).toHaveCount(CAMPANHAS_EXTRAS + 1 - 50);
        await drill.getByRole('button', { name: 'Anterior' }).click();
        await expect(drill).toContainText('página 1');
        await expect(drill.locator('tbody tr')).toHaveCount(50);
        await semOverflow(page, `drilldown ${tag}`);

        expect(pageErrors).toEqual([]);
        expect(consoleErrors).toEqual([]);
      } finally {
        await testInfo.attach(`console-${tag}`, {
          body: JSON.stringify({ pageErrors, consoleErrors }),
          contentType: 'application/json',
        });
        await context.close();
      }
    }
  } finally {
    await db.destroy();
  }
});
