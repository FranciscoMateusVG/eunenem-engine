/**
 * DPS (Declaração de Prestação de Serviço) — leiaute SN NFS-e v1.01
 * (pacote nfse-esquemas_xsd-v1-01-20260209). Módulo puro, sem I/O.
 * aperture-dh1k7.
 *
 * Porta o builder de ~/projects/nfse-sandbox/src/dps.ts corrigindo o que a
 * 1.01 recusa ali: o `Id` mora no `infDPS` (TSIdDPS = "DPS" + 42 dígitos, sem
 * "_"), `DPS` só leva `versao`, `subst` vazio não existe, e `regTrib`,
 * `tpRetISSQN` e `totTrib` são obrigatórios.
 *
 * O grupo `toma` é `minOccurs="0"` em TCInfDPS: a NFS-e mensal agregada é de
 * consumidor não identificado, então o grupo é omitido (nunca o CNPJ do
 * próprio prestador como tomador).
 *
 * A ordem dos elementos é a da `xs:sequence` do XSD — não reordenar.
 */

export const NFSE_NAMESPACE = 'http://www.sped.fazenda.gov.br/nfse';
export const DPS_VERSAO = '1.01';

/** Série de prévia: nunca colide com a série real (que começa em 00001). */
export const SERIE_DPS_PREVIA = '99999';

export type TipoAmbiente = '1' | '2';
export type OpSimpNac = '1' | '2' | '3';
export type RegApTribSN = '1' | '2' | '3';
export type RegEspTrib = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '9';
export type TribISSQN = '1' | '2' | '3' | '4';
export type TpRetISSQN = '1' | '2' | '3';

export interface DpsInput {
  readonly tpAmb: TipoAmbiente;
  /** AAAA-MM-DDThh:mm:ss±hh:mm */
  readonly dhEmi: string;
  readonly verAplic: string;
  readonly serie: string;
  readonly nDPS: string;
  /** AAAA-MM-DD */
  readonly dCompet: string;
  /** IBGE, 7 dígitos. */
  readonly cLocEmi: string;
  readonly prestador: {
    readonly cnpj: string;
    readonly inscricaoMunicipal: string | null;
    readonly opSimpNac: OpSimpNac;
    /** Só para opSimpNac = 3 (ME/EPP). */
    readonly regApTribSN: RegApTribSN | null;
    readonly regEspTrib: RegEspTrib;
  };
  readonly servico: {
    readonly cLocPrestacao: string;
    /** 6 dígitos: item (2) + subitem (2) LC 116 + desdobro nacional (2). */
    readonly cTribNac: string;
    readonly xDescServ: string;
    readonly cNBS: string | null;
  };
  readonly valores: {
    readonly vServCents: number;
    readonly tribISSQN: TribISSQN;
    readonly tpRetISSQN: TpRetISSQN;
    /** Alíquota já formatada (TSDec1V2), ex. "2.00". */
    readonly pAliq: string | null;
  };
}

/** Centavos inteiros positivos → TSDec15V2 ("1234.56"). */
export function formatarValorDps(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    throw new Error('nfse_valor_invalido');
  }
  const reais = Math.floor(cents / 100);
  const resto = String(cents % 100).padStart(2, '0');
  return `${reais}.${resto}`;
}

const MESES_PT = [
  'janeiro',
  'fevereiro',
  'março',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
] as const;

/** TSData do XSD só aceita anos 20xx. */
const MES_PATTERN = /^(20\d{2})-(0[1-9]|1[0-2])$/;

export interface Competencia {
  readonly mes: string;
  /** Primeiro dia do mês (data local SP), inclusivo. */
  readonly de: string;
  /** Primeiro dia do mês seguinte, exclusivo. */
  readonly ate: string;
  readonly ultimoDia: string;
  /** "setembro/2026" */
  readonly rotulo: string;
}

