import { describe, expect, it } from 'vitest';
import {
  agregarDias,
  barraEmpilhada,
  type DiaPainel,
  faixaKpiMes,
  faixaKpiSemana,
  formatCompacto,
  gradePainel,
  nomeMes,
  notaSemana,
  rotuloMesCurto,
  rotuloSemana,
} from '../../../apps/eunenem-server/pages/lib/receitaPainel.js';

/**
 * aperture-zn5cm — painel Receita 1b (módulo puro, sem banco e sem relógio).
 *
 * Fixa a grade do painel em America/Sao_Paulo (12 meses, semanas de seg a dom
 * recortadas ao mês atual, KPIs com semanas inteiras), a soma dos dias em
 * buckets e os rótulos e escalas que a tela desenha.
 */

describe('gradePainel', () => {
  it('segunda 05/10/2026: mês até hoje, semanas inteiras nos KPIs e recortadas nas barras', () => {
    const g = gradePainel('2026-10-05');
    expect(g.kpis).toEqual({
      mesAtual: { de: '2026-10-01', ate: '2026-10-06' },
      mesAnterior: { de: '2026-09-01', ate: '2026-10-01' },
      semanaAtual: { de: '2026-10-05', ate: '2026-10-12' },
      semanaAnterior: { de: '2026-09-28', ate: '2026-10-05' },
    });
    expect(g.semanas).toEqual([
      { de: '2026-10-01', ate: '2026-10-05', estado: 'passada' },
      { de: '2026-10-05', ate: '2026-10-12', estado: 'atual' },
      { de: '2026-10-12', ate: '2026-10-19', estado: 'futura' },
      { de: '2026-10-19', ate: '2026-10-26', estado: 'futura' },
      { de: '2026-10-26', ate: '2026-11-01', estado: 'futura' },
    ]);
    expect(g.meses).toHaveLength(12);
    expect(g.meses[0]).toEqual({ de: '2025-11-01', ate: '2025-12-01', parcial: false });
    expect(g.meses[11]).toEqual({ de: '2026-10-01', ate: '2026-11-01', parcial: true });
    expect(g.meses.filter((m) => m.parcial)).toHaveLength(1);
    expect(g.janela).toEqual({ de: '2025-11-01', ate: '2026-11-01' });
  });

  it('domingo 01/03/2026: a semana atual começa em fevereiro', () => {
    const g = gradePainel('2026-03-01');
    expect(g.kpis.semanaAtual).toEqual({ de: '2026-02-23', ate: '2026-03-02' });
    expect(g.kpis.semanaAnterior).toEqual({ de: '2026-02-16', ate: '2026-02-23' });
    expect(g.kpis.mesAnterior).toEqual({ de: '2026-02-01', ate: '2026-03-01' });
    expect(g.semanas[0]).toEqual({ de: '2026-03-01', ate: '2026-03-02', estado: 'atual' });
    expect(g.semanas.at(-1)).toEqual({ de: '2026-03-30', ate: '2026-04-01', estado: 'futura' });
    expect(g.meses[0]?.de).toBe('2025-04-01');
  });

  it('segunda 30/11/2026: a semana atual atravessa para dezembro e alarga a janela', () => {
    const g = gradePainel('2026-11-30');
    expect(g.semanas.map((s) => [s.de, s.ate, s.estado])).toEqual([
      ['2026-11-01', '2026-11-02', 'passada'],
      ['2026-11-02', '2026-11-09', 'passada'],
      ['2026-11-09', '2026-11-16', 'passada'],
      ['2026-11-16', '2026-11-23', 'passada'],
      ['2026-11-23', '2026-11-30', 'passada'],
      ['2026-11-30', '2026-12-01', 'atual'],
    ]);
    expect(g.kpis.semanaAtual).toEqual({ de: '2026-11-30', ate: '2026-12-07' });
    expect(g.janela).toEqual({ de: '2025-12-01', ate: '2026-12-07' });
  });

  it('virada de ano: janeiro compara com dezembro do ano anterior', () => {
    const g = gradePainel('2027-01-02');
    expect(g.kpis.mesAnterior).toEqual({ de: '2026-12-01', ate: '2027-01-01' });
    expect(g.kpis.semanaAtual).toEqual({ de: '2026-12-28', ate: '2027-01-04' });
    expect(g.meses[0]?.de).toBe('2026-02-01');
  });

  it('rejeita data inválida', () => {
    expect(() => gradePainel('2026-02-30')).toThrow();
  });
});

