import { describe, expect, it } from 'vitest';
import { parseNfseConfig } from '../../../apps/eunenem-server/server/nfse/config.js';
import {
  MesFuturoError,
  montarPreviaDps,
  situacaoDoMes,
} from '../../../apps/eunenem-server/server/nfse/previa-mensal.js';

/**
 * aperture-dh1k7 — montagem da prévia (pura): decide sem_valor /
 * config_incompleta / gerada e produz a tabela de campos com "a confirmar".
 * Leitura do ledger e assinatura real ficam nos testes de fronteira.
 */

const NOW = new Date('2026-10-05T17:30:00Z'); // 14:30 em SP
const ENV_MINIMO = { NFSE_PRESTADOR_CNPJ: '11222333000181', NFSE_MUNICIPIO_IBGE: '2611606' };

describe('situacaoDoMes', () => {
  it('mês passado', () => {
    expect(situacaoDoMes('2026-09', NOW)).toBe('fechado');
  });
  it('mês corrente em SP é "em_andamento"', () => {
    expect(situacaoDoMes('2026-10', NOW)).toBe('em_andamento');
  });
  it('usa o mês de SP, não o de UTC (01/11 01:00Z ainda é outubro em SP)', () => {
    expect(situacaoDoMes('2026-10', new Date('2026-11-01T01:00:00Z'))).toBe('em_andamento');
    expect(() => situacaoDoMes('2026-11', new Date('2026-11-01T01:00:00Z'))).toThrow(
      MesFuturoError,
    );
  });
  it('mês futuro lança MesFuturoError', () => {
    expect(() => situacaoDoMes('2026-11', NOW)).toThrow(MesFuturoError);
    expect(() => situacaoDoMes('2027-01', NOW)).toThrow(MesFuturoError);
  });
});

describe('montarPreviaDps', () => {
  it.each([0, -500])('resultado %i → sem_valor, sem DPS', (resultadoCents) => {
    const previa = montarPreviaDps({
      mes: '2026-09',
      resultadoCents,
      config: parseNfseConfig(ENV_MINIMO),
      now: NOW,
    });
    expect(previa).toEqual({ status: 'sem_valor' });
  });

  it('sem CNPJ/município → config_incompleta listando só as variáveis que bloqueiam', () => {
    const previa = montarPreviaDps({
      mes: '2026-09',
      resultadoCents: 100,
      config: parseNfseConfig({ NFSE_MUNICIPIO_IBGE: '2611606', NFSE_TP_RET_ISSQN: '9' }),
      now: NOW,
    });
    expect(previa).toEqual({ status: 'config_incompleta', faltando: ['NFSE_PRESTADOR_CNPJ'] });
  });

  it('gerada: XML, Id, valor formatado; série/número de prévia', () => {
    const previa = montarPreviaDps({
      mes: '2026-09',
      resultadoCents: 123456,
      config: parseNfseConfig(ENV_MINIMO),
      now: NOW,
    });
    if (previa.status !== 'gerada') throw new Error(previa.status);
    expect(previa.idDps).toBe('DPS2611606211222333000181999990' + '20260999999999');
    expect(previa.valorServico).toBe('1234.56');
    expect(previa.xml).toContain(
      '<serie>99999</serie><nDPS>20260999999999</nDPS><dCompet>2026-09-01</dCompet>',
    );
    expect(previa.xml).toContain('<dhEmi>2026-10-05T14:30:00-03:00</dhEmi>');
    expect(previa.xml).toContain('<vServ>1234.56</vServ>');
    expect(previa.xml).toContain('competência setembro/2026');
    expect(previa.xml).not.toContain('<toma>');
  });

  it('campos: valor vem do ledger e não é "a confirmar"; defaults fiscais são', () => {
    const previa = montarPreviaDps({
      mes: '2026-09',
      resultadoCents: 500,
      config: parseNfseConfig(ENV_MINIMO),
      now: NOW,
    });
    if (previa.status !== 'gerada') throw new Error(previa.status);
    const por = (tag: string) => {
      const c = previa.campos.find((campo) => campo.tag === tag);
      if (!c) throw new Error(`campo ausente: ${tag}`);
      return c;
    };
    expect(por('vServ')).toMatchObject({ valor: '5.00', origem: 'ledger', aConfirmar: false });
    expect(por('CNPJ')).toMatchObject({
      valor: '11222333000181',
      origem: 'env',
      aConfirmar: false,
    });
    expect(por('cLocEmi')).toMatchObject({ valor: '2611606', origem: 'env', aConfirmar: false });
    expect(por('cTribNac')).toMatchObject({ valor: '100501', origem: 'default', aConfirmar: true });
    expect(por('opSimpNac')).toMatchObject({ origem: 'default', aConfirmar: true });
    expect(por('tribISSQN')).toMatchObject({ origem: 'default', aConfirmar: true });
    expect(por('tpRetISSQN')).toMatchObject({ origem: 'default', aConfirmar: true });
    expect(por('xDescServ')).toMatchObject({ origem: 'default', aConfirmar: true });
    expect(por('tpAmb')).toMatchObject({ valor: '2', origem: 'default', aConfirmar: true });
    expect(por('dCompet')).toMatchObject({
      valor: '2026-09-01',
      origem: 'derivado',
      aConfirmar: true,
    });
    expect(por('toma')).toMatchObject({ origem: 'fixo', aConfirmar: true });
    expect(por('serie')).toMatchObject({ valor: '99999', origem: 'fixo', aConfirmar: false });
    for (const campo of previa.campos) {
      expect(campo.rotulo.length).toBeGreaterThan(0);
      expect(campo.grupo.length).toBeGreaterThan(0);
    }
  });

  it('valores explícitos no env deixam de ser "a confirmar"', () => {
    const previa = montarPreviaDps({
      mes: '2026-09',
      resultadoCents: 500,
      config: parseNfseConfig({ ...ENV_MINIMO, NFSE_CTRIB_NAC: '100202', NFSE_OP_SIMP_NAC: '3' }),
      now: NOW,
    });
    if (previa.status !== 'gerada') throw new Error(previa.status);
    expect(previa.campos.find((c) => c.tag === 'cTribNac')).toMatchObject({
      valor: '100202',
      origem: 'env',
      aConfirmar: false,
    });
    expect(previa.campos.find((c) => c.tag === 'opSimpNac')).toMatchObject({
      valor: '3',
      aConfirmar: false,
    });
  });

  it('nada na saída carrega a senha do certificado', () => {
    const senha = 'senha-que-nao-pode-vazar';
    const previa = montarPreviaDps({
      mes: '2026-09',
      resultadoCents: 500,
      config: parseNfseConfig({
        ...ENV_MINIMO,
        NFSE_CERT_BASE64: 'AAAA',
        NFSE_CERT_PASSWORD: senha,
      }),
      now: NOW,
    });
    expect(JSON.stringify(previa)).not.toContain(senha);
  });
});
