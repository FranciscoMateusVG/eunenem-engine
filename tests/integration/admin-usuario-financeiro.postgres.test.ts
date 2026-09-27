import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadAdminUserFinanceiroSnapshot } from '../../apps/eunenem-server/server/admin-user-financeiro.js';
import type { ServerDeps } from '../../apps/eunenem-server/server/auth/setup.js';
import type { TrpcContext } from '../../apps/eunenem-server/server/trpc/context.js';
import { appRouter } from '../../apps/eunenem-server/server/trpc/router.js';
import { LivroFinanceiroRepositoryPostgres } from '../../src/adapters/pagamentos/financeiro/livro-repository.postgres.js';
import { UsuarioRepositoryPostgres } from '../../src/adapters/usuario/repository.postgres.js';
import type { IdCampanha } from '../../src/domain/arrecadacao/value-objects/ids.js';
import type { LancamentoFinanceiro } from '../../src/domain/pagamentos/financeiro/entities/lancamento-financeiro.js';
import type { IdRepasse } from '../../src/domain/pagamentos/financeiro/value-objects/ids.js';
import { ID_PLATAFORMA_EUNENEM } from '../../src/index.js';
import { adminAuthOverrides } from '../helpers/admin-auth.js';
import { withLancamentoSeeding } from '../helpers/seed-lancamento-parents.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';

/**
 * aperture-5jk8y — admin.usuarios.financeiro.* contra Postgres real.
 *
 * Prova, no snapshot único (READ ONLY REPEATABLE READ, 3 statements):
 *   - totais sobre TODAS as campanhas administradas, DISTINCT, restritas à
 *     plataforma (campanha de outra plataforma administrada pela mesma conta
 *     fica FORA), independentes de paginação;
 *   - buckets por linha com fatos explícitos (estorno_ativo via devolução PIX
 *     em_processamento; disponivel_canonico via predicado da branch);
 *   - cross-check SUM independente = recebido (diferença 0 em base sã);
 *   - coadmins explícitos; celular do titular mascarado SÓ no summary;
 *   - keyset determinístico de lançamentos (sem duplicar/perder), cursor de
 *     outra conta / inválido ⇒ BAD_REQUEST;
 *   - repasses com estadoExtrato da projeção compartilhada;
 *   - >100 campanhas ⇒ truncated=true, campanhasTotal completo, lista ≤100.
 *
 * NOT_RUN nesta branch (obrigatório antes de promover a main): refund-op
 * Stripe ativa (`stripe_refund_operations`) ⇒ linha NÃO disponível. A tabela
 * não existe em staging.
 */

const NOW = new Date('2026-09-26T12:00:00.000Z');
const PAST = new Date('2026-09-20T12:00:00.000Z');
const FUTURE = new Date('2026-10-02T12:00:00.000Z');

const OWNER_ID = '11000000-0000-4000-8000-0000000000a1';
const OWNER_CONTA = '12000000-0000-4000-8000-0000000000a1';
const COADMIN_ID = '11000000-0000-4000-8000-0000000000a2';
const COADMIN_CONTA = '12000000-0000-4000-8000-0000000000a2';
const MANY_ID = '11000000-0000-4000-8000-0000000000a3';
const MANY_CONTA = '12000000-0000-4000-8000-0000000000a3';

const CAMP_A = '10000000-0000-4000-8000-0000000000c1';
const CAMP_B = '10000000-0000-4000-8000-0000000000c2';
const CAMP_OTHER_PLATFORM = '10000000-0000-4000-8000-0000000000c3';
const OTHER_PLATFORM = '00000000-0000-4000-8000-00000000ffff';
const CELULAR_RAW = '11987654321';

let testDb: TestDatabase;
let repo: LivroFinanceiroRepositoryPostgres;
let manyCampaignIds: string[] = [];

// biome-ignore lint/suspicious/noExplicitAny: raw fixture writes span several BCs
const anyDb = () => testDb.db as any;

