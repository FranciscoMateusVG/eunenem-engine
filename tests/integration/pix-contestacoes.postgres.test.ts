import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  listarContestacoes,
  registrarContestacao,
  resolverContestacao,
} from '../../apps/eunenem-server/server/admin-pix-contestacoes.js';
import { LivroFinanceiroRepositoryPostgres } from '../../src/adapters/pagamentos/financeiro/livro-repository.postgres.js';
import type { LancamentoFinanceiro } from '../../src/domain/pagamentos/financeiro/entities/lancamento-financeiro.js';
import { seedLancamentoParents } from '../helpers/seed-lancamento-parents.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';

const paymentIds: string[] = [];
const repasseIds: string[] = [];
let rig: TestDatabase;
let repo: LivroFinanceiroRepositoryPostgres;
beforeAll(async () => {
  rig = await createTestDatabase();
  repo = new LivroFinanceiroRepositoryPostgres(rig.db);
});
afterAll(async () => {
  await sql`DELETE FROM repasse_transfer_attempts WHERE repasse_id = ANY(${repasseIds}::uuid[])`.execute(
    rig.db,
  );
  await sql`DELETE FROM lancamentos_financeiros WHERE id_pagamento = ANY(${paymentIds}::uuid[])`.execute(
    rig.db,
  );
  await sql`DELETE FROM repasses_recebedor WHERE id = ANY(${repasseIds}::uuid[])`.execute(rig.db);
  await sql`DELETE FROM pagamentos WHERE id = ANY(${paymentIds}::uuid[])`.execute(rig.db);
  await rig.teardown();
});
const now = new Date('2026-11-01T12:00:00Z');
async function fixture() {
  const l: LancamentoFinanceiro = {
    id: randomUUID() as never,
    idPagamento: randomUUID() as never,
    idItemPagamento: randomUUID() as never,
    idContribuicao: randomUUID() as never,
    idCampanha: randomUUID() as never,
    tipo: 'credito_saldo_recebedor',
    amountCents: 2000 as never,
    criadoEm: now,
    transferidoEm: null,
    canceladoEm: null,
    idRepasse: null,
  };
  paymentIds.push(l.idPagamento);
  await seedLancamentoParents(rig.db, [l]);
  await repo.saveLancamentos([l]);
  await sql`UPDATE pagamentos SET intencao_balance_transaction_available_on = ${now} WHERE id = ${l.idPagamento}`.execute(
    rig.db,
  );
  return l;
}
async function contest(l: LancamentoFinanceiro, status = 'bloqueada') {
  await sql`INSERT INTO pix_contestacoes (id, id_pagamento, valor_cents, ocorrida_em, estado, criado_por)
    VALUES (${randomUUID()}, ${l.idPagamento}, 2180, ${now}, ${status}, 'admin-test')`.execute(
    rig.db,
  );
}
async function request(l: LancamentoFinanceiro) {
  const idRepasse = randomUUID();
  repasseIds.push(idRepasse);
  return repo.solicitarRepasseTransaction({
    idCampanha: l.idCampanha as NonNullable<LancamentoFinanceiro['idCampanha']>,
    idRepasse: idRepasse as never,
    solicitadoEm: now,
    now,
  });
}
describe('MED real PG payout boundaries', () => {
  it('excludes contested payment credits from availability and sweep; release restores them', async () => {
    const l = await fixture();
    await contest(l);
    expect(
      await repo.findLancamentosDisponiveisByIdCampanha(
        l.idCampanha as NonNullable<LancamentoFinanceiro['idCampanha']>,
        now,
      ),
    ).toEqual([]);
    const empty = await request(l);
    expect(empty.idsLancamentosClaimados).toEqual([]);
    expect(empty.repasse.amountCents).toBe(0);
    // Repository preserves its empty-snapshot contract; use-case preflight rejects it.
    await sql`DELETE FROM repasses_recebedor WHERE id = ${empty.repasse.id}`.execute(rig.db);
    await sql`UPDATE pix_contestacoes SET estado = 'liberada' WHERE id_pagamento = ${l.idPagamento}`.execute(
      rig.db,
    );
    expect((await request(l)).repasse.amountCents).toBe(2000);
  });
  it.each([
    'bloqueada',
    'devolvida',
  ])('blocks manual and PIX approval for %s, without enqueue or ledger changes', async (estado) => {
    const l = await fixture();
    const { repasse } = await request(l);
    await contest(l, estado);
    await expect(
      repo.aprovarRepasseTransaction({
        idRepasse: repasse.id,
        aprovadoEm: now,
        bankTransferRef: null,
      }),
    ).rejects.toThrow(/MED/);
    let enqueued = false;
    await expect(
      repo.aprovarRepassePixTransaction(
        { idRepasse: repasse.id, aprovadoEm: now, transferReferencia: 'test' },
        async () => {
          enqueued = true;
        },
      ),
    ).rejects.toThrow(/MED/);
    expect(enqueued).toBe(false);
    expect((await repo.findRepasseById(repasse.id))?.status).toBe('solicitado');
    expect((await repo.findLancamentosByIdPagamento(l.idPagamento))[0]?.transferidoEm).toBeNull();
  });
  it('blocks a queued payout when MED is registered after approval', async () => {
    const l = await fixture();
    const { repasse } = await request(l);
    await repo.aprovarRepassePixTransaction(
      { idRepasse: repasse.id, aprovadoEm: now, transferReferencia: 'test' },
      async () => {},
    );
    await contest(l);
    await expect(
      repo.iniciarTransferenciaTransaction({
        idRepasse: repasse.id,
        agora: now,
        requestSummary: 'test',
      }),
    ).rejects.toThrow(/MED/);
    expect((await repo.findRepasseById(repasse.id))?.status).toBe('aprovado');
  });
});

