import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { FunilSecao } from '../../../apps/eunenem-server/pages/components/eunenem/admin/estatisticas/FunilSecao.js';
import type {
  FunilData,
  VendasData,
} from '../../../apps/eunenem-server/pages/components/eunenem/admin/estatisticas/types.js';
import { VendasSecao } from '../../../apps/eunenem-server/pages/components/eunenem/admin/estatisticas/VendasSecao.js';

/** aperture-lcug3 — o que as seções Funil e Vendas DIZEM (sem browser, sem banco). */

const req = createRequire(`${process.cwd()}/apps/eunenem-server/package.json`);
const React = req('react');
const { renderToStaticMarkup } = req('react-dom/server');

const ETAPAS = ['cadastro', 'onboarding', 'lista_criada', 'primeiro_presente'] as const;
const c = (cadastro: number, onboarding: number, lista: number, presente: number) => ({
  cadastro,
  onboarding,
  lista_criada: lista,
  primeiro_presente: presente,
});
const base = {
  hoje: '2026-11-01',
  snapshotAt: '2026-11-01T15:00:00.000Z',
  periodo: { de: '2026-09-01', ate: '2026-11-02' },
};
const meses = [
  { de: '2026-09-01', ate: '2026-10-01', parcial: false },
  { de: '2026-10-01', ate: '2026-11-01', parcial: false },
  { de: '2026-11-01', ate: '2026-12-01', parcial: true },
];
const semanas = [{ de: '2026-10-26', ate: '2026-11-02', parcial: true }];

const funil: FunilData = {
  ...base,
  etapas: ETAPAS,
  totais: c(200, 120, 220, 30),
  meses: meses.map((m, i) => ({ ...m, contagens: c(50 + i, 30, 55, 10) })),
  semanas: semanas.map((s) => ({ ...s, contagens: c(10, 5, 11, 1) })),
  porOrigem: [
    { origem: 'google_ads', contagens: c(100, 60, 110, 20) },
    { origem: 'organico', contagens: c(0, 0, 0, 0) },
    { origem: 'direto', contagens: c(50, 30, 55, 5) },
    { origem: 'outros', contagens: c(10, 5, 10, 1) },
    { origem: 'desconhecida', contagens: c(40, 25, 45, 4) },
  ],
} as FunilData;

const metricas = (gmv: number, pix: number, cartao: number) => ({
  gmvCents: gmv,
  presentes: 10,
  ticketMedioCents: Math.round(gmv / 10),
  pixCents: pix,
  cartaoCents: cartao,
  pixQtd: 4,
  cartaoQtd: 2,
  pixGerados: 20,
  pixPagos: 12,
  pixExpirados: 5,
});
const vendas: VendasData = {
  ...base,
  totais: { ...metricas(300_000, 225_000, 75_000), presentes: 0, ticketMedioCents: null },
  meses: meses.map((m) => ({ ...m, ...metricas(100_000, 75_000, 25_000) })),
  semanas: semanas.map((s) => ({ ...s, ...metricas(10_000, 5_000, 5_000) })),
} as VendasData;

const render = (el: unknown) => renderToStaticMarkup(el) as string;

describe('Funil', () => {
  const html = render(React.createElement(FunilSecao, { data: funil }));

  it('quatro etapas, porcentagem sempre sobre os cadastros', () => {
    expect(html.match(/data-testid="funil-etapa"/g)).toHaveLength(4);
    expect(html).toContain('60% dos cadastros');
    // lista_criada > cadastro: marcos independentes, não um caminho sequencial.
    expect(html).toContain('110% dos cadastros');
    expect(html).toContain('sempre sobre os cadastros');
  });

  it('um grupo por mês e por semana do período', () => {
    expect(html.match(/data-testid="funil-mes"/g)).toHaveLength(3);
    expect(html.match(/data-testid="funil-semana"/g)).toHaveLength(1);
  });

  it('origens com rótulo em português e sem divisão por zero', () => {
    expect(html.match(/data-testid="funil-origem"/g)).toHaveLength(5);
    for (const r of ['Google Ads', 'Orgânico', 'Direto', 'Outras origens', 'Sem registro'])
      expect(html).toContain(r);
    expect(html).toContain('—');
  });
});

describe('Vendas', () => {
  const html = render(React.createElement(VendasSecao, { data: vendas }));

  it('KPIs de volume, ticket e PIX × cartão', () => {
    expect(html).toMatch(/R\$\s3\.000,00/);
    expect(html).toContain('75% PIX');
    // Sem presentes, ticket médio é "—", não R$ 0.
    expect(html).toMatch(/Ticket médio<\/div><div[^>]*>—</);
  });

  it('taxas de PIX sobre os gerados', () => {
    expect(html).toContain('60%');
    expect(html).toContain('25%');
    expect(html).toContain('não somam 100%');
  });

  it('uma barra por mês e por semana', () => {
    expect(html.match(/data-testid="vendas-mes"/g)).toHaveLength(3);
    expect(html.match(/data-testid="vendas-semana"/g)).toHaveLength(1);
    expect(html.match(/data-testid="vendas-pix-mes"/g)).toHaveLength(3);
  });
});
