import { SpanStatusCode, trace } from '@opentelemetry/api';
import {
  type Campanha,
  campanhaComRecebedorAtivo,
  campanhaSemRecebedor,
} from '../../domain/arrecadacao/entities/campanha.js';
import type {
  IdCampanha,
  IdConta,
  IdPlataformaReferencia,
} from '../../domain/arrecadacao/value-objects/ids.js';
import type { CampanhaRepository } from './campanha-repository.js';
import type { RecebedorRepository } from './recebedor-repository.js';
import type { ArrecadacaoRepositoryContext } from './repository-context.js';

const tracer = trace.getTracer('frame');

const DB_ATTRS = {
  'db.system': 'memory',
  'db.collection.name': 'arrecadacao_campanhas',
} as const;

export class CampanhaRepositoryMemory implements CampanhaRepository {
  private readonly campanhas = new Map<IdCampanha, Campanha>();

  constructor(private readonly recebedorRepository?: RecebedorRepository) {}

  async save(campanha: Campanha, _context?: ArrecadacaoRepositoryContext): Promise<void> {
    return tracer.startActiveSpan('db.arrecadacao_campanhas.save', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPSERT' });
      try {
        this.campanhas.set(campanha.id, campanha);
        span.setStatus({ code: SpanStatusCode.OK });
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async findById(
    id: IdCampanha,
    _context?: ArrecadacaoRepositoryContext,
  ): Promise<Campanha | undefined> {
    return tracer.startActiveSpan('db.arrecadacao_campanhas.findById', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const campanha = this.campanhas.get(id);
        if (!campanha) {
          span.setStatus({ code: SpanStatusCode.OK });
          return undefined;
        }

        if (!this.recebedorRepository) {
          span.setStatus({ code: SpanStatusCode.OK });
          return campanha;
        }

        const recebedorAtivo = await this.recebedorRepository.findAtivoByCampanhaId(id);
        span.setStatus({ code: SpanStatusCode.OK });
        return recebedorAtivo
          ? campanhaComRecebedorAtivo(campanha, recebedorAtivo)
          : campanhaSemRecebedor(campanha);
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async findByPlataforma(
    idPlataforma: IdPlataformaReferencia,
    _context?: ArrecadacaoRepositoryContext,
  ): Promise<readonly Campanha[]> {
    return tracer.startActiveSpan('db.arrecadacao_campanhas.findByPlataforma', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        const campanhasDaPlataforma = [...this.campanhas.values()].filter(
          (c) => c.idPlataforma === idPlataforma,
        );

        if (!this.recebedorRepository) {
          span.setStatus({ code: SpanStatusCode.OK });
          return campanhasDaPlataforma;
        }

        const resultados: Campanha[] = [];
        for (const campanha of campanhasDaPlataforma) {
          const recebedorAtivo = await this.recebedorRepository.findAtivoByCampanhaId(campanha.id);
          resultados.push(
            recebedorAtivo
              ? campanhaComRecebedorAtivo(campanha, recebedorAtivo)
              : campanhaSemRecebedor(campanha),
          );
        }

        span.setStatus({ code: SpanStatusCode.OK });
        return resultados;
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async findFirstByAdministrador(
    idConta: IdConta,
    _context?: ArrecadacaoRepositoryContext,
  ): Promise<Campanha | undefined> {
    return tracer.startActiveSpan(
      'db.arrecadacao_campanhas.findFirstByAdministrador',
      async (span) => {
        span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
        try {
          // Deterministic ordering by criadaEm ASC (oldest first) — matches
          // the Postgres adapter contract so callers see a stable result.
          const matches = [...this.campanhas.values()]
            .filter((c) => c.idsAdministradores.includes(idConta))
            .sort((a, b) => a.criadaEm.getTime() - b.criadaEm.getTime());

          const first = matches[0];
          if (!first) {
            span.setStatus({ code: SpanStatusCode.OK });
            return undefined;
          }

          if (!this.recebedorRepository) {
            span.setStatus({ code: SpanStatusCode.OK });
            return first;
          }

          const recebedorAtivo = await this.recebedorRepository.findAtivoByCampanhaId(first.id);
          span.setStatus({ code: SpanStatusCode.OK });
          return recebedorAtivo
            ? campanhaComRecebedorAtivo(first, recebedorAtivo)
            : campanhaSemRecebedor(first);
        } catch (error: unknown) {
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }

  async findByAdministrador(
    idConta: IdConta,
    _context?: ArrecadacaoRepositoryContext,
  ): Promise<Campanha | undefined> {
    return tracer.startActiveSpan('db.arrecadacao_campanhas.findByAdministrador', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
      try {
        // aperture-x0unf 🚨 SAFETY: deterministic OLDEST-wins, mirroring the
        // postgres adapter's `ORDER BY criada_em ASC, id ASC`. A bare `.find()`
        // returned insertion-order (arbitrary), so a conta's 2nd campanha could
        // silently take over the resolved single-result. Same comparator as
        // findCampanhasByAdministrador so single- and multi-result ports agree.
        const campanha = [...this.campanhas.values()]
          .filter((c) => c.idsAdministradores.includes(idConta))
          .sort((a, b) => {
            const dt = a.criadaEm.getTime() - b.criadaEm.getTime();
            if (dt !== 0) return dt;
            if (a.id < b.id) return -1;
            if (a.id > b.id) return 1;
            return 0;
          })[0];
        if (!campanha) {
          span.setStatus({ code: SpanStatusCode.OK });
          return undefined;
        }

        if (!this.recebedorRepository) {
          span.setStatus({ code: SpanStatusCode.OK });
          return campanha;
        }

        const recebedorAtivo = await this.recebedorRepository.findAtivoByCampanhaId(campanha.id);
        // aperture-x0unf/wthsg: a campanha WITHOUT an active recebedor is a
        // legit 'pre-bank-info' lifecycle state (ENGINE-DDD §66klh) — the
        // Postgres adapter (findById → criarCampanhaSemRecebedor) returns it,
        // and NOVA LISTA creates exactly this (campanhas.criar is {titulo}-only,
        // no recebedor). Memory previously returned `undefined` here, so tests
        // lied about prod for every pre-bank-info user. Aligned to Postgres +
        // findFirstByAdministrador: return the campanha sem recebedor.
        span.setStatus({ code: SpanStatusCode.OK });
        return recebedorAtivo
          ? campanhaComRecebedorAtivo(campanha, recebedorAtivo)
          : campanhaSemRecebedor(campanha);
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async findCampanhasByAdministrador(
    idConta: IdConta,
    _context?: ArrecadacaoRepositoryContext,
  ): Promise<readonly Campanha[]> {
    return tracer.startActiveSpan(
      'db.arrecadacao_campanhas.findCampanhasByAdministrador',
      async (span) => {
        span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
        try {
          // 1..N filter, deterministic ordering by criadaEm ASC then id ASC
          // for ties. Matches findFirstByAdministrador's contract so the
          // single-result port and the multi-result port agree on which
          // campanha is "first."
          const matches = [...this.campanhas.values()]
            .filter((c) => c.idsAdministradores.includes(idConta))
            .sort((a, b) => {
              const dt = a.criadaEm.getTime() - b.criadaEm.getTime();
              if (dt !== 0) return dt;
              if (a.id < b.id) return -1;
              if (a.id > b.id) return 1;
              return 0;
            });

          if (matches.length === 0) {
            span.setStatus({ code: SpanStatusCode.OK });
            return [];
          }

          if (!this.recebedorRepository) {
            span.setStatus({ code: SpanStatusCode.OK });
            return matches;
          }

          // Apply recebedor wrapper per row — same pattern as
          // findByPlataforma / findFirstByAdministrador. Returns
          // campanhaSemRecebedor (NOT undefined) when no recebedor is
          // active, so the admin view sees every campanha regardless of
          // bank-info readiness.
          const resultados: Campanha[] = [];
          for (const campanha of matches) {
            const recebedorAtivo = await this.recebedorRepository.findAtivoByCampanhaId(
              campanha.id,
            );
            resultados.push(
              recebedorAtivo
                ? campanhaComRecebedorAtivo(campanha, recebedorAtivo)
                : campanhaSemRecebedor(campanha),
            );
          }

          span.setStatus({ code: SpanStatusCode.OK });
          return resultados;
        } catch (error: unknown) {
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }

  async findCampanhasByContribuinte(
    _idPlataforma: IdPlataformaReferencia,
    _emailContribuinte: string,
    _context?: ArrecadacaoRepositoryContext,
  ): Promise<readonly Campanha[]> {
    return tracer.startActiveSpan(
      'db.arrecadacao_campanhas.findCampanhasByContribuinte',
      async (span) => {
        span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'SELECT' });
        try {
          // Cross-aggregate lookup (aperture-2ma52). The memory
          // CampanhaRepository has no access to contribuicoes data —
          // that lives in ContribuicaoRepository, a different
          // aggregate. The postgres adapter resolves this via a JOIN
          // through `contribuicoes` on `contribuinte_email`. In memory
          // mode, the honest answer is "I don't know" → empty array.
          // Saga / use-case tests that need this lookup must use the
          // postgres adapter (or compose ContribuicaoRepository at the
          // caller).
          span.setStatus({ code: SpanStatusCode.OK });
          return [];
        } catch (error: unknown) {
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }

  async delete(idCampanha: IdCampanha, _context?: ArrecadacaoRepositoryContext): Promise<void> {
    return tracer.startActiveSpan('db.arrecadacao_campanhas.delete', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'DELETE' });
      try {
        // Idempotent — no-op if id is unknown.
        this.campanhas.delete(idCampanha);
        span.setStatus({ code: SpanStatusCode.OK });
      } catch (error: unknown) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async updateSlug(
    idCampanha: IdCampanha,
    slug: string | null,
    _context?: ArrecadacaoRepositoryContext,
  ): Promise<void> {
    return tracer.startActiveSpan('db.arrecadacao_campanhas.updateSlug', async (span) => {
      span.setAttributes({ ...DB_ATTRS, 'db.operation.name': 'UPDATE' });
      try {
        // Single-column update mirroring the Postgres adapter — no-op for
        // unknown id (the caller owner-gates before calling).
        const campanha = this.campanhas.get(idCampanha);
        if (campanha) {
          this.campanhas.set(idCampanha, { ...campanha, slug });
        }
        span.setStatus({ code: SpanStatusCode.OK });
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
