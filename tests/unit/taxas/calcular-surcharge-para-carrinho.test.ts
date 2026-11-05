import { describe, expect, it } from 'vitest';
import { NoopLogger } from '../../../src/observability/noop-logger.js';
import { noopTracer } from '../../../src/observability/tracer.js';
import { calcularSurchargeParaCarrinho } from '../../../src/use-cases/taxas/calcular-surcharge-para-carrinho.js';

const deps = { observability: { logger: new NoopLogger(), tracer: noopTracer() } };

describe('calcularSurchargeParaCarrinho — base is gift + EuNeném fee', () => {
  it('R$200 gift, fee 1796 → base 21796 → surcharge 926', async () => {
    const r = await calcularSurchargeParaCarrinho(deps, {
      totalContributionCents: 20000 as never,
      totalFeeCents: 1796 as never,
      metodo: 'credit_card',
    });
    expect(r?.amountCents).toBe(926);
  });

  it('pix returns null', async () => {
    const r = await calcularSurchargeParaCarrinho(deps, {
      totalContributionCents: 20000 as never,
      totalFeeCents: 1796 as never,
      metodo: 'pix',
    });
    expect(r).toBeNull();
  });
});