function lancamento(idCampanha: string, amountCents: number): LancamentoFinanceiro {
  return {
    id: randomUUID(),
    idPagamento: randomUUID(),
    idItemPagamento: randomUUID(),
    idContribuicao: randomUUID(),
    idCampanha,
    tipo: 'credito_saldo_recebedor',
    amountCents,
    criadoEm: new Date('2026-09-01T12:00:00Z'),
    transferidoEm: null,
    canceladoEm: null,
    idRepasse: null,
  } as never;
}

async function setAvailableOn(idPagamento: string, when: Date | null) {
  await anyDb()
    .updateTable('pagamentos')
    .set({ intencao_balance_transaction_available_on: when })
    .where('id', '=', idPagamento)
    .execute();
}

async function setPagamentoStatus(idPagamento: string, status: string) {
  await anyDb().updateTable('pagamentos').set({ status }).where('id', '=', idPagamento).execute();
}

function alnum(len: number): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

async function wipe(campaignIds: readonly string[], userIds: readonly string[]) {
  const db = anyDb();
  const pagamentosDe = db
    .selectFrom('pagamentos')
    .select('id')
    .where('intencao_id_campanha', 'in', campaignIds);
  await db
    .deleteFrom('pix_cobranca_devolucoes')
    .where('id_pagamento', 'in', pagamentosDe)
    .execute();
  await db.deleteFrom('lancamentos_financeiros').where('id_campanha', 'in', campaignIds).execute();
  await db.deleteFrom('repasses_recebedor').where('id_campanha', 'in', campaignIds).execute();
  await db.deleteFrom('intencao_items').where('id_pagamento', 'in', pagamentosDe).execute();
  await db.deleteFrom('pagamentos').where('intencao_id_campanha', 'in', campaignIds).execute();
  await db.deleteFrom('recebedores').where('campanha_id', 'in', campaignIds).execute();
  await db.deleteFrom('contribuicoes').where('campanha_id', 'in', campaignIds).execute();
  await db.deleteFrom('opcoes_contribuicao').where('campanha_id', 'in', campaignIds).execute();
  await db.deleteFrom('campanha_administradores').where('campanha_id', 'in', campaignIds).execute();
  await db.deleteFrom('campanhas').where('id', 'in', campaignIds).execute();
  await db.deleteFrom('contas').where('id_usuario', 'in', userIds).execute();
  await db.deleteFrom('usuarios').where('id', 'in', userIds).execute();
}

/** Router caller: gate real (allowlist) + escopo real (UsuarioRepositoryPostgres) + db real. */
function buildCaller() {
  const auth = adminAuthOverrides();
  const real = new UsuarioRepositoryPostgres(testDb.db);
  const stubbed = auth.depsOverrides.usuarioRepository as unknown as {
    findUsuarioById: (id: string) => Promise<unknown>;
  };
  const deps = {
    ...auth.depsOverrides,
    usuarioRepository: {
      findUsuarioById: stubbed.findUsuarioById,
      findUsuarioByConta: (idConta: never, idPlataforma: never) =>
        real.findUsuarioByConta(idConta, idPlataforma),
    },
    db: testDb.db,
    clock: () => NOW,
    logPiiHashSalt: 'integration-cursor-salt',
  } as unknown as ServerDeps;
  const ctx: TrpcContext = { deps, headers: auth.headers, resHeaders: new Headers() };
  return appRouter.createCaller(ctx);
}

// Fixture ids populated in beforeAll for assertions.
const F: Record<string, LancamentoFinanceiro> = {};
let repasseB: string;