function dia(d: string, tarifas: [number, number], recebido: [number, number]): DiaPainel {
  return {
    dia: d,
    tarifas: { registradoCents: tarifas[0], canceladoCents: tarifas[1] },
    recebido: { registradoCents: recebido[0], canceladoCents: recebido[1] },
  };
}

describe('agregarDias', () => {
  const grade = gradePainel('2026-10-05');

  it('soma cada dia em todos os buckets que o contêm e calcula o resultado', () => {
    const r = agregarDias(grade, [
      dia('2026-09-28', [100, 0], [2000, 0]), // set + semana anterior
      dia('2026-10-04', [300, 50], [6000, 1000]), // out + semana anterior + barra 01–04
      dia('2026-10-05', [700, 0], [14000, 0]), // out + semana atual
      dia('2025-11-15', [10, 10], [200, 200]), // primeiro mês
    ]);
    expect(r.kpis.mesAtual.tarifas).toEqual({
      registradoCents: 1000,
      canceladoCents: 50,
      resultadoCents: 950,
    });
    expect(r.kpis.mesAtual.recebido.resultadoCents).toBe(19000);
    expect(r.kpis.mesAnterior.tarifas.resultadoCents).toBe(100);
    expect(r.kpis.semanaAnterior.tarifas.resultadoCents).toBe(350);
    expect(r.kpis.semanaAnterior.recebido.resultadoCents).toBe(7000);
    expect(r.kpis.semanaAtual.recebido.resultadoCents).toBe(14000);
    expect(r.semanas[0]?.tarifas.resultadoCents).toBe(250);
    expect(r.semanas[1]?.tarifas.resultadoCents).toBe(700);
    expect(r.semanas[2]?.tarifas.resultadoCents).toBe(0);
    expect(r.meses[0]?.recebido).toEqual({
      registradoCents: 200,
      canceladoCents: 200,
      resultadoCents: 0,
    });
    expect(r.meses[10]?.tarifas.resultadoCents).toBe(100);
    expect(r.meses[11]?.tarifas.resultadoCents).toBe(950);
    expect(r.somaDosDias).toEqual({
      tarifas: { registradoCents: 1110, canceladoCents: 60 },
      recebido: { registradoCents: 22200, canceladoCents: 1200 },
    });
  });

  it('resultado pode ser negativo (mais cancelamento que registro no bucket)', () => {
    const r = agregarDias(grade, [dia('2026-10-02', [0, 500], [0, 10000])]);
    expect(r.kpis.mesAtual.tarifas.resultadoCents).toBe(-500);
    expect(r.semanas[0]?.recebido.resultadoCents).toBe(-10000);
  });

  it('falha alto quando um dia fica fora da janela', () => {
    expect(() => agregarDias(grade, [dia('2025-10-31', [1, 0], [1, 0])])).toThrow(
      'receita_painel_dia_fora_da_janela',
    );
    expect(() => agregarDias(grade, [dia('2026-11-01', [1, 0], [1, 0])])).toThrow(
      'receita_painel_dia_fora_da_janela',
    );
  });
});

