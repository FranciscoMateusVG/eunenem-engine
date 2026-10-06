/**
 * aperture-q4pfz — tela Receita 1b (/admin/pagamentos/receita) pela interface.
 *
 * SÓ roda contra o Postgres efêmero do runner do 9bpre:
 *   node --import tsx e2e/support/9bpre-ephemeral-run.mjs e2e/q4pfz-receita-1b.spec.ts
 * Antes de qualquer seed confere a identidade do banco; sem ela o teste
 * aborta. Nunca cai no banco de desenvolvimento (localhost:54320).
 *
 * LEITURA PURA pela interface: nenhuma ação financeira. Escritas são apenas
 * fixtures sintéticas diretas no banco efêmero (tests/helpers/
 * receita-ledger-seed.ts, provado em Postgres real por
 * tests/integration/receita-1b.postgres.test.ts).
 *
 * O servidor usa o relógio real, então as fixtures são relativas a hoje e os
 * valores esperados saem de um oráculo puro (mesmas regras do contrato):
 *   tarifas  = taxa por criado_em − taxa por cancelado_em
 *   recebido = (presente + taxa + adicional) por criado_em − o mesmo por cancelado_em
 */
import type { Locator, Page } from '@playwright/test';
import { sql } from 'kysely';
import {
  addDays,
  localDateInSaoPaulo,
  mesAtual,
  semanaAtual,
  startOfIsoWeek,
  startOfMonth,
} from '../apps/eunenem-server/pages/lib/receitaPeriodo.js';
import { createDatabase, type Database } from '../src/adapters/database.js';
import { ReceitaLedgerSeed } from '../tests/helpers/receita-ledger-seed.js';
import { expect, test } from './fixtures.js';
import { browserCookieFor, mintMagicLinkSession } from './magic-link-auth.js';

const DEV_DB_PORT = '54320';
const OTHER_PLATFORM = '00000000-0000-4000-8000-00000000f1b2';

// Credenciais ficam em memória; sem trace/vídeo com cookie de sessão.
test.use({ trace: 'off', video: 'off' });

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
function brlTexto(cents: number): string {
  return BRL.format(cents / 100).replace(/ /g, ' ');
}
function brl(cents: number): RegExp {
  // Aceita espaço comum ou NBSP entre "R$" e o número.
  return new RegExp(
    brlTexto(cents)
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/ /g, '[\\s\\u00a0]'),
  );
}

const MESES_PT = [
  'janeiro',
  'fevereiro',
  'março',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
];

/** Instante de uma data/hora local de São Paulo (UTC−3, sem horário de verão desde 2019). */
function sp(data: string, hora: string): Date {
  return new Date(`${data}T${hora}-03:00`);
}

interface Evento {
  readonly em: Date;
  readonly tarifa: number;
  readonly recebido: number;
}

/** Oráculo puro: soma dos eventos com data local SP em [de, ate). */
function somar(eventos: readonly Evento[], de: string, ate: string) {
  let tarifas = 0;
  let recebido = 0;
  for (const e of eventos) {
    const dia = localDateInSaoPaulo(e.em);
    if (dia >= de && dia < ate) {
      tarifas += e.tarifa;
      recebido += e.recebido;
    }
  }
  return { tarifas, recebido };
}

// Cores do design 1b (Receita.dc.html): cheias para períodos fechados, claras
// para o período em andamento.
const LILAS = 'rgb(167, 123, 190)'; // #a77bbe
const TEAL = 'rgb(63, 139, 146)'; // #3f8b92
const LILAS_CLARO = 'rgb(232, 213, 240)'; // #e8d5f0
const TEAL_CLARO = 'rgb(222, 241, 243)'; // #def1f3

function ddmm(data: string): string {
  return `${data.slice(8, 10)}/${data.slice(5, 7)}`;
}

function ddmmaaaa(data: string): string {
  return `${ddmm(data)}/${data.slice(0, 4)}`;
}

