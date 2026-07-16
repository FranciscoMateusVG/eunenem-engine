/**
 * CROSS-USER access-denial gate (aperture cross-user-denial).
 *
 * THE GAP THIS CLOSES: every other gate spec uses ONE user owning two campanhas
 * (A + B) — proving same-owner A↮B separation, but NEVER that a RIVAL user is
 * denied. The ownership gate `resolverCampanhaAdministrada` and its ~8 inline
 * `idsAdministradores.includes(usuario.idConta)` copies (pagina, painel-mensagens,
 * evento-convite, evento-lista-de-convidados, perfil, perfil-campanha, recebedor)
 * are UNIT-tested on the shared resolver only. No e2e proved each inline copy is
 * actually WIRED. A regression in any one = full cross-tenant read/edit/delete.
 *
 * THIS SPEC: seed the VICTIM (seedGateWalker — owns campanha A + B) AND a second,
 * fully-valid INTRUDER user (seedIntruderWalker — owns their OWN campanha, admins
 * none of the victim's). Log in AS THE INTRUDER, then attempt to read/mutate the
 * VICTIM's campanha A across a representative set of enforcement points, asserting
 * DENIAL on EACH. For every case a NEGATIVE CONTROL fires the SAME op on the
 * intruder's OWN campanha and asserts SUCCESS — proving the denial is
 * ownership-based, not a blanket failure.
 *
 * Enforcement points covered (procedure → expected rejection):
 *   1. painelMensagens.list       READ  victim's recados scoped to A   → UNAUTHORIZED
 *   2. recebedor.atualizar        WRITE the worst leak: CPF/bank on A  → UNAUTHORIZED
 *   3. perfilCampanha.atualizar   WRITE A's per-campanha profile       → UNAUTHORIZED
 *   4. contribuicao.create        WRITE a gift onto A                  → UNAUTHORIZED
 *   5. contribuicao.update        WRITE edit a gift on A               → UNAUTHORIZED
 *   6. contribuicao.delete        WRITE delete a gift on A             → UNAUTHORIZED
 *
 * not-found == not-owner is the deliberate posture (resolve-campanha-administrada:
 * "an attacker can't distinguish doesn't-exist from not-yours"), so all six
 * collapse to the same non-leaking code. We accept the family {UNAUTHORIZED,
 * NOT_FOUND, FORBIDDEN} as "denied" but pin the SPECIFIC code each router throws.
 *
 * Gated on the SAME E2E_GATE_EMAIL/E2E_GATE_SENHA creds as the other gate specs
 * (skips when unset) so it runs in the same CI job. Intruder creds are distinct
 * hardcoded hermetic-only literals (E2E_INTRUDER_EMAIL / _SENHA override optional).
 *
 * RUN:
 *   E2E_GATE_EMAIL=e2e-gate-walker@e2e.local \
 *   E2E_GATE_SENHA=senha-e2e-gate-walker-123 \
 *   pnpm test:e2e e2e/cross-user-denial.spec.ts
 */
import type { APIRequestContext } from '@playwright/test';
import { expect, request as pwRequest, test } from '@playwright/test';
import { ID_PLATAFORMA_EUNENEM } from '../apps/eunenem-server/pages/lib/constants.js';
import {
  type IntruderSeed,
  resolveVictimCampanhaA,
  seedGateWalker,
  seedIntruderWalker,
  type VictimCampanhaA,
} from './gate-fixtures.js';

const GATE_EMAIL = process.env.E2E_GATE_EMAIL;
const GATE_SENHA = process.env.E2E_GATE_SENHA;

const INTRUDER_NOME_EXIBICAO = 'Intruso Rival';
const RUN = Math.random().toString(36).slice(2, 8);
// Valid-UUID-format placeholder — the ownership gate rejects BEFORE this id is
// ever looked up, so a non-existent id is fine (and proves the point: the gate
// fires on tenancy, not on row existence).
const RANDOM_UUID = '00000000-0000-4000-8000-000000000000';

