import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { AttemptHistory } from '../../../apps/eunenem-server/pages/AdminRepasseDetailPage.js';
import type { RepasseTransferAttempt } from '../../../apps/eunenem-server/pages/components/eunenem/admin/RepassesStubData.js';

const appRequire = createRequire(
  new URL('../../../apps/eunenem-server/package.json', import.meta.url),
);
const { createElement } = appRequire('react') as {
  createElement: (type: unknown, props: Record<string, unknown>) => unknown;
};
const { renderToStaticMarkup } = appRequire('react-dom/server') as {
  renderToStaticMarkup: (node: unknown) => string;
};

const RECEIPT = '203f4559-72d8-4675-9f79-aa360b9f4456';

function attempt(overrides: Partial<RepasseTransferAttempt> = {}): RepasseTransferAttempt {
  return {
    id: 'attempt-4',
    attemptNo: 4,
    referencia: 'repasse-test',
    startedAt: '2026-09-08T12:12:09.060Z',
    finishedAt: '2026-09-08T12:12:09.139Z',
    requestSummary: 'valor=2000; chave=cpf',
    outcome: 'verificando',
    codigoSolicitacao: RECEIPT,
    error: null,
    operation: 'pagar_pix',
    httpStatus: 200,
    providerRequestId: null,
    responseClass: 'accepted',
    diagnosticCode: 'diagnostic_unavailable',
    diagnosticField: null,
    diagnosticReason: 'diagnostic_unavailable',
    durationMs: 79,
    stateBefore: 'falhou',
    stateAfter: 'verificando',
    providerErrorBodyPrivate: null,
    providerErrorBodyTruncated: false,
    ...overrides,
  };
}

function renderHistory(
  currentStatus: 'enviado_ao_banco' | 'verificando',
  currentCodigoSolicitacao: string | null,
  item: RepasseTransferAttempt = attempt(),
): string {
  return renderToStaticMarkup(
    createElement(AttemptHistory, {
      attempts: [item],
      currentStatus,
      currentCodigoSolicitacao,
    }),
  );
}

describe('AdminRepasseDetailPage attempt history', () => {
  it('distinguishes a matching accepted attempt from the current bank handoff', () => {
    const html = renderHistory('enviado_ao_banco', RECEIPT);

    expect(html).toContain('resultado histórico: verificando');
    expect(html).toContain('Estado atual: Enviado ao banco.');
    expect(html).toContain('nenhuma consulta está em andamento');
    expect(html).toContain('falhou → verificando');
    expect(html).toContain(RECEIPT);
    expect(html).not.toContain('diagnóstico indisponível');
  });

  it('does not apply handoff context when the receipt does not match', () => {
    const html = renderHistory('enviado_ao_banco', 'different-receipt');

    expect(html).toContain('verificando');
    expect(html).toContain('diagnóstico indisponível');
    expect(html).not.toContain('resultado histórico');
    expect(html).not.toContain('Estado atual: Enviado ao banco.');
  });

  it('retains actual error evidence on a matching historical attempt', () => {
    const html = renderHistory(
      'enviado_ao_banco',
      RECEIPT,
      attempt({ error: 'PROVIDER_RECORDED_ERROR' }),
    );

    expect(html).toContain('resultado histórico: verificando');
    expect(html).toContain('PROVIDER_RECORDED_ERROR');
    expect(html).toContain('diagnóstico indisponível');
  });

  it('retains the uncertain presentation while the parent is still verificando', () => {
    const html = renderHistory('verificando', RECEIPT);

    expect(html).toContain('verificando');
    expect(html).toContain('diagnóstico indisponível');
    expect(html).not.toContain('resultado histórico');
    expect(html).not.toContain('nenhuma consulta está em andamento');
  });
});
