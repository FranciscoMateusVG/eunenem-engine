import type { IdCampanha } from '../../domain/arrecadacao/value-objects/ids.js';

/**
 * aperture-xdylg — o recebedor ativo da campanha mudou entre a leitura e a
 * gravação de quem está alterando (outra aba/pessoa salvou antes). Nada foi
 * sobrescrito; o cliente recarrega e tenta de novo.
 */
export class ArrecadacaoRecebedorAlteradoConcorrentementeError extends Error {
  constructor(public readonly idCampanha: IdCampanha) {
    super(
      `O recebedor da campanha "${idCampanha}" foi alterado por outra operação; recarregue e tente de novo.`,
    );
    this.name = 'ArrecadacaoRecebedorAlteradoConcorrentementeError';
  }
}
