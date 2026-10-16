/**
 * aperture-6wl0f review — a failed campanhaMembros.meuAcesso must surface the
 * dashboard error state with a retry, never render a "no permissions" dashboard
 * (an owner silently stripped of every card).
 */
import { describe, expect, it, vi } from 'vitest';
import { estadoDadosDashboard } from '../../../apps/eunenem-server/pages/lib/painel-dashboard-estado.js';

function q(over: Partial<{ isLoading: boolean; error: unknown }> = {}) {
  return { isLoading: false, error: null, refetch: vi.fn(), ...over };
}

describe('estadoDadosDashboard', () => {
  it('meuAcesso failure → failed, and retry refetches meuAcesso', () => {
    const acesso = q({ error: new Error('boom') });
    const outros = { summary: q(), convidados: q(), lista: q() };
    const estado = estadoDadosDashboard({ acesso, ...outros });
    expect(estado.failed).toBe(true);
    estado.retry();
    expect(acesso.refetch).toHaveBeenCalledOnce();
    expect(outros.summary.refetch).not.toHaveBeenCalled();
  });

  it('meuAcesso loading → loading (no permission-stripped flash)', () => {
    expect(
      estadoDadosDashboard({
        acesso: q({ isLoading: true }),
        summary: q(),
        convidados: q(),
        lista: q(),
      }).loading,
    ).toBe(true);
  });

  it('all ok → neither loading nor failed; other query errors still retried individually', () => {
    expect(
      estadoDadosDashboard({ acesso: q(), summary: q(), convidados: q(), lista: q() }),
    ).toMatchObject({ loading: false, failed: false });
    const lista = q({ error: new Error('x') });
    const estado = estadoDadosDashboard({ acesso: q(), summary: q(), convidados: q(), lista });
    expect(estado.failed).toBe(true);
    estado.retry();
    expect(lista.refetch).toHaveBeenCalledOnce();
  });
});
