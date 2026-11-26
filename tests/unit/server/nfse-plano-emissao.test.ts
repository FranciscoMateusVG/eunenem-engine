import { describe, expect, it } from 'vitest';
import { parseNfseConfig } from '../../../apps/eunenem-server/server/nfse/config.js';
import {
  bloquearCompetenciaComPendencias,
  montarPlanoEmissao,
  pisoDaCompetencia,
} from '../../../apps/eunenem-server/server/nfse/plano-emissao.js';
import type { PreviaMensal } from '../../../apps/eunenem-server/server/nfse/previa-mensal.js';

/**
 * aperture-wp6j6 — plano de emissão (puro). A estratégia de agrupamento e a
 * política de pendências são parâmetros: trocá-las não mexe no resto.
 */

const CONFIG_ENV = {
  NFSE_PRESTADOR_CNPJ: '11222333000181',
  NFSE_MUNICIPIO_IBGE: '3106200',
  NFSE_CERT_BASE64: 'AAAA',
  // Leiaute de produção nos testes gerais; o RTC tem bloco próprio abaixo.
  NFSE_LEIAUTE_DPS: 'producao-2026-02',
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
      {
        cpf: '52998224725',
        nome: 'Ana',
        resultadoCents: 100,
        houveTroca: false,
        campanhas: ['c1'],
        dps: assinada,
      },
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
    expect(p.notas).toEqual([
      { tomadorCpf: '52998224725', tomadorNome: 'Ana', valorCents: 100, campanhas: ['c1'] },
    ]);
    expect(p.quantidade).toBe(1);
    expect(p.totalCents).toBe(100);
    expect(p.bloqueios).toEqual([]);
  });

  it('pendência é pulada e listada (padrão); a política alternativa bloqueia', () => {
    const comPendencia = previa({
      pendencias: [{ campanhaId: 'c9', motivo: 'cpf_ausente_ou_invalido', resultadoCents: 300 }],
    });
    const p = montarPlanoEmissao({ previa: comPendencia, config: CONFIG });
    expect(p.bloqueios).toEqual([]);
    expect(p.notas).toHaveLength(1);
    expect(p.puladas).toEqual([
      { referencia: 'c9', motivo: 'cpf_ausente_ou_invalido', valorCents: 300 },
    ]);
    expect(
      montarPlanoEmissao({
        previa: comPendencia,
        config: CONFIG,
        pendencias: bloquearCompetenciaComPendencias,
      }).bloqueios,
    ).toEqual(['pendencias_de_tomador']);
  });

  it('pendência resolvida depois entra como nota nova; campanha já gravada sob outro CPF diverge', () => {
    const gravada = {
      id: 'r1',
      tomadorCpf: '11144477735',
      tomadorNome: 'Bruno',
      valorCents: 50,
      campanhas: ['c2'],
      serie: '00001',
      status: 'autorizada' as const,
    };
    const agora = () => [
      { tomadorCpf: '11144477735', tomadorNome: 'Bruno', valorCents: 50, campanhas: ['c2'] },
      { tomadorCpf: '52998224725', tomadorNome: 'Ana', valorCents: 100, campanhas: ['c1'] },
    ];
    const ok = montarPlanoEmissao({
      previa: previa(),
      config: CONFIG,
      fixadas: [gravada],
      agrupar: agora,
    });
    expect(ok.bloqueios).toEqual([]);
    expect(ok.notas.map((n) => n.tomadorCpf)).toEqual(['52998224725']);
    const trocado = () => [
      { tomadorCpf: '39053344705', tomadorNome: 'C', valorCents: 50, campanhas: ['c2'] },
    ];
    expect(
      montarPlanoEmissao({ previa: previa(), config: CONFIG, fixadas: [gravada], agrupar: trocado })
        .bloqueios,
    ).toContain('competencia_divergente');
  });

  it('piso 2026-11 vale SÓ em produção: outubro/2026 bloqueado mesmo com NFSE_COMPETENCIA_MINIMA menor', () => {
    const prod = (extra: Record<string, string> = {}) =>
      parseNfseConfig({
        ...CONFIG_ENV,
        NFSE_AMBIENTE: '1',
        NFSE_EMISSAO_PRODUCAO: 'liberada',
        ...extra,
      });
    const out = previa({ mes: '2026-10' });
    expect(montarPlanoEmissao({ previa: out, config: prod() }).bloqueios).toContain(
      'competencia_anterior_ao_inicio',
    );
    expect(
      montarPlanoEmissao({ previa: out, config: prod({ NFSE_COMPETENCIA_MINIMA: '2025-01' }) })
        .bloqueios,
    ).toContain('competencia_anterior_ao_inicio');
    expect(
      montarPlanoEmissao({ previa: previa({ mes: '2026-11' }), config: prod() }).bloqueios,
    ).toEqual([]);
  });

  it('homologação: qualquer mês fechado, inclusive outubro/2026 e antes (smoke)', () => {
    for (const mes of ['2026-10', '2025-03']) {
      expect(
        montarPlanoEmissao({ previa: previa({ mes }), config: CONFIG }).bloqueios,
        mes,
      ).toEqual([]);
    }
    const comPiso = parseNfseConfig({ ...CONFIG_ENV, NFSE_COMPETENCIA_MINIMA: '2033-01' });
    expect(
      montarPlanoEmissao({ previa: previa({ mes: '2026-10' }), config: comPiso }).bloqueios,
    ).toEqual([]);
  });

  it('estratégia injetada (ex.: consolidada) troca as notas sem mexer nos bloqueios', () => {
    const consolidada = () => [
      {
        tomadorCpf: '00000000000',
        tomadorNome: 'consolidada',
        valorCents: 999,
        campanhas: ['c1', 'c2'],
      },
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

describe('competência fixada e impressão', () => {
  const fixadaA = {
    tomadorCpf: '52998224725',
    tomadorNome: 'Ana',
    valorCents: 100,
    campanhas: ['c1'],
  };

  it('igual ao fixado: sem bloqueio; só reenvia o que não foi autorizado', () => {
    const p = montarPlanoEmissao({
      previa: previa(),
      config: CONFIG,
      fixadas: [{ ...fixadaA, id: 'r1', serie: '00001', status: 'autorizada' }],
    });
    expect(p.fixada).toBe(true);
    expect(p.bloqueios).toEqual([]);
    expect(p.notas).toEqual([]);
  });

  it('mesma receita sob outro CPF (recebedor trocado): competencia_divergente', () => {
    const p = montarPlanoEmissao({
      previa: previa(),
      config: CONFIG,
      fixadas: [
        { ...fixadaA, id: 'r1', serie: '00001', tomadorCpf: '39053344705', status: 'autorizada' },
      ],
    });
    expect(p.bloqueios).toContain('competencia_divergente');
    expect(p.divergencias).toHaveLength(2);
  });

  it('a impressão muda com ambiente, série, valores, campanhas e campos fiscais', () => {
    const base = montarPlanoEmissao({ previa: previa(), config: CONFIG }).impressao;
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(montarPlanoEmissao({ previa: previa(), config: CONFIG }).impressao).toBe(base);
    const variantes = [
      montarPlanoEmissao({
        previa: previa(),
        config: parseNfseConfig({ ...CONFIG_ENV, NFSE_AMBIENTE: '1' }),
      }),
      montarPlanoEmissao({
        previa: previa(),
        config: parseNfseConfig({ ...CONFIG_ENV, NFSE_SERIE: '00002' }),
      }),
      montarPlanoEmissao({
        previa: previa(),
        config: CONFIG,
        agrupar: () => [{ ...fixadaA, valorCents: 101 }],
      }),
      montarPlanoEmissao({
        previa: previa(),
        config: CONFIG,
        agrupar: () => [{ ...fixadaA, campanhas: ['c9'] }],
      }),
      montarPlanoEmissao({
        previa: previa(),
        config: CONFIG,
        agrupar: () => [{ ...fixadaA, tomadorCpf: '39053344705' }],
      }),
    ];
    for (const v of variantes) expect(v.impressao).not.toBe(base);
  });
});

describe('série reservada × configurada', () => {
  it('NFSE_SERIE mudou depois da fixação: bloqueia (serie_divergente)', () => {
    const fixada = {
      id: 'r1',
      tomadorCpf: '52998224725',
      tomadorNome: 'Ana',
      valorCents: 100,
      campanhas: ['c1'],
      serie: '00001',
      status: 'rejeitada' as const,
    };
    const mudou = parseNfseConfig({ ...CONFIG_ENV, NFSE_SERIE: '00002' });
    expect(
      montarPlanoEmissao({ previa: previa(), config: mudou, fixadas: [fixada] }).bloqueios,
    ).toContain('serie_divergente');
    expect(
      montarPlanoEmissao({ previa: previa(), config: CONFIG, fixadas: [fixada] }).bloqueios,
    ).not.toContain('serie_divergente');
  });
});

describe('leiaute RTC: endereço do tomador obrigatório (E0239 na produção restrita)', () => {
  const RTC = parseNfseConfig({ ...CONFIG_ENV, NFSE_LEIAUTE_DPS: 'rtc-2026-11' });
  const RTC_NBS = parseNfseConfig({
    ...CONFIG_ENV,
    NFSE_LEIAUTE_DPS: 'rtc-2026-11',
    NFSE_CNBS: '109059000',
  });
  const endereco = {
    cMun: '3106200',
    cep: '30130003',
    logradouro: 'Av. Afonso Pena',
    numero: '1212',
    bairro: 'Centro',
  };

  it('sem endereço: nota PULADA com motivo sem_endereco (não vai para a Receita)', () => {
    const p = montarPlanoEmissao({ previa: previa(), config: RTC_NBS });
    expect(p.notas).toEqual([]);
    expect(p.puladas).toEqual([{ referencia: 'c1', motivo: 'sem_endereco', valorCents: 100 }]);
    expect(p.bloqueios).toEqual(['sem_notas']);
  });

  it('com endereço: emite normalmente', () => {
    const comEndereco = previa();
    (comEndereco.notas[0] as { endereco: unknown }).endereco = endereco;
    const p = montarPlanoEmissao({ previa: comEndereco, config: RTC_NBS });
    expect(p.notas.map((n) => n.tomadorCpf)).toEqual(['52998224725']);
    expect(p.puladas).toEqual([]);
    expect(p.bloqueios).toEqual([]);
  });

  it('sem NFSE_CNBS o leiaute RTC bloqueia (E0322: NBS obrigatória com IBS/CBS)', () => {
    const comEndereco = previa();
    (comEndereco.notas[0] as { endereco: unknown }).endereco = endereco;
    expect(montarPlanoEmissao({ previa: comEndereco, config: RTC }).bloqueios).toContain(
      'cnbs_obrigatorio',
    );
    const comNbs = parseNfseConfig({
      ...CONFIG_ENV,
      NFSE_LEIAUTE_DPS: 'rtc-2026-11',
      NFSE_CNBS: '109059000',
    });
    expect(montarPlanoEmissao({ previa: comEndereco, config: comNbs }).bloqueios).toEqual([]);
    expect(montarPlanoEmissao({ previa: previa(), config: CONFIG }).bloqueios).not.toContain(
      'cnbs_obrigatorio',
    );
  });

  it('leiaute de produção: sem endereço continua emitindo (só CPF e nome)', () => {
    expect(montarPlanoEmissao({ previa: previa(), config: CONFIG }).notas).toHaveLength(1);
  });
});

describe('pisoDaCompetencia — o que a tela usa para desligar "Emitir NFS-e"', () => {
  const prod = (extra: Record<string, string> = {}) =>
    parseNfseConfig({
      ...CONFIG_ENV,
      NFSE_AMBIENTE: '1',
      NFSE_EMISSAO_PRODUCAO: 'liberada',
      ...extra,
    });

  it('produção + 2026-10: abaixo do piso 2026-11', () => {
    expect(pisoDaCompetencia(prod(), '2026-10')).toEqual({
      competenciaMinima: '2026-11',
      rotuloMinima: 'novembro/2026',
      abaixoDoPiso: true,
    });
  });

  it('produção + 2026-11: no piso, emitível', () => {
    expect(pisoDaCompetencia(prod(), '2026-11')).toEqual({
      competenciaMinima: '2026-11',
      rotuloMinima: 'novembro/2026',
      abaixoDoPiso: false,
    });
  });

  it('produção: NFSE_COMPETENCIA_MINIMA só sobe o piso', () => {
    expect(
      pisoDaCompetencia(prod({ NFSE_COMPETENCIA_MINIMA: '2025-01' }), '2026-10').abaixoDoPiso,
    ).toBe(true);
    expect(pisoDaCompetencia(prod({ NFSE_COMPETENCIA_MINIMA: '2027-02' }), '2027-01')).toEqual({
      competenciaMinima: '2027-02',
      rotuloMinima: 'fevereiro/2027',
      abaixoDoPiso: true,
    });
  });

  it('homologação + 2026-10: sem piso', () => {
    expect(pisoDaCompetencia(CONFIG, '2026-10')).toEqual({
      competenciaMinima: null,
      rotuloMinima: null,
      abaixoDoPiso: false,
    });
  });

  it('é a mesma decisão do bloqueio competencia_anterior_ao_inicio do plano', () => {
    for (const config of [CONFIG, prod(), prod({ NFSE_COMPETENCIA_MINIMA: '2027-02' })]) {
      for (const mes of ['2025-03', '2026-10', '2026-11', '2027-01', '2027-02']) {
        const bloqueado = montarPlanoEmissao({
          previa: previa({ mes }),
          config,
        }).bloqueios.includes('competencia_anterior_ao_inicio');
        expect(pisoDaCompetencia(config, mes).abaixoDoPiso, `${config.ambiente.valor} ${mes}`).toBe(
          bloqueado,
        );
      }
    }
  });
});