beforeAll(async () => {
  testDb = await createTestDatabase();
  await wipe([CAMP_A, CAMP_B, CAMP_OTHER_PLATFORM], [OWNER_ID, COADMIN_ID, MANY_ID]);
  repo = withLancamentoSeeding(new LivroFinanceiroRepositoryPostgres(testDb.db), testDb.db);

  await anyDb()
    .insertInto('usuarios')
    .values([
      {
        id: OWNER_ID,
        id_plataforma: ID_PLATAFORMA_EUNENEM,
        id_conta: OWNER_CONTA,
        email: 'owner-fin@example.test',
        nome_exibicao: 'Owner Fin',
        slug: 'owner-fin',
      },
      {
        id: COADMIN_ID,
        id_plataforma: ID_PLATAFORMA_EUNENEM,
        id_conta: COADMIN_CONTA,
        email: 'coadmin-fin@example.test',
        nome_exibicao: 'Coadmin Fin',
        slug: 'coadmin-fin',
      },
      {
        id: MANY_ID,
        id_plataforma: ID_PLATAFORMA_EUNENEM,
        id_conta: MANY_CONTA,
        email: 'many-fin@example.test',
        nome_exibicao: 'Many Fin',
        slug: 'many-fin',
      },
    ])
    .execute();
  // findUsuarioByConta resolve via JOIN contas → usuarios.
  await anyDb()
    .insertInto('contas')
    .values([
      { id: OWNER_CONTA, id_usuario: OWNER_ID },
      { id: COADMIN_CONTA, id_usuario: COADMIN_ID },
      { id: MANY_CONTA, id_usuario: MANY_ID },
    ])
    .execute();

  await anyDb()
    .insertInto('campanhas')
    .values([
      { id: CAMP_A, id_plataforma: ID_PLATAFORMA_EUNENEM, titulo: 'Chá A', slug: 'cha-a' },
      { id: CAMP_B, id_plataforma: ID_PLATAFORMA_EUNENEM, titulo: 'Chá B', slug: 'cha-b' },
      {
        id: CAMP_OTHER_PLATFORM,
        id_plataforma: OTHER_PLATFORM,
        titulo: 'Outra plataforma',
        slug: 'outra',
      },
    ])
    .execute();
  await anyDb()
    .insertInto('campanha_administradores')
    .values([
      { campanha_id: CAMP_A, id_usuario: OWNER_CONTA },
      { campanha_id: CAMP_A, id_usuario: COADMIN_CONTA },
      { campanha_id: CAMP_B, id_usuario: OWNER_CONTA },
      { campanha_id: CAMP_OTHER_PLATFORM, id_usuario: OWNER_CONTA },
    ])
    .execute();

  // Recebedor ativo só em A (celular em claro no banco; deve sair mascarado).
  await anyDb()
    .insertInto('recebedores')
    .values({
      id: randomUUID(),
      campanha_id: CAMP_A,
      metodo: 'pix',
      nome_titular: 'Titular A',
      cpf_titular: '52998224725',
      tipo_chave_pix: 'email',
      chave_pix: 'titular-a@example.test',
      celular_titular: CELULAR_RAW,
      is_active: true,
    })
    .execute();

  // ── Campanha A ──
  F.a1 = lancamento(CAMP_A, 100); // disponivel
  F.a2 = lancamento(CAMP_A, 200); // aguardando_liberacao (futuro)
  F.a3 = lancamento(CAMP_A, 300); // aguardando_liberacao (null)
  F.a4 = lancamento(CAMP_A, 400); // estorno_em_andamento
  F.a5 = lancamento(CAMP_A, 500); // estornado
  F.a6 = lancamento(CAMP_A, 600); // anomalia: pagamento pendente
  F.a7 = lancamento(CAMP_A, 700); // transferido
  await repo.saveLancamentos([F.a1, F.a2, F.a3, F.a4, F.a5, F.a6, F.a7] as never);
  await setAvailableOn(F.a1.idPagamento, PAST);
  await setAvailableOn(F.a2.idPagamento, FUTURE);
  await setAvailableOn(F.a3.idPagamento, null);
  await setAvailableOn(F.a4.idPagamento, PAST);
  await anyDb()
    .insertInto('pix_cobranca_devolucoes')
    .values({
      id: randomUUID(),
      id_pagamento: F.a4.idPagamento,
      e2e_id: `E${alnum(31)}`,
      id_devolucao: alnum(30),
      amount_cents: 400,
      status: 'em_processamento',
      rtr_id: null,
    })
    .execute();
  await setAvailableOn(F.a5.idPagamento, PAST);
  await repo.marcarLancamentosComoCanceladosPorPagamento(F.a5.idPagamento, PAST);
  await setPagamentoStatus(F.a5.idPagamento, 'estornado');
  await setAvailableOn(F.a6.idPagamento, PAST);
  await setPagamentoStatus(F.a6.idPagamento, 'pendente');
  await setAvailableOn(F.a7.idPagamento, PAST);
  await repo.marcarLancamentosComoTransferidos([F.a7.id], PAST);

  // ── Campanha B ── b1 reivindicado por repasse solicitado; b2 disponível (criado depois).
  F.b1 = lancamento(CAMP_B, 800);
  await repo.saveLancamentos([F.b1] as never);
  await setAvailableOn(F.b1.idPagamento, PAST);
  repasseB = randomUUID();
  const claimed = await repo.solicitarRepasseTransaction({
    idCampanha: CAMP_B as IdCampanha,
    idRepasse: repasseB as IdRepasse,
    solicitadoEm: PAST,
    now: NOW,
  });
  expect(claimed.idsLancamentosClaimados).toEqual([F.b1.id]);
  F.b2 = lancamento(CAMP_B, 900);
  await repo.saveLancamentos([F.b2] as never);
  await setAvailableOn(F.b2.idPagamento, PAST);

  // ── Campanha de OUTRA plataforma administrada pelo owner: deve ficar fora.
  F.c1 = lancamento(CAMP_OTHER_PLATFORM, 1000);
  await repo.saveLancamentos([F.c1] as never);
  await setAvailableOn(F.c1.idPagamento, PAST);
}, 120_000);

