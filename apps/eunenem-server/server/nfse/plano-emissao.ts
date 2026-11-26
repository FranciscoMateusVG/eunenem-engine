import { createHash } from 'node:crypto';
import type { NfseConfig } from './config.js';
import type { TipoAmbiente } from './dps.js';
import type { AvisoPrevia, CampoDps, PreviaMensal } from './previa-mensal.js';

/**
 * Plano de emissão de uma competência (aperture-wp6j6). Módulo puro: recebe a
 * prévia já calculada e o que já foi gravado, e decide QUAIS notas este clique
 * envia e O QUE impede a emissão. É o mesmo plano que a tela de confirmação
 * mostra e que o servidor recalcula no clique.
 *
 * Decisões do contador (26/11/2026), isoladas aqui:
 *   - AGRUPAMENTO: uma nota por mês por tomador (dono da lista) →
 *     `agruparPorTomador`.
 *   - PENDÊNCIAS: emite tudo que for possível e PULA as campanhas sem CPF/nome
 *     válido (`pularPendencias`); elas aparecem na confirmação e podem ser
 *     emitidas depois na mesma competência, quando os dados estiverem
 *     completos. `bloquearCompetenciaComPendencias` segue disponível.
 *   - PISO (só em produção): nenhuma competência antes de 2026-11 (outubro/2026
 *     nunca). Homologação aceita qualquer mês fechado.
 *
 * NOTAS GRAVADAS: cada clique grava as notas que vai enviar (CPF, valor,
 * campanhas) antes de enviar. Um clique posterior NÃO reparte de novo o que
 * já foi gravado: confere o recálculo contra o gravado e só ACRESCENTA notas
 * de CPFs novos cujas campanhas ainda não estão em nenhuma nota gravada (as
 * pendências resolvidas). Qualquer outra diferença — mesmo CPF com valor ou
 * campanhas diferentes, campanha gravada que agora aparece sob outro CPF
 * (recebedor trocado), nota gravada que sumiu — bloqueia com
 * `competencia_divergente`. Sem isso a mesma receita sairia em duas notas.
 *
 * IMPRESSÃO: sha256 do plano canônico (ambiente, série, prestador, notas a
 * enviar com campanhas, notas já gravadas, campos fiscais). O admin confirma a
 * impressão que viu; o servidor recusa se a recalculada for outra.
 */

/** Primeira competência emitível. Outubro/2026 e anteriores: nunca. */
export const COMPETENCIA_MINIMA_ABSOLUTA = '2026-11';

export interface NotaPlanejada {
  readonly tomadorCpf: string;
  readonly tomadorNome: string;
  readonly valorCents: number;
  /** Campanhas cuja receita compõe a nota (ordenadas). */
  readonly campanhas: readonly string[];
}

/** Nota já gravada para a competência por um clique anterior. */
export interface NotaFixada extends NotaPlanejada {
  readonly id: string;
  /** Série reservada na fixação (pode diferir da configurada hoje). */
  readonly serie: string;
  readonly status: 'pendente' | 'enviando' | 'incerta' | 'rejeitada' | 'autorizada' | 'cancelada';
}

export type BloqueioEmissao =
  | 'mes_em_andamento'
  | 'config_com_problemas'
  | 'config_incompleta'
  | 'sem_certificado'
  | 'certificado_ilegivel'
  | 'certificado_de_outro_cnpj'
  | 'certificado_vencido'
  | 'tot_trib_pendente'
  | 'pendencias_de_tomador'
  | 'competencia_anterior_ao_inicio'
  | 'producao_nao_liberada'
  | 'competencia_divergente'
  | 'serie_divergente'
  | 'sem_notas';

export type EstrategiaAgrupamento = (previa: PreviaMensal) => readonly NotaPlanejada[];
export type PoliticaPendencias = (previa: PreviaMensal) => readonly BloqueioEmissao[];

/** Uma nota por CPF de tomador com DPS gerada (valor positivo). */
export const agruparPorTomador: EstrategiaAgrupamento = (previa) =>
  previa.notas
    .filter((n) => n.dps.status === 'gerada')
    .map((n) => ({ tomadorCpf: n.cpf, tomadorNome: n.nome, valorCents: n.resultadoCents, campanhas: [...n.campanhas].sort() }));

export interface NotaPulada {
  /** Campanha(s) ou CPF da pendência. */
  readonly referencia: string;
  readonly motivo: string;
  readonly valorCents: number;
}

/** Pendências de tomador do mês (campanhas sem CPF/nome válido etc.). */
export function pendenciasDaPrevia(previa: PreviaMensal): NotaPulada[] {
  return [
    ...previa.pendencias.map((p) => ({ referencia: p.campanhaId, motivo: p.motivo, valorCents: p.resultadoCents })),
    ...previa.notas
      .filter((n) => n.dps.status === 'config_incompleta' && n.dps.faltando.includes('tomador_cpf_nome'))
      .map((n) => ({ referencia: n.campanhas.join(','), motivo: 'tomador_cpf_nome', valorCents: n.resultadoCents })),
  ];
}

