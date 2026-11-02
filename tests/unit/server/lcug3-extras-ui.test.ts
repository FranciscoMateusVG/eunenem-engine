import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  CheckoutPainel,
  EmailCoberturaPainel,
  FaixasPrecoPainel,
  rotuloFaixa,
  rotuloFaixaCurto,
} from '../../../apps/eunenem-server/pages/components/eunenem/admin/estatisticas/ExtrasPaineis.js';
import type {
  FunilData,
  SaudeData,
  VendasData,
} from '../../../apps/eunenem-server/pages/components/eunenem/admin/estatisticas/types.js';

/** aperture-lcug3 — painéis extras: checkout (8), faixas de preço (9), e-mails (12). */

const req = createRequire(`${process.cwd()}/apps/eunenem-server/package.json`);
const React = req('react');
const { renderToStaticMarkup } = req('react-dom/server');
const render = (el: unknown) => renderToStaticMarkup(el) as string;
const cob = (nota: string) => ({ nota, parcial: true, denominador: 20, observados: 15 });

describe('Checkout', () => {
  const data = {
    operacoes: 20,
    estados: [
      { estado: 'local_committed', quantidade: 14 },
      { estado: 'failed', quantidade: 4 },
      { estado: 'estado_futuro', quantidade: 2 },
    ],
    comErro: 6,
    recuperadasAposErro: 3,
    percentualRecuperadas: 50,
    comprasLogicas: null,
    trocasPixCartao: null,
    cobertura: cob('NOTA-CHECKOUT'),
  } as unknown as FunilData['checkout'];
  const html = render(React.createElement(CheckoutPainel, { data }));

  it('recuperação como %, não como conversão; troca PIX→cartão não medida', () => {
    expect(html).toContain('50%');
    expect(html).toContain('3 de 6');
    expect(html).toContain('não é o mesmo que compra aprovada');
    expect(html).toContain('não medido');
    expect(html).toContain('NOTA-CHECKOUT');
  });

  it('estados em pt-BR; código desconhecido aparece cru', () => {
    expect(html.match(/data-testid="checkout-estado"/g)).toHaveLength(3);
    expect(html).toContain('Concluída');
    expect(html).toContain('Falhou');
    expect(html).toContain('estado_futuro');
    expect(html).toContain('70%');
  });
});

describe('Faixas de preço', () => {
  const data = {
    faixas: [
      { deCents: 0, ateCents: 5_000, disponiveis: 30, comprados: 10, gmvCents: 30_000 },
      { deCents: 50_000, ateCents: null, disponiveis: 2, comprados: 0, gmvCents: 0 },
    ],
    cobertura: cob('NOTA-FAIXAS'),
  } as unknown as VendasData['faixasPreco'];

  it('rótulo da última faixa aberta', () => {
    expect(rotuloFaixa({ deCents: 50_000, ateCents: null })).toMatch(/R\$\s500\+/);
    expect(rotuloFaixaCurto({ deCents: 0, ateCents: 5_000 })).toBe('até 50');
    expect(rotuloFaixaCurto({ deCents: 5_000, ateCents: 10_000 })).toBe('50–100');
    expect(rotuloFaixaCurto({ deCents: 50_000, ateCents: null })).toBe('500+');
  });

  it('gráfico e tabela por faixa com nota', () => {
    const html = render(React.createElement(FaixasPrecoPainel, { data }));
    expect(html.match(/data-testid="vendas-faixa"/g)).toHaveLength(2);
    expect(html).toContain('100%');
    expect(html).toContain('NOTA-FAIXAS');
  });
});

describe('Cobertura de e-mails', () => {
  const data = {
    tipos: [
      {
        tipo: 'payment_received',
        eventosRegistrados: 10,
        eventosComDestinatario: 8,
        pendentes: 0,
        enviando: 0,
        enviados: 7,
        falhos: 1,
        desconhecidos: 0,
        suprimidos: 0,
      },
      {
        tipo: 'tipo_novo',
        eventosRegistrados: 1,
        eventosComDestinatario: 0,
        pendentes: 0,
        enviando: 0,
        enviados: 0,
        falhos: 0,
        desconhecidos: 0,
        suprimidos: 0,
      },
    ],
    cobertura: cob('NOTA-EMAIL'),
  } as unknown as SaudeData['emailCobertura'];

  it('tipo em pt-BR, % com destinatário, falhas destacadas', () => {
    const html = render(React.createElement(EmailCoberturaPainel, { data }));
    expect(html.match(/data-testid="email-tipo"/g)).toHaveLength(2);
    expect(html).toContain('Presente recebido');
    expect(html).toContain('tipo_novo');
    expect(html).toContain('80%');
    expect(html).toContain('text-red-700');
    expect(html).toContain('Enviado não quer dizer entregue');
    expect(html).toContain('NOTA-EMAIL');
  });

  it('sem eventos, diz isso', () => {
    const html = render(
      React.createElement(EmailCoberturaPainel, { data: { ...data, tipos: [] } }),
    );
    expect(html).toContain('Nenhum evento de e-mail no período');
  });
});
