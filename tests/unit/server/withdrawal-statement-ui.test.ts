import { describe, expect, it } from 'vitest';
import type {
  ExtratoSummaryDTO,
  MovimentacaoRepasseDTO,
} from '../../../apps/eunenem-server/pages/components/eunenem/painel/ExtratoStubData.js';
import {
  adaptSummary,
  awaitingReleaseSummaryLabel,
  movementRowViewModel,
  movementStateLabel,
  pendingTransferSummaryLabel,
} from '../../../apps/eunenem-server/pages/components/eunenem/painel/PresentesBody.js';

function summary(overrides: Partial<ExtratoSummaryDTO> = {}): ExtratoSummaryDTO {
  return {
    totalRecebidoCents: 0,
    resgatadoCents: 0,
    saldoDisponivelCents: 0,
    aguardandoLiberacaoCents: 0,
    aguardandoAprovacaoCents: 0,
    enviadoAoBancoCents: 0,
    proximaTransfDate: null,
    totalPresentes: 0,
    totalRecadosCount: 0,
    totalPresentesItensCount: 0,
    totalPresentesUnidades: 0,
    dateRangeStart: null,
    dateRangeEnd: null,
    ...overrides,
  };
}

function movement(overrides: Partial<MovimentacaoRepasseDTO> = {}): MovimentacaoRepasseDTO {
  return {
    idRepasse: 'repasse-test',
    solicitadoEm: '2026-09-08T02:15:00.000Z',
    concluidoEm: null,
    enviadoAoBancoEm: null,
    valorCents: 2000,
    quantidade: 2,
    tipo: 'transferencia_conta',
    estado: 'aguardando_aprovacao',
    statusRepasse: 'solicitado',
    ...overrides,
  };
}

describe('withdrawal statement UI projection', () => {
  it('keeps completed and pending totals disjoint', () => {
    const pendingOnly = adaptSummary(
      summary({
        totalRecebidoCents: 2000,
        aguardandoAprovacaoCents: 2000,
      }),
    );
    expect(pendingOnly).toMatchObject({
      recebido: 2000,
      resgatado: 0,
      aguardandoAprovacao: 2000,
      disponivel: 0,
    });

    const mixed = adaptSummary(
      summary({
        totalRecebidoCents: 3000,
        resgatadoCents: 1000,
        aguardandoAprovacaoCents: 2000,
      }),
    );
    expect(mixed.resgatado).toBe(1000);
    expect(mixed.aguardandoAprovacao).toBe(2000);
  });

  it('keeps the empty statement zeroed', () => {
    expect(adaptSummary(summary())).toMatchObject({
      recebido: 0,
      resgatado: 0,
      disponivel: 0,
      aguardando: 0,
      aguardandoAprovacao: 0,
    });
  });

  it('shows the accepted R$20 only as resgatado with no separate handoff bucket', () => {
    const adapted = adaptSummary(
      summary({
        totalRecebidoCents: 2000,
        resgatadoCents: 2000,
        enviadoAoBancoCents: 2000,
      }),
    );
    expect(adapted).toMatchObject({
      recebido: 2000,
      resgatado: 2000,
      aguardandoAprovacao: 0,
      disponivel: 0,
    });
    expect(adapted).not.toHaveProperty('enviadoAoBanco');
  });

  it('places a conditional pending label beside the completed summary', () => {
    expect(pendingTransferSummaryLabel(2000)).toBe('(+ R$\u00a020,00 em transferência)');
    expect(pendingTransferSummaryLabel(0)).toBeNull();
  });

  it('places awaiting release in the same cluster and hides its zero state', () => {
    expect(awaitingReleaseSummaryLabel(1500)).toBe('(R$\u00a015,00 aguardando liberação)');
    expect(awaitingReleaseSummaryLabel(0)).toBeNull();
  });

  it.each([
    ['aguardando_aprovacao', 'aguardando aprovação'],
    ['em_transferencia', 'em transferência'],
    ['enviado_ao_banco', 'resgatado'],
    ['concluido', 'transferência concluída'],
    ['falhou', 'transferência falhou'],
    ['cancelado', 'transferência cancelada'],
    ['inconsistente', 'status pendente de conferência'],
  ] as const)('renders the %s state with accurate copy', (estado, label) => {
    expect(movementStateLabel(estado)).toBe(label);
    const view = movementRowViewModel(movement({ estado }));
    expect(view.statusLabel).toBe(label);
    expect(view.requestedLabel).toBe('solicitada 07/09');
    expect(view.requestedLabel).not.toContain(':');
  });

  it('renders bank handoff as complete for the platform without a settlement timestamp', () => {
    const view = movementRowViewModel(
      movement({
        estado: 'enviado_ao_banco',
        statusRepasse: 'enviado_ao_banco',
        enviadoAoBancoEm: '2026-09-08T06:00:40.466Z',
        concluidoEm: null,
      }),
    );
    expect(view).toMatchObject({
      completed: true,
      amountPrefix: '− ',
      statusLabel: 'resgatado',
    });
    expect(view.completedLabel).toBe('resgatado 08/09');
    expect(view.completedLabel).not.toContain(':');
  });

  it('shows a minus sign and completion date only for completed transfers', () => {
    const pendingView = movementRowViewModel(movement());
    expect(pendingView.amountPrefix).toBe('');
    expect(pendingView.completedLabel).toBeNull();

    const completedView = movementRowViewModel(
      movement({
        estado: 'concluido',
        statusRepasse: 'pago',
        concluidoEm: '2026-09-08T03:45:00.000Z',
      }),
    );
    expect(completedView.amountPrefix).toBe('− ');
    expect(completedView.completedLabel).toBe('concluída 08/09');
    expect(completedView.completedLabel).not.toContain(':');
  });
});