/** Padrão (contador, 26/11/2026): pendências são puladas, não bloqueiam. */
export const pularPendencias: PoliticaPendencias = () => [];

/** Alternativa: qualquer pendência bloqueia o mês inteiro. */
export const bloquearCompetenciaComPendencias: PoliticaPendencias = (previa) =>
  previa.pendencias.length > 0 || previa.notas.some((n) => n.dps.status === 'config_incompleta')
    ? ['pendencias_de_tomador']
    : [];

export interface PlanoEmissao {
  readonly mes: string;
  readonly rotulo: string;
  readonly ambiente: TipoAmbiente;
  readonly serie: string;
  /** Notas que ESTE clique enviaria (na 1ª emissão: todas; depois: as pendentes). */
  readonly notas: readonly NotaPlanejada[];
  /** Pendências que ficam de fora deste clique (podem ser emitidas depois). */
  readonly puladas: readonly NotaPulada[];
  /** A competência já tem notas gravadas por um clique anterior. */
  readonly fixada: boolean;
  /** Ids das notas já gravadas que este plano considerou (controle de corrida). */
  readonly idsFixados: readonly string[];
  /** Diferenças entre o recálculo e o fixado (texto para o admin). */
  readonly divergencias: readonly string[];
  /** sha256 hex do plano canônico; é o que o admin confirma. */
  readonly impressao: string;
  readonly quantidade: number;
  readonly totalCents: number;
  readonly bloqueios: readonly BloqueioEmissao[];
  /** Avisos da prévia que não bloqueiam, mas o admin vê antes de confirmar. */
  readonly avisos: readonly AvisoPrevia[];
  /** Campos fiscais iguais em todas as notas (para a confirmação). */
  readonly camposFiscais: readonly CampoDps[];
}

/** Avisos da prévia que impedem emitir; o resto só é mostrado. */
const AVISO_BLOQUEIA: Partial<Record<AvisoPrevia, BloqueioEmissao>> = {
  mes_em_andamento: 'mes_em_andamento',
  config_com_problemas: 'config_com_problemas',
  certificado_de_outro_cnpj: 'certificado_de_outro_cnpj',
  certificado_vencido: 'certificado_vencido',
  tot_trib_pendente: 'tot_trib_pendente',
};

/** Identificação de prévia e tomador variam por nota/emissão; não são "fiscais". */
const TAGS_NAO_FISCAIS = new Set(['dhEmi', 'serie', 'nDPS', 'toma', 'CPF', 'xNome', 'vServ', 'verAplic']);

