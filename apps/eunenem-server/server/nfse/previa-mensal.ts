import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { Database } from '../../../../src/adapters/database.js';
import { localDateInSaoPaulo } from '../../pages/lib/receitaPeriodo.js';
import {
  loadReceitaDashboard,
  type MeioProvedorReceita,
  type ReceitaDashboard,
} from '../admin-receita.js';
import { assinarDps, carregarCertificado } from './assinatura.js';
import {
  type CampoConfig,
  descricaoDoServico,
  type NfseConfig,
  type NfseVariavel,
  type ProblemaConfig,
} from './config.js';
import {
  competenciaDoMes,
  dhEmiSaoPaulo,
  type DpsInput,
  formatarValorDps,
  montarDpsXml,
  numeroDpsPrevia,
  SERIE_DPS_PREVIA,
} from './dps.js';

/**
 * Prévia (dry run) da NFS-e mensal da EuNeném — aperture-dh1k7.
 *
 * SÓ LEITURA. Nada aqui envia, emite ou cancela no Sistema Nacional, e nada
 * escreve no banco. O valor do mês é o MESMO "Resultado de taxas" da tela
 * Receita: `loadReceitaDashboard` com o mês calendário de São Paulo como
 * período (taxas registradas por criado_em − cancelamentos por cancelado_em).
 * Nenhum SQL novo.
 *
 * Resultado ≤ 0 → sem DPS. Sem CNPJ/município → sem DPS (config incompleta).
 * Sem certificado → DPS gerada e NÃO assinada, sinalizada. Com certificado →
 * assinada; falha de leitura do PFX vira `certificado_ilegivel`, sem detalhe.
 */

const tracer = trace.getTracer('eunenem-server');

export const VER_APLIC_PREVIA = 'eunenem-previa-1';

export class MesFuturoError extends Error {
  constructor() {
    super('nfse_mes_futuro');
    this.name = 'MesFuturoError';
  }
}

export type SituacaoMes = 'fechado' | 'em_andamento';

/** Compara com o mês corrente de São Paulo. Mês futuro não tem prévia. */
export function situacaoDoMes(mes: string, now: Date): SituacaoMes {
  competenciaDoMes(mes);
  const atual = localDateInSaoPaulo(now).slice(0, 7);
  if (mes > atual) throw new MesFuturoError();
  return mes === atual ? 'em_andamento' : 'fechado';
}

// ────────────────────────────────────────────────────────────────────
//  Campos da DPS para a tabela da UI
// ────────────────────────────────────────────────────────────────────

export type OrigemCampo = 'ledger' | 'env' | 'default' | 'derivado' | 'fixo';

export interface CampoDps {
  readonly grupo: string;
  readonly tag: string;
  readonly rotulo: string;
  readonly valor: string;
  readonly origem: OrigemCampo;
  readonly aConfirmar: boolean;
  readonly nota: string | null;
}

const OMITIDO = '(omitido)';

function deConfig(
  grupo: string,
  tag: string,
  rotulo: string,
  campo: CampoConfig<string | null>,
  nota: string | null,
): CampoDps {
  return {
    grupo,
    tag,
    rotulo,
    valor: campo.valor ?? OMITIDO,
    origem: campo.origem,
    aConfirmar: campo.origem === 'default',
    nota: campo.origem === 'default' ? nota : null,
  };
}

const ROTULO_OP_SIMP_NAC: Record<string, string> = {
  '1': 'Não optante',
  '2': 'MEI',
  '3': 'ME/EPP',
};