afterAll(async () => {
  await wipe(
    [CAMP_A, CAMP_B, CAMP_OTHER_PLATFORM, ...manyCampaignIds],
    [OWNER_ID, COADMIN_ID, MANY_ID],
  );
  await testDb.teardown();
});

describe('loadAdminUserFinanceiroSnapshot — fatos explícitos no snapshot', () => {
  it('traz um fato por linha das campanhas administradas na plataforma, com estorno_ativo e disponivel_canonico', async () => {
    const snap = await loadAdminUserFinanceiroSnapshot(testDb.db, {
      idConta: OWNER_CONTA,
      platformId: ID_PLATAFORMA_EUNENEM,
      now: NOW,
    });
    const byId = new Map(snap.fatos.map((f) => [f.idLancamento, f]));
    expect(snap.fatos).toHaveLength(9);
    expect(byId.has(F.c1.id)).toBe(false);

    expect(byId.get(F.a4.id)?.estornoAtivo).toBe(true);
    expect([...byId.values()].filter((f) => f.estornoAtivo).map((f) => f.idLancamento)).toEqual([
      F.a4.id,
    ]);
    expect(
      [...byId.values()]
        .filter((f) => f.disponivelCanonico)
        .map((f) => f.idLancamento)
        .sort(),
    ).toEqual([F.a1.id, F.b2.id].sort());
    expect(byId.get(F.b1.id)?.repasseStatus).toBe('solicitado');
    expect(byId.get(F.a6.id)?.pagamentoStatus).toBe('pendente');
    expect(byId.get(F.a5.id)?.canceladoEm).not.toBeNull();
    expect(byId.get(F.a7.id)?.transferidoEm).not.toBeNull();

    // C — SUM independente: aprovado ∧ sem cancelado_em = a1 a2 a3 a4 a7 b1 b2
    expect(snap.ledgerAprovadoSemCancelCents).toBe(100 + 200 + 300 + 400 + 700 + 800 + 900);

    // B — metadados: 2 campanhas (DISTINCT), coadmins de A, celular em claro só aqui (router mascara)
    expect(snap.campanhas.map((c) => c.idCampanha)).toEqual([CAMP_A, CAMP_B]);
    const a = snap.campanhas.find((c) => c.idCampanha === CAMP_A);
    expect(a?.administradores.map((x) => x.idConta).sort()).toEqual(
      [OWNER_CONTA, COADMIN_CONTA].sort(),
    );
    expect(a?.celularTitularRaw).toBe(CELULAR_RAW);
    expect(snap.campanhas.find((c) => c.idCampanha === CAMP_B)?.celularTitularRaw).toBeNull();
  });
});

