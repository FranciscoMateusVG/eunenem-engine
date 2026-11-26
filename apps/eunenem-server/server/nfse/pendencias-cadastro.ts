import { SpanStatusCode, trace } from '@opentelemetry/api';
import { sql } from 'kysely';
import type { Database } from '../../../../src/adapters/database.js';
import { cpfValido } from '../../../../src/domain/arrecadacao/value-objects/dados-recebedor.js';
import { competenciaDoMes } from './dps.js';

/**
 * Cadastros incompletos de uma competência (aperture-xdylg): listas com taxa
 * da plataforma no mês cujo recebedor mais recente não tem os dados que a
 * NFS-e exige do tomador (CPF válido, nome, endereço fiscal). Para a equipe
 * cobrar o cadastro.
 *
 * NUNCA devolve o CPF — só o motivo. Responsáveis = administradores da lista
 * (nome e e-mail da conta), para contato.
 */

const tracer = trace.getTracer('eunenem-server');

export type MotivoCadastroIncompleto = 'sem_recebedor' | 'cpf_invalido' | 'nome_ausente' | 'sem_endereco';

export interface CadastroIncompleto {
  readonly campanhaId: string;
  readonly campanhaTitulo: string;
  readonly responsaveis: readonly { readonly nome: string; readonly email: string }[];
  readonly taxaCents: number;
  readonly motivos: readonly MotivoCadastroIncompleto[];
}

export async function listarCadastrosIncompletos(
  db: Database,
  input: { readonly platformId: string; readonly mes: string },
): Promise<CadastroIncompleto[]> {
  return tracer.startActiveSpan('nfse.cadastrosIncompletos', async (span) => {
    try {
      span.setAttribute('nfse.mes', input.mes);
      const { de, ate } = competenciaDoMes(input.mes);
      const inicio = sql`(${de}::date::timestamp AT TIME ZONE 'America/Sao_Paulo')`;
      const fim = sql`(${ate}::date::timestamp AT TIME ZONE 'America/Sao_Paulo')`;
      const rows = await sql<{
        campanha_id: string;
        titulo: string;
        taxa: string;
        tem_recebedor: boolean;
        cpf: string | null;
        nome: string | null;
        tem_endereco: boolean;
        responsaveis: { nome: string; email: string }[] | null;
      }>`
        WITH valores AS (
          SELECT c.id AS campanha_id,
            SUM(CASE WHEN l.criado_em >= ${inicio} AND l.criado_em < ${fim} THEN l.amount_cents ELSE 0 END
              - CASE WHEN l.cancelado_em >= ${inicio} AND l.cancelado_em < ${fim} THEN l.amount_cents ELSE 0 END)::bigint AS taxa
          FROM lancamentos_financeiros l
          JOIN pagamentos p ON p.id = l.id_pagamento
          JOIN campanhas c ON c.id = p.intencao_id_campanha
          WHERE c.id_plataforma = ${input.platformId}::uuid AND l.tipo = 'credito_receita_plataforma'
            AND ((l.criado_em >= ${inicio} AND l.criado_em < ${fim}) OR (l.cancelado_em >= ${inicio} AND l.cancelado_em < ${fim}))
          GROUP BY c.id
        )
        SELECT v.campanha_id, c.titulo, v.taxa,
          r.id IS NOT NULL AS tem_recebedor, r.cpf_titular AS cpf, r.nome_titular AS nome,
          r.endereco_cep IS NOT NULL AS tem_endereco,
          (SELECT json_agg(json_build_object('nome', u.nome_exibicao, 'email', u.email) ORDER BY u.email)
             FROM campanha_administradores a JOIN usuarios u ON u.id_conta = a.id_usuario
            WHERE a.campanha_id = v.campanha_id) AS responsaveis
        FROM valores v
        JOIN campanhas c ON c.id = v.campanha_id
        LEFT JOIN LATERAL (
          SELECT id, cpf_titular, nome_titular, endereco_cep FROM recebedores
          WHERE campanha_id = v.campanha_id ORDER BY criada_em DESC, id DESC LIMIT 1
        ) r ON true
        WHERE v.taxa > 0
        ORDER BY v.taxa DESC, v.campanha_id
      `.execute(db);

      const lista: CadastroIncompleto[] = [];
      for (const r of rows.rows) {
        const motivos: MotivoCadastroIncompleto[] = [];
        if (!r.tem_recebedor) motivos.push('sem_recebedor');
        else {
          if (!cpfValido(r.cpf ?? '')) motivos.push('cpf_invalido');
          if (!(r.nome ?? '').trim()) motivos.push('nome_ausente');
          if (!r.tem_endereco) motivos.push('sem_endereco');
        }
        if (motivos.length === 0) continue;
        lista.push({
          campanhaId: r.campanha_id,
          campanhaTitulo: r.titulo,
          responsaveis: r.responsaveis ?? [],
          taxaCents: Number(r.taxa),
          motivos,
        });
      }
      span.setAttribute('nfse.cadastros_incompletos', lista.length);
      return lista;
    } catch (error: unknown) {
      if (error instanceof Error) span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}
