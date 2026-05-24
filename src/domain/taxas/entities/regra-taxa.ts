import { z } from 'zod/v4';
import {
  type IdPlataformaReferencia,
  IdPlataformaReferenciaSchema,
  type IdRegraTaxa,
  IdRegraTaxaSchema,
} from '../value-objects/ids.js';
import {
  type TarifaTipo,
  TarifaTipoSchema,
  type TipoOpcaoContribuicaoReferencia,
  TipoOpcaoContribuicaoReferenciaSchema,
} from '../value-objects/tarifa-tipo.js';

/**
 * @aggregateRoot RegraTaxa (BC Taxas)
 *
 * Per-plataforma pricing posture. Holds the set of `TarifaTipo` entries the
 * plataforma applies, indexed by the kind of contribuição (presente / rifa
 * / convite). Each plataforma has exactly one active RegraTaxa.
 *
 * Persisted via: `ProvedorRegraTaxa`. The composição that crosses BC
 * boundaries (snapshot on Pagamento) is produced by `calcularComposicaoValores`
 * — the RegraTaxa itself never leaves Taxas; only the snapshot does.
 *
 * Aggregate boundary: `tarifasPorTipo` lives entirely inside this aggregate;
 * no external entity refers to a TarifaTipo by id. Updates to a RegraTaxa
 * replace the whole `tarifasPorTipo` shape — single transactional unit.
 */
export const RegraTaxaSchema = z.object({
  id: IdRegraTaxaSchema,
  idPlataforma: IdPlataformaReferenciaSchema,
  tarifasPorTipo: z.record(TipoOpcaoContribuicaoReferenciaSchema, TarifaTipoSchema),
  criadaEm: z.date(),
});

export type RegraTaxa = Readonly<z.infer<typeof RegraTaxaSchema>>;

export interface CriarRegraTaxaInput {
  readonly id: IdRegraTaxa;
  readonly idPlataforma: IdPlataformaReferencia;
  readonly tarifasPorTipo: Readonly<Record<TipoOpcaoContribuicaoReferencia, TarifaTipo>>;
  readonly criadaEm: Date;
}

export function criarRegraTaxa(input: CriarRegraTaxaInput): RegraTaxa {
  return {
    id: input.id,
    idPlataforma: input.idPlataforma,
    tarifasPorTipo: input.tarifasPorTipo,
    criadaEm: input.criadaEm,
  };
}

/**
 * Pure query: returns the TarifaTipo configured for a given tipo. Every
 * plataforma is required by the type system to price every supported tipo,
 * so this never returns undefined — adding a new tipo breaks the build
 * until every RegraTaxa configures it.
 */
export function obterTarifaPorTipo(
  regra: RegraTaxa,
  tipo: TipoOpcaoContribuicaoReferencia,
): TarifaTipo {
  return regra.tarifasPorTipo[tipo];
}
