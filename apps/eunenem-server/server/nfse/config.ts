import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type {
  LeiauteDps,
  OpSimpNac,
  RegApTribSN,
  RegEspTrib,
  TipoAmbiente,
  TpRetISSQN,
  TribISSQN,
} from './dps.js';

/**
 * Configuração NFSE_* da prévia mensal da NFS-e (aperture-dh1k7).
 *
 * Fronteira de env: cada variável é validada sozinha com zod. Ausente ou
 * inválida NUNCA derruba o servidor — vira item de `problemas` (só o NOME da
 * variável, nunca o valor) e o campo cai no default. A prévia decide o que
 * fazer com isso (sem CNPJ/município não há DPS).
 *
 * Campos fiscais têm `origem`: `default` significa "ninguém confirmou" e a UI
 * marca "a confirmar".
 *
 * SEGREDOS: senha e PFX ficam em campos privados de `CertificadoNfse`. Não
 * aparecem em JSON.stringify, util.inspect, String() nem em chaves
 * enumeráveis. Erros de leitura/decodificação viram códigos fixos.
 */

export type OrigemConfig = 'env' | 'default';

export interface CampoConfig<T> {
  readonly valor: T;
  readonly origem: OrigemConfig;
}

export interface ProblemaConfig {
  readonly variavel: NfseVariavel;
  readonly motivo: 'ausente' | 'invalido';
}

export type FonteCertificado = 'caminho' | 'base64';

const REDACTED = '[CertificadoNfse redacted]';

export class CertificadoNfse {
  readonly fonte: FonteCertificado;
  readonly #ler: () => Buffer;
  readonly #senha: string;

  constructor(fonte: FonteCertificado, ler: () => Buffer, senha: string) {
    this.fonte = fonte;
    this.#ler = ler;
    this.#senha = senha;
  }

  /** Bytes do PFX. Lança `nfse_certificado_ilegivel` sem detalhes. */
  lerPfx(): Buffer {
    try {
      return this.#ler();
    } catch {
      throw new Error('nfse_certificado_ilegivel');
    }
  }

  senha(): string {
    return this.#senha;
  }

  toJSON(): { fonte: FonteCertificado } {
    return { fonte: this.fonte };
  }

  toString(): string {
    return REDACTED;
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `CertificadoNfse { fonte: '${this.fonte}' }`;
  }
}

export interface PercentuaisTributos {
  readonly fed: string;
  readonly est: string;
  readonly mun: string;
}

export interface NfseConfig {
  /** 14 dígitos, DV conferido. */
  readonly prestadorCnpj: string | null;
  /** IBGE 7 dígitos: cLocEmi e cLocPrestacao. */
  readonly municipioIbge: string | null;
  readonly ambiente: CampoConfig<TipoAmbiente>;
  /**
   * Leiaute da DPS. Padrão por ambiente: homologação (2) → 'rtc-2026-11'
   * (a produção restrita já exige o leiaute da Reforma); produção (1) →
   * 'producao-2026-02'. NFSE_LEIAUTE_DPS sobrescreve (ex.: quando a produção
   * migrar).
   */
  readonly leiauteDps: CampoConfig<LeiauteDps>;
  readonly cTribNac: CampoConfig<string>;
  /** Template; `{competencia}` vira "setembro/2026". */
  readonly descricaoServico: CampoConfig<string>;
  readonly opSimpNac: CampoConfig<OpSimpNac>;
  readonly regApTribSN: CampoConfig<RegApTribSN | null>;
  readonly regEspTrib: CampoConfig<RegEspTrib>;
  readonly tribISSQN: CampoConfig<TribISSQN>;
  readonly tpRetISSQN: CampoConfig<TpRetISSQN>;
  readonly pAliq: CampoConfig<string | null>;
  readonly inscricaoMunicipal: CampoConfig<string | null>;
  readonly cNBS: CampoConfig<string | null>;
  /** pTotTrib (não optante): percentuais fed/est/mun, TSDec3V2. */
  readonly pTotTrib: CampoConfig<PercentuaisTributos | null>;
  /** pTotTribSN (ME/EPP), TSDec2V2. */
  readonly pTotTribSN: CampoConfig<string | null>;
  readonly certificado: CertificadoNfse | null;
  /** Série real da DPS (aperture-wp6j6). Nunca a série de prévia 89999. */
  readonly serie: CampoConfig<string>;
  /**
   * Segunda chave da produção: emitir com tpAmb=1 exige também
   * NFSE_EMISSAO_PRODUCAO=liberada. Homologação não depende dela.
   */
  readonly emissaoProducaoLiberada: boolean;
  /**
   * NFSE_COMPETENCIA_MINIMA (AAAA-MM): primeira competência emitível EM
   * PRODUÇÃO. Só pode SUBIR o piso absoluto 2026-11 (decisão do contador);
   * valor menor é ignorado pelo plano. Homologação não tem piso.
   */
  readonly competenciaMinima: string;
  readonly problemas: readonly ProblemaConfig[];
}

