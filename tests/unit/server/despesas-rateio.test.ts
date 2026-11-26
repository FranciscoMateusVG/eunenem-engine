import { describe, expect, it } from 'vitest';
import {
  type DespesaManual,
  datasDeCobranca,
  descreverRecorrencia,
  diasManuais,
  diasRecorrentesRateados,
  valorDaCobranca,
} from '../../../apps/eunenem-server/pages/lib/despesasManuais.js';
import { agregarDespesas } from '../../../apps/eunenem-server/pages/lib/despesasPainel.js';
import { agregarLucro } from '../../../apps/eunenem-server/pages/lib/lucroPainel.js';
import { agregarDias, gradePainel } from '../../../apps/eunenem-server/pages/lib/receitaPainel.js';

function despesa(inicio: string): DespesaManual {
  return {
    id: 'fixture',
    nome: 'fixture',
    categoria: null,
    recorrencia: 'mensal',
    diaCobranca: 22,
    inicio,
    fim: null,
    data: null,
    valores: [{ vigenteDesde: inicio, valorCents: 10001 }],
  };
}
it.each([
  ['2026-02-01', '2026-03-01', 28],
  ['2028-02-01', '2028-03-01', 29],
  ['2026-10-01', '2026-11-01', 31],
] as const)('rateia %s com resto determinístico', (de, ate, n) => {
  const dias = diasRecorrentesRateados([despesa(de)], { de, ate });
  expect(dias).toHaveLength(n);
  expect(dias.reduce((s, d) => s + d.manualCents, 0)).toBe(10001);
  expect(dias[0]?.manualCents).toBe(Math.ceil(10001 / n));
  expect(dias.at(-1)?.manualCents).toBe(Math.floor(10001 / n));
  expect(dias.reduce((s, d) => s + d.ocorrencias, 0)).toBe(1);
});
it('início/fim no meio do mês limita pesos, sem perder centavos', () => {
  const d = { ...despesa('2026-10-15'), fim: '2026-10-25' };
  const dias = diasRecorrentesRateados([d], { de: '2026-10-01', ate: '2026-11-01' });
  expect(dias).toHaveLength(11);
  expect(dias.reduce((s, d) => s + d.manualCents, 0)).toBe(10001);
});
it('faltam desconta taxas de provedor antes de comparar com meta', () => {
  const grade = gradePainel('2026-10-05');
  const r = agregarDias(grade, [
    {
      dia: '2026-10-05',
      tarifas: { registradoCents: 1000, canceladoCents: 0 },
      recebido: { registradoCents: 1000, canceladoCents: 0 },
    },
  ]);
  const d = agregarDespesas(
    grade,
    [
      {
        dia: '2026-10-05',
        stripeCents: 200,
        interCents: 100,
        naoVinculadas: 0,
        naoVinculadasCents: 0,
      },
    ],
    [],
    [],
    [],
    [{ dia: '2026-10-05', manualCents: 900, ocorrencias: 0 }],
  );
  expect(
    agregarLucro(r, d, '2026-09-01', '2026-10-05').semanas.find((s) => s.de === '2026-10-05')
      ?.faltamCents,
  ).toBe(200);
});
it('avalia a mesma meta em semanas encerradas, atual parcial e futuras sem inventar resultado', () => {
  const grade = gradePainel('2026-10-20');
  const r = agregarDias(grade, []);
  const d = agregarDespesas(
    grade,
    [],
    [],
    [],
    [],
    [{ dia: '2026-10-05', manualCents: 500, ocorrencias: 0 }],
  );
  const semanas = agregarLucro(r, d, '2026-09-01', '2026-10-20').semanas;
  expect(semanas.find((s) => s.de === '2026-10-05')?.faltamCents).toBe(500);
  expect(semanas.find((s) => s.de === '2026-10-19')).toMatchObject({ parcial: true });
  expect(semanas.find((s) => s.de === '2026-10-26')?.faltamCents).toBeUndefined();
});

