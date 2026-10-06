import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  cnpjValido,
  descricaoDoServico,
  parseNfseConfig,
} from '../../../apps/eunenem-server/server/nfse/config.js';

/**
 * aperture-dh1k7 — configuração NFSE_* (zod na fronteira de env).
 *
 * Contrato: env ausente ou inválido NUNCA derruba o servidor; vira item em
 * `problemas` (só o NOME da variável). Senha e PFX nunca aparecem em
 * serialização, inspeção ou mensagem.
 */

const CNPJ = '11222333000181';
const SENHA = 'senha-super-secreta-123';
const PFX_B64 = Buffer.from('nao-e-um-pfx-de-verdade').toString('base64');

describe('cnpjValido', () => {
  it('aceita CNPJ com dígitos verificadores corretos', () => {
    expect(cnpjValido(CNPJ)).toBe(true);
  });
  it.each([
    '11222333000182',
    '00000000000000',
    '1122233300018',
    'abcdefghijklmn',
  ])('recusa %s', (v) => {
    expect(cnpjValido(v)).toBe(false);
  });
});

describe('parseNfseConfig', () => {
  it('env vazio: defaults fiscais marcados como default, CNPJ/IBGE ausentes, sem certificado', () => {
    const cfg = parseNfseConfig({});
    expect(cfg.prestadorCnpj).toBeNull();
    expect(cfg.municipioIbge).toBeNull();
    expect(cfg.certificado).toBeNull();
    expect(cfg.problemas).toEqual([
      { variavel: 'NFSE_PRESTADOR_CNPJ', motivo: 'ausente' },
      { variavel: 'NFSE_MUNICIPIO_IBGE', motivo: 'ausente' },
    ]);
    expect(cfg.cTribNac).toEqual({ valor: '100501', origem: 'default' });
    expect(cfg.ambiente).toEqual({ valor: '2', origem: 'default' });
    expect(cfg.opSimpNac).toEqual({ valor: '1', origem: 'default' });
    expect(cfg.regApTribSN).toEqual({ valor: null, origem: 'default' });
    expect(cfg.regEspTrib).toEqual({ valor: '0', origem: 'default' });
    expect(cfg.tribISSQN).toEqual({ valor: '1', origem: 'default' });
    expect(cfg.tpRetISSQN).toEqual({ valor: '1', origem: 'default' });
    expect(cfg.pAliq).toEqual({ valor: null, origem: 'default' });
    expect(cfg.inscricaoMunicipal).toEqual({ valor: null, origem: 'default' });
    expect(cfg.cNBS).toEqual({ valor: null, origem: 'default' });
    expect(cfg.descricaoServico.origem).toBe('default');
  });

  it('valores válidos vindos do env ficam com origem env', () => {
    const cfg = parseNfseConfig({
      NFSE_PRESTADOR_CNPJ: '11.222.333/0001-81',
      NFSE_MUNICIPIO_IBGE: '2611606',
      NFSE_CTRIB_NAC: '100202',
      NFSE_AMBIENTE: '1',
      NFSE_OP_SIMP_NAC: '3',
      NFSE_REG_AP_TRIB_SN: '1',
      NFSE_REG_ESP_TRIB: '0',
      NFSE_TRIB_ISSQN: '1',
      NFSE_TP_RET_ISSQN: '1',
      NFSE_ALIQUOTA_ISS: '2.00',
      NFSE_INSCRICAO_MUNICIPAL: '123456',
      NFSE_CNBS: '109051200',
      NFSE_DESCRICAO_SERVICO: 'Comissão {competencia}',
    });
    expect(cfg.problemas).toEqual([]);
    expect(cfg.prestadorCnpj).toBe(CNPJ);
    expect(cfg.municipioIbge).toBe('2611606');
    expect(cfg.cTribNac).toEqual({ valor: '100202', origem: 'env' });
    expect(cfg.ambiente).toEqual({ valor: '1', origem: 'env' });
    expect(cfg.opSimpNac).toEqual({ valor: '3', origem: 'env' });
    expect(cfg.regApTribSN).toEqual({ valor: '1', origem: 'env' });
    expect(cfg.pAliq).toEqual({ valor: '2.00', origem: 'env' });
    expect(cfg.inscricaoMunicipal).toEqual({ valor: '123456', origem: 'env' });
    expect(cfg.cNBS).toEqual({ valor: '109051200', origem: 'env' });
    expect(cfg.descricaoServico).toEqual({ valor: 'Comissão {competencia}', origem: 'env' });
  });

  it('valor inválido cai no default e vira problema "invalido" (sem ecoar o valor)', () => {
    const cfg = parseNfseConfig({
      NFSE_PRESTADOR_CNPJ: '11222333000182',
      NFSE_MUNICIPIO_IBGE: '26116',
      NFSE_CTRIB_NAC: '1.05.01',
      NFSE_TP_RET_ISSQN: '9',
    });
    expect(cfg.prestadorCnpj).toBeNull();
    expect(cfg.municipioIbge).toBeNull();
    expect(cfg.cTribNac).toEqual({ valor: '100501', origem: 'default' });
    expect(cfg.tpRetISSQN).toEqual({ valor: '1', origem: 'default' });
    expect(cfg.problemas).toEqual([
      { variavel: 'NFSE_PRESTADOR_CNPJ', motivo: 'invalido' },
      { variavel: 'NFSE_MUNICIPIO_IBGE', motivo: 'invalido' },
      { variavel: 'NFSE_CTRIB_NAC', motivo: 'invalido' },
      { variavel: 'NFSE_TP_RET_ISSQN', motivo: 'invalido' },
    ]);
    expect(JSON.stringify(cfg.problemas)).not.toContain('11222333000182');
  });

  it('percentuais de tributos: NFSE_P_TOT_TRIB "fed;est;mun" e NFSE_P_TOT_TRIB_SN', () => {
    const cfg = parseNfseConfig({ NFSE_P_TOT_TRIB: '13.45;0.00;2.00', NFSE_P_TOT_TRIB_SN: '6.00' });
    expect(cfg.pTotTrib).toEqual({
      valor: { fed: '13.45', est: '0.00', mun: '2.00' },
      origem: 'env',
    });
    expect(cfg.pTotTribSN).toEqual({ valor: '6.00', origem: 'env' });
    expect(cfg.problemas).toEqual([
      { variavel: 'NFSE_PRESTADOR_CNPJ', motivo: 'ausente' },
      { variavel: 'NFSE_MUNICIPIO_IBGE', motivo: 'ausente' },
    ]);
  });

  it.each([
    '13.45;0.00',
    '13.4;0;2',
    '1000.00;0;0',
    'a;b;c',
  ])('NFSE_P_TOT_TRIB %j é inválido', (v) => {
    const cfg = parseNfseConfig({ NFSE_P_TOT_TRIB: v });
    expect(cfg.pTotTrib).toEqual({ valor: null, origem: 'default' });
    expect(cfg.problemas).toContainEqual({ variavel: 'NFSE_P_TOT_TRIB', motivo: 'invalido' });
  });

  it('regApTribSN só vale com opSimpNac=3', () => {
    const cfg = parseNfseConfig({ NFSE_OP_SIMP_NAC: '1', NFSE_REG_AP_TRIB_SN: '1' });
    expect(cfg.regApTribSN).toEqual({ valor: null, origem: 'default' });
    expect(cfg.problemas).toContainEqual({ variavel: 'NFSE_REG_AP_TRIB_SN', motivo: 'invalido' });
  });

  it('descrição fora do Latin-1 (TSString do XSD) é inválida', () => {
    const cfg = parseNfseConfig({ NFSE_DESCRICAO_SERVICO: 'Comissão — {competencia}' });
    expect(cfg.descricaoServico.origem).toBe('default');
    expect(cfg.problemas).toContainEqual({
      variavel: 'NFSE_DESCRICAO_SERVICO',
      motivo: 'invalido',
    });
  });

  it('string vazia conta como ausente', () => {
    const cfg = parseNfseConfig({ NFSE_CTRIB_NAC: '', NFSE_CERT_PATH: '' });
    expect(cfg.cTribNac.origem).toBe('default');
    expect(cfg.certificado).toBeNull();
  });

  describe('certificado', () => {
    it('base64: fonte base64, bytes decodificados sob demanda', () => {
      const cfg = parseNfseConfig({ NFSE_CERT_BASE64: PFX_B64, NFSE_CERT_PASSWORD: SENHA });
      expect(cfg.certificado?.fonte).toBe('base64');
      expect(cfg.certificado?.lerPfx().toString()).toBe('nao-e-um-pfx-de-verdade');
      expect(cfg.certificado?.senha()).toBe(SENHA);
    });

    it('senha é usada como está (espaços nas pontas fazem parte dela)', () => {
      const cfg = parseNfseConfig({
        NFSE_CERT_BASE64: PFX_B64,
        NFSE_CERT_PASSWORD: ' com espaço ',
      });
      expect(cfg.certificado?.senha()).toBe(' com espaço ');
    });

    it('senha só de espaços também é usada como está', () => {
      const cfg = parseNfseConfig({ NFSE_CERT_BASE64: PFX_B64, NFSE_CERT_PASSWORD: '   ' });
      expect(cfg.certificado?.senha()).toBe('   ');
    });

    it('caminho: fonte caminho (arquivo só é lido em lerPfx)', () => {
      const cfg = parseNfseConfig({ NFSE_CERT_PATH: '/nao/existe.pfx' });
      expect(cfg.certificado?.fonte).toBe('caminho');
      expect(cfg.certificado?.senha()).toBe('');
      expect(() => cfg.certificado?.lerPfx()).toThrow('nfse_certificado_ilegivel');
    });

    it('caminho E base64 ao mesmo tempo é ambíguo: sem certificado + problema', () => {
      const cfg = parseNfseConfig({ NFSE_CERT_PATH: '/x.pfx', NFSE_CERT_BASE64: PFX_B64 });
      expect(cfg.certificado).toBeNull();
      expect(cfg.problemas).toContainEqual({ variavel: 'NFSE_CERT_PATH', motivo: 'invalido' });
    });

    it('senha e PFX não vazam em JSON, inspect, String ou chaves enumeráveis', () => {
      const cfg = parseNfseConfig({
        NFSE_PRESTADOR_CNPJ: CNPJ,
        NFSE_CERT_BASE64: PFX_B64,
        NFSE_CERT_PASSWORD: SENHA,
      });
      const vistas = [
        JSON.stringify(cfg),
        inspect(cfg, { depth: 10, showHidden: true }),
        String(cfg.certificado),
        JSON.stringify(Object.entries(cfg.certificado ?? {})),
      ];
      for (const vista of vistas) {
        expect(vista).not.toContain(SENHA);
        expect(vista).not.toContain(PFX_B64);
      }
    });
  });
});

