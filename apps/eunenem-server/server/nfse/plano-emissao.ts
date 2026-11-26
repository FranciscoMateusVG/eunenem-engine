import { createHash } from 'node:crypto';
import type { NfseConfig } from './config.js';
import type { TipoAmbiente } from './dps.js';
import type { AvisoPrevia, CampoDps, PreviaMensal } from './previa-mensal.js';

/**
 * Plano de emissão de uma competência (aperture-wp6j6). Módulo puro: recebe a
 * prévia já calculada e decide QUAIS notas emitir e O QUE impede a emissão.
 * É o mesmo plano que a tela de confirmação mostra e que o servidor recalcula
 * no clique — o admin confirma quantidade e total, e se mudou, nada é enviado.
 *
 * Duas decisões fiscais ainda abertas com o contador ficam isoladas aqui:
 *   - ESTRATÉGIA DE AGRUPAMENTO: uma nota por tomador (atual) ou uma nota
 *     consolidada do mês → `agruparPorTomador`.
 *   - POLÍTICA DE PENDÊNCIAS: campanhas sem CPF/nome válido bloqueiam a
 *     competência inteira (atual) → `bloquearCompetenciaComPendencias`.
 * Trocar qualquer uma é trocar a função passada em `montarPlanoEmissao`.
 *
 * COMPETÊNCIA FIXADA: a primeira emissão grava todas as notas do mês antes do
 * primeiro envio. Daí em diante o plano NÃO reparte a receita de novo: ele
 * confere o recálculo contra o que foi fixado e, se houver qualquer diferença
 * (CPF, valor ou campanhas — ex.: recebedor trocado depois da emissão),
 * bloqueia com `competencia_divergente`. Sem isso, a mesma receita sairia
 * numa segunda nota para o novo CPF. As notas a enviar num retry são as
 * fixadas que ainda não foram autorizadas/canceladas, com os valores fixados.
 *
 * IMPRESSÃO: sha256 do plano canônico (ambiente, série, prestador, notas com
 * campanhas, campos fiscais). O admin confirma a impressão que viu; o servidor
 * recusa se a recalculada for outra.
 */

export interface NotaPlanejada {
  readonly tomadorCpf: string;
  readonly tomadorNome: string;
  readonly valorCents: number;
  /** Campanhas cuja receita compõe a nota (ordenadas). */
  readonly campanhas: readonly string[];
}

/** Nota já gravada para a competência (o que foi fixado na 1ª emissão). */
export interface NotaFixada extends NotaPlanejada {
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
  | 'producao_nao_liberada'
  | 'competencia_divergente'
  | 'sem_notas';

export type EstrategiaAgrupamento = (previa: PreviaMensal) => readonly NotaPlanejada[];
export type PoliticaPendencias = (previa: PreviaMensal) => readonly BloqueioEmissao[];

/** Uma nota por CPF de tomador com DPS gerada (valor positivo). */
export const agruparPorTomador: EstrategiaAgrupamento = (previa) =>
  previa.notas
    .filter((n) => n.dps.status === 'gerada')
    .map((n) => ({ tomadorCpf: n.cpf, tomadorNome: n.nome, valorCents: n.resultadoCents, campanhas: [...n.campanhas].sort() }));

/** Qualquer pendência de tomador bloqueia o mês inteiro: nada sai pela metade. */
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
  /** A competência já foi fixada por uma emissão anterior. */
  readonly fixada: boolean;
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
  const politica = input.pendencias ?? bloquearCompetenciaComPendencias;

  const bloqueios = new Set<BloqueioEmissao>();
  const avisos: AvisoPrevia[] = [];
  for (const aviso of previa.avisos) {
    const b = AVISO_BLOQUEIA[aviso];
    if (b) bloqueios.add(b);
    else avisos.push(aviso);
  }
  for (const b of politica(previa)) bloqueios.add(b);

  if (config.prestadorCnpj === null || config.municipioIbge === null) bloqueios.add('config_incompleta');
  if (config.certificado === null) bloqueios.add('sem_certificado');
  for (const n of previa.notas) {
    if (n.dps.status === 'gerada' && n.dps.assinatura.status === 'nao_assinada' && n.dps.assinatura.motivo === 'certificado_ilegivel') {
      bloqueios.add('certificado_ilegivel');
    }
  }
  if (config.ambiente.valor === '1' && !config.emissaoProducaoLiberada) bloqueios.add('producao_nao_liberada');

  const recalculadas = agrupar(previa);
  const fixada = fixadas.length > 0;
  const divergencias = fixada ? compararComFixadas(recalculadas, fixadas) : [];
  if (divergencias.length > 0) bloqueios.add('competencia_divergente');
  const notas: readonly NotaPlanejada[] = fixada
    ? fixadas
        .filter((f) => f.status !== 'autorizada' && f.status !== 'cancelada')
        .map(({ status: _status, ...nota }) => nota)
    : recalculadas;
  if (!fixada && notas.length === 0) bloqueios.add('sem_notas');

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
    quantidade: notas.length,
    totalCents: notas.reduce((s, n) => s + n.valorCents, 0),
  };
  return {
    ...base,
    divergencias,
    impressao: impressaoDoPlano({ ...base, prestadorCnpj: config.prestadorCnpj, camposFiscais }),
    bloqueios: [...bloqueios],
    avisos: avisos.filter((a) => a !== 'xml_nao_assinado'),
    camposFiscais,
  };
}

const chaveNota = (n: NotaPlanejada) => `${n.tomadorCpf}|${n.valorCents}|${n.campanhas.join(',')}`;

/** Diferenças entre o recálculo de agora e as notas fixadas (canceladas incluídas). */
function compararComFixadas(recalculadas: readonly NotaPlanejada[], fixadas: readonly NotaFixada[]): string[] {
  const agora = new Set(recalculadas.map(chaveNota));
  const antes = new Set(fixadas.map(chaveNota));
  const fmt = (n: NotaPlanejada) => `CPF ${n.tomadorCpf}, ${n.valorCents} centavos, campanhas ${n.campanhas.join(', ')}`;
  return [
    ...fixadas.filter((f) => !agora.has(chaveNota(f))).map((f) => `Fixada (${f.status}) e diferente agora: ${fmt(f)}`),
    ...recalculadas.filter((r) => !antes.has(chaveNota(r))).map((r) => `Recalculada e não fixada: ${fmt(r)}`),
  ];
}

function impressaoDoPlano(plano: {
  readonly mes: string;
  readonly ambiente: string;
  readonly serie: string;
  readonly prestadorCnpj: string | null;
  readonly fixada: boolean;
  readonly notas: readonly NotaPlanejada[];
  readonly camposFiscais: readonly CampoDps[];
}): string {
  const canonico = JSON.stringify([
    plano.mes,
    plano.ambiente,
    plano.serie,
    plano.prestadorCnpj,
    plano.fixada,
    plano.notas.map((n) => [n.tomadorCpf, n.tomadorNome, n.valorCents, [...n.campanhas]]).sort(),
    plano.camposFiscais.map((c) => [c.tag, c.valor]).sort(),
  ]);
  return createHash('sha256').update(canonico).digest('hex');
}
