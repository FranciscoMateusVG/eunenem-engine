import { sql } from 'kysely';
import type { Database } from '../../../../src/adapters/database.js';
import { cpfValido } from '../../../../src/domain/arrecadacao/value-objects/dados-recebedor.js';

export interface TomadorMes { cpf: string; nome: string; resultadoCents: number; campanhas: string[] }
export interface PendenciaTomador { campanhaId: string; motivo: string; resultadoCents: number }

/** Titular ATUAL, não um snapshot histórico. Nunca infere CPF do pagador. */
export async function carregarTomadoresMes(db: Database, platformId: string, de: string, ate: string) {
  const rows = await sql<{ campanha_id: string; resultado: string; ativos: string; historicos: string; novos: string; cpf: string | null; nome: string | null }>`
    WITH valores AS (
      SELECT c.id AS campanha_id,
        SUM(CASE WHEN l.criado_em >= (${de}::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
          AND l.criado_em < (${ate}::date::timestamp AT TIME ZONE 'America/Sao_Paulo') THEN l.amount_cents ELSE 0 END
          - CASE WHEN l.cancelado_em >= (${de}::date::timestamp AT TIME ZONE 'America/Sao_Paulo')
          AND l.cancelado_em < (${ate}::date::timestamp AT TIME ZONE 'America/Sao_Paulo') THEN l.amount_cents ELSE 0 END)::bigint AS resultado
      FROM lancamentos_financeiros l JOIN pagamentos p ON p.id=l.id_pagamento
      JOIN campanhas c ON c.id=p.intencao_id_campanha
      WHERE c.id_plataforma=${platformId}::uuid AND l.tipo='credito_receita_plataforma'
        AND ((l.criado_em >= (${de}::date::timestamp AT TIME ZONE 'America/Sao_Paulo') AND l.criado_em < (${ate}::date::timestamp AT TIME ZONE 'America/Sao_Paulo'))
          OR (l.cancelado_em >= (${de}::date::timestamp AT TIME ZONE 'America/Sao_Paulo') AND l.cancelado_em < (${ate}::date::timestamp AT TIME ZONE 'America/Sao_Paulo')))
      GROUP BY c.id
    )
    SELECT v.campanha_id, v.resultado,
      count(r.id) FILTER(WHERE r.is_active)::text AS ativos, count(r.id)::text AS historicos,
      count(r.id) FILTER(WHERE r.criada_em >= (${de}::date::timestamp AT TIME ZONE 'America/Sao_Paulo') AND r.criada_em < (${ate}::date::timestamp AT TIME ZONE 'America/Sao_Paulo'))::text AS novos,
      max(r.cpf_titular) FILTER(WHERE r.is_active) AS cpf,
      max(r.nome_titular) FILTER(WHERE r.is_active) AS nome
    FROM valores v LEFT JOIN recebedores r ON r.campanha_id=v.campanha_id
    GROUP BY v.campanha_id,v.resultado ORDER BY v.campanha_id
  `.execute(db);
  const grupos = new Map<string, TomadorMes>();
  const pendencias: PendenciaTomador[] = [];
  const conflitos = new Set<string>();
  for (const r of rows.rows) {
    const resultadoCents = Number(r.resultado);
    if (!Number.isSafeInteger(resultadoCents)) throw new Error('nfse_valor_invalido');
    const cpf = (r.cpf ?? '').replace(/\D/g, '');
    const nome = (r.nome ?? '').trim();
    const motivo = Number(r.ativos) !== 1 ? 'recebedor_ausente_ou_ambiguo'
      : Number(r.historicos) > 1 && Number(r.novos) > 0 ? 'possivel_troca_no_mes'
      : !cpfValido(cpf) ? 'cpf_ausente_ou_invalido'
      : !nome ? 'nome_ausente' : null;
    if (motivo) { pendencias.push({ campanhaId:r.campanha_id, motivo, resultadoCents }); continue; }
    const anterior = grupos.get(cpf);
    if (anterior && anterior.nome.toLocaleUpperCase('pt-BR') !== nome.toLocaleUpperCase('pt-BR')) conflitos.add(cpf);
    grupos.set(cpf, { cpf, nome: anterior?.nome ?? nome, resultadoCents:(anterior?.resultadoCents ?? 0)+resultadoCents, campanhas:[...(anterior?.campanhas ?? []),r.campanha_id] });
  }
  for (const cpf of conflitos) {
    const g=grupos.get(cpf)!;
    pendencias.push({ campanhaId:g.campanhas.join(','), motivo:'nomes_divergentes_no_cpf', resultadoCents:g.resultadoCents });
    grupos.delete(cpf);
  }
  return { tomadores:[...grupos.values()].sort((a,b)=>a.cpf.localeCompare(b.cpf)), pendencias };
}
