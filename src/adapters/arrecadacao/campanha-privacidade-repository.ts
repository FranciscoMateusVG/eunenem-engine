import type { IdCampanha } from '../../domain/arrecadacao/value-objects/ids.js';

/**
 * Preferências de privacidade da página pública de uma campanha
 * (aperture-851nu). Ausência de registro = padrão (recados visíveis).
 */
export interface CampanhaPrivacidadeRepository {
  exibeRecadosPublicamente(idCampanha: IdCampanha): Promise<boolean>;
  definirExibirRecados(idCampanha: IdCampanha, exibir: boolean): Promise<void>;
  /** aperture-bqvb5 — mensagem padrão de agradecimento (null = usar a sugerida). */
  mensagemAgradecimento(idCampanha: IdCampanha): Promise<string | null>;
  definirMensagemAgradecimento(idCampanha: IdCampanha, mensagem: string | null): Promise<void>;
}