export function montarPlanoEmissao(input: {
  readonly previa: PreviaMensal;
  readonly config: NfseConfig;
  /** Notas já gravadas para (ambiente, competência). Vazio = 1ª emissão. */
  readonly fixadas?: readonly NotaFixada[];
  readonly agrupar?: EstrategiaAgrupamento;
  readonly pendencias?: PoliticaPendencias;
}): PlanoEmissao {
  const { previa, config } = input;
  const fixadas = input.fixadas ?? [];
  const agrupar = input.agrupar ?? agruparPorTomador;
  const politica = input.pendencias ?? pularPendencias;
  const minima = config.competenciaMinima > COMPETENCIA_MINIMA_ABSOLUTA ? config.competenciaMinima : COMPETENCIA_MINIMA_ABSOLUTA;

  const bloqueios = new Set<BloqueioEmissao>();
  const avisos: AvisoPrevia[] = [];
  for (const aviso of previa.avisos) {
    const b = AVISO_BLOQUEIA[aviso];
    if (b) bloqueios.add(b);
    else avisos.push(aviso);
  }
  for (const b of politica(previa)) bloqueios.add(b);
  // O piso vale só em PRODUÇÃO (tpAmb=1). Homologação não tem valor fiscal e
  // precisa aceitar qualquer mês fechado para o smoke test (glados, 26/11).
  if (config.ambiente.valor === '1' && previa.mes < minima) bloqueios.add('competencia_anterior_ao_inicio');

  if (config.prestadorCnpj === null || config.municipioIbge === null) bloqueios.add('config_incompleta');
  // Falta de configuração fiscal (não de tomador) numa nota é problema global.
  if (previa.notas.some((n) => n.dps.status === 'config_incompleta' && n.dps.faltando.some((f) => f !== 'tomador_cpf_nome'))) {
    bloqueios.add('config_incompleta');
  }
  if (config.certificado === null) bloqueios.add('sem_certificado');
  for (const n of previa.notas) {
    if (n.dps.status === 'gerada' && n.dps.assinatura.status === 'nao_assinada' && n.dps.assinatura.motivo === 'certificado_ilegivel') {
      bloqueios.add('certificado_ilegivel');
    }
  }
  if (config.ambiente.valor === '1' && !config.emissaoProducaoLiberada) bloqueios.add('producao_nao_liberada');

  const recalculadas = agrupar(previa);
  const fixada = fixadas.length > 0;
  const { divergencias, novas } = compararComFixadas(recalculadas, fixadas);
  if (divergencias.length > 0) bloqueios.add('competencia_divergente');
  const notas: readonly NotaPlanejada[] = [
    ...fixadas
      .filter((f) => f.status !== 'autorizada' && f.status !== 'cancelada')
      .map(({ status: _status, serie: _serie, id: _id, ...nota }) => nota),
    ...novas,
  ];
  if (!fixada && notas.length === 0) bloqueios.add('sem_notas');
  // Num retry a série enviada é a RESERVADA; se NFSE_SERIE mudou desde a
  // gravação, a confirmação mostraria uma série e o envio usaria outra.
  if (fixadas.some((f) => f.serie !== config.serie.valor)) bloqueios.add('serie_divergente');

  const primeira = previa.notas.find((n) => n.dps.status === 'gerada')?.dps;
  const camposFiscais =
    primeira?.status === 'gerada' ? primeira.campos.filter((c) => !TAGS_NAO_FISCAIS.has(c.tag)) : [];

  const base = {
    mes: previa.mes,
    rotulo: previa.rotulo,
    ambiente: config.ambiente.valor,
    serie: config.serie.valor,
    notas,
    fixada,
    idsFixados: fixadas.map((f) => f.id).sort(),
    quantidade: notas.length,
    totalCents: notas.reduce((s, n) => s + n.valorCents, 0),
  };
  return {
    ...base,
    puladas: pendenciasDaPrevia(previa),
    divergencias,
    impressao: impressaoDoPlano({ ...base, prestadorCnpj: config.prestadorCnpj, camposFiscais }),
    bloqueios: [...bloqueios],
    avisos: avisos.filter((a) => a !== 'xml_nao_assinado'),
    camposFiscais,
  };
}

const chaveNota = (n: NotaPlanejada) => `${n.tomadorCpf}|${n.valorCents}|${n.campanhas.join(',')}`;

/**
 * Recálculo × gravado. CPF já gravado: tem de bater exatamente. CPF novo:
 * só entra se nenhuma das suas campanhas já estiver numa nota gravada.
 */
function compararComFixadas(
  recalculadas: readonly NotaPlanejada[],
  fixadas: readonly NotaFixada[],
): { divergencias: string[]; novas: NotaPlanejada[] } {
  const fmt = (n: NotaPlanejada) => `CPF ${n.tomadorCpf}, ${n.valorCents} centavos, campanhas ${n.campanhas.join(', ')}`;
  const porCpf = new Map(fixadas.map((f) => [f.tomadorCpf, f]));
  const campanhasGravadas = new Set(fixadas.flatMap((f) => f.campanhas));
  const recalculadasPorCpf = new Set(recalculadas.map((r) => r.tomadorCpf));
  const divergencias: string[] = [];
  const novas: NotaPlanejada[] = [];
  for (const r of recalculadas) {
    const f = porCpf.get(r.tomadorCpf);
    if (f) {
      if (chaveNota(f) !== chaveNota(r)) divergencias.push(`Gravada (${f.status}): ${fmt(f)} — agora: ${fmt(r)}`);
    } else if (r.campanhas.some((c) => campanhasGravadas.has(c))) {
      divergencias.push(`Campanha já emitida em outra nota aparece agora sob outro CPF: ${fmt(r)}`);
    } else {
      novas.push(r);
    }
  }
  for (const f of fixadas) {
    if (!recalculadasPorCpf.has(f.tomadorCpf)) divergencias.push(`Gravada (${f.status}) e ausente agora: ${fmt(f)}`);
  }
  return { divergencias, novas };
}

function impressaoDoPlano(plano: {
  readonly mes: string;
  readonly ambiente: string;
  readonly serie: string;
  readonly prestadorCnpj: string | null;
  readonly fixada: boolean;
  readonly idsFixados: readonly string[];
  readonly notas: readonly NotaPlanejada[];
  readonly camposFiscais: readonly CampoDps[];
}): string {
  const canonico = JSON.stringify([
    plano.mes,
    plano.ambiente,
    plano.serie,
    plano.prestadorCnpj,
    plano.fixada,
    plano.idsFixados,
    plano.notas.map((n) => [n.tomadorCpf, n.tomadorNome, n.valorCents, [...n.campanhas]]).sort(),
    plano.camposFiscais.map((c) => [c.tag, c.valor]).sort(),
  ]);
  return createHash('sha256').update(canonico).digest('hex');
}