describe('barraEmpilhada (escala única do Recebido; Tarifas são a fatia de baixo)', () => {
  it('a altura é proporcional ao Recebido: o maior chega à escala', () => {
    expect(barraEmpilhada(500, 10_000, 10_000, 84)).toEqual({ total: 84, tarifas: 5 });
    expect(barraEmpilhada(400, 5_000, 10_000, 84)).toEqual({ total: 42, tarifas: 8 });
  });

  it('a fatia é Tarifas/Recebido, não a escala própria das tarifas', () => {
    // Tarifas ~8% em todos os meses: a fatia é 8% da barra, nunca 100%.
    const a = barraEmpilhada(800, 10_000, 10_000, 84);
    const b = barraEmpilhada(80, 1_000, 10_000, 84);
    expect(a.tarifas).toBeCloseTo(8);
    expect(b.tarifas).toBeCloseTo(8);
    expect(b.total).toBeCloseTo(a.total / 10);
  });

  it('Recebido zero ou negativo (estornos) vira barra vazia', () => {
    expect(barraEmpilhada(300, 0, 10_000, 84)).toEqual({ total: 0, tarifas: 0 });
    expect(barraEmpilhada(-300, -5_000, 10_000, 84)).toEqual({ total: 0, tarifas: 0 });
  });

  it('Tarifas acima do Recebido enchem a barra, sem passar de 100%', () => {
    expect(barraEmpilhada(900, 600, 10_000, 84)).toEqual({ total: 5.04, tarifas: 100 });
  });

  it('Tarifas negativas não viram fatia negativa', () => {
    expect(barraEmpilhada(-200, 5_000, 10_000, 84)).toEqual({ total: 42, tarifas: 0 });
  });

  it('máximo zero ou negativo não divide por zero', () => {
    expect(barraEmpilhada(0, 0, 0, 76)).toEqual({ total: 0, tarifas: 0 });
    expect(barraEmpilhada(10, 100, -5, 76)).toEqual({ total: 0, tarifas: 0 });
  });
});

describe('formatação', () => {
  it('formatCompacto: mil com uma casa, abaixo disso inteiro', () => {
    expect(formatCompacto(341200)).toBe('R$ 3,4 mil');
    expect(formatCompacto(100000)).toBe('R$ 1 mil');
    expect(formatCompacto(51200)).toBe('R$ 512');
    expect(formatCompacto(0)).toBe('R$ 0');
    expect(formatCompacto(123456789)).toBe('R$ 1.234,6 mil');
    expect(formatCompacto(-51200)).toBe('-R$ 512');
    expect(formatCompacto(-341200)).toBe('-R$ 3,4 mil');
  });

  it('rótulos de semana', () => {
    expect(rotuloSemana({ de: '2026-10-05', ate: '2026-10-12' })).toBe('05–11/10');
    expect(rotuloSemana({ de: '2026-10-01', ate: '2026-10-05' })).toBe('01–04/10');
    expect(rotuloSemana({ de: '2026-09-28', ate: '2026-10-05' })).toBe('28/09–04/10');
    expect(rotuloSemana({ de: '2026-11-01', ate: '2026-11-02' })).toBe('01/11');
  });

  it('faixas dos KPIs', () => {
    expect(faixaKpiMes({ de: '2026-10-01', ate: '2026-10-06' })).toBe('01/10 – 05/10');
    expect(faixaKpiMes({ de: '2026-10-01', ate: '2026-10-02' })).toBe('01/10');
    expect(faixaKpiSemana({ de: '2026-10-05', ate: '2026-10-12' })).toBe('05 – 11/10');
    expect(faixaKpiSemana({ de: '2026-09-28', ate: '2026-10-05' })).toBe('28/09 – 04/10');
    expect(faixaKpiSemana({ de: '2026-12-28', ate: '2027-01-04' })).toBe('28/12 – 03/01');
  });

  it('nota da semana: atual, recorte passado do mês ou nada', () => {
    expect(notaSemana({ de: '2026-10-05', ate: '2026-10-12', estado: 'atual' })).toBe(
      'esta semana',
    );
    expect(notaSemana({ de: '2026-10-01', ate: '2026-10-05', estado: 'passada' })).toBe(
      'qui a dom',
    );
    expect(notaSemana({ de: '2026-11-01', ate: '2026-11-02', estado: 'passada' })).toBe('dom');
    expect(notaSemana({ de: '2026-10-12', ate: '2026-10-19', estado: 'passada' })).toBe('');
    expect(notaSemana({ de: '2026-10-26', ate: '2026-11-01', estado: 'futura' })).toBe('');
  });

  it('meses', () => {
    expect(nomeMes('2026-09-01')).toBe('setembro');
    expect(nomeMes('2026-03-01')).toBe('março');
    expect(rotuloMesCurto('2025-11-01')).toBe('nov/25');
  });
});
