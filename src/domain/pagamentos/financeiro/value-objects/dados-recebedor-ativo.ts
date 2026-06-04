import type { DadosRecebedor } from '../../../arrecadacao/value-objects/dados-recebedor.js';
import { DadosRecebedorSchema } from '../../../arrecadacao/value-objects/dados-recebedor.js';

/**
 * Value object: snapshot of the currently-active receiver's PIX data, as
 * exposed by the LivroFinanceiroRepository's `findRecebedorAtivoPorIdCampanha`
 * query. Today this is structurally identical to `DadosRecebedor` from
 * Arrecadação — kept as an alias so consumers depend on the financeiro path.
 *
 * Cross-BC coupling note: this is the one place Financeiro imports from
 * Arrecadação's domain. Marked as a follow-up architecture decision.
 */
export const DadosRecebedorAtivoSchema = DadosRecebedorSchema;
export type DadosRecebedorAtivo = Readonly<DadosRecebedor>;
