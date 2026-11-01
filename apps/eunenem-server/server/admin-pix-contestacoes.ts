import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { Database } from '../../../src/adapters/database.js';
import { acquirePaymentMoneyMovementLocks } from '../../../src/adapters/pagamentos/payment-money-movement-lock.postgres.js';

export interface ContestacaoInput {
  pagamentoOuE2e: string;
  casoId?: string;
  valorCents: number;
  ocorridaEm: Date;
  notas: string;
}
export class ContestacaoInvalidaError extends Error {}

export async function registrarContestacao(db: Database, platformId: string, actor: string, input: ContestacaoInput) {
  return db.transaction().execute(async (tx) => {
    const payments = await sql<{id: string; total: number}>`
      SELECT p.id, p.intencao_total_paid_cents AS total FROM pagamentos p
      JOIN campanhas c ON c.id = p.intencao_id_campanha
      WHERE c.id_plataforma = ${platformId}::uuid
        AND (p.id::text = ${input.pagamentoOuE2e} OR p.intencao_e2e_external_ref = ${input.pagamentoOuE2e})
        AND p.intencao_metodo = 'pix' AND p.status = 'aprovado'
    `.execute(tx);
    if (payments.rows.length !== 1) throw new ContestacaoInvalidaError('Pagamento PIX aprovado não encontrado ou E2E ambíguo.');
    const payment = payments.rows[0];
    if (!payment) throw new ContestacaoInvalidaError('Pagamento não encontrado.');
    if (!Number.isSafeInteger(input.valorCents) || input.valorCents <= 0 || input.valorCents > Number(payment.total)) {
      throw new ContestacaoInvalidaError('Valor da contestação deve ser positivo e não exceder o pagamento.');
    }
    await acquirePaymentMoneyMovementLocks(tx, [payment.id]);
    const existing = await sql<{id: string; caso_id: string | null; valor_cents: number; ocorrida_em: Date}>`
      SELECT id, caso_id, valor_cents, ocorrida_em FROM pix_contestacoes WHERE id_pagamento = ${payment.id}::uuid
    `.execute(tx);
    if (existing.rows[0]) {
      const row = existing.rows[0];
      if (row.caso_id !== (input.casoId ?? null) || row.valor_cents !== input.valorCents || row.ocorrida_em.getTime() !== input.ocorridaEm.getTime()) {
        throw new ContestacaoInvalidaError('Pagamento já possui contestação; consulte o registro existente.');
      }
      return {id: row.id};
    }
    const id = randomUUID();
    await sql`INSERT INTO pix_contestacoes
      (id, id_pagamento, caso_id, valor_cents, ocorrida_em, notas, criado_por)
      VALUES (${id}::uuid, ${payment.id}::uuid, ${input.casoId ?? null}, ${input.valorCents}, ${input.ocorridaEm}, ${input.notas}, ${actor})`.execute(tx);
    return {id};
  });
}

export async function resolverContestacao(db: Database, platformId: string, actor: string, input: {
  id: string; estado: 'liberada' | 'devolvida'; resolvidaEm: Date; notas: string;
}) {
  return db.transaction().execute(async (tx) => {
    const rows = await sql<{id_pagamento: string; estado: string; ocorrida_em: Date}>`
      SELECT med.id_pagamento, med.estado, med.ocorrida_em FROM pix_contestacoes med
      JOIN pagamentos p ON p.id = med.id_pagamento JOIN campanhas c ON c.id = p.intencao_id_campanha
      WHERE med.id = ${input.id}::uuid AND c.id_plataforma = ${platformId}::uuid
    `.execute(tx);
    const row = rows.rows[0];
    if (!row) throw new ContestacaoInvalidaError('Contestação não encontrada.');
    await acquirePaymentMoneyMovementLocks(tx, [row.id_pagamento]);
    if (input.resolvidaEm < row.ocorrida_em) throw new ContestacaoInvalidaError('Resolução anterior à contestação.');
    const result = await sql`UPDATE pix_contestacoes SET estado = ${input.estado}, resolvida_em = ${input.resolvidaEm},
      notas = notas || E'\nResolução: ' || ${input.notas}, atualizado_em = now(), atualizado_por = ${actor}
      WHERE id = ${input.id}::uuid AND estado = 'bloqueada'`.execute(tx);
    if (result.numAffectedRows !== 1n) throw new ContestacaoInvalidaError('Contestação já resolvida.');
    return {id: input.id};
  });
}

export async function listarContestacoes(db: Database, platformId: string, filter: {idPagamento?: string; idCampanha?: string}) {
  const result = await sql<{
    id: string; idPagamento: string; idCampanha: string; casoId: string | null; valorCents: number;
    estado: 'bloqueada' | 'liberada' | 'devolvida'; ocorridaEm: Date; resolvidaEm: Date | null; notas: string; exposicao: boolean; repasseCancelavel: string | null;
  }>`SELECT med.id, med.id_pagamento AS "idPagamento", p.intencao_id_campanha AS "idCampanha",
    med.caso_id AS "casoId", med.valor_cents AS "valorCents", med.estado,
    med.ocorrida_em AS "ocorridaEm", med.resolvida_em AS "resolvidaEm", med.notas,
    (SELECT r.id FROM lancamentos_financeiros l JOIN repasses_recebedor r ON r.id = l.id_repasse
      WHERE l.id_pagamento = med.id_pagamento AND l.transferido_em IS NULL
        AND r.status IN ('solicitado', 'aprovado', 'falhou') LIMIT 1) AS "repasseCancelavel",
    EXISTS (SELECT 1 FROM lancamentos_financeiros l LEFT JOIN repasses_recebedor r ON r.id = l.id_repasse
      WHERE l.id_pagamento = med.id_pagamento AND (l.transferido_em IS NOT NULL OR r.status IN
      ('transferindo', 'verificando', 'enviado_ao_banco', 'pago', 'needs_manual_resolution'))) AS exposicao
    FROM pix_contestacoes med JOIN pagamentos p ON p.id = med.id_pagamento
    JOIN campanhas c ON c.id = p.intencao_id_campanha
    WHERE c.id_plataforma = ${platformId}::uuid
      AND (${filter.idPagamento ?? null}::uuid IS NULL OR p.id = ${filter.idPagamento ?? null}::uuid)
      AND (${filter.idCampanha ?? null}::uuid IS NULL OR c.id = ${filter.idCampanha ?? null}::uuid)
    ORDER BY med.criado_em DESC`.execute(db);
  return result.rows;
}