/** A checksum-valid test CPF + the pix receiver shape recebedor.atualizar wants. */
function dadosRecebedorPix(nomeTitular: string) {
  return {
    metodo: 'pix' as const,
    nomeTitular,
    cpfTitular: '11144477735',
    tipoChavePix: 'cpf' as const,
    chavePix: '11144477735',
  };
}

/** A zod-valid whole-content perfilCampanha payload (all-null baby-half). The
 *  ownership gate rejects before the upsert, so content is incidental. */
function perfilCampanhaInput(idCampanha: string) {
  return {
    idCampanha,
    nomeBebe: null,
    relacao: null,
    historia: null,
    dataNascimento: null,
    tipoEvento: null,
    dataEvento: null,
    fotoPerfilKey: null,
    fotoCapaKey: null,
    fotoHistoriaKey: null,
  };
}

interface RawResult {
  ok: boolean;
  status: number;
  code?: string;
  message?: string;
  data?: unknown;
}

/** GET a query and return {ok,status,code,message,data} WITHOUT asserting. */
async function trpcRawQuery(
  api: APIRequestContext,
  procedure: string,
  input?: unknown,
): Promise<RawResult> {
  const qs = input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await api.get(`/api/trpc/${procedure}${qs}`);
  const body = (await res.json().catch(() => ({}))) as {
    error?: { message?: string; data?: { code?: string } };
    result?: { data?: unknown };
  };
  return {
    ok: res.ok(),
    status: res.status(),
    code: body.error?.data?.code,
    message: body.error?.message,
    data: body.result?.data,
  };
}

/** POST a mutation and return {ok,status,code,message,data} WITHOUT asserting. */
async function trpcRawMutation(
  api: APIRequestContext,
  procedure: string,
  input: unknown,
): Promise<RawResult> {
  const res = await api.post(`/api/trpc/${procedure}`, { data: input });
  const body = (await res.json().catch(() => ({}))) as {
    error?: { message?: string; data?: { code?: string } };
    result?: { data?: unknown };
  };
  return {
    ok: res.ok(),
    status: res.status(),
    code: body.error?.data?.code,
    message: body.error?.message,
    data: body.result?.data,
  };
}

/** The non-leaking denial codes the ownership gate is allowed to surface. */
const DENIAL_CODES = ['UNAUTHORIZED', 'NOT_FOUND', 'FORBIDDEN'];

function assertDenied(r: RawResult, proc: string, expectedCode: string) {
  expect(r.ok, `${proc} on the VICTIM's campanha MUST be denied — got ${r.status} ok`).toBe(false);
  expect(
    DENIAL_CODES,
    `${proc} rejection must be a non-leaking denial code, got ${r.code} (${r.message})`,
  ).toContain(r.code);
  expect(
    r.code,
    `${proc} must reject the intruder with ${expectedCode}, got ${r.code} (${r.message})`,
  ).toBe(expectedCode);
}

