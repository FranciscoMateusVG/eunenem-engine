import { describe, expect, it } from 'vitest';
import {
  addDays,
  bucketsDoPeriodo,
  isLocalDate,
  localDateInSaoPaulo,
  mesAtual,
  RECEITA_MAX_BUCKETS,
  semanaAtual,
  startOfIsoWeek,
} from '../../../apps/eunenem-server/pages/lib/receitaPeriodo.js';

/**
 * aperture-9bpre — período da aba Receita EuNeném (módulo puro).
 *
 * Servidor e página usam as MESMAS funções; este arquivo fixa onde um período
 * começa e termina em America/Sao_Paulo, sem banco e sem relógio real.
 */

describe('datas locais', () => {
  it('aceita só datas reais de calendário', () => {
    expect(isLocalDate('2031-02-28')).toBe(true);
    expect(isLocalDate('2032-02-29')).toBe(true); // bissexto
    expect(isLocalDate('2031-02-29')).toBe(false);
    expect(isLocalDate('2031-13-01')).toBe(false);
    expect(isLocalDate('2031-1-01')).toBe(false);
    expect(isLocalDate('31/01/2031')).toBe(false);
    expect(isLocalDate('')).toBe(false);
  });

  it('soma dias atravessando mês e ano', () => {
    expect(addDays('2031-01-31', 1)).toBe('2031-02-01');
    expect(addDays('2031-12-31', 1)).toBe('2032-01-01');
    expect(addDays('2031-03-01', -1)).toBe('2031-02-28');
  });

  it('a data local de São Paulo vem do fuso, não do UTC', () => {
    // 02:30Z ainda é o dia anterior em SP (UTC−3).
    expect(localDateInSaoPaulo(new Date('2031-03-01T02:30:00Z'))).toBe('2031-02-28');
    expect(localDateInSaoPaulo(new Date('2031-03-01T03:00:00Z'))).toBe('2031-03-01');
  });
});

describe('semana ISO e mês', () => {
  it('a semana começa na segunda-feira', () => {
    // 2031-03-03 é segunda-feira.
    expect(startOfIsoWeek('2031-03-03')).toBe('2031-03-03');
    expect(startOfIsoWeek('2031-03-09')).toBe('2031-03-03'); // domingo
    expect(startOfIsoWeek('2031-03-02')).toBe('2031-02-24'); // domingo anterior
  });

  it('semana e mês atuais seguem o relógio em São Paulo', () => {
    // Segunda 03/03 02:30Z = domingo 02/03 23:30 em SP.
    const limite = new Date('2031-03-03T02:30:00Z');
    expect(semanaAtual(limite)).toEqual({ de: '2031-02-24', ate: '2031-03-03' });
    expect(mesAtual(new Date('2031-03-01T02:30:00Z'))).toEqual({
      de: '2031-02-01',
      ate: '2031-03-01',
    });
    expect(mesAtual(new Date('2031-12-15T15:00:00Z'))).toEqual({
      de: '2031-12-01',
      ate: '2032-01-01',
    });
  });
});

describe('grade de intervalos', () => {
  it('cobre o período inteiro com intervalos contíguos e marca os parciais', () => {
    const grade = bucketsDoPeriodo({ de: '2031-01-15', ate: '2031-03-10', granularidade: 'mes' });
    expect(grade).toEqual({
      ok: true,
      buckets: [
        { inicio: '2031-01-01', fim: '2031-02-01', parcial: true },
        { inicio: '2031-02-01', fim: '2031-03-01', parcial: false },
        { inicio: '2031-03-01', fim: '2031-04-01', parcial: true },
      ],
    });
  });

  it('rejeita data inválida, intervalo vazio e excesso de intervalos', () => {
    expect(bucketsDoPeriodo({ de: '2031-02-30', ate: '2031-03-01', granularidade: 'mes' })).toEqual(
      { ok: false, erro: 'data_invalida' },
    );
    expect(bucketsDoPeriodo({ de: '2031-03-01', ate: '2031-03-01', granularidade: 'mes' })).toEqual(
      { ok: false, erro: 'intervalo_vazio' },
    );
    expect(bucketsDoPeriodo({ de: '2031-03-02', ate: '2031-03-01', granularidade: 'mes' })).toEqual(
      { ok: false, erro: 'intervalo_vazio' },
    );
    expect(
      bucketsDoPeriodo({ de: '2020-01-01', ate: '2031-03-01', granularidade: 'semana' }),
    ).toEqual({ ok: false, erro: 'buckets_demais' });
  });

  it('o limite de intervalos é inclusivo', () => {
    const de = '2031-01-06'; // segunda-feira
    const cabe = bucketsDoPeriodo({
      de,
      ate: addDays(de, 7 * RECEITA_MAX_BUCKETS),
      granularidade: 'semana',
    });
    expect(cabe.ok && cabe.buckets.length).toBe(RECEITA_MAX_BUCKETS);
    const naoCabe = bucketsDoPeriodo({
      de,
      ate: addDays(de, 7 * RECEITA_MAX_BUCKETS + 1),
      granularidade: 'semana',
    });
    expect(naoCabe).toEqual({ ok: false, erro: 'buckets_demais' });
  });
});