/** Série própria das DPS reais (docs/nfse-prontidao.md). */
export const SERIE_DPS_PADRAO = '00001';

/** Código indicado pelo contador: LC 116 item 10.02, desdobro 02. */
export const CTRIB_NAC_PADRAO = '100202';

export const DESCRICAO_SERVICO_PADRAO =
  'Comissão de intermediação de pagamentos da plataforma EuNeném - competência {competencia}.';

export function descricaoDoServico(template: string, rotuloCompetencia: string): string {
  return template.replaceAll('{competencia}', rotuloCompetencia);
}

export function cnpjValido(cnpj: string): boolean {
  if (!/^\d{14}$/.test(cnpj) || /^(\d)\1{13}$/.test(cnpj)) return false;
  const digitos = [...cnpj].map(Number);
  const dv = (n: number) => {
    const pesos = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const soma = pesos.reduce((acc, peso, i) => acc + peso * (digitos[i] ?? 0), 0);
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };
  return dv(12) === digitos[12] && dv(13) === digitos[13];
}

/** Latin-1 imprimível, sem espaço nas pontas (TSString / TSDesc2000). */
const LATIN1 = /^[!-ÿ](?:[ -ÿ]*[!-ÿ])?$/;

const CnpjSchema = z
  .string()
  .transform((v) => v.replace(/[.\-/\s]/g, ''))
  .refine(cnpjValido);
const IbgeSchema = z.string().regex(/^\d{7}$/);
const CTribNacSchema = z.string().regex(/^\d{6}$/);
const AmbienteSchema = z.enum(['1', '2']);
const OpSimpNacSchema = z.enum(['1', '2', '3']);
const RegApTribSNSchema = z.enum(['1', '2', '3']);
const RegEspTribSchema = z.enum(['0', '1', '2', '3', '4', '5', '6', '9']);
const TribISSQNSchema = z.enum(['1', '2', '3', '4']);
const TpRetISSQNSchema = z.enum(['1', '2', '3']);
const AliquotaSchema = z.string().regex(/^(0|[0-9](\.[0-9]{2})?)$/);
/**
 * IM do prestador. 'omitir' tira a tag: a produção restrita recusa IM quando
 * o CNC NFS-e do município não tem dados complementares do prestador (E0120,
 * smoke 26/11/2026).
 */
const InscricaoMunicipalSchema = z
  .string()
  .min(1)
  .max(15)
  .regex(LATIN1)
  .transform((v) => (v === 'omitir' ? null : v));
const CNbsSchema = z.string().regex(/^\d{9}$/);
const DEC3V2 = /^(0|0\.[0-9]{2}|[1-9][0-9]{0,2}(\.[0-9]{2})?)$/;
const DEC2V2 = /^(0|0\.[0-9]{2}|[1-9][0-9]?(\.[0-9]{2})?)$/;
const PTotTribSchema = z
  .string()
  .transform((v) => v.split(';').map((p) => p.trim()))
  .refine((partes) => partes.length === 3 && partes.every((p) => DEC3V2.test(p)))
  .transform(([fed, est, mun]): PercentuaisTributos => ({ fed: fed ?? '', est: est ?? '', mun: mun ?? '' }));
const PTotTribSNSchema = z.string().regex(DEC2V2);
/**
 * Rótulo de competência mais longo possível ("fevereiro/AAAA", 14). O limite
 * de 2000 do TSDesc2000 vale para o texto EXPANDIDO, então o template é
 * validado já expandido com o pior caso — vale para qualquer mês.
 */
