import { describe, expect, it } from 'vitest';
import { parseNfseConfig } from '../../../apps/eunenem-server/server/nfse/config.js';
import { montarPlanoEmissao } from '../../../apps/eunenem-server/server/nfse/plano-emissao.js';
import type { PreviaMensal } from '../../../apps/eunenem-server/server/nfse/previa-mensal.js';

/**
 * aperture-wp6j6 — plano de emissão (puro). A estratégia de agrupamento e a
 * política de pendências são parâmetros: trocá-las não mexe no resto.
 */

const CONFIG_ENV = {
  NFSE_PRESTADOR_CNPJ: '11222333000181',
  NFSE_MUNICIPIO_IBGE: '3106200',
  NFSE_CERT_BASE64: 'AAAA',
};
const CONFIG = parseNfseConfig(CONFIG_ENV);

const assinada = {
  status: 'gerada' as const,
  idDps: `DPS${'1'.repeat(42)}`,
  valorServico: '1.00',
  campos: [],
  xml: '<DPS/>',
  totTribPendente: false,
  assinatura: {
    status: 'assinada' as const,
    certificadoCnpj: '11222333000181',
    certificadoConfereComPrestador: true,
    certificadoValidoAte: new Date('2040-01-01'),
  },
};

function previa(overrides: Partial<PreviaMensal> = {}): PreviaMensal {
  return {
    mes: '2033-03',
    rotulo: 'março/2033',
    avisos: [],
    pendencias: [],
    notas: [
      { cpf: '52998224725', nome: 'Ana', resultadoCents: 100, houveTroca: false, dps: assinada },
      {
        cpf: '11144477735',
        nome: 'Bruno',
        resultadoCents: 0,
        houveTroca: false,
        dps: { status: 'sem_valor' },
      },
    ],
    ...overrides,
  } as PreviaMensal;
}

describe('montarPlanoEmissao', () => {
  it('por tomador: só notas com DPS gerada (valor positivo)', () => {
    const p = montarPlanoEmissao({ previa: previa(), config: CONFIG });
    expect(p.notas).toEqual([{ tomadorCpf: '52998224725', tomadorNome: 'Ana', valorCents: 100 }]);
    expect(p.quantidade).toBe(1);
    expect(p.totalCents).toBe(100);
    expect(p.bloqueios).toEqual([]);
  });

  it('pendência bloqueia a competência; política injetada pode liberar', () => {
    const comPendencia = previa({
      pendencias: [{ campanhaId: 'c1', motivo: 'cpf_ausente_ou_invalido', resultadoCents: 300 }],
    });
    expect(montarPlanoEmissao({ previa: comPendencia, config: CONFIG }).bloqueios).toEqual([
      'pendencias_de_tomador',
    ]);
    expect(
      montarPlanoEmissao({ previa: comPendencia, config: CONFIG, pendencias: () => [] }).bloqueios,
    ).toEqual([]);
  });

  it('estratégia injetada (ex.: consolidada) troca as notas sem mexer nos bloqueios', () => {
    const consolidada = () => [
      { tomadorCpf: '00000000000', tomadorNome: 'consolidada', valorCents: 999 },
    ];
    const p = montarPlanoEmissao({ previa: previa(), config: CONFIG, agrupar: consolidada });
    expect(p.notas).toHaveLength(1);
    expect(p.totalCents).toBe(999);
  });

  it('avisos da prévia que impedem a emissão viram bloqueio; os outros só aparecem', () => {
    const p = montarPlanoEmissao({
      previa: previa({
        avisos: ['mes_em_andamento', 'certificado_vencido', 'inconsistencias_no_periodo'],
      }),
      config: CONFIG,
    });
    expect(p.bloqueios).toEqual(
      expect.arrayContaining(['mes_em_andamento', 'certificado_vencido']),
    );
    expect(p.avisos).toEqual(['inconsistencias_no_periodo']);
  });

  it('produção sem NFSE_EMISSAO_PRODUCAO=liberada é bloqueada; com ela, não', () => {
    const prod = parseNfseConfig({ ...CONFIG_ENV, NFSE_AMBIENTE: '1' });
    expect(montarPlanoEmissao({ previa: previa(), config: prod }).bloqueios).toContain(
      'producao_nao_liberada',
    );
    const liberada = parseNfseConfig({
      ...CONFIG_ENV,
      NFSE_AMBIENTE: '1',
      NFSE_EMISSAO_PRODUCAO: 'liberada',
    });
    expect(montarPlanoEmissao({ previa: previa(), config: liberada }).bloqueios).toEqual([]);
  });

  it('sem notas positivas: bloqueado (nada a emitir)', () => {
    const p = montarPlanoEmissao({ previa: previa({ notas: [] }), config: CONFIG });
    expect(p.bloqueios).toContain('sem_notas');
  });
});
