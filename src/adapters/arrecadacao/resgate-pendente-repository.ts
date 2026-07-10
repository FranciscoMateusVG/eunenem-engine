import type { IdCampanha } from '../../domain/arrecadacao/value-objects/ids.js';

/**
 * Persistência do marcador de "resgate pendente" (porta) — aperture-kj9el #4b.
 *
 * 1:1 com Campanha: o marcador é keyed por `idCampanha`. Quando o
 * administrador pede para "preencher depois", gravamos APENAS a intenção
 * pendente (sem nenhum dado bancário — esses moram em `recebedores`).
 * Salvar os dados do recebedor depois LIMPA o marcador.
 *
 * `marcarPendente` é um upsert idempotente; `limparPendente` é um delete
 * idempotente (no-op se já não existe). O adapter é um persistidor "burro";
 * o use-case decide quando marcar/limpar.
 */
export interface ResgatePendenteRepository {
  marcarPendente(idCampanha: IdCampanha, pendenteDesde: Date, criadoEm: Date): Promise<void>;
  limparPendente(idCampanha: IdCampanha): Promise<void>;
  obterPendenteDesde(idCampanha: IdCampanha): Promise<Date | null>;
}
