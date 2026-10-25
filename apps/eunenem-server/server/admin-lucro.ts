import type { Database } from "../../../src/adapters/database.js";
import { agregarLucro } from "../pages/lib/lucroPainel.js";
import { DESPESAS_DESDE, loadDespesasPainel } from "./admin-despesas.js";
import { emSnapshotDeLeitura, loadReceitaPainel } from "./admin-receita.js";

export function loadReceitaComLucro(db: Database, input: { platformId: string; now: Date; interAccountRef: string | null }) {
  return emSnapshotDeLeitura(db, async (trx) => {
    const receita = await loadReceitaPainel(trx, input);
    const despesas = await loadDespesasPainel(trx, input);
    return { ...receita, lucro: agregarLucro(receita, despesas, DESPESAS_DESDE, receita.hoje) };
  });
}
