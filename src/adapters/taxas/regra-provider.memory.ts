import { SpanStatusCode, trace } from '@opentelemetry/api';
import { criarRegraTaxa, type RegraTaxa } from '../../domain/taxas/entities/regra-taxa.js';
import type { IdPlataformaReferencia, IdRegraTaxa } from '../../domain/taxas/value-objects/ids.js';
import { RegraTaxaNaoEncontradaError } from '../../errors/taxas/regra-nao-encontrada.error.js';
import { ID_PLATAFORMA_EUCASEI, ID_PLATAFORMA_EUNENEM } from '../plataforma/repository.memory.js';
import type { ProvedorRegraTaxa } from './regra-provider.js';

const tracer = trace.getTracer('frame');

const DB_ATTRS = {
  'db.system': 'memory',
  'db.collection.name': 'taxas_regras',
} as const;

const SEED_DATE = new Date('2026-01-01T00:00:00.000Z');

const ID_REGRA_EUNENEM: IdRegraTaxa = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ID_REGRA_EUCASEI: IdRegraTaxa = 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa';

/**
 * Regras seed das plataformas iniciais.
 *
 * - eunenem: 5% sobre o contribuinte em todos os tipos (modelo legado).
 * - eucasei: 6% em presente e 8% em rifa/convite, sempre sobre o contribuinte.
 */
export const REGRAS_TAXA_SEED: readonly RegraTaxa[] = [
  criarRegraTaxa({
    id: ID_REGRA_EUNENEM,
    idPlataforma: ID_PLATAFORMA_EUNENEM,
    tarifasPorTipo: {
      presente: { percentageBps: 500, responsavelTaxa: 'contribuinte' },
      rifa: { percentageBps: 500, responsavelTaxa: 'contribuinte' },
      convite: { percentageBps: 500, responsavelTaxa: 'contribuinte' },
    },
    criadaEm: SEED_DATE,
  }),
  criarRegraTaxa({
    id: ID_REGRA_EUCASEI,
    idPlataforma: ID_PLATAFORMA_EUCASEI,
    tarifasPorTipo: {
      presente: { percentageBps: 600, responsavelTaxa: 'contribuinte' },
      rifa: { percentageBps: 800, responsavelTaxa: 'contribuinte' },
      convite: { percentageBps: 800, responsavelTaxa: 'contribuinte' },
    },
    criadaEm: SEED_DATE,
  }),
];

export class ProvedorRegraTaxaMemory implements ProvedorRegraTaxa {
  private readonly regras: Map<IdPlataformaReferencia, RegraTaxa>;

  constructor(seed: readonly RegraTaxa[] = REGRAS_TAXA_SEED) {
    this.regras = new Map(seed.map((r) => [r.idPlataforma, r]));
  }

  async getRegraAtiva(idPlataforma: IdPlataformaReferencia): Promise<RegraTaxa> {
    return tracer.startActiveSpan('db.taxas_regras.getRegraAtiva', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const regra = this.regras.get(idPlataforma);
        if (!regra) {
          throw new RegraTaxaNaoEncontradaError(idPlataforma);
        }
        span.setStatus({ code: SpanStatusCode.OK });
        return regra;
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }
}