function camposDaDps(dps: DpsInput, config: NfseConfig): CampoDps[] {
  const id = 'Identificação';
  const prest = 'Prestador';
  const serv = 'Serviço';
  const val = 'Valores e tributação';
  return [
    deConfig(id, 'tpAmb', 'Ambiente', config.ambiente, '1 = produção, 2 = homologação (produção restrita). Defina NFSE_AMBIENTE.'),
    {
      grupo: id,
      tag: 'dhEmi',
      rotulo: 'Data/hora de emissão',
      valor: dps.dhEmi,
      origem: 'derivado',
      aConfirmar: false,
      nota: 'Instante desta prévia. Na emissão real é o instante do envio.',
    },
    { grupo: id, tag: 'verAplic', rotulo: 'Versão do aplicativo', valor: dps.verAplic, origem: 'fixo', aConfirmar: false, nota: null },
    {
      grupo: id,
      tag: 'serie',
      rotulo: 'Série da DPS',
      valor: dps.serie,
      origem: 'fixo',
      aConfirmar: false,
      nota: 'Série de PRÉVIA. A emissão real usa a série própria (ex.: 00001).',
    },
    {
      grupo: id,
      tag: 'nDPS',
      rotulo: 'Número da DPS',
      valor: dps.nDPS,
      origem: 'fixo',
      aConfirmar: false,
      nota: 'Número de PRÉVIA. A emissão real usa a sequência da série, sem lacunas.',
    },
    {
      grupo: id,
      tag: 'dCompet',
      rotulo: 'Competência',
      valor: dps.dCompet,
      origem: 'derivado',
      aConfirmar: true,
      nota: 'Primeiro dia do mês. Confirmar com o contador se é este ou o último dia.',
    },
    { grupo: id, tag: 'tpEmit', rotulo: 'Emitente', valor: '1', origem: 'fixo', aConfirmar: false, nota: '1 = prestador.' },
    { grupo: id, tag: 'cLocEmi', rotulo: 'Município emissor (IBGE)', valor: dps.cLocEmi, origem: 'env', aConfirmar: false, nota: null },

    { grupo: prest, tag: 'CNPJ', rotulo: 'CNPJ do prestador', valor: dps.prestador.cnpj, origem: 'env', aConfirmar: false, nota: null },
    deConfig(prest, 'IM', 'Inscrição municipal', config.inscricaoMunicipal, 'Omitida. Defina NFSE_INSCRICAO_MUNICIPAL se o município exigir.'),
    {
      ...deConfig(prest, 'opSimpNac', 'Situação no Simples Nacional', config.opSimpNac, null),
      nota:
        `${ROTULO_OP_SIMP_NAC[config.opSimpNac.valor] ?? ''}.` +
        (config.opSimpNac.origem === 'default' ? ' Regime tributário da empresa. Defina NFSE_OP_SIMP_NAC.' : ''),
    },
    deConfig(prest, 'regApTribSN', 'Regime de apuração (Simples)', config.regApTribSN, 'Só para ME/EPP (opSimpNac = 3).'),
    deConfig(prest, 'regEspTrib', 'Regime especial de tributação', config.regEspTrib, '0 = nenhum. Defina NFSE_REG_ESP_TRIB.'),

    {
      grupo: 'Tomador',
      tag: 'toma',
      rotulo: 'Tomador',
      valor: '(omitido: consumidor não identificado)',
      origem: 'fixo',
      aConfirmar: true,
      nota: 'Grupo opcional no leiaute 1.01. Nota agregada do mês, sem tomador identificado.',
    },

    { grupo: serv, tag: 'cLocPrestacao', rotulo: 'Local da prestação (IBGE)', valor: dps.servico.cLocPrestacao, origem: 'env', aConfirmar: false, nota: null },
    deConfig(
      serv,
      'cTribNac',
      'Código de tributação nacional',
      config.cTribNac,
      'LC 116 item 10.05, desdobro 01: agenciamento, corretagem ou intermediação de bens móveis ou imóveis, por quaisquer meios. Defina NFSE_CTRIB_NAC.',
    ),
    {
      ...deConfig(serv, 'xDescServ', 'Descrição do serviço', config.descricaoServico, 'Texto padrão. Defina NFSE_DESCRICAO_SERVICO ({competencia} vira o mês).'),
      valor: dps.servico.xDescServ,
    },
    deConfig(serv, 'cNBS', 'Código NBS', config.cNBS, 'Omitido. Defina NFSE_CNBS (9 dígitos) se exigido.'),

    {
      grupo: val,
      tag: 'vServ',
      rotulo: 'Valor do serviço (R$)',
      valor: formatarValorDps(dps.valores.vServCents),
      origem: 'ledger',
      aConfirmar: false,
      nota: 'Resultado de taxas do mês: o mesmo número da tela Receita.',
    },
    deConfig(val, 'tribISSQN', 'Tributação do ISSQN', config.tribISSQN, '1 = operação tributável. Defina NFSE_TRIB_ISSQN.'),
    deConfig(val, 'tpRetISSQN', 'Retenção do ISSQN', config.tpRetISSQN, '1 = não retido. Defina NFSE_TP_RET_ISSQN.'),
    deConfig(val, 'pAliq', 'Alíquota do ISSQN (%)', config.pAliq, 'Omitida: a alíquota vem da parametrização do município. Defina NFSE_ALIQUOTA_ISS se exigido.'),
    {
      grupo: val,
      tag: 'indTotTrib',
      rotulo: 'Total aproximado de tributos',
      valor: '0',
      origem: 'fixo',
      aConfirmar: false,
      nota: '0 = não informar valor estimado (Decreto 8.264/2014).',
    },
  ];
}

// ────────────────────────────────────────────────────────────────────
//  Prévia da DPS (pura)
// ────────────────────────────────────────────────────────────────────