describe('descrição: limite de 2000 (TSDesc2000) DEPOIS de expandir {competencia}', () => {
  // Rótulo mais longo possível: "fevereiro/2026" (14). O template precisa caber com ele.
  it('2000 caracteres após expansão é aceito', () => {
    const cfg = parseNfseConfig({ NFSE_DESCRICAO_SERVICO: `${'a'.repeat(1986)}{competencia}` });
    expect(cfg.descricaoServico.origem).toBe('env');
    expect(descricaoDoServico(cfg.descricaoServico.valor, 'fevereiro/2026')).toHaveLength(2000);
  });

  it('2001 após expansão é inválido e cai no default', () => {
    const cfg = parseNfseConfig({ NFSE_DESCRICAO_SERVICO: `${'a'.repeat(1987)}{competencia}` });
    expect(cfg.descricaoServico.origem).toBe('default');
    expect(cfg.problemas).toContainEqual({
      variavel: 'NFSE_DESCRICAO_SERVICO',
      motivo: 'invalido',
    });
  });

  it('muitos {competencia} que estouram só depois de expandir são inválidos', () => {
    const cfg = parseNfseConfig({ NFSE_DESCRICAO_SERVICO: '{competencia}'.repeat(146) });
    expect(cfg.descricaoServico.origem).toBe('default');
    expect(cfg.problemas).toContainEqual({
      variavel: 'NFSE_DESCRICAO_SERVICO',
      motivo: 'invalido',
    });
  });
});

describe('descricaoDoServico', () => {
  it('substitui {competencia} pelo rótulo do mês', () => {
    expect(descricaoDoServico('Comissão - {competencia}.', 'setembro/2026')).toBe(
      'Comissão - setembro/2026.',
    );
  });

  it('o default menciona intermediação e a competência, e cabe no Latin-1', () => {
    const cfg = parseNfseConfig({});
    const texto = descricaoDoServico(cfg.descricaoServico.valor, 'março/2026');
    expect(texto).toContain('março/2026');
    expect(texto.toLowerCase()).toContain('intermediação');
    expect(/^[ -ÿ]+$/.test(texto)).toBe(true);
  });
});
