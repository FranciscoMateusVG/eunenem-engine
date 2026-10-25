import { expect, it } from 'vitest';
import {
  type DespesaManual,
  diasRecorrentesRateados,
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
    agregarLucro(r, d, '2026-09-01', '2026-10-05').semanas.find((s) => s.faltamCents !== undefined)
      ?.faltamCents,
  ).toBe(200);
});