describe('admin.usuarios.financeiro.summary', () => {
  it('totais deduplicados sobre todas as campanhas da plataforma, coadmins explícitos, celular mascarado, diferença 0', async () => {
    const caller = buildCaller();
    const s = await caller.admin.usuarios.financeiro.summary({ idConta: OWNER_CONTA });
    expect(s).not.toBeNull();
    if (!s) return;

    expect(s.usuario).toEqual({
      idConta: OWNER_CONTA,
      email: 'owner-fin@example.test',
      nomeExibicao: 'Owner Fin',
    });
    expect(s.campanhasTotal).toBe(2);
    expect(s.truncated).toBe(false);

    const t = s.totais;
    expect(t.recebidoConfirmadoCents).toBe(3400);
    expect(t.disponivelCents).toBe(1000);
    expect(t.aguardandoLiberacaoCents).toBe(500);
    expect(t.aguardandoTransferenciaCents).toBe(800);
    expect(t.transferenciaFalhouCents).toBe(0);
    expect(t.emTransferenciaCents).toBe(800);
    expect(t.enviadoAoBancoCents).toBe(0);
    expect(t.transferidoCents).toBe(700);
    expect(t.resgatadoConcluidoCents).toBe(700);
    expect(t.estornoEmAndamentoCents).toBe(400);
    expect(t.inconsistenteCents).toBe(0);
    expect(t.pendenteConferenciaCents).toBe(400);
    expect(t.estornadoCents).toBe(500);
    expect(t.estornadoCount).toBe(1);
    expect(t.anomaliaCents).toBe(600);
    expect(t.anomaliaCount).toBe(1);
    expect(t.lancamentosCount).toBe(9);
    expect(
      t.disponivelCents +
        t.aguardandoLiberacaoCents +
        t.aguardandoTransferenciaCents +
        t.transferenciaFalhouCents +
        t.enviadoAoBancoCents +
        t.transferidoCents +
        t.estornoEmAndamentoCents +
        t.inconsistenteCents,
    ).toBe(t.recebidoConfirmadoCents);
    expect(s.ledgerAprovadoSemCancelCents).toBe(3400);
    expect(s.diferencaNaoConciliadaCents).toBe(0);

    expect(s.campanhas.map((c) => c.idCampanha)).toEqual([CAMP_A, CAMP_B]);
    const a = s.campanhas[0];
    const b = s.campanhas[1];
    expect(a?.totais.recebidoConfirmadoCents).toBe(100 + 200 + 300 + 400 + 700);
    expect(a?.totais.estornadoCents).toBe(500);
    expect(a?.totais.anomaliaCents).toBe(600);
    expect(b?.totais.recebidoConfirmadoCents).toBe(800 + 900);
    expect(b?.totais.aguardandoTransferenciaCents).toBe(800);
    expect(a?.administradores.map((x) => x.nomeExibicao).sort()).toEqual([
      'Coadmin Fin',
      'Owner Fin',
    ]);
    expect(b?.administradores).toEqual([
      { idConta: OWNER_CONTA, nomeExibicao: 'Owner Fin', email: 'owner-fin@example.test' },
    ]);
    expect(a?.celularTitularMascarado).toBe('(**) *****-4321');
    expect(b?.celularTitularMascarado).toBeNull();

    const wire = JSON.stringify(s);
    expect(wire).not.toContain(CELULAR_RAW);
    expect(wire).not.toContain('1198765');
    expect(wire).not.toContain('Outra plataforma');
  });

  it('coadmin vê a MESMA campanha A (uma vez) e só ela', async () => {
    const caller = buildCaller();
    const s = await caller.admin.usuarios.financeiro.summary({ idConta: COADMIN_CONTA });
    expect(s?.campanhas.map((c) => c.idCampanha)).toEqual([CAMP_A]);
    expect(s?.totais.recebidoConfirmadoCents).toBe(100 + 200 + 300 + 400 + 700);
    expect(s?.totais.lancamentosCount).toBe(7);
  });

  it('>100 campanhas administradas ⇒ truncated, campanhasTotal completo, lista limitada a 100', async () => {
    manyCampaignIds = Array.from({ length: 101 }, () => randomUUID());
    await anyDb()
      .insertInto('campanhas')
      .values(
        manyCampaignIds.map((id, i) => ({
          id,
          id_plataforma: ID_PLATAFORMA_EUNENEM,
          titulo: `Muitas ${i}`,
          slug: `muitas-${id.slice(0, 8)}`,
        })),
      )
      .execute();
    await anyDb()
      .insertInto('campanha_administradores')
      .values(manyCampaignIds.map((id) => ({ campanha_id: id, id_usuario: MANY_CONTA })))
      .execute();

    const caller = buildCaller();
    const s = await caller.admin.usuarios.financeiro.summary({ idConta: MANY_CONTA });
    expect(s?.campanhasTotal).toBe(101);
    expect(s?.truncated).toBe(true);
    expect(s?.campanhas).toHaveLength(100);
    expect(s?.totais.recebidoConfirmadoCents).toBe(0);
    expect(s?.totais.lancamentosCount).toBe(0);
    expect(s?.diferencaNaoConciliadaCents).toBe(0);
  });
});