test.describe('Cross-USER access-denial gate (aperture cross-user-denial)', () => {
  test.skip(
    !GATE_EMAIL || !GATE_SENHA,
    'E2E_GATE_EMAIL / E2E_GATE_SENHA not set — gate-walker creds live in env/mempalace',
  );

  let intruderApi: APIRequestContext;
  let intruder: IntruderSeed;
  let victimA: VictimCampanhaA;

  test.beforeAll(async ({ baseURL }) => {
    // Seed victim (owns A + B) and intruder (owns their own campanha) directly
    // in the DB, then resolve the victim's campanha A id + painel slug.
    await seedGateWalker();
    const intruderSeed = await seedIntruderWalker();
    const victimSeed = await resolveVictimCampanhaA();
    expect(
      intruderSeed,
      'seedIntruderWalker must return a seed when gate creds are set',
    ).toBeTruthy();
    expect(
      victimSeed,
      'resolveVictimCampanhaA must return campanha A when gate creds are set',
    ).toBeTruthy();
    intruder = intruderSeed as IntruderSeed;
    victimA = victimSeed as VictimCampanhaA;

    expect(baseURL, 'baseURL must be configured').toBeTruthy();
    intruderApi = await pwRequest.newContext({ baseURL });

    // Log in AS THE INTRUDER — a fully valid session for a user who admins none
    // of the victim's campanhas.
    const cont = await intruderApi.post('/api/trpc/auth.continuarComEmail', {
      data: {
        email: intruder.email,
        senha: intruder.senha,
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        nomeExibicao: INTRUDER_NOME_EXIBICAO,
      },
    });
    expect(cont.ok(), `intruder login failed: ${cont.status()} ${await cont.text()}`).toBe(true);

    // Sanity: the intruder must NOT be resolvable as an admin of A — assert the
    // seed shapes are actually distinct campanhas (guards a mis-seed that would
    // make every denial assertion below a false-green).
    expect(
      victimA.idCampanha,
      'victim A and intruder campanha must be DISTINCT ids (else denial is untestable)',
    ).not.toBe(intruder.idCampanha);
  });

  test.afterAll(async () => {
    await intruderApi?.dispose();
  });

  // ── 1. READ the victim's painel recados scoped to A ──────────────────────
  test('painelMensagens.list — intruder is DENIED the victim campanha A recados', async () => {
    // Attack: pass the VICTIM's painel slug + A's idCampanha. The slug's owner
    // (victim) IS an admin of A, but the SESSION user (intruder) is not →
    // painel-mensagens-router.ts:106 throws PainelMensagensSessaoError → UNAUTHORIZED.
    const denied = await trpcRawQuery(intruderApi, 'painelMensagens.list', {
      slug: victimA.slug,
      idCampanha: victimA.idCampanha,
    });
    assertDenied(denied, 'painelMensagens.list', 'UNAUTHORIZED');

    // Negative control: the intruder CAN read their OWN painel.
    const own = await trpcRawQuery(intruderApi, 'painelMensagens.list', {
      slug: intruder.slug,
      idCampanha: intruder.idCampanha,
    });
    expect(own.ok, `intruder must read their OWN painel — ${own.status} ${own.message}`).toBe(true);
  });

  // ── 2. recebedor.atualizar — the worst leak: CPF / bank on A ──────────────
  test('recebedor.atualizar — intruder is DENIED writing bank/CPF onto victim A', async () => {
    const denied = await trpcRawMutation(intruderApi, 'recebedor.atualizar', {
      idCampanha: victimA.idCampanha,
      dadosRecebedor: dadosRecebedorPix('Intruso Rival'),
    });
    assertDenied(denied, 'recebedor.atualizar', 'UNAUTHORIZED');

    // Negative control: the intruder CAN set bank/CPF on their OWN campanha.
    const own = await trpcRawMutation(intruderApi, 'recebedor.atualizar', {
      idCampanha: intruder.idCampanha,
      dadosRecebedor: dadosRecebedorPix('Intruso Rival'),
    });
    expect(
      own.ok,
      `intruder must set recebedor on their OWN campanha — ${own.status} ${own.message}`,
    ).toBe(true);
  });

  // ── 3. perfilCampanha.atualizar — A's per-campanha profile ────────────────
  test('perfilCampanha.atualizar — intruder is DENIED editing victim A profile', async () => {
    const denied = await trpcRawMutation(
      intruderApi,
      'perfilCampanha.atualizar',
      perfilCampanhaInput(victimA.idCampanha),
    );
    assertDenied(denied, 'perfilCampanha.atualizar', 'UNAUTHORIZED');

    // Negative control: intruder CAN edit their OWN campanha profile.
    const own = await trpcRawMutation(
      intruderApi,
      'perfilCampanha.atualizar',
      perfilCampanhaInput(intruder.idCampanha),
    );
    expect(own.ok, `intruder must edit their OWN profile — ${own.status} ${own.message}`).toBe(
      true,
    );
  });

  // ── 4. contribuicao.create — add a gift onto A ────────────────────────────
  test('contribuicao.create — intruder is DENIED adding a gift to victim A', async () => {
    const denied = await trpcRawMutation(intruderApi, 'contribuicao.create', {
      idCampanha: victimA.idCampanha,
      nome: `Intruso gift ${RUN}`,
      valor: 5_000,
      quantidade: 1,
    });
    assertDenied(denied, 'contribuicao.create', 'UNAUTHORIZED');

    // Negative control: intruder CAN add a gift to their OWN campanha (cleanup).
    const own = await trpcRawMutation(intruderApi, 'contribuicao.create', {
      idCampanha: intruder.idCampanha,
      nome: `Intruso own gift ${RUN}`,
      valor: 5_000,
      quantidade: 1,
    });
    expect(
      own.ok,
      `intruder must add a gift to their OWN campanha — ${own.status} ${own.message}`,
    ).toBe(true);
    const ids = (own.data as { ids?: string[] } | undefined)?.ids ?? [];
    expect(ids[0], 'own contribuicao.create must return an id').toBeTruthy();
    await trpcRawMutation(intruderApi, 'contribuicao.delete', {
      idCampanha: intruder.idCampanha,
      ids,
    });
  });

  // ── 5. contribuicao.update — edit a gift on A ─────────────────────────────
  test('contribuicao.update — intruder is DENIED editing a gift on victim A', async () => {
    // The ownership gate fires before the item id is resolved, so a random id is
    // sufficient — denial is on tenancy, not row existence.
    const denied = await trpcRawMutation(intruderApi, 'contribuicao.update', {
      idCampanha: victimA.idCampanha,
      id: RANDOM_UUID,
      nome: `Hijacked ${RUN}`,
    });
    assertDenied(denied, 'contribuicao.update', 'UNAUTHORIZED');

    // Negative control: intruder CAN edit a gift on their OWN campanha. Create
    // one, update it, then clean up.
    const created = await trpcRawMutation(intruderApi, 'contribuicao.create', {
      idCampanha: intruder.idCampanha,
      nome: `Intruso upd base ${RUN}`,
      valor: 4_200,
      quantidade: 1,
    });
    expect(created.ok, `setup create must succeed — ${created.status} ${created.message}`).toBe(
      true,
    );
    const ids = (created.data as { ids?: string[] } | undefined)?.ids ?? [];
    try {
      const own = await trpcRawMutation(intruderApi, 'contribuicao.update', {
        idCampanha: intruder.idCampanha,
        id: ids[0],
        nome: `Intruso upd done ${RUN}`,
      });
      expect(own.ok, `intruder must edit their OWN gift — ${own.status} ${own.message}`).toBe(true);
    } finally {
      await trpcRawMutation(intruderApi, 'contribuicao.delete', {
        idCampanha: intruder.idCampanha,
        ids,
      });
    }
  });

  // ── 6. contribuicao.delete — delete a gift on A ───────────────────────────
  test('contribuicao.delete — intruder is DENIED deleting a gift on victim A', async () => {
    const denied = await trpcRawMutation(intruderApi, 'contribuicao.delete', {
      idCampanha: victimA.idCampanha,
      ids: [RANDOM_UUID],
    });
    assertDenied(denied, 'contribuicao.delete', 'UNAUTHORIZED');

    // Negative control: intruder CAN delete a gift on their OWN campanha.
    const created = await trpcRawMutation(intruderApi, 'contribuicao.create', {
      idCampanha: intruder.idCampanha,
      nome: `Intruso del base ${RUN}`,
      valor: 3_300,
      quantidade: 1,
    });
    expect(created.ok, `setup create must succeed — ${created.status} ${created.message}`).toBe(
      true,
    );
    const ids = (created.data as { ids?: string[] } | undefined)?.ids ?? [];
    const own = await trpcRawMutation(intruderApi, 'contribuicao.delete', {
      idCampanha: intruder.idCampanha,
      ids,
    });
    expect(own.ok, `intruder must delete their OWN gift — ${own.status} ${own.message}`).toBe(true);
  });
});