function dataLocal(ano: number, mes: number, dia: number): string {
  return `${String(ano).padStart(4, '0')}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

export function competenciaDoMes(mes: string): Competencia {
  const match = MES_PATTERN.exec(mes);
  if (!match) throw new Error('nfse_mes_invalido');
  const ano = Number(match[1]);
  const numero = Number(match[2]);
  const ultimo = new Date(Date.UTC(ano, numero, 0)).getUTCDate();
  const seguinteAno = numero === 12 ? ano + 1 : ano;
  const seguinteMes = numero === 12 ? 1 : numero + 1;
  return {
    mes,
    de: dataLocal(ano, numero, 1),
    ate: dataLocal(seguinteAno, seguinteMes, 1),
    ultimoDia: dataLocal(ano, numero, ultimo),
    rotulo: `${MESES_PT[numero - 1]}/${ano}`,
  };
}

/** Número de DPS da prévia: AAAAMM + 99999999 (14 dígitos, não começa com 0). */
export function numeroDpsPrevia(mes: string): string {
  competenciaDoMes(mes);
  return `${mes.replace('-', '')}99999999`;
}

/** Anexo I v1.01 (regra E0004): tipo de inscrição federal 1 = CPF, 2 = CNPJ. */
const TIPO_INSCRICAO_CNPJ = '2';

/**
 * "DPS" + cLocEmi (7) + tipo de inscrição federal (1) + CNPJ (14) +
 * série (5) + número (15). O sandbox usava "1" para CNPJ, o que está errado.
 */
export function montarIdDps(input: {
  readonly cLocEmi: string;
  readonly cnpj: string;
  readonly serie: string;
  readonly nDPS: string;
}): string {
  return `DPS${input.cLocEmi}${TIPO_INSCRICAO_CNPJ}${input.cnpj.padStart(14, '0')}${input.serie.padStart(5, '0')}${input.nDPS.padStart(15, '0')}`;
}

const SAO_PAULO = 'America/Sao_Paulo';

/** Instante → "AAAA-MM-DDThh:mm:ss±hh:mm" no horário de São Paulo. */
export function dhEmiSaoPaulo(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SAO_PAULO,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  }).formatToParts(now);
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  const offset = pick('timeZoneName').replace('GMT', '') || '+00:00';
  return `${pick('year')}-${pick('month')}-${pick('day')}T${pick('hour')}:${pick('minute')}:${pick('second')}${offset}`;
}

export function escaparXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function el(tag: string, conteudo: string): string {
  return `<${tag}>${conteudo}</${tag}>`;
}

function txt(tag: string, valor: string): string {
  return el(tag, escaparXml(valor));
}

function opcional(tag: string, valor: string | null): string {
  return valor === null ? '' : txt(tag, valor);
}

/** XML da DPS sem assinatura. A assinatura (quando houver) entra depois de `infDPS`. */
export function montarDpsXml(input: DpsInput): { readonly xml: string; readonly idDps: string } {
  const idDps = montarIdDps({
    cLocEmi: input.cLocEmi,
    cnpj: input.prestador.cnpj,
    serie: input.serie,
    nDPS: input.nDPS,
  });
  const { prestador, servico, valores } = input;

  const prest = el(
    'prest',
    txt('CNPJ', prestador.cnpj) +
      opcional('IM', prestador.inscricaoMunicipal) +
      el(
        'regTrib',
        txt('opSimpNac', prestador.opSimpNac) +
          opcional('regApTribSN', prestador.regApTribSN) +
          txt('regEspTrib', prestador.regEspTrib),
      ),
  );

  const serv = el(
    'serv',
    el('locPrest', txt('cLocPrestacao', servico.cLocPrestacao)) +
      el(
        'cServ',
        txt('cTribNac', servico.cTribNac) + txt('xDescServ', servico.xDescServ) + opcional('cNBS', servico.cNBS),
      ),
  );

  const vals = el(
    'valores',
    el('vServPrest', txt('vServ', formatarValorDps(valores.vServCents))) +
      el(
        'trib',
        el(
          'tribMun',
          txt('tribISSQN', valores.tribISSQN) + txt('tpRetISSQN', valores.tpRetISSQN) + opcional('pAliq', valores.pAliq),
        ) + el('totTrib', txt('indTotTrib', '0')),
      ),
  );

  const infDps =
    `<infDPS Id="${idDps}">` +
    txt('tpAmb', input.tpAmb) +
    txt('dhEmi', input.dhEmi) +
    txt('verAplic', input.verAplic) +
    txt('serie', input.serie) +
    txt('nDPS', input.nDPS) +
    txt('dCompet', input.dCompet) +
    txt('tpEmit', '1') +
    txt('cLocEmi', input.cLocEmi) +
    prest +
    serv +
    vals +
    '</infDPS>';

  return {
    xml: `<?xml version="1.0" encoding="UTF-8"?><DPS xmlns="${NFSE_NAMESPACE}" versao="${DPS_VERSAO}">${infDps}</DPS>`,
    idDps,
  };
}
