/**
 * aperture-8r5kp — W2 ENFORCEMENT gate (the critical one).
 *
 * Guards #378 (aperture-48mxt, 9557b90, deployed): the 11 authed
 * per-campanha mutations now REQUIRE idCampanha (z.string().uuid()); the
 * server rejects an id-less write with BAD_REQUEST. The frontend wrapper
 * (useCampanhaEscrita, #376/1kbyx) always supplies rota ?? me.idCampanha.
 *
 * THIS GATE'S JOB: prove that enforcing required-idCampanha did NOT break the
 * certified per-campanha isolation. If ANY authed write flow broke, that is a
 * P0 — hold/revert. Four arms:
 *
 *   A. ADDRESSED writes stay GREEN — representative authed writes WITH
 *      idCampanha still succeed post-enforcement (the wrapper's path).
 *   B. FAIL-CLOSED — each of the 11 mutations fired id-less (raw tRPC, no
 *      idCampanha) returns BAD_REQUEST whose zod error names idCampanha.
 *      Asserting the message contains "idCampanha" (not merely "some 400")
 *      is what proves idCampanha SPECIFICALLY is now required — a still-
 *      optional field would never appear in the required-issue set.
 *   C. PUBLIC TRIO unaffected — iniciarPagamentoContribuicao /
 *      iniciarPagamentoCarrinho / confirmarPresenca (optional-by-design) must
 *      NOT reject for a missing idCampanha (they can fail for other reasons;
 *      just never on idCampanha-required).
 *   D. CROSS-CAMPANHA ISOLATION intact — an addressed write on A lands in A
 *      and does NOT leak into B (the property W1c certified; enforcement must
 *      preserve it).
 *
 * The fail-closed arm is SIDE-EFFECT-FREE by construction: idCampanha is
 * required, so zod rejects the input BEFORE the mutation body runs — no write
 * ever happens, even for payloads whose other fields are valid.
 *
 * WALKER: permanent gate-walker (creds env / mempalace
 * drawer_eunenem_secrets_afd95964dc3c7bbba928fad8). B=slug gate-camp-b,
 * A=slugless. Same base as the llol4 G1a/G1b write-isolation battery.
 *
 * RUN:
 *   E2E_BASE_URL=https://eunenem.xeroxtoxerox.com \
 *   E2E_GATE_EMAIL=<walker> E2E_GATE_SENHA=<walker> \
 *   pnpm exec playwright test e2e/w2-enforcement-gate.spec.ts
 */
import type { APIRequestContext } from '@playwright/test';
import { expect, request as pwRequest, test } from '@playwright/test';
import { ID_PLATAFORMA_EUNENEM } from '../apps/eunenem-server/pages/lib/constants.js';

const GATE_EMAIL = process.env.E2E_GATE_EMAIL;
const GATE_SENHA = process.env.E2E_GATE_SENHA;

const NOME_EXIBICAO = 'Izzygate Walker';
const TITULO_A = `Lista de ${NOME_EXIBICAO}`;
const TITULO_B = 'Segunda Lista do Gate 118sb';
// The walker's user slug (derived from 'izzygate'). Used only as the `slug`
// field on marcarLida/marcarTodasLidas + the public trio — where it is
// INCIDENTAL to the assertions: arm B asserts on the idCampanha zod issue
// (fires regardless of slug validity) and arm C asserts the absence of an
// idCampanha-required rejection (a wrong slug would fail elsewhere, never on
// idCampanha). So a stable literal is safe here.
const WALKER_SLUG = 'izzygate';
const RUN = Math.random().toString(36).slice(2, 8);
const RANDOM_UUID = '00000000-0000-4000-8000-000000000000'; // valid-format placeholder

interface CampanhaCard {
  id: string;
  titulo: string;
  slug: string;
  campanhaSlug: string | null;
}
interface CatalogItem {
  id: string;
  nome: string;
}

async function trpcQuery<T>(
  api: APIRequestContext,
  procedure: string,
  input?: unknown,
): Promise<T> {
  const qs = input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await api.get(`/api/trpc/${procedure}${qs}`);
  expect(res.ok(), `${procedure} must succeed — ${res.status()}: ${await res.text()}`).toBe(true);
  return ((await res.json()) as { result: { data: T } }).result.data;
}

async function trpcMutation<T>(
  api: APIRequestContext,
  procedure: string,
  input: unknown,
): Promise<T> {
  const res = await api.post(`/api/trpc/${procedure}`, { data: input });
  expect(res.ok(), `${procedure} must succeed — ${res.status()}: ${await res.text()}`).toBe(true);
  return ((await res.json()) as { result: { data: T } }).result.data;
}

/** POST a mutation and return the raw {status, code, message} WITHOUT
 *  asserting success/failure — the caller decides. */
