import { describe, expect, it } from 'vitest';
import type {
  ExtratoSummaryDTO,
  MovimentacaoRepasseDTO,
} from '../../../apps/eunenem-server/pages/components/eunenem/painel/ExtratoStubData.js';
import {
  adaptSummary,
  movementRowViewModel,
  movementStateLabel,
} from '../../../apps/eunenem-server/pages/components/eunenem/painel/PresentesBody.js';

function summary(overrides: Partial<ExtratoSummaryDTO> = {}): ExtratoSummaryDTO {
  return {
    totalRecebidoCents: 0,
    resgatadoCents: 0,
    saldoDisponivelCents: 0,
    aguardandoLiberacaoCents: 0,
    aguardandoAprovacaoCents: 0,
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

  it.each([
    ['aguardando_aprovacao', 'aguardando aprovação'],
    ['em_transferencia', 'em transferência'],
    ['concluido', 'transferência concluída'],
    ['falhou', 'transferência falhou'],
    ['cancelado', 'transferência cancelada'],
    ['inconsistente', 'status pendente de conferência'],
  ] as const)('renders the %s state with accurate copy', (estado, label) => {
    expect(movementStateLabel(estado)).toBe(label);
    const view = movementRowViewModel(movement({ estado }));
    expect(view.statusLabel).toBe(label);
    expect(view.requestedLabel).toContain('solicitada');
    expect(view.requestedLabel).toContain('23:15');
  });

  it('shows a minus sign and completion timestamp only for completed transfers', () => {
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
    expect(completedView.completedLabel).toContain('concluída');
    expect(completedView.completedLabel).toContain('00:45');
  });
});
