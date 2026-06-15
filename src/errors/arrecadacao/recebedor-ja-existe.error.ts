import type { IdCampanha } from '../../domain/arrecadacao/value-objects/ids.js';

/**
 * Raised by `criarRecebedorParaCampanha` when the target campanha already
 * has an active recebedor. Callers should use
 * `alterarDadosRecebedorCampanha` to swap the active row instead.
 *
 * Frontend (TransferModal embed flow) reads this as the "redirect to
 * `/painel/:slug/bancarios` edit form" signal rather than the
 * first-time onboarding form.
 */
export class ArrecadacaoRecebedorJaExisteError extends Error {
  constructor(public readonly idCampanha: IdCampanha) {
    super(`Campanha "${idCampanha}" ja possui um recebedor ativo.`);
    this.name = 'ArrecadacaoRecebedorJaExisteError';
  }
}