async function adminFixture() {
  const l = await fixture();
  const platformId = randomUUID();
  const e2e = `E${randomUUID().replaceAll('-', '')}`;
  await sql`UPDATE campanhas SET id_plataforma = ${platformId} WHERE id = ${l.idCampanha}`.execute(
    rig.db,
  );
  await sql`UPDATE pagamentos SET intencao_total_paid_cents = 2180, intencao_e2e_external_ref = ${e2e} WHERE id = ${l.idPagamento}`.execute(
    rig.db,
  );
  return {
    l,
    platformId,
    e2e,
    input: {
      pagamentoOuE2e: e2e,
      valorCents: 2180,
      ocorridaEm: now,
      notas: 'Aviso manual',
      casoId: randomUUID(),
    },
  };
}
describe('MED administrative persistence', () => {
  it('resolves E2E, is idempotent by payment/case, scopes tenants and releases availability', async () => {
    const { l, platformId, input } = await adminFixture();
    await expect(registrarContestacao(rig.db, randomUUID(), 'admin', input)).rejects.toThrow(
      /não encontrado/,
    );
    const result = await registrarContestacao(rig.db, platformId, 'admin', input);
    expect(
      await registrarContestacao(rig.db, platformId, 'admin', {
        ...input,
        pagamentoOuE2e: l.idPagamento,
      }),
    ).toEqual(result);
    await expect(
      registrarContestacao(rig.db, platformId, 'admin', { ...input, valorCents: 100 }),
    ).rejects.toThrow(/já possui/);
    expect(await listarContestacoes(rig.db, randomUUID(), { idPagamento: l.idPagamento })).toEqual(
      [],
    );
    expect(
      (
        await listarContestacoes(rig.db, platformId, {
          idCampanha: l.idCampanha as NonNullable<LancamentoFinanceiro['idCampanha']>,
        })
      )[0],
    ).toMatchObject({ estado: 'bloqueada', exposicao: false });
    expect(
      await repo.findLancamentosDisponiveisByIdCampanha(
        l.idCampanha as NonNullable<LancamentoFinanceiro['idCampanha']>,
        now,
      ),
    ).toEqual([]);
    await resolverContestacao(rig.db, platformId, 'admin2', {
      id: result.id,
      estado: 'liberada',
      resolvidaEm: now,
      notas: 'Banco liberou',
    });
    expect((await request(l)).repasse.amountCents).toBe(2000);
    await expect(
      resolverContestacao(rig.db, platformId, 'admin2', {
        id: result.id,
        estado: 'devolvida',
        resolvidaEm: now,
        notas: '',
      }),
    ).rejects.toThrow(/já resolvida/);
  });
  it('records already-sent exposure without modifying the ledger or payment status', async () => {
    const { l, platformId, input } = await adminFixture();
    const { repasse } = await request(l);
    await repo.aprovarRepasseTransaction({
      idRepasse: repasse.id,
      aprovadoEm: now,
      bankTransferRef: 'manual-test',
    });
    await registrarContestacao(rig.db, platformId, 'admin', input);
    expect(
      (await listarContestacoes(rig.db, platformId, { idPagamento: l.idPagamento }))[0]?.exposicao,
    ).toBe(true);
    expect((await repo.findLancamentosByIdPagamento(l.idPagamento))[0]?.transferidoEm).toEqual(now);
    const payment = await sql<{
      status: string;
    }>`SELECT status FROM pagamentos WHERE id = ${l.idPagamento}`.execute(rig.db);
    expect(payment.rows[0]?.status).toBe('aprovado');
  });
  it('rejects invalid amount and non-PIX registration', async () => {
    const { l, platformId, input } = await adminFixture();
    for (const valorCents of [0, -1, 2181, 1.5])
      await expect(
        registrarContestacao(rig.db, platformId, 'admin', { ...input, valorCents }),
      ).rejects.toThrow(/Valor/);
    await sql`UPDATE pagamentos SET intencao_metodo = 'credit_card' WHERE id = ${l.idPagamento}`.execute(
      rig.db,
    );
    await expect(registrarContestacao(rig.db, platformId, 'admin', input)).rejects.toThrow(
      /não encontrado/,
    );
  });
  it('serializes competing MED registrations into one record', async () => {
    const { platformId, input } = await adminFixture();
    const results = await Promise.all([
      registrarContestacao(rig.db, platformId, 'admin', input),
      registrarContestacao(rig.db, platformId, 'admin', input),
    ]);
    expect(results[0]).toEqual(results[1]);
  });
});

