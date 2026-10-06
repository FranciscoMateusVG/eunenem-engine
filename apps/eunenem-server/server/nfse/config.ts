import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type {
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

export interface NfseConfig {
  /** 14 dígitos, DV conferido. */
  readonly prestadorCnpj: string | null;
  /** IBGE 7 dígitos: cLocEmi e cLocPrestacao. */
  readonly municipioIbge: string | null;
  readonly ambiente: CampoConfig<TipoAmbiente>;
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
  readonly certificado: CertificadoNfse | null;
  readonly problemas: readonly ProblemaConfig[];
}

/**
 * Default do código de tributação nacional: LC 116 item 10.05, desdobro 01
 * — "Agenciamento, corretagem ou intermediação de bens móveis ou imóveis, não
 * abrangidos em outros itens ou subitens, por quaisquer meios" (lista
 * nacional, anexo B v1.01). A receita é comissão de intermediação da
 * plataforma. O "1.05.01" do sandbox é licenciamento de software e não
 * descreve a atividade. A confirmar com o contador.
 */
export const CTRIB_NAC_PADRAO = '100501';

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
const InscricaoMunicipalSchema = z.string().min(1).max(15).regex(LATIN1);
const CNbsSchema = z.string().regex(/^\d{9}$/);
const DescricaoSchema = z.string().min(1).max(1900).regex(LATIN1);
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
  NFSE_CERT_PATH: z.string().optional(),
  NFSE_CERT_BASE64: z.string().optional(),
  NFSE_CERT_PASSWORD: z.string().optional(),
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
  const inscricaoMunicipal = campo<string | null, null>('NFSE_INSCRICAO_MUNICIPAL', InscricaoMunicipalSchema, null);
  const cNBS = campo<string | null, null>('NFSE_CNBS', CNbsSchema, null);
  const descricaoServico = campo('NFSE_DESCRICAO_SERVICO', DescricaoSchema, DESCRICAO_SERVICO_PADRAO);

  const certificado = parseCertificado(ler, problemas);

  return {
    prestadorCnpj,
    municipioIbge,
    ambiente,
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
    certificado,
    problemas,
  };
}

function parseCertificado(
  ler: (nome: NfseVariavel) => string | undefined,
  problemas: ProblemaConfig[],
): CertificadoNfse | null {
  const caminho = ler('NFSE_CERT_PATH');
  const base64 = ler('NFSE_CERT_BASE64');
  const senha = ler('NFSE_CERT_PASSWORD') ?? '';

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