const ROTULO_COMPETENCIA_MAIS_LONGO = 'fevereiro/2026';
const DescricaoSchema = z
  .string()
  .min(1)
  .regex(LATIN1)
  .refine((t) => descricaoDoServico(t, ROTULO_COMPETENCIA_MAIS_LONGO).length <= 2000);
/**
 * Série com 5 dígitos, 00001–89999: o pack RTC (produção restrita 20261124)
 * reserva 90000–99999 (TSSerieDPS = [0-9]{1,4}|[0-8][0-9]{4}); 89999 é a
 * série da prévia.
 */
const SerieSchema = z.string().regex(/^[0-8]\d{4}$/).refine((v) => v !== '00000' && v !== '89999');
const Base64Schema = z.string().transform((v) => v.replace(/\s/g, '')).pipe(z.base64().min(1));

export type NfseVariavel = keyof typeof NfseEnvShape;
export type NfseEnv = { readonly [K in NfseVariavel]?: string | undefined };

/**
 * Chaves NFSE_* aceitas pelo `ServerEnvSchema` (todas opcionais e cruas:
 * a validação de verdade é `parseNfseConfig`, que nunca derruba o boot).
 */
export const NfseEnvShape = {
  NFSE_PRESTADOR_CNPJ: z.string().optional(),
  NFSE_MUNICIPIO_IBGE: z.string().optional(),
  NFSE_AMBIENTE: z.string().optional(),
  NFSE_CTRIB_NAC: z.string().optional(),
  NFSE_DESCRICAO_SERVICO: z.string().optional(),
  NFSE_OP_SIMP_NAC: z.string().optional(),
  NFSE_REG_AP_TRIB_SN: z.string().optional(),
  NFSE_REG_ESP_TRIB: z.string().optional(),
  NFSE_TRIB_ISSQN: z.string().optional(),
  NFSE_TP_RET_ISSQN: z.string().optional(),
  NFSE_ALIQUOTA_ISS: z.string().optional(),
  NFSE_INSCRICAO_MUNICIPAL: z.string().optional(),
  NFSE_CNBS: z.string().optional(),
  NFSE_P_TOT_TRIB: z.string().optional(),
  NFSE_P_TOT_TRIB_SN: z.string().optional(),
  NFSE_CERT_PATH: z.string().optional(),
  NFSE_CERT_BASE64: z.string().optional(),
  NFSE_CERT_PASSWORD: z.string().optional(),
  NFSE_SERIE: z.string().optional(),
  NFSE_EMISSAO_PRODUCAO: z.string().optional(),
  NFSE_COMPETENCIA_MINIMA: z.string().optional(),
  NFSE_LEIAUTE_DPS: z.string().optional(),
};

