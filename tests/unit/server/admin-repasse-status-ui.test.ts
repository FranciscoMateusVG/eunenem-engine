import { describe, expect, it } from 'vitest';
import {
  REPASSE_STATUS_GLOSS,
  repasseInFlightExplanation,
} from '../../../apps/eunenem-server/pages/components/eunenem/admin/repasse-status.js';

describe('admin repasse in-flight status copy', () => {
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
