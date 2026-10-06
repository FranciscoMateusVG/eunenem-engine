/**
 * aperture-4yse9 — THE `pagamento_aprovado` emitter: unified props across
 * providers/paths, owner resolution, "new fact" guard, and never-throws.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  aprovacaoEhNova,
  pagamentoAprovadoProps,
  trackPagamentoAprovado,
} from '../../../apps/eunenem-server/server/analytics/pagamento-aprovado.js';
import type { ServerAnalytics } from '../../../apps/eunenem-server/server/analytics/server-analytics.js';
import { makePagamento } from '../../helpers/pagamento-repository.conformance.js';

function recorder() {
  const calls: Array<{
    event: string;
    distinctId: string | null;
    props?: Record<string, unknown>;
    options?: { insertKey?: string; occurredAt?: Date };
  }> = [];
  const serverAnalytics: ServerAnalytics = {
    track: (event, distinctId, props, options) => {
      calls.push({ event, distinctId, props, options });
    },
  };
  return { serverAnalytics, calls };
}

describe('aprovacaoEhNova', () => {
  it('is true only from the two pre-approval FSM states', () => {
    expect(aprovacaoEhNova('pendente')).toBe(true);
    expect(aprovacaoEhNova('processing')).toBe(true);
    expect(aprovacaoEhNova('aprovado')).toBe(false);
    expect(aprovacaoEhNova('rejeitado')).toBe(false);
    expect(aprovacaoEhNova('estornado')).toBe(false);
    expect(aprovacaoEhNova(undefined)).toBe(false);
  });
});

describe('pagamentoAprovadoProps', () => {
  it('is one schema regardless of provider/path, money in integer centavos', () => {
    const pagamento = makePagamento({ id: randomUUID(), idCampanha: randomUUID(), metodo: 'pix' });
    const agg = pagamento.intencao.composicaoValoresAggregate;

    const props = pagamentoAprovadoProps(pagamento, 'inter', 'reconciliacao', 'conta-dono');

    expect(props).toEqual({
      id_pagamento: pagamento.id,
      id_campanha: pagamento.intencao.idCampanha,
      id_conta_dono: 'conta-dono',
      metodo: 'pix',
      provedor: 'inter',
      caminho: 'reconciliacao',
      valor_centavos: agg.totalPaidCents,
      valor_recebedor_centavos: agg.totalReceiverCents,
      quantidade_itens: pagamento.intencao.items.filter((it) => it.tipo === 'contribuicao').length,
    });
    expect(Number.isInteger(props.valor_centavos)).toBe(true);
    // No payer PII, no free text.
    expect(Object.keys(props)).not.toContain('contribuinte');
    expect(Object.keys(props)).not.toContain('gift_name');
  });

  it('quantidade_itens sums contribuição UNITS (quantidade > 1), not lines — matches the client totalUnits', () => {
    const pagamento = makePagamento({ id: randomUUID(), idCampanha: randomUUID(), quantidade: 3 });
    const linhas = pagamento.intencao.items.filter((it) => it.tipo === 'contribuicao').length;
    expect(linhas).toBe(1);

    const props = pagamentoAprovadoProps(pagamento, 'stripe', 'webhook', 'conta-dono');

    expect(props.quantidade_itens).toBe(3);
  });
});

describe('trackPagamentoAprovado', () => {
  const occurredAt = new Date('2026-09-13T12:00:00.000Z');

  it('tracks once under the campaign OWNER with insertKey = idPagamento and the business time', async () => {
    const { serverAnalytics, calls } = recorder();
    const pagamento = makePagamento({ id: randomUUID(), idCampanha: randomUUID() });
    const campanhaRepository = {
      findById: vi.fn(async () => ({ idsAdministradores: ['conta-dono', 'conta-2'] })),
    } as never;

    await trackPagamentoAprovado(
      { serverAnalytics, campanhaRepository },
      { pagamento, provedor: 'stripe', caminho: 'webhook', occurredAt },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      event: 'pagamento_aprovado',
      distinctId: 'conta-dono',
      props: { id_conta_dono: 'conta-dono', provedor: 'stripe', caminho: 'webhook' },
      options: { insertKey: pagamento.id, occurredAt },
    });
  });

  it('passes a null actor to the sink (explicit drop) when the owner cannot be resolved — never a campaign stand-in', async () => {
    const { serverAnalytics, calls } = recorder();
    const pagamento = makePagamento({ id: randomUUID(), idCampanha: randomUUID() });
    const campanhaRepository = { findById: vi.fn(async () => undefined) } as never;

    await trackPagamentoAprovado(
      { serverAnalytics, campanhaRepository },
      { pagamento, provedor: 'inter', caminho: 'webhook', occurredAt },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.distinctId).toBeNull();
    expect(calls[0]?.distinctId).not.toBe(`campanha:${pagamento.intencao.idCampanha}`);
  });

  it('never throws when the repository throws, and is a no-op without a sink', async () => {
    const { serverAnalytics, calls } = recorder();
    const pagamento = makePagamento({ id: randomUUID(), idCampanha: randomUUID() });
    const throwing = {
      findById: vi.fn(async () => {
        throw new Error('db down');
      }),
    } as never;

    await expect(
      trackPagamentoAprovado(
        { serverAnalytics, campanhaRepository: throwing },
        { pagamento, provedor: 'stripe', caminho: 'webhook', occurredAt },
      ),
    ).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);

    await expect(
      trackPagamentoAprovado(
        { campanhaRepository: throwing },
        { pagamento, provedor: 'stripe', caminho: 'webhook', occurredAt },
      ),
    ).resolves.toBeUndefined();
  });
});