export function parseNfseConfig(env: NfseEnv): NfseConfig {
  const problemas: ProblemaConfig[] = [];

  const ler = (nome: NfseVariavel): string | undefined => {
    const v = env[nome];
    return v === undefined || v.trim() === '' ? undefined : v.trim();
  };

  function obrigatorio<T>(nome: NfseVariavel, schema: z.ZodType<T>): T | null {
    const bruto = ler(nome);
    if (bruto === undefined) {
      problemas.push({ variavel: nome, motivo: 'ausente' });
      return null;
    }
    const r = schema.safeParse(bruto);
    if (!r.success) {
      problemas.push({ variavel: nome, motivo: 'invalido' });
      return null;
    }
    return r.data;
  }

  function campo<T, D extends T>(nome: NfseVariavel, schema: z.ZodType<T>, padrao: D): CampoConfig<T> {
    const bruto = ler(nome);
    if (bruto === undefined) return { valor: padrao, origem: 'default' };
    const r = schema.safeParse(bruto);
    if (!r.success) {
      problemas.push({ variavel: nome, motivo: 'invalido' });
      return { valor: padrao, origem: 'default' };
    }
    return { valor: r.data, origem: 'env' };
  }

  const prestadorCnpj = obrigatorio('NFSE_PRESTADOR_CNPJ', CnpjSchema);
  const municipioIbge = obrigatorio('NFSE_MUNICIPIO_IBGE', IbgeSchema);
  const cTribNac = campo('NFSE_CTRIB_NAC', CTribNacSchema, CTRIB_NAC_PADRAO);
  const ambiente = campo<TipoAmbiente, '2'>('NFSE_AMBIENTE', AmbienteSchema, '2');
  const leiauteDps = campo<LeiauteDps, LeiauteDps>(
    'NFSE_LEIAUTE_DPS',
    z.enum(['producao-2026-02', 'rtc-2026-11']),
    ambiente.valor === '1' ? 'producao-2026-02' : 'rtc-2026-11',
  );
  const opSimpNac = campo<OpSimpNac, '1'>('NFSE_OP_SIMP_NAC', OpSimpNacSchema, '1');

  let regApTribSN = campo<RegApTribSN | null, null>('NFSE_REG_AP_TRIB_SN', RegApTribSNSchema, null);
  if (regApTribSN.valor !== null && opSimpNac.valor !== '3') {
    problemas.push({ variavel: 'NFSE_REG_AP_TRIB_SN', motivo: 'invalido' });
    regApTribSN = { valor: null, origem: 'default' };
  }

  const regEspTrib = campo<RegEspTrib, '0'>('NFSE_REG_ESP_TRIB', RegEspTribSchema, '0');
  const tribISSQN = campo<TribISSQN, '1'>('NFSE_TRIB_ISSQN', TribISSQNSchema, '1');
  const tpRetISSQN = campo<TpRetISSQN, '1'>('NFSE_TP_RET_ISSQN', TpRetISSQNSchema, '1');
  const pAliq = campo<string | null, null>('NFSE_ALIQUOTA_ISS', AliquotaSchema, null);
  const inscricaoMunicipal = campo<string | null, string>('NFSE_INSCRICAO_MUNICIPAL', InscricaoMunicipalSchema, '12306200019');
  const cNBS = campo<string | null, null>('NFSE_CNBS', CNbsSchema, null);
  const pTotTrib = campo<PercentuaisTributos | null, PercentuaisTributos>('NFSE_P_TOT_TRIB', PTotTribSchema, { fed: '11.33', est: '0.00', mun: '3.00' });
  const pTotTribSN = campo<string | null, null>('NFSE_P_TOT_TRIB_SN', PTotTribSNSchema, null);
  const descricaoServico = campo('NFSE_DESCRICAO_SERVICO', DescricaoSchema, DESCRICAO_SERVICO_PADRAO);
  const serie = campo('NFSE_SERIE', SerieSchema, SERIE_DPS_PADRAO);
  const emissaoProducaoLiberada = ler('NFSE_EMISSAO_PRODUCAO') === 'liberada';
  const competenciaMinima = campo('NFSE_COMPETENCIA_MINIMA', z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/), '2026-11').valor;

  // A senha NÃO passa por trim: espaços nas pontas fazem parte dela.
  const certificado = parseCertificado(ler, env.NFSE_CERT_PASSWORD ?? '', problemas);

  return {
    prestadorCnpj,
    municipioIbge,
    ambiente,
    leiauteDps,
    cTribNac,
    descricaoServico,
    opSimpNac,
    regApTribSN,
    regEspTrib,
    tribISSQN,
    tpRetISSQN,
    pAliq,
    inscricaoMunicipal,
    cNBS,
    pTotTrib,
    pTotTribSN,
    certificado,
    serie,
    emissaoProducaoLiberada,
    competenciaMinima,
    problemas,
  };
}

function parseCertificado(
  ler: (nome: NfseVariavel) => string | undefined,
  senhaCrua: string,
  problemas: ProblemaConfig[],
): CertificadoNfse | null {
  const caminho = ler('NFSE_CERT_PATH');
  const base64 = ler('NFSE_CERT_BASE64');
  const senha = senhaCrua;

  if (caminho !== undefined && base64 !== undefined) {
    problemas.push({ variavel: 'NFSE_CERT_PATH', motivo: 'invalido' });
    return null;
  }
  if (caminho !== undefined) {
    return new CertificadoNfse('caminho', () => readFileSync(caminho), senha);
  }
  if (base64 !== undefined) {
    const r = Base64Schema.safeParse(base64);
    if (!r.success) {
      problemas.push({ variavel: 'NFSE_CERT_BASE64', motivo: 'invalido' });
      return null;
    }
    const conteudo = r.data;
    return new CertificadoNfse('base64', () => Buffer.from(conteudo, 'base64'), senha);
  }
  return null;
}
