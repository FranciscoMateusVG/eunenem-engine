import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  REPASSE_STATUS_GLOSS,
  REPASSE_STATUS_LABEL,
  RepasseStatusPill,
  repasseInFlightExplanation,
} from '../../../apps/eunenem-server/pages/components/eunenem/admin/repasse-status.js';

const appRequire = createRequire(
  new URL('../../../apps/eunenem-server/package.json', import.meta.url),
);
const { createElement } = appRequire('react') as {
  createElement: (type: unknown, props: Record<string, unknown>) => unknown;
};
const { renderToStaticMarkup } = appRequire('react-dom/server') as {
  renderToStaticMarkup: (node: unknown) => string;
};

describe('admin repasse in-flight status copy', () => {
  it('renders the accepted handoff state without exposing the persisted enum', () => {
    expect(REPASSE_STATUS_LABEL.enviado_ao_banco).toBe('Enviado ao banco');

    const html = renderToStaticMarkup(
      createElement(RepasseStatusPill, { status: 'enviado_ao_banco' }),
    );
    expect(html).toContain('Enviado ao banco');
    expect(html).not.toContain('enviado_ao_banco');
  });

  it('describes an approved payout as queued for its initial send', () => {
    expect(repasseInFlightExplanation('aprovado')).toBe(
      'na fila de transferência. O envio inicial foi enfileirado e ainda não começou.',
    );
  });

  it('describes transferindo as the initial send in progress', () => {
    expect(repasseInFlightExplanation('transferindo')).toBe(
      'transferência em andamento no Inter. O envio inicial está em andamento; não inicie outro pagamento.',
    );
  });

  it('describes verificando as uncertain and manual, with no automatic send or query', () => {
    expect(REPASSE_STATUS_GLOSS.verificando).toBe(
      'resultado do envio incerto — revisão manual necessária',
    );
    expect(repasseInFlightExplanation('verificando')).toBe(
      'resultado do envio incerto — revisão manual necessária. Nenhum novo envio ou consulta automática será feito. Confira o caso manualmente antes de qualquer ação financeira.',
    );
  });
});