export type PreviaDps =
  | { readonly status: 'sem_valor' }
  | { readonly status: 'config_incompleta'; readonly faltando: readonly string[] }
  | {
      readonly status: 'gerada';
      readonly idDps: string;
      readonly valorServico: string;
      readonly campos: readonly CampoDps[];
      readonly xml: string;
    };

const VARIAVEIS_BLOQUEANTES: readonly NfseVariavel[] = ['NFSE_PRESTADOR_CNPJ', 'NFSE_MUNICIPIO_IBGE'];

export function montarPreviaDps(input: {
  readonly mes: string;
  readonly resultadoCents: number;
  readonly config: NfseConfig;
  readonly now: Date;
}): PreviaDps {
  const { mes, resultadoCents, config, now } = input;
  if (resultadoCents <= 0) return { status: 'sem_valor' };

  const { prestadorCnpj, municipioIbge } = config;
  if (prestadorCnpj === null || municipioIbge === null) {
    return {
      status: 'config_incompleta',
      faltando: config.problemas
        .map((p) => p.variavel)
        .filter((variavel) => VARIAVEIS_BLOQUEANTES.includes(variavel)),
    };
  }

  const competencia = competenciaDoMes(mes);
  const dps: DpsInput = {
    tpAmb: config.ambiente.valor,
    dhEmi: dhEmiSaoPaulo(now),
    verAplic: VER_APLIC_PREVIA,
    serie: SERIE_DPS_PREVIA,
    nDPS: numeroDpsPrevia(mes),
    dCompet: competencia.de,
    cLocEmi: municipioIbge,
    prestador: {
      cnpj: prestadorCnpj,
      inscricaoMunicipal: config.inscricaoMunicipal.valor,
      opSimpNac: config.opSimpNac.valor,
      regApTribSN: config.regApTribSN.valor,
      regEspTrib: config.regEspTrib.valor,
    },
    servico: {
      cLocPrestacao: municipioIbge,
      cTribNac: config.cTribNac.valor,
      xDescServ: descricaoDoServico(config.descricaoServico.valor, competencia.rotulo),
      cNBS: config.cNBS.valor,
    },
    valores: {
      vServCents: resultadoCents,
      tribISSQN: config.tribISSQN.valor,
      tpRetISSQN: config.tpRetISSQN.valor,
      pAliq: config.pAliq.valor,
    },
  };
  const { xml, idDps } = montarDpsXml(dps);
  return {
    status: 'gerada',
    idDps,
    valorServico: formatarValorDps(resultadoCents),
    campos: camposDaDps(dps, config),
    xml,
  };
}

// ────────────────────────────────────────────────────────────────────
//  Assinatura opcional
// ────────────────────────────────────────────────────────────────────

export type AssinaturaPrevia =
  | {
      readonly status: 'assinada';
      /** CNPJ do CN do certificado (público), null se não houver. */
      readonly certificadoCnpj: string | null;
      readonly certificadoConfereComPrestador: boolean;
      readonly certificadoValidoAte: Date;
    }
  | { readonly status: 'nao_assinada'; readonly motivo: 'sem_certificado' | 'certificado_ilegivel' };

export function assinarPrevia(
  xml: string,
  idDps: string,
  config: NfseConfig,
): { readonly xml: string; readonly assinatura: AssinaturaPrevia } {
  if (config.certificado === null) {
    return { xml, assinatura: { status: 'nao_assinada', motivo: 'sem_certificado' } };
  }
  let material: ReturnType<typeof carregarCertificado>;
  try {
    material = carregarCertificado(config.certificado);
  } catch {
    return { xml, assinatura: { status: 'nao_assinada', motivo: 'certificado_ilegivel' } };
  }
  return {
    xml: assinarDps(xml, idDps, material),
    assinatura: {
      status: 'assinada',
      certificadoCnpj: material.cnpj,
      certificadoConfereComPrestador: material.cnpj !== null && material.cnpj === config.prestadorCnpj,
      certificadoValidoAte: material.validoAte,
    },
  };
}

// ────────────────────────────────────────────────────────────────────
//  Prévia completa (lê o read model da Receita)
// ────────────────────────────────────────────────────────────────────

export type AvisoPrevia =
  | 'mes_em_andamento'
  | 'resultado_nao_positivo'
  | 'config_com_problemas'
  | 'xml_nao_assinado'
  | 'certificado_de_outro_cnpj'
  | 'certificado_vencido'
  | 'inconsistencias_no_periodo'
  | 'detalhamento_nao_concilia';