it('does not block reconciliation of a transfer already claimed before MED', async () => {
  const { l, platformId, input } = await adminFixture();
  const { repasse } = await request(l);
  await repo.aprovarRepassePixTransaction(
    { idRepasse: repasse.id, aprovadoEm: now, transferReferencia: 'test' },
    async () => {},
  );
  const started = await repo.iniciarTransferenciaTransaction({
    idRepasse: repasse.id,
    agora: now,
    requestSummary: 'test',
  });
  await registrarContestacao(rig.db, platformId, 'admin', input);
  expect(
    (
      await repo.iniciarTransferenciaTransaction({
        idRepasse: repasse.id,
        agora: now,
        requestSummary: 'redelivery',
      })
    ).acao,
  ).toBe('reconciliar');
  await repo.finalizarTentativaTransferencia({
    idRepasse: repasse.id,
    attemptId: started.attemptId,
    resultado: { tipo: 'enviado_ao_banco', codigoSolicitacao: 'bank-test' },
    agora: now,
  });
  expect(
    (await listarContestacoes(rig.db, platformId, { idPagamento: l.idPagamento }))[0]?.exposicao,
  ).toBe(true);
  expect((await repo.findRepasseById(repasse.id))?.status).toBe('enviado_ao_banco');
});

it.each([
  'solicitado',
  'aprovado',
])('cancels a MED lot in %s and permits a fresh sweep without held credits', async (status) => {
  const l = await fixture();
  const { repasse } = await request(l);
  if (status === 'aprovado')
    await repo.aprovarRepassePixTransaction(
      { idRepasse: repasse.id, aprovadoEm: now, transferReferencia: 'test' },
      async () => {},
    );
  await contest(l);
  const result = await repo.cancelarRepasseTransaction({
    idRepasse: repasse.id,
    canceladoPor: 'admin',
    agora: now,
  });
  expect(result.repasse.status).toBe('cancelado');
  expect(result.lancamentosLiberados).toBe(1);
  expect(
    await repo.findLancamentosDisponiveisByIdCampanha(
      l.idCampanha as NonNullable<LancamentoFinanceiro['idCampanha']>,
      now,
    ),
  ).toEqual([]);
  await expect(
    repo.iniciarTransferenciaTransaction({
      idRepasse: repasse.id,
      agora: now,
      requestSummary: 'stale-job',
    }),
  ).resolves.toMatchObject({ acao: 'concluido' });
});
