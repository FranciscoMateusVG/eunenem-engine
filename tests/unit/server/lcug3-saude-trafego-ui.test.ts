import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { SaudeSecao } from '../../../apps/eunenem-server/pages/components/eunenem/admin/estatisticas/SaudeSecao.js';
import { TrafegoSecao } from '../../../apps/eunenem-server/pages/components/eunenem/admin/estatisticas/TrafegoSecao.js';
import type {
  SaudeData,
  TrafegoData,
} from '../../../apps/eunenem-server/pages/components/eunenem/admin/estatisticas/types.js';

/** aperture-lcug3 — o que as seções Saúde & erros e Tráfego DIZEM. */

const req = createRequire(`${process.cwd()}/apps/eunenem-server/package.json`);
const React = req('react');
const { renderToStaticMarkup } = req('react-dom/server');
const render = (el: unknown) => renderToStaticMarkup(el) as string;

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
const cont = (p: number, w: number, c: number, e: number) => ({
  provedor: p,
  webhook: w,
  checkout: c,
  email: e,
});

const RAW = '{"title":"Chave PIX inválida","violacoes":[{"razao":"chave não encontrada"}]}';
const saude = {
  ...base,
  categorias: ['provedor', 'webhook', 'checkout', 'email'],
  totais: cont(7, 2, 1, 3),
  meses: meses.map((m) => ({ ...m, contagens: cont(2, 1, 0, 1) })),
  semanas: semanas.map((s) => ({ ...s, contagens: cont(1, 0, 0, 0) })),
  recentes: [
    {
      id: 'provider-checkout:00000000-0000-4000-8000-000000000001',
      em: '2026-10-31T13:05:00.000Z',
      categoria: 'provedor',
      provedor: 'inter',
      operacao: 'checkout:pix',
      mensagem: RAW,
      truncado: false,
      referencia: { tipo: 'pagamento', id: '00000000-0000-4000-8000-0000000000aa' },
    },
    {
      id: 'webhook:00000000-0000-4000-8000-000000000002',
      em: '2026-10-30T10:00:00.000Z',
      categoria: 'webhook',
      provedor: 'stripe',
      operacao: 'charge.refunded',
      mensagem: 'x'.repeat(2048),
      truncado: true,
      referencia: { tipo: 'webhook', id: '00000000-0000-4000-8000-000000000002' },
    },
    {
      id: 'provider-payout:00000000-0000-4000-8000-000000000003',
      em: '2026-10-29T10:00:00.000Z',
      categoria: 'provedor',
      provedor: 'inter',
      operacao: 'pix_transfer',
      mensagem: 'saldo insuficiente',
      truncado: false,
      referencia: { tipo: 'repasse', id: '00000000-0000-4000-8000-0000000000bb' },
    },
  ],
  emailCobertura: {
    tipos: [],
    cobertura: { nota: 'NOTA', parcial: true, denominador: 1, observados: 1 },
  },
} as unknown as SaudeData;

describe('Saúde & erros', () => {
  const html = render(React.createElement(SaudeSecao, { data: saude }));

  it('contagem por categoria e gráficos do período', () => {
    expect(html.match(/data-testid="saude-categoria"/g)).toHaveLength(4);
    expect(html.match(/data-testid="saude-mes"/g)).toHaveLength(3);
    expect(html.match(/data-testid="saude-semana"/g)).toHaveLength(1);
    expect(html).toContain('continua sem resolução hoje');
  });

  it('mensagem crua do provedor, com links para pagamento e repasse', () => {
    expect(html.match(/data-testid="saude-recente"/g)).toHaveLength(3);
    expect(html).toContain('Chave PIX inválida');
    expect(html).toContain('href="/admin/pagamento/00000000-0000-4000-8000-0000000000aa"');
    expect(html).toContain('href="/admin/repasses/00000000-0000-4000-8000-0000000000bb"');
  });

  it('só a mensagem cortada oferece "ver completo"', () => {
    expect(html.match(/ver completo/g)).toHaveLength(1);
    expect(html).toContain(`${'x'.repeat(2048)}…`);
  });

  it('sem erros, diz isso', () => {
    const vazio = render(
      React.createElement(SaudeSecao, { data: { ...saude, recentes: [] } as SaudeData }),
    );
    expect(vazio).toContain('Nenhum erro no período');
  });
});

const metr = (v: number, c: number) => ({
  visitas: v,
  cadastros: c,
  visitantes: null,
  conversaoPct: null,
});
const AVISO = 'Dias no fuso de Mixpanel (Pacífico).';
const trafego = {
  ...base,
  timezone: 'America/Los_Angeles',
  aviso: AVISO,
  disponivel: true,
  atualizadoEm: '2026-11-01T14:00:00.000Z',
  totais: metr(1200, 30),
  meses: meses.map((m) => ({ ...m, ...metr(400, 10) })),
  semanas: semanas.map((s) => ({ ...s, ...metr(50, 1) })),
  fontes: [
    { fonte: 'Google', visitas: 800, cadastros: 20 },
    { fonte: 'Não informada', visitas: 0, cadastros: 2 },
  ],
} as unknown as TrafegoData;

describe('Tráfego', () => {
  it('totais, aviso do fuso e fontes', () => {
    const html = render(React.createElement(TrafegoSecao, { data: trafego }));
    expect(html.match(/data-testid="trafego-kpi"/g)).toHaveLength(2);
    expect(html).toContain(AVISO);
    expect(html.match(/data-testid="trafego-mes"/g)).toHaveLength(3);
    expect(html.match(/data-testid="trafego-fonte"/g)).toHaveLength(2);
    expect(html).toContain('2,5%');
    expect(html).toContain('não a taxa de conversão');
  });

  it('Mixpanel fora: mostra o motivo, nunca zeros', () => {
    const html = render(
      React.createElement(TrafegoSecao, {
        data: { ...trafego, disponivel: false, motivo: 'Mixpanel indisponível no momento.' },
      }),
    );
    expect(html).toContain('data-testid="trafego-indisponivel"');
    expect(html).toContain('Mixpanel indisponível no momento.');
    expect(html).not.toContain('data-testid="trafego-kpi"');
  });
});
