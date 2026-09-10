import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { refundErrorCopy } from '../../../apps/eunenem-server/pages/components/eunenem/admin/EstornoBlock.js';
import {
  interVerificationLabel,
  WebhookEventRow,
  webhookEventHasIssue,
} from '../../../apps/eunenem-server/pages/components/eunenem/admin/PagamentoWebhookList.js';

const appRequire = createRequire(
  new URL('../../../apps/eunenem-server/package.json', import.meta.url),
);
const React = appRequire('react') as typeof import('react');
const { renderToStaticMarkup } = appRequire('react-dom/server') as {
  renderToStaticMarkup: (node: unknown) => string;
};

const INTER_EVENT = {
  id: 'event-inter',
  provider: 'inter',
  eventType: 'pix',
  receivedAt: '2026-09-09T14:00:00.000Z',
  signatureValid: false,
  processedAt: '2026-09-09T14:00:01.000Z',
  processingError: null,
  pagamentoId: 'payment-inter',
};

describe('admin payment operator copy', () => {
  it.each([
    ['pagamento_nao_encontrado', 'Pagamento não encontrado. Confira o registro aberto.'],
    [
      'pagamento_status_invalido',
      'Só pagamentos aprovados podem ser estornados. Confira o estado atual.',
    ],
    [
      'lancamento_ja_transferido',
      'Estorno bloqueado porque o repasse já foi transferido. Não repita a operação.',
    ],
    [
      'estorno_recusado_pelo_provedor',
      'O provedor recusou o estorno. Verifique o painel do provedor antes de decidir qualquer nova ação.',
    ],
    [
      'devolucao_nao_realizada',
      'O banco informou que a devolução PIX não foi concluída. Investigue o registro antes de qualquer nova ação.',
    ],
    [
      'devolucao_rejeitada',
      'O banco informou que a devolução PIX não foi concluída. Investigue o registro antes de qualquer nova ação.',
    ],
    [
      'devolucao_vinculo_invalido',
      'O vínculo da devolução está inconsistente. Investigue o registro sem tentar novamente.',
    ],
  ])('maps %s to a bounded operator explanation', (code, copy) => {
    expect(refundErrorCopy(code)).toBe(copy);
  });

  it('does not expose an unknown refund error or suggest blind retry', () => {
    const raw = 'provider-internal: token=private retry now';
    const copy = refundErrorCopy(raw);

    expect(copy).toBe(
      'Não foi possível confirmar o resultado. Consulte o estado e as evidências antes de qualquer nova tentativa.',
    );
    expect(copy).not.toContain(raw);
    expect(copy.toLowerCase()).not.toContain('tente de novo');
  });

  it('treats the intentionally unsigned Inter hint as neutral', () => {
    expect(webhookEventHasIssue(INTER_EVENT)).toBe(false);
    expect(interVerificationLabel(INTER_EVENT)).toBe('confirmado por reconsulta');

    const html = renderToStaticMarkup(
      React.createElement(WebhookEventRow, {
        event: INTER_EVENT,
        onOpenPayload: () => undefined,
      }),
    );

    expect(html).toContain('não assinado');
    expect(html).toContain('confirmado por reconsulta');
    expect(html).not.toContain('inválida');
  });

  it('keeps pending and failed Inter evidence unconfirmed', () => {
    const pending = { ...INTER_EVENT, processedAt: null };
    const failed = { ...INTER_EVENT, processingError: 'classified_failure' };

    expect(interVerificationLabel(pending)).toBe('não confirmado');
    expect(webhookEventHasIssue(pending)).toBe(false);
    expect(interVerificationLabel(failed)).toBe('não confirmado');
    expect(webhookEventHasIssue(failed)).toBe(true);
  });

  it('continues to flag a missing required Stripe signature', () => {
    expect(
      webhookEventHasIssue({
        provider: 'stripe',
        signatureValid: false,
        processingError: null,
      }),
    ).toBe(true);
  });
});