async function trpcRaw(
  api: APIRequestContext,
  procedure: string,
  input: unknown,
): Promise<{ ok: boolean; status: number; code?: string; message?: string }> {
  const res = await api.post(`/api/trpc/${procedure}`, { data: input });
  const body = (await res.json().catch(() => ({}))) as {
    error?: { message?: string; data?: { code?: string } };
  };
  return {
    ok: res.ok(),
    status: res.status(),
    code: body.error?.data?.code,
    message: body.error?.message,
  };
}

function conviteSaveInput(nomeExibido: string, idCampanha?: string) {
  return {
    ...(idCampanha === undefined ? {} : { idCampanha }),
    tipoEvento: 'cha-bebe' as const,
    modalidade: 'presencial' as const,
    dataHoraIso: '2026-08-01T15:00:00.000Z',
    endereco: 'Rua das Flores, 123',
    remetente: 'Francisco',
    nomeExibido,
    mensagem: 'Venha comemorar conosco!',
    paleta: 'lilas' as const,
    fonte: 'patrick' as const,
    modelo: 'scrapbook' as const,
  };
}

test.describe('W2 enforcement gate — required idCampanha (aperture-8r5kp)', () => {
  test.skip(
    !GATE_EMAIL || !GATE_SENHA,
    'E2E_GATE_EMAIL / E2E_GATE_SENHA not set — gate-walker creds live in env/mempalace',
  );

  let api: APIRequestContext;
  let campA: CampanhaCard;
  let campB: CampanhaCard;

  test.beforeAll(async ({ baseURL }) => {
    expect(baseURL, 'baseURL must be configured').toBeTruthy();
    api = await pwRequest.newContext({ baseURL });

    const cont = await api.post('/api/trpc/auth.continuarComEmail', {
      data: {
        email: GATE_EMAIL,
        senha: GATE_SENHA,
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        nomeExibicao: NOME_EXIBICAO,
      },
    });
    expect(cont.ok(), `continuarComEmail failed: ${cont.status()} ${await cont.text()}`).toBe(true);

    let list = await trpcQuery<{ novas: CampanhaCard[] }>(api, 'campanhas.list');
    if (!list.novas.some((c) => c.titulo === TITULO_B)) {
      await trpcMutation(api, 'campanhas.criar', { titulo: TITULO_B });
      list = await trpcQuery<{ novas: CampanhaCard[] }>(api, 'campanhas.list');
    }
    campA = list.novas.find((c) => c.titulo === TITULO_A) as CampanhaCard;
    campB = list.novas.find((c) => c.titulo === TITULO_B) as CampanhaCard;
    expect(campA, `walker must own "${TITULO_A}"`).toBeTruthy();
    expect(campB, `walker must own "${TITULO_B}"`).toBeTruthy();

    // B needs an evento (convite) for adicionarConvidado to succeed in arm A.
    const conviteB = await trpcQuery<{ evento: unknown }>(api, 'eventoConvite.get', {
      idCampanha: campB.id,
    });
    if (conviteB.evento == null) {
      await trpcMutation(api, 'eventoConvite.save', conviteSaveInput('Bebe Gate B', campB.id));
    }
  });

  test.afterAll(async () => {
    await api?.dispose();
  });

  // ── Arm A — ADDRESSED writes stay GREEN post-enforcement ─────────────────
  test('A — addressed authed writes (WITH idCampanha) still succeed', async () => {
    // contribuicao.create on B → success → cleanup delete. NOTE: create
    // returns { ids: string[] } (a batch insert), NOT { id } — verified
    // against the router (criarContribuicoesEmLote).
    const created = await trpcMutation<{ ids: string[] }>(api, 'contribuicao.create', {
      idCampanha: campB.id,
      nome: `W2 addressed gift ${RUN}`,
      valor: 5_000,
      quantidade: 1,
    });
    expect(
      created?.ids?.[0],
      'addressed contribuicao.create must return the new item id',
    ).toBeTruthy();
    // eventoConvite.save on B (upsert) → success.
    await trpcMutation(api, 'eventoConvite.save', conviteSaveInput('Bebe Gate B W2', campB.id));
    // adicionarConvidado on B → success (requires numeroCelular too).
    await trpcMutation(api, 'eventoListaDeConvidados.adicionarConvidado', {
      idCampanha: campB.id,
      nome: `Convidada W2 ${RUN}`,
      numeroCelular: '11987654321',
    });
    // Cleanup the gift (addressed delete is itself an addressed-write proof).
    await trpcMutation(api, 'contribuicao.delete', { idCampanha: campB.id, ids: created.ids });
  });

  // ── Arm B — FAIL-CLOSED: every enforced mutation rejects id-less ─────────
  // The 11 frozen mutations (aperture-48mxt). Each payload OMITS idCampanha
  // but carries valid-format placeholders for other fields, so the sole (or
  // at least a present) zod issue is the missing idCampanha. We assert
  // BAD_REQUEST AND that the error names idCampanha — proving idCampanha is
  // SPECIFICALLY in the required set now.
  const ENFORCED: Array<{ proc: string; idlessInput: Record<string, unknown> }> = [
    { proc: 'contribuicao.create', idlessInput: { nome: 'x', valor: 5_000, quantidade: 1 } },
    {
      proc: 'contribuicao.createBulk',
      idlessInput: { itens: [{ nome: 'x', valor: 5_000, quantidade: 1 }] },
    },
    { proc: 'contribuicao.update', idlessInput: { id: RANDOM_UUID, nome: 'x' } },
    { proc: 'contribuicao.delete', idlessInput: { ids: [RANDOM_UUID] } },
    { proc: 'contribuicao.emitirUrlUploadImagemItem', idlessInput: { contentType: 'image/png' } },
    { proc: 'eventoConvite.save', idlessInput: conviteSaveInput('x') },
    {
      proc: 'eventoListaDeConvidados.alterarPresenca',
      idlessInput: { idConvidado: RANDOM_UUID, presenca: 'confirmado' },
    },
    { proc: 'eventoListaDeConvidados.adicionarConvidado', idlessInput: { nome: 'x' } },
    {
      proc: 'eventoListaDeConvidados.salvarFormatoMensagem',
      idlessInput: { formatoMensagemConvite: 'texto' },
    },
    {
      proc: 'painelMensagens.marcarLida',
      idlessInput: { slug: WALKER_SLUG, idPagamento: RANDOM_UUID },
    },
    { proc: 'painelMensagens.marcarTodasLidas', idlessInput: { slug: WALKER_SLUG } },
  ];

  for (const { proc, idlessInput } of ENFORCED) {
    test(`B — ${proc} rejects an id-less write with BAD_REQUEST citing idCampanha`, async () => {
      const r = await trpcRaw(api, proc, idlessInput);
      expect(r.ok, `${proc} id-less write must FAIL (fail-closed) — got ${r.status}`).toBe(false);
      expect(r.code, `${proc} id-less rejection must be BAD_REQUEST`).toBe('BAD_REQUEST');
      expect(
        r.message ?? '',
        `${proc} rejection must name idCampanha (proves it is the required field), got: ${r.message}`,
      ).toContain('idCampanha');
    });
  }

  // ── Arm C — PUBLIC TRIO stays optional (must NOT require idCampanha) ──────
  const PUBLIC_TRIO: Array<{ proc: string; input: Record<string, unknown> }> = [
    // iniciarPagamento* omit idCampanha; will fail on other fields, never on idCampanha.
    { proc: 'pagina.iniciarPagamentoContribuicao', input: { slug: WALKER_SLUG } },
    { proc: 'pagina.iniciarPagamentoCarrinho', input: { slug: WALKER_SLUG } },
    // confirmarPresenca is convidado-first — no idCampanha by design.
    {
      proc: 'eventoListaDeConvidados.confirmarPresenca',
      input: { slug: WALKER_SLUG, idConvidado: RANDOM_UUID, presenca: 'confirmado' },
    },
  ];

  for (const { proc, input } of PUBLIC_TRIO) {
    test(`C — public ${proc} does NOT reject for missing idCampanha (optional-by-design)`, async () => {
      const r = await trpcRaw(api, proc, input);
      // It may error for OTHER reasons (missing item, unknown convidado) — that
      // is fine. What must NEVER happen is an idCampanha-required rejection.
      const idCampanhaRequired =
        r.code === 'BAD_REQUEST' && (r.message ?? '').includes('idCampanha');
      expect(
        idCampanhaRequired,
        `${proc} must stay optional-by-design — it must not reject for a missing idCampanha. msg: ${r.message}`,
      ).toBe(false);
    });
  }

  // ── Arm D — CROSS-CAMPANHA ISOLATION intact under enforcement ────────────
  test('D — an addressed write on A lands in A and does NOT leak into B', async () => {
    const nome = `W2 isolation A ${RUN}`;
    const created = await trpcMutation<{ ids: string[] }>(api, 'contribuicao.create', {
      idCampanha: campA.id,
      nome,
      valor: 4_200,
      quantidade: 1,
    });
    try {
      const [catA, catB] = await Promise.all([
        trpcQuery<CatalogItem[]>(api, 'contribuicao.list', { idCampanha: campA.id }),
        trpcQuery<CatalogItem[]>(api, 'contribuicao.list', { idCampanha: campB.id }),
      ]);
      expect(
        catA.some((i) => i.nome === nome),
        "A's addressed write must land in A's catalog",
      ).toBe(true);
      expect(
        catB.some((i) => i.nome === nome),
        "A's write must NOT leak into B's catalog (isolation preserved under enforcement)",
      ).toBe(false);
    } finally {
      await trpcMutation(api, 'contribuicao.delete', { idCampanha: campA.id, ids: created.ids });
    }
  });
});