export interface PreviaMensal {
  readonly mes: string;
  readonly rotulo: string;
  readonly situacao: SituacaoMes;
  readonly periodo: { readonly de: string; readonly ate: string };
  readonly timezone: ReceitaDashboard['timezone'];
  readonly snapshotAt: Date;
  readonly valor: {
    readonly taxasRegistradasCents: number;
    readonly cancelamentosCents: number;
    readonly resultadoDeTaxasCents: number;
    readonly lancamentosRegistrados: number;
    readonly lancamentosCancelados: number;
    readonly pagamentosComTaxa: number;
  };
  readonly porMeioProvedor: readonly MeioProvedorReceita[];
  readonly adicionalCartao: ReceitaDashboard['cards']['periodo']['adicionalCartao'];
  readonly inconsistencias: ReceitaDashboard['inconsistencias'];
  readonly configuracao: { readonly problemas: readonly ProblemaConfig[] };
  readonly avisos: readonly AvisoPrevia[];
  readonly dps:
    | Exclude<PreviaDps, { status: 'gerada' }>
    | (Extract<PreviaDps, { status: 'gerada' }> & { readonly assinatura: AssinaturaPrevia });
}

export async function carregarPreviaMensal(
  db: Database,
  input: {
    readonly platformId: string;
    readonly mes: string;
    readonly now: Date;
    readonly config: NfseConfig;
  },
): Promise<PreviaMensal> {
  return tracer.startActiveSpan('nfse.previaMensal', async (span) => {
    try {
      span.setAttribute('nfse.mes', input.mes);
      const previa = await previaMensal(db, input);
      span.setAttribute('nfse.dps.status', previa.dps.status);
      if (previa.dps.status === 'gerada') {
        span.setAttribute('nfse.assinatura.status', previa.dps.assinatura.status);
      }
      return previa;
    } catch (error: unknown) {
      if (error instanceof Error) span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

async function previaMensal(
  db: Database,
  input: {
    readonly platformId: string;
    readonly mes: string;
    readonly now: Date;
    readonly config: NfseConfig;
  },
): Promise<PreviaMensal> {
  const { platformId, mes, now, config } = input;
  const situacao = situacaoDoMes(mes, now);
  const competencia = competenciaDoMes(mes);

  const dashboard = await loadReceitaDashboard(db, {
    platformId,
    periodo: { de: competencia.de, ate: competencia.ate, granularidade: 'mes' },
    now,
  });
  const card = dashboard.cards.periodo;

  const avisos: AvisoPrevia[] = [];
  if (situacao === 'em_andamento') avisos.push('mes_em_andamento');
  if (card.resultadoDeTaxasCents <= 0) avisos.push('resultado_nao_positivo');
  if (config.problemas.length > 0) avisos.push('config_com_problemas');
  const inc = dashboard.inconsistencias;
  if (inc.estornadoSemCancelamento.count > 0 || inc.canceladoSemEstorno.count > 0) {
    avisos.push('inconsistencias_no_periodo');
  }
  const dif = dashboard.conciliacao.diferencas.porMeioProvedor;
  if (dif.taxasRegistradasCents !== 0 || dif.cancelamentosCents !== 0) {
    avisos.push('detalhamento_nao_concilia');
  }

  const previa = montarPreviaDps({ mes, resultadoCents: card.resultadoDeTaxasCents, config, now });
  let dps: PreviaMensal['dps'];
  if (previa.status === 'gerada') {
    const { xml, assinatura } = assinarPrevia(previa.xml, previa.idDps, config);
    if (assinatura.status === 'nao_assinada') avisos.push('xml_nao_assinado');
    if (assinatura.status === 'assinada') {
      if (!assinatura.certificadoConfereComPrestador) avisos.push('certificado_de_outro_cnpj');
      if (assinatura.certificadoValidoAte.getTime() < now.getTime()) avisos.push('certificado_vencido');
    }
    dps = { ...previa, xml, assinatura };
  } else {
    dps = previa;
  }

  return {
    mes,
    rotulo: competencia.rotulo,
    situacao,
    periodo: { de: competencia.de, ate: competencia.ate },
    timezone: dashboard.timezone,
    snapshotAt: dashboard.snapshotAt,
    valor: {
      taxasRegistradasCents: card.taxasRegistradasCents,
      cancelamentosCents: card.cancelamentosCents,
      resultadoDeTaxasCents: card.resultadoDeTaxasCents,
      lancamentosRegistrados: card.lancamentosRegistrados,
      lancamentosCancelados: card.lancamentosCancelados,
      pagamentosComTaxa: card.pagamentosComTaxa,
    },
    porMeioProvedor: dashboard.porMeioProvedor,
    adicionalCartao: card.adicionalCartao,
    inconsistencias: dashboard.inconsistencias,
    configuracao: { problemas: config.problemas },
    avisos,
    dps,
  };
}
