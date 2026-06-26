import type { IdUsuario } from '../../domain/usuario/value-objects/ids.js';

/**
 * Persistência do marcador de "resgate pendente" (porta) — aperture-kj9el #4b.
 *
 * 1:1 com Usuario: o marcador é keyed por `idUsuario`. Quando o usuário pede
 * para "preencher depois", gravamos APENAS a intenção pendente (sem nenhum
 * dado bancário — esses moram em `dados_recebimento_usuario`, que exige um
 * payload completo via CHECK). Salvar os dados bancários depois LIMPA o
 * marcador.
 *
 * `marcarPendente` é um upsert idempotente; `limparPendente` é um delete
 * idempotente (no-op se já não existe). O adapter é um persistidor "burro";
 * o use-case decide quando marcar/limpar.
 */
export interface ResgatePendenteRepository {
  marcarPendente(idUsuario: IdUsuario, pendenteDesde: Date, criadoEm: Date): Promise<void>;
  limparPendente(idUsuario: IdUsuario): Promise<void>;
  obterPendenteDesde(idUsuario: IdUsuario): Promise<Date | null>;
}