it('lucro positivo menor que a meta já a cobre; semana negativa não a cobre', () => {
  const grade = gradePainel('2026-10-30');
  const r = agregarDias(grade, [
    {
      dia: '2026-10-05',
      tarifas: { registradoCents: 137010, canceladoCents: 0 },
      recebido: { registradoCents: 137010, canceladoCents: 0 },
    },
  ]);
  const manuais = [
    { dia: '2026-10-05', manualCents: 99724, ocorrencias: 1 },
    { dia: '2026-10-12', manualCents: 500, ocorrencias: 1 },
  ];
  const d = agregarDespesas(
    grade,
    [
      {
        dia: '2026-10-05',
        stripeCents: 200,
        interCents: 100,
        naoVinculadas: 0,
        naoVinculadasCents: 0,
      },
    ],
    [],
    manuais,
    manuais,
    manuais,
  );
  const s = agregarLucro(r, d, '2026-09-01', '2026-10-30').semanas;
  expect(s.find((x) => x.de === '2026-10-05')).toMatchObject({
    valorCents: 36986,
    metaRecorrenteCents: 99724,
    faltamCents: 0,
  });
  expect(s.find((x) => x.de === '2026-10-12')).toMatchObject({
    valorCents: -500,
    faltamCents: 500,
  });
});

describe('9nmdo — periodicidade e correção de um mês', () => {
  const tri: DespesaManual = {
    ...despesa('2026-11-01'),
    diaCobranca: 5,
    intervaloMeses: 3,
    valores: [{ vigenteDesde: '2026-11-01', valorCents: 92_000 }],
  };

  it('cobra no mês do início e a cada N meses, atravessando o ano', () => {
    expect(datasDeCobranca(tri, { de: '2026-01-01', ate: '2027-12-01' })).toEqual([
      '2026-11-05',
      '2027-02-05',
      '2027-05-05',
      '2027-08-05',
      '2027-11-05',
    ]);
    expect(
      datasDeCobranca({ ...tri, intervaloMeses: 2 }, { de: '2027-01-01', ate: '2027-05-01' }),
    ).toEqual(['2027-01-05', '2027-03-05']);
  });

  it('rateio espalha a cobrança pelos N meses do ciclo, no centavo', () => {
    // nov+dez+jan = 30+31+31 = 92 dias → 1.000/dia.
    const ciclo = diasRecorrentesRateados([tri], { de: '2026-11-01', ate: '2027-02-01' });
    expect(ciclo).toHaveLength(92);
    expect(ciclo.reduce((s, d) => s + d.manualCents, 0)).toBe(92_000);
    expect(ciclo.every((d) => d.manualCents === 1_000)).toBe(true);
    expect(ciclo.reduce((s, d) => s + d.ocorrencias, 0)).toBe(1);
    // Janela no meio do ciclo: só dezembro, sem a cobrança (que foi em novembro).
    const dez = diasRecorrentesRateados([tri], { de: '2026-12-01', ate: '2027-01-01' });
    expect(dez.reduce((s, d) => s + d.manualCents, 0)).toBe(31_000);
    expect(dez.reduce((s, d) => s + d.ocorrencias, 0)).toBe(0);
    // cobrancasAte antes da cobrança: o ciclo ainda não conta.
    expect(
      diasRecorrentesRateados([tri], { de: '2026-12-01', ate: '2027-01-01' }, '2026-11-04'),
    ).toEqual([]);
  });

  it('correção substitui o valor só daquela cobrança; a mais recente vale', () => {
    const d: DespesaManual = {
      ...despesa('2026-08-01'),
      diaCobranca: 4,
      valores: [{ vigenteDesde: '2026-08-01', valorCents: 10_000 }],
      ajustes: [
        { competencia: '2026-09-04', valorCents: 12_500, nota: 'a' },
        { competencia: '2026-09-04', valorCents: 11_000, nota: 'b' },
      ],
    };
    expect(valorDaCobranca(d, '2026-08-04')).toBe(10_000);
    expect(valorDaCobranca(d, '2026-09-04')).toBe(11_000);
    expect(
      diasManuais([d], { de: '2026-08-01', ate: '2026-11-01' }).map((x) => x.manualCents),
    ).toEqual([10_000, 11_000, 10_000]);
    const set = diasRecorrentesRateados([d], { de: '2026-09-01', ate: '2026-10-01' });
    expect(set.reduce((s, x) => s + x.manualCents, 0)).toBe(11_000);
  });

  it('descreve a periodicidade', () => {
    const f = (x: string) => x;
    expect(descreverRecorrencia({ ...tri }, f)).toBe('trimestral · todo dia 5 · desde 2026-11-01');
    expect(descreverRecorrencia({ ...tri, intervaloMeses: 1 }, f)).toBe(
      'mensal · todo dia 5 · desde 2026-11-01',
    );
    expect(descreverRecorrencia({ ...tri, intervaloMeses: 5 }, f)).toBe(
      'a cada 5 meses · todo dia 5 · desde 2026-11-01',
    );
  });
});