function cap(texto: string): string {
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

async function expectKpi(
  card: Locator,
  serie: 'tarifas' | 'recebido',
  valor: number,
  prefixo: string,
  comparacao: number,
) {
  const coluna = card.getByTestId(`receita-kpi-${serie}`);
  await expect(coluna.getByTestId('receita-kpi-valor')).toHaveText(brl(valor));
  await expect(coluna.getByTestId('receita-kpi-comparacao')).toHaveText(
    new RegExp(`^${prefixo}${brl(comparacao).source}$`),
  );
}

/** Cores de fundo não transparentes dos descendentes (as barras). */
function coresDasBarras(item: Locator): Promise<string[]> {
  return item.evaluate((el) =>
    [...el.querySelectorAll('*')]
      .map((n) => getComputedStyle(n).backgroundColor)
      .filter((c) => c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent'),
  );
}

function temBordaTracejada(item: Locator): Promise<boolean> {
  return item.evaluate((el) =>
    [el, ...el.querySelectorAll('*')].some((n) => {
      const st = getComputedStyle(n);
      return [
        st.borderTopStyle,
        st.borderRightStyle,
        st.borderBottomStyle,
        st.borderLeftStyle,
      ].some((b) => b === 'dashed');
    }),
  );
}

interface SemanaEsperada {
  readonly de: string;
  readonly ate: string;
  readonly estado: 'passada' | 'atual' | 'futura';
}

/** Semanas seg–dom do mês de `hoje`, recortadas ao mês. */
function semanasDoMes(mes: { de: string; ate: string }, hoje: string): SemanaEsperada[] {
  const out: SemanaEsperada[] = [];
  let de = mes.de;
  while (de < mes.ate) {
    const proxima = addDays(startOfIsoWeek(de), 7);
    const ate = proxima < mes.ate ? proxima : mes.ate;
    const estado = hoje >= ate ? 'passada' : hoje < de ? 'futura' : 'atual';
    out.push({ de, ate, estado });
    de = ate;
  }
  return out;
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

test('q4pfz: Receita 1b — KPIs, meses, semanas do mês e notas de definição', async ({
  browser,
  baseURL,
}, testInfo) => {
  test.skip(
    !process.env.E2E_9BPRE_CONTAINER,
    'roda apenas pelo runner efêmero: node --import tsx e2e/support/9bpre-ephemeral-run.mjs e2e/q4pfz-receita-1b.spec.ts',
  );
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

    // ── Fixtures relativas a hoje ─────────────────────────────────────────
    const agora = new Date();
    const hoje = localDateInSaoPaulo(agora);
    const mes = mesAtual(agora);
    const semana = semanaAtual(agora);
    const inicioDoMes = sp(mes.de, '01:00:00');
    test.skip(agora < sp(mes.de, '02:00:00'), 'primeira hora do mês: fixtures cairiam no futuro');

    const seed = new ReceitaLedgerSeed(db);
    const campanha = await seed.campanha();
    const outra = await seed.campanha(OTHER_PLATFORM);
    const eventos: Evento[] = [];
    const registrar = (em: Date, taxa: number, pago: number) =>
      eventos.push({ em, tarifa: taxa, recebido: pago });
    const cancelar = (em: Date, taxa: number, pago: number) =>
      eventos.push({ em, tarifa: -taxa, recebido: -pago });

    // Onze meses anteriores, dia 10 ao meio-dia: série crescente.
    const meses: string[] = [mes.de];
    for (let k = 1; k <= 11; k++) {
      meses.unshift(startOfMonth(addDays(meses[0] as string, -1)));
    }
    for (let k = 0; k < 11; k++) {
      const taxa = 10_000 + k * 1_500;
      const p = await seed.pagamento({
        campaignId: campanha,
        taxaCents: taxa,
        contribuicaoCents: taxa * 19,
        criadoEm: sp(addDays(meses[k] as string, 9), '12:00:00'),
        provedor: k % 2 === 0 ? 'stripe' : 'inter',
      });
      registrar(sp(addDays(meses[k] as string, 9), '12:00:00'), taxa, p.pagoCents);
    }
    // Último dia do mês passado 23:30 SP, cartão com adicional, estornado
    // neste mês ⇒ conta no mês passado e é descontado neste.
    const ultimoDiaMesPassado = addDays(mes.de, -1);
    const virada = await seed.pagamento({
      campaignId: campanha,
      taxaCents: 2_500,
      contribuicaoCents: 50_000,
      adicionalCents: 1_800,
      metodo: 'credit_card',
      criadoEm: sp(ultimoDiaMesPassado, '23:30:00'),
      canceladoEm: inicioDoMes,
      provedor: 'stripe',
    });
    registrar(sp(ultimoDiaMesPassado, '23:30:00'), 2_500, virada.pagoCents);
    cancelar(inicioDoMes, 2_500, virada.pagoCents);
    // Mês corrente: primeiro dia e agora.
    const dia1 = sp(mes.de, '01:30:00');
    const p1 = await seed.pagamento({
      campaignId: campanha,
      taxaCents: 5_120,
      contribuicaoCents: 97_000,
      criadoEm: dia1,
      provedor: 'inter',
    });
    registrar(dia1, 5_120, p1.pagoCents);
    const recente = new Date(agora.getTime() - 60_000);
    const p2 = await seed.pagamento({
      campaignId: campanha,
      taxaCents: 720,
      contribuicaoCents: 13_320,
      criadoEm: recente,
      provedor: 'stripe',
    });
    registrar(recente, 720, p2.pagoCents);
    // Outra plataforma, agora: não pode aparecer em lugar nenhum.
    await seed.pagamento({ campaignId: outra, taxaCents: 99_900, criadoEm: recente });

    // ── Valores esperados (oráculo) ───────────────────────────────────────
    const amanha = addDays(hoje, 1);
    const kMes = somar(eventos, mes.de, amanha);
    const kMesAnterior = somar(eventos, meses[10] as string, mes.de);
    const kSemana = somar(eventos, semana.de, semana.ate);
    const kSemanaAnterior = somar(eventos, addDays(semana.de, -7), semana.de);
    const nomeMesAnterior = MESES_PT[Number((meses[10] as string).slice(5, 7)) - 1] as string;
    const nomeMes = MESES_PT[Number(mes.de.slice(5, 7)) - 1] as string;
    const semanasEsperadas = semanasDoMes(mes, hoje);
    expect(semanasEsperadas.filter((w) => w.estado === 'atual')).toHaveLength(1);

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

    for (const viewport of [
      { width: 1280, height: 1250 },
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
      page.on('response', (r) => {
        if (r.status() >= 500)
          consoleErrors.push(`HTTP ${r.status()} ${new URL(r.url()).pathname}`);
      });
      page.on('console', (e) => {
        if (e.type() === 'error' && !e.text().includes('ERR_BLOCKED_BY_CLIENT')) {
          consoleErrors.push(e.text());
        }
      });

      try {
        const resposta = await page.goto(`${baseURL}/admin/pagamentos/receita`);
        expect(resposta?.status()).toBe(200);
        await expect(
          page.getByRole('heading', { level: 1, name: 'Receita EuNeném' }),
        ).toBeVisible();
        await expect(page.getByText('Taxas da plataforma menos cancelamentos.')).toBeVisible();
        await expect(
          page.getByText(`Atualizado ${ddmmaaaa(hoje)} · horário de São Paulo`),
        ).toBeVisible();
        await expect(page.locator('body')).not.toContainText(/lucro|l[ií]quid/i);
        await expect(page.locator('body')).not.toContainText(brl(99_900));

        // ── KPIs: duas colunas por cartão (Tarifas | Recebido) ────────────
        const cardMes = page.getByTestId('receita-kpi-mes');
        await expect(cardMes).toHaveAttribute('aria-label', 'Mês atual');
        await expect(cardMes.getByTestId('receita-kpi-faixa')).toHaveText(
          `${ddmm(mes.de)} – ${ddmm(hoje)}`,
        );
        await expectKpi(
          cardMes,
          'tarifas',
          kMes.tarifas,
          `${cap(nomeMesAnterior)}: `,
          kMesAnterior.tarifas,
        );
        await expectKpi(
          cardMes,
          'recebido',
          kMes.recebido,
          `${cap(nomeMesAnterior)}: `,
          kMesAnterior.recebido,
        );
        const cardSemana = page.getByTestId('receita-kpi-semana');
        await expect(cardSemana).toHaveAttribute('aria-label', 'Semana atual');
        await expectKpi(
          cardSemana,
          'tarifas',
          kSemana.tarifas,
          'Semana anterior: ',
          kSemanaAnterior.tarifas,
        );
        await expectKpi(
          cardSemana,
          'recebido',
          kSemana.recebido,
          'Semana anterior: ',
          kSemanaAnterior.recebido,
        );

        // ── Legenda: as duas séries juntas, sem alternância ───────────────
        await expect(page.getByText('cada série na sua própria escala')).toBeVisible();
        await expect(page.getByRole('tab')).toHaveCount(0);
        await expect(
          page.getByRole('button', { name: /^(Tarifas EuNeném|Recebido no banco)$/ }),
        ).toHaveCount(0);

        // ── Por mês: 12 meses, só o corrente parcial, barras pareadas ─────
        await expect(page.getByRole('heading', { name: 'Por mês' })).toBeVisible();
        const barrasMes = page.getByTestId('receita-mes');
        await expect(barrasMes).toHaveCount(12);
        for (let k = 0; k < 12; k++) {
          const de = meses[k] as string;
          const ate = k === 11 ? amanha : (meses[k + 1] as string);
          const esperado = somar(eventos, de, ate);
          const barra = barrasMes.nth(k);
          await expect(barra).toHaveAttribute('data-mes', de);
          await expect(barra).toHaveAttribute('data-parcial', k === 11 ? 'true' : 'false');
          const rotulo = await barra.getAttribute('aria-label');
          expect(rotulo, `aria-label do mês ${de}`).toMatch(brl(esperado.tarifas));
          expect(rotulo).toMatch(new RegExp(`tarifas ${brl(esperado.tarifas).source}`));
          expect(rotulo).toMatch(new RegExp(`recebido ${brl(esperado.recebido).source}`));
          if (k === 11) expect(rotulo).toContain('(parcial)');
          await expect(barra.locator('[data-serie=tarifas]')).toBeVisible();
          await expect(barra.locator('[data-serie=recebido]')).toBeVisible();
          const cores = await coresDasBarras(barra);
          if (k === 11) {
            expect(cores, `mês parcial ${de} em tons claros`).toEqual(
              expect.arrayContaining([LILAS_CLARO, TEAL_CLARO]),
            );
            expect(cores).not.toContain(LILAS);
            expect(cores).not.toContain(TEAL);
          } else {
            expect(cores, `mês fechado ${de} em tons cheios`).toEqual(
              expect.arrayContaining([LILAS, TEAL]),
            );
          }
        }

        // ── Semanas do mês corrente: seg–dom recortadas, futuras tracejadas
        await expect(
          page.getByRole('heading', { name: new RegExp(`^Semanas de ${nomeMes}$`, 'i') }),
        ).toBeVisible();
        await expect(page.getByText('semana de segunda a domingo')).toBeVisible();
        const barrasSemana = page.getByTestId('receita-semana');
        await expect(barrasSemana).toHaveCount(semanasEsperadas.length);
        for (let k = 0; k < semanasEsperadas.length; k++) {
          const w = semanasEsperadas[k] as SemanaEsperada;
          const barra = barrasSemana.nth(k);
          await expect(barra).toHaveAttribute('data-de', w.de);
          await expect(barra).toHaveAttribute('data-estado', w.estado);
          const cores = await coresDasBarras(barra);
          const tracejada = await temBordaTracejada(barra);
          if (w.estado === 'futura') {
            await expect(barra.locator('[data-serie=tarifas]')).toHaveText('—');
            await expect(barra.locator('[data-serie=recebido]')).toHaveText('');
            await expect(barra).toHaveAttribute('aria-label', /ainda não começou/);
            expect(tracejada, `semana futura ${w.de} tracejada`).toBe(true);
            expect(cores).not.toContain(LILAS);
            expect(cores).not.toContain(TEAL);
          } else {
            const esperado = somar(eventos, w.de, w.ate);
            await expect(barra.locator('[data-serie=tarifas]')).toHaveText(brl(esperado.tarifas));
            await expect(barra.locator('[data-serie=recebido]')).toHaveText(brl(esperado.recebido));
            expect(tracejada, `semana ${w.estado} ${w.de} sem tracejado`).toBe(false);
            if (w.estado === 'atual') {
              await expect(barra).toContainText('esta semana');
              await expect(barra).toHaveAttribute('aria-label', /\(esta semana\)/);
              expect(cores).toEqual(expect.arrayContaining([LILAS_CLARO, TEAL_CLARO]));
            } else {
              expect(cores).toEqual(expect.arrayContaining([LILAS, TEAL]));
            }
          }
        }

        // ── Sem nada a conferir, o aviso não existe ───────────────────────
        await expect(page.getByTestId('receita-aviso')).toHaveCount(0);

        // ── Notas de definição (texto do design) ──────────────────────────
        await expect(page.locator('p').filter({ hasText: /^Tarifas EuNeném:/ })).toHaveText(
          'Tarifas EuNeném: taxas registradas na data do pagamento aprovado, menos cancelamentos na data em que ocorreram.',
        );
        await expect(page.locator('p').filter({ hasText: /^Recebido no banco:/ })).toHaveText(
          'Recebido no banco: soma dos pagamentos aprovados, menos estornos. É uma estimativa: o custo do provedor e o valor que de fato caiu na conta não são registrados.',
        );

        await page.screenshot({
          path: testInfo.outputPath(`receita-1b-${tag}.png`),
          fullPage: true,
        });
        await semOverflow(page, `/admin/pagamentos/receita ${tag}`);

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

    // ── Com algo a conferir, o aviso aparece ──────────────────────────────
    // Pagamento estornado cuja taxa não tem data de cancelamento.
    await seed.pagamento({
      campaignId: campanha,
      taxaCents: 640,
      criadoEm: new Date(agora.getTime() - 120_000),
      status: 'estornado',
    });
    const context = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
    try {
      await context.addCookies([browserCookieFor(session, baseURL)]);
      const page = await context.newPage();
      await page.goto(`${baseURL}/admin/pagamentos/receita`);
      const aviso = page.getByTestId('receita-aviso');
      await expect(aviso).toBeVisible();
      await expect(aviso).toHaveAttribute('role', 'status');
      await expect(aviso).toHaveAttribute('aria-label', 'Conferir');
      await expect(aviso.getByTestId('receita-aviso-estornado')).toHaveText(
        new RegExp(
          `^1 taxa\\(s\\) de pagamento estornado sem data de cancelamento \\(${brl(640).source}\\): seguem somadas\\.$`,
        ),
      );
      await expect(aviso.getByTestId('receita-aviso-cancelado')).toHaveCount(0);
      await expect(aviso.getByTestId('receita-aviso-conciliacao')).toHaveCount(0);
      await page.screenshot({
        path: testInfo.outputPath('receita-1b-aviso-1280.png'),
        fullPage: true,
      });
    } finally {
      await context.close();
    }
  } finally {
    await db.destroy();
  }
});