describe('admin.usuarios.financeiro.lancamentos.listPaginated', () => {
  it('buckets por linha, filtros, sem telefone', async () => {
    const caller = buildCaller();
    const all = await caller.admin.usuarios.financeiro.lancamentos.listPaginated({
      idConta: OWNER_CONTA,
      cursor: null,
      limit: 100,
    });
    expect(all?.totalCount).toBe(9);
    expect(all?.nextCursor).toBeNull();
    const bucketOf = new Map(all?.rows.map((r) => [r.idLancamento, r.bucket]));
    expect(bucketOf.get(F.a1.id)).toBe('disponivel');
    expect(bucketOf.get(F.a2.id)).toBe('aguardando_liberacao');
    expect(bucketOf.get(F.a3.id)).toBe('aguardando_liberacao');
    expect(bucketOf.get(F.a4.id)).toBe('estorno_em_andamento');
    expect(bucketOf.get(F.a5.id)).toBe('estornado');
    expect(bucketOf.get(F.a6.id)).toBe('anomalia');
    expect(bucketOf.get(F.a7.id)).toBe('transferido');
    expect(bucketOf.get(F.b1.id)).toBe('aguardando_transferencia');
    expect(bucketOf.get(F.b2.id)).toBe('disponivel');
    expect(bucketOf.has(F.c1.id)).toBe(false);

    const a2 = all?.rows.find((r) => r.idLancamento === F.a2.id);
    expect(a2?.liberacaoPrevistaEm).toBe(FUTURE.toISOString());
    const a6 = all?.rows.find((r) => r.idLancamento === F.a6.id);
    expect(a6?.motivo).toBe('pagamento_nao_aprovado');
    expect(a6?.elegivelRecebido).toBe(false);
    const b1 = all?.rows.find((r) => r.idLancamento === F.b1.id);
    expect(b1?.idRepasse).toBe(repasseB);
    expect(b1?.repasseStatus).toBe('solicitado');
    expect(b1?.campanhaTitulo).toBe('Chá B');

    const wire = JSON.stringify(all);
    expect(wire).not.toContain(CELULAR_RAW);
    expect(wire).not.toContain('celular');

    const so = await caller.admin.usuarios.financeiro.lancamentos.listPaginated({
      idConta: OWNER_CONTA,
      cursor: null,
      limit: 100,
      estado: 'estorno_em_andamento',
    });
    expect(so?.rows.map((r) => r.idLancamento)).toEqual([F.a4.id]);
    expect(so?.totalCount).toBe(1);

    const b = await caller.admin.usuarios.financeiro.lancamentos.listPaginated({
      idConta: OWNER_CONTA,
      cursor: null,
      limit: 100,
      idCampanha: CAMP_B,
    });
    expect(b?.totalCount).toBe(2);
    expect(b?.rows.every((r) => r.idCampanha === CAMP_B)).toBe(true);
  });

  it('keyset determinístico: páginas de 4 cobrem os 9 sem duplicar nem perder; totalCount constante', async () => {
    const caller = buildCaller();
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await caller.admin.usuarios.financeiro.lancamentos.listPaginated({
        idConta: OWNER_CONTA,
        cursor,
        limit: 4,
      });
      expect(page?.totalCount).toBe(9);
      for (const r of page?.rows ?? []) seen.push(r.idLancamento);
      cursor = page?.nextCursor ?? null;
      pages += 1;
    } while (cursor !== null && pages < 10);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(9);
    expect(seen).toHaveLength(9);
  });

  it('cursor inválido ou de outra conta ⇒ BAD_REQUEST', async () => {
    const caller = buildCaller();
    const first = await caller.admin.usuarios.financeiro.lancamentos.listPaginated({
      idConta: OWNER_CONTA,
      cursor: null,
      limit: 2,
    });
    expect(first?.nextCursor).not.toBeNull();
    await expect(
      caller.admin.usuarios.financeiro.lancamentos.listPaginated({
        idConta: COADMIN_CONTA,
        cursor: first?.nextCursor ?? null,
        limit: 2,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller.admin.usuarios.financeiro.lancamentos.listPaginated({
        idConta: OWNER_CONTA,
        cursor: 'nao-e-um-cursor',
        limit: 2,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('admin.usuarios.financeiro.repasses.listPaginated', () => {
  it('lista o repasse de B com estadoExtrato da projeção compartilhada e sem destino/telefone', async () => {
    const caller = buildCaller();
    const r = await caller.admin.usuarios.financeiro.repasses.listPaginated({
      idConta: OWNER_CONTA,
      cursor: null,
      limit: 20,
    });
    expect(r?.totalCount).toBe(1);
    expect(r?.nextCursor).toBeNull();
    const row = r?.rows[0];
    expect(row?.idRepasse).toBe(repasseB);
    expect(row?.idCampanha).toBe(CAMP_B);
    expect(row?.campanhaTitulo).toBe('Chá B');
    expect(row?.status).toBe('solicitado');
    expect(row?.estadoExtrato).toBe('aguardando_aprovacao');
    expect(row?.amountCents).toBe(800);
    expect(row?.numLancamentos).toBe(1);
    expect(row?.concluidoEm).toBeNull();
    expect(row?.recebedorNome).toBeNull(); // B não tem recebedor ativo
    const wire = JSON.stringify(r);
    expect(wire).not.toContain('destination');
    expect(wire).not.toContain('celular');
    expect(wire).not.toContain(CELULAR_RAW);
  });

  it('coadmin não vê o repasse de B', async () => {
    const caller = buildCaller();
    const r = await caller.admin.usuarios.financeiro.repasses.listPaginated({
      idConta: COADMIN_CONTA,
      cursor: null,
      limit: 20,
    });
    expect(r?.totalCount).toBe(0);
    expect(r?.rows).toEqual([]);
  });

  it('cursor inválido ⇒ BAD_REQUEST', async () => {
    const caller = buildCaller();
    await expect(
      caller.admin.usuarios.financeiro.repasses.listPaginated({
        idConta: OWNER_CONTA,
        cursor: 'xx',
        limit: 20,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
