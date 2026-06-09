/**
 * Shared conformance test suite for PagamentoRepository implementations.
 *
 * Any adapter implementing PagamentoRepository must pass these tests. This
 * ensures the in-memory adapter (PagamentoRepositoryMemory) and the Postgres
 * adapter (PagamentoRepositoryPostgres) conform to the same contract.
 *
 * Includes behavioral tests (save, update, find, error mapping) AND
 * observability tests (every method must produce a span with the correct
 * name and semantic attributes).
 *
 * Pattern source: tests/helpers/cat-repository.conformance.ts +
 * tests/helpers/campanha-repository.conformance.ts.
 *
 * History (aperture-cf4mi): PagamentoRepository was the only first-class
 * repository in the EuNenem engine without a shared conformance rig — the
 * old tests/unit/pagamentos/repository.memory.test.ts covered the memory
 * adapter directly + the Postgres adapter had no direct test at all (it
 * was exercised only via fluxo-* integration tests). Plan 0016 adds a new
 * bulk query method that needs memory-vs-postgres parity; the rig is the
 * landing surface for that method (and the existing methods that had no
 * shared coverage either, notably findByExternalRef +
 * findIdsContribuicoesComPagamentoAprovado +
 * findContribuintesFromLatestAprovadoPagamento).
 *
 * Usage:
 *   describePagamentoRepositoryConformance('Memory', {
 *     factory: () => new PagamentoRepositoryMemory(),
 *     getSpans: () => testObs.getSpans(),
 *     resetSpans: () => testObs.reset(),
 *     expectedDbSystem: 'memory',
 *   });
 */
import { randomUUID } from 'node:crypto';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PagamentoRepository } from '../../src/adapters/pagamentos/repository.js';
import {
  criarItemContribuicao,
  type ItemDoPagamento,
} from '../../src/domain/pagamentos/entities/item-do-pagamento.js';
import {
  criarPagamentoPendente,
  type Pagamento,
  PagamentoSchema,
} from '../../src/domain/pagamentos/entities/pagamento.js';
import type {
  IdContribuicaoPagamento,
  IdPagamento,
} from '../../src/domain/pagamentos/value-objects/ids.js';
import { PagamentoJaExisteError } from '../../src/errors/pagamentos/ja-existe.error.js';
import { PagamentoNaoEncontradoError } from '../../src/errors/pagamentos/nao-encontrado.error.js';

interface ConformanceOptions {
  /** Factory that returns a fresh PagamentoRepository instance. */
  factory: () => PagamentoRepository | Promise<PagamentoRepository>;
  /** Called before each test to reset state (e.g., truncate tables). */
  resetState?: () => Promise<void>;
  /** Returns all finished spans since the last reset. */
  getSpans: () => ReadableSpan[];
  /** Resets the span exporter. Called before each test. */
  resetSpans: () => void;
  /** Expected value of `db.system` attribute ('memory' or 'postgresql'). */
  expectedDbSystem: string;
}

export function describePagamentoRepositoryConformance(name: string, options: ConformanceOptions) {
  describe(`PagamentoRepository conformance — ${name}`, () => {
    let repo: PagamentoRepository;

    beforeEach(async () => {
      if (options.resetState) {
        await options.resetState();
      }
      options.resetSpans();
      repo = await options.factory();
    });

    // ───────── save + findById ─────────

    it('saves and finds a pagamento by id', async () => {
      const pagamento = makePagamento();
      await repo.save(pagamento);

      const found = await repo.findById(pagamento.id);
      // Both adapters must return the schema-canonical form of what was
      // saved. The Postgres adapter round-trips through PagamentoSchema.parse
      // (which surfaces surchargeCents=0 default + an explicit
      // transacaoExterna=undefined key); the memory adapter returns the
      // literal saved object. Parsing both sides through the schema pins
      // the contract on canonical equivalence rather than adapter quirks.
      expect(PagamentoSchema.parse(found)).toEqual(PagamentoSchema.parse(pagamento));
    });

    it('rejects duplicate pagamento ids with PagamentoJaExisteError', async () => {
      const pagamento = makePagamento();
      await repo.save(pagamento);

      await expect(repo.save(pagamento)).rejects.toThrow(PagamentoJaExisteError);
    });

    it('findById returns undefined for non-existent id', async () => {
      await expect(repo.findById(randomUUID())).resolves.toBeUndefined();
    });

    // ───────── update ─────────

    it('updates an existing pagamento', async () => {
      const pagamento = makePagamento();
      const updated: Pagamento = {
        ...pagamento,
        atualizadoEm: new Date('2026-05-01T12:10:00.000Z'),
      };

      await repo.save(pagamento);
      await repo.update(updated);

      const found = await repo.findById(pagamento.id);
      // Same canonical-form rule as the save+findById test above.
      expect(PagamentoSchema.parse(found)).toEqual(PagamentoSchema.parse(updated));
    });

    it('update throws PagamentoNaoEncontradoError when pagamento is missing', async () => {
      await expect(repo.update(makePagamento())).rejects.toThrow(PagamentoNaoEncontradoError);
    });

    // ───────── findByContribuicao (aperture-i0pz8) ─────────

    it('findByContribuicao returns empty array when no pagamentos exist', async () => {
      await expect(repo.findByContribuicao(randomUUID())).resolves.toEqual([]);
    });

    it('findByContribuicao returns the single matching pagamento', async () => {
      const target = randomUUID();
      const pagamento = makePagamento({ idContribuicao: target });
      await repo.save(pagamento);

      const found = await repo.findByContribuicao(target);
      expect(found).toHaveLength(1);
      expect(found[0]?.id).toBe(pagamento.id);
    });

    it('findByContribuicao returns ALL matching pagamentos in criadoEm ASC order', async () => {
      const target = randomUUID();
      const other = randomUUID();

      const newer = makePagamento({
        idContribuicao: target,
        criadoEm: new Date('2026-05-03T00:00:00.000Z'),
      });
      const oldest = makePagamento({
        idContribuicao: target,
        criadoEm: new Date('2026-05-01T00:00:00.000Z'),
      });
      const middle = makePagamento({
        idContribuicao: target,
        criadoEm: new Date('2026-05-02T00:00:00.000Z'),
      });
      const unrelated = makePagamento({
        idContribuicao: other,
        criadoEm: new Date('2026-05-01T12:00:00.000Z'),
      });

      // Save out-of-order to prove sorting works.
      await repo.save(newer);
      await repo.save(oldest);
      await repo.save(middle);
      await repo.save(unrelated);

      const found = await repo.findByContribuicao(target);
      expect(found.map((p) => p.id)).toEqual([oldest.id, middle.id, newer.id]);
      expect(found.map((p) => p.id)).not.toContain(unrelated.id);
    });

    it('findByContribuicao tolerates the full lifecycle mix (pendente / aprovado / rejeitado)', async () => {
      const target = randomUUID();

      const pendente = makePagamento({ idContribuicao: target });
      const aprovado = makePagamento({ idContribuicao: target, status: 'aprovado' });
      const rejeitado = makePagamento({ idContribuicao: target, status: 'rejeitado' });

      await repo.save(pendente);
      await repo.save(aprovado);
      await repo.save(rejeitado);

      const found = await repo.findByContribuicao(target);
      expect(found).toHaveLength(3);
      const statuses = found.map((p) => p.status).sort();
      expect(statuses).toEqual(['aprovado', 'pendente', 'rejeitado']);
    });

    // ───────── findByExternalRef (aperture-xaha2) ─────────

    it('findByExternalRef returns the pagamento whose intencao carries the externalRef', async () => {
      const pagamento = makePagamento({ externalRef: 'cs_test_externalref_001' });
      await repo.save(pagamento);

      const found = await repo.findByExternalRef('cs_test_externalref_001');
      expect(found?.id).toBe(pagamento.id);
      expect(found?.intencao.externalRef).toBe('cs_test_externalref_001');
    });

    it('findByExternalRef returns undefined for unknown ref', async () => {
      await repo.save(makePagamento({ externalRef: 'cs_test_known' }));
      await expect(repo.findByExternalRef('cs_test_unknown')).resolves.toBeUndefined();
    });

    it('findByExternalRef does not match pagamentos with null externalRef', async () => {
      // Pagamentos created via the saga before the webhook arrives have
      // externalRef === null. An empty-string lookup must NOT match them.
      await repo.save(makePagamento()); // externalRef defaults to null
      await expect(repo.findByExternalRef('')).resolves.toBeUndefined();
    });

    // ───────── findByPaymentIntentExternalRef + findByChargeExternalRef (aperture-wif8s) ─────────

    it('findByPaymentIntentExternalRef returns the pagamento whose intencao carries the pi', async () => {
      const pagamento = makePagamento({ paymentIntentExternalRef: 'pi_test_abc123' });
      await repo.save(pagamento);

      const found = await repo.findByPaymentIntentExternalRef('pi_test_abc123');
      expect(found?.id).toBe(pagamento.id);
      expect(found?.intencao.paymentIntentExternalRef).toBe('pi_test_abc123');
    });

    it('findByPaymentIntentExternalRef returns undefined for unknown pi_xxx', async () => {
      await repo.save(makePagamento({ paymentIntentExternalRef: 'pi_test_known' }));
      await expect(
        repo.findByPaymentIntentExternalRef('pi_does_not_exist'),
      ).resolves.toBeUndefined();
    });

    it('findByPaymentIntentExternalRef does not match pagamentos with null intencao.paymentIntentExternalRef', async () => {
      await repo.save(makePagamento()); // paymentIntentExternalRef defaults to null
      await expect(repo.findByPaymentIntentExternalRef('')).resolves.toBeUndefined();
    });

    it('findByChargeExternalRef returns the pagamento whose intencao carries the ch', async () => {
      const pagamento = makePagamento({ chargeExternalRef: 'ch_test_xyz789' });
      await repo.save(pagamento);

      const found = await repo.findByChargeExternalRef('ch_test_xyz789');
      expect(found?.id).toBe(pagamento.id);
      expect(found?.intencao.chargeExternalRef).toBe('ch_test_xyz789');
    });

    it('findByChargeExternalRef returns undefined for unknown ch_xxx', async () => {
      await repo.save(makePagamento({ chargeExternalRef: 'ch_test_known' }));
      await expect(repo.findByChargeExternalRef('ch_does_not_exist')).resolves.toBeUndefined();
    });

    it('findByChargeExternalRef does not match pagamentos with null intencao.chargeExternalRef', async () => {
      await repo.save(makePagamento());
      await expect(repo.findByChargeExternalRef('')).resolves.toBeUndefined();
    });

    it('pi + ch refs round-trip through save plus update', async () => {
      const pagamento = makePagamento(); // both refs null at creation
      await repo.save(pagamento);

      const updated: Pagamento = {
        ...pagamento,
        intencao: {
          ...pagamento.intencao,
          paymentIntentExternalRef: 'pi_test_round_trip',
          chargeExternalRef: 'ch_test_round_trip',
        },
      };
      await repo.update(updated);

      const reloaded = await repo.findById(pagamento.id);
      expect(reloaded?.intencao.paymentIntentExternalRef).toBe('pi_test_round_trip');
      expect(reloaded?.intencao.chargeExternalRef).toBe('ch_test_round_trip');

      expect((await repo.findByPaymentIntentExternalRef('pi_test_round_trip'))?.id).toBe(
        pagamento.id,
      );
      expect((await repo.findByChargeExternalRef('ch_test_round_trip'))?.id).toBe(pagamento.id);
    });

    // ───── somarQuantidadesContribuicoesEmPagamentosAprovados (Plan 0016 Phase 2, aperture-eg1s2) ─────

    it('somarQuantidadesContribuicoesEmPagamentosAprovados returns empty Map for empty input', async () => {
      const result = await repo.somarQuantidadesContribuicoesEmPagamentosAprovados([]);
      expect(result.size).toBe(0);
    });

    it('somarQuantidadesContribuicoesEmPagamentosAprovados returns 0 for every input id when no aprovado pagamentos exist', async () => {
      const idA = randomUUID();
      const idB = randomUUID();
      await repo.save(makePagamento({ idContribuicao: idA, status: 'pendente' }));
      await repo.save(makePagamento({ idContribuicao: idB, status: 'rejeitado' }));

      const result = await repo.somarQuantidadesContribuicoesEmPagamentosAprovados([idA, idB]);
      expect(result.get(idA)).toBe(0);
      expect(result.get(idB)).toBe(0);
    });

    it('somarQuantidadesContribuicoesEmPagamentosAprovados sums only aprovado contribuição-tipo items', async () => {
      const idAprovada = randomUUID();
      const idPendente = randomUUID();
      const idRejeitada = randomUUID();
      const idSemPagamento = randomUUID();

      await repo.save(makePagamento({ idContribuicao: idAprovada, status: 'aprovado' }));
      await repo.save(makePagamento({ idContribuicao: idPendente, status: 'pendente' }));
      await repo.save(makePagamento({ idContribuicao: idRejeitada, status: 'rejeitado' }));

      const result = await repo.somarQuantidadesContribuicoesEmPagamentosAprovados([
        idAprovada,
        idPendente,
        idRejeitada,
        idSemPagamento,
      ]);
      // makePagamento defaults to quantidade=1 per item.
      expect(result.get(idAprovada)).toBe(1);
      expect(result.get(idPendente)).toBe(0);
      expect(result.get(idRejeitada)).toBe(0);
      expect(result.get(idSemPagamento)).toBe(0);
    });

    it('somarQuantidadesContribuicoesEmPagamentosAprovados accumulates across multiple aprovado pagamentos per contribuição', async () => {
      const idTarget = randomUUID();
      // Locked decision #6 (accept double-pay) + Plan 0016 multi-cart shape:
      // three separate pagamentos all aprovado, each carrying a single
      // contribuicao item with quantidade=1 → sum = 3.
      await repo.save(makePagamento({ idContribuicao: idTarget, status: 'aprovado' }));
      await repo.save(makePagamento({ idContribuicao: idTarget, status: 'aprovado' }));
      await repo.save(makePagamento({ idContribuicao: idTarget, status: 'aprovado' }));

      const result = await repo.somarQuantidadesContribuicoesEmPagamentosAprovados([idTarget]);
      expect(result.get(idTarget)).toBe(3);
    });

    // ───────── findContribuintesFromLatestAprovadoPagamento (Plan 0015, aperture-6iqum) ─────────

    it('findContribuintesFromLatestAprovadoPagamento returns empty Map for empty input', async () => {
      const result = await repo.findContribuintesFromLatestAprovadoPagamento([]);
      expect(result.size).toBe(0);
    });

    it('findContribuintesFromLatestAprovadoPagamento omits keys for contribuicoes with no aprovado pagamento', async () => {
      const idAprovada = randomUUID();
      const idPendente = randomUUID();

      await repo.save(
        makePagamento({
          idContribuicao: idAprovada,
          status: 'aprovado',
          contribuinte: { nome: 'Alice', email: 'alice@example.com' },
        }),
      );
      await repo.save(
        makePagamento({
          idContribuicao: idPendente,
          status: 'pendente',
          contribuinte: { nome: 'Bob', email: 'bob@example.com' },
        }),
      );

      const result = await repo.findContribuintesFromLatestAprovadoPagamento([
        idAprovada,
        idPendente,
      ]);
      expect(result.size).toBe(1);
      expect(result.get(idAprovada)).toEqual({ nome: 'Alice', email: 'alice@example.com' });
      expect(result.has(idPendente)).toBe(false);
    });

    it('findContribuintesFromLatestAprovadoPagamento returns null for aprovado pagamentos with null contribuinte (anonymous checkout)', async () => {
      const idAnonima = randomUUID();
      await repo.save(
        makePagamento({ idContribuicao: idAnonima, status: 'aprovado', contribuinte: null }),
      );

      const result = await repo.findContribuintesFromLatestAprovadoPagamento([idAnonima]);
      expect(result.size).toBe(1);
      expect(result.get(idAnonima)).toBeNull();
    });

    it('findContribuintesFromLatestAprovadoPagamento returns the contribuinte of the MOST RECENT aprovado pagamento (by criadoEm DESC)', async () => {
      const idTarget = randomUUID();

      // Three aprovado pagamentos for the same contribuicao at different
      // times — the result must reflect the latest one's contribuinte.
      await repo.save(
        makePagamento({
          idContribuicao: idTarget,
          status: 'aprovado',
          criadoEm: new Date('2026-05-01T00:00:00.000Z'),
          contribuinte: { nome: 'First', email: 'first@example.com' },
        }),
      );
      await repo.save(
        makePagamento({
          idContribuicao: idTarget,
          status: 'aprovado',
          criadoEm: new Date('2026-05-03T00:00:00.000Z'),
          contribuinte: { nome: 'Latest', email: 'latest@example.com' },
        }),
      );
      await repo.save(
        makePagamento({
          idContribuicao: idTarget,
          status: 'aprovado',
          criadoEm: new Date('2026-05-02T00:00:00.000Z'),
          contribuinte: { nome: 'Middle', email: 'middle@example.com' },
        }),
      );

      const result = await repo.findContribuintesFromLatestAprovadoPagamento([idTarget]);
      expect(result.get(idTarget)).toEqual({
        nome: 'Latest',
        email: 'latest@example.com',
      });
    });

    it('findContribuintesFromLatestAprovadoPagamento includes mensagem when present and omits the key when undefined', async () => {
      const idComMensagem = randomUUID();
      const idSemMensagem = randomUUID();

      await repo.save(
        makePagamento({
          idContribuicao: idComMensagem,
          status: 'aprovado',
          contribuinte: { nome: 'Carla', email: 'carla@example.com', mensagem: 'Parabéns!' },
        }),
      );
      await repo.save(
        makePagamento({
          idContribuicao: idSemMensagem,
          status: 'aprovado',
          contribuinte: { nome: 'Davi', email: 'davi@example.com' },
        }),
      );

      const result = await repo.findContribuintesFromLatestAprovadoPagamento([
        idComMensagem,
        idSemMensagem,
      ]);
      expect(result.get(idComMensagem)).toEqual({
        nome: 'Carla',
        email: 'carla@example.com',
        mensagem: 'Parabéns!',
      });
      // mensagem key absent (not null) when contribuinte had no mensagem
      // — both adapters spread it conditionally per the schema's optional
      // field semantics.
      expect(result.get(idSemMensagem)).toEqual({
        nome: 'Davi',
        email: 'davi@example.com',
      });
      expect(result.get(idSemMensagem)).not.toHaveProperty('mensagem');
    });

    it('findContribuintesFromLatestAprovadoPagamento ignores pendente / rejeitado pagamentos even when more recent than aprovado', async () => {
      const idTarget = randomUUID();

      // An older aprovado pagamento and a newer rejeitado pagamento for
      // the same contribuicao — the result must still come from the
      // aprovado one.
      await repo.save(
        makePagamento({
          idContribuicao: idTarget,
          status: 'aprovado',
          criadoEm: new Date('2026-05-01T00:00:00.000Z'),
          contribuinte: { nome: 'AprovadoOld', email: 'old@example.com' },
        }),
      );
      await repo.save(
        makePagamento({
          idContribuicao: idTarget,
          status: 'rejeitado',
          criadoEm: new Date('2026-05-02T00:00:00.000Z'),
          contribuinte: { nome: 'RejeitadoNew', email: 'new@example.com' },
        }),
      );

      const result = await repo.findContribuintesFromLatestAprovadoPagamento([idTarget]);
      expect(result.get(idTarget)).toEqual({
        nome: 'AprovadoOld',
        email: 'old@example.com',
      });
    });

    // ═══════════════ SPAN EMISSION ═══════════════
    // Every method must emit a db.pagamentos.<method> span with the
    // expected db.system + db.operation.name + db.collection.name.

    it('save emits a db.pagamentos.save span with correct attributes', async () => {
      await repo.save(makePagamento());

      const span = findSpan(options.getSpans(), 'db.pagamentos.save');
      expect(span).toBeDefined();
      expect(span?.attributes['db.system']).toBe(options.expectedDbSystem);
      expect(span?.attributes['db.operation.name']).toBe('INSERT');
      expect(span?.attributes['db.collection.name']).toBe('pagamentos');
    });

    it('save records an exception on the span when the pagamento id collides', async () => {
      const pagamento = makePagamento();
      await repo.save(pagamento);
      options.resetSpans();

      try {
        await repo.save(pagamento);
      } catch {
        // expected — duplicate-id PagamentoJaExisteError
      }

      const span = findSpan(options.getSpans(), 'db.pagamentos.save');
      expect(span).toBeDefined();
      expect(span?.status.code).toBe(2); // SpanStatusCode.ERROR === 2
      expect(span?.events.some((e) => e.name === 'exception')).toBe(true);
    });

    it('update emits a db.pagamentos.update span with correct attributes', async () => {
      const pagamento = makePagamento();
      await repo.save(pagamento);
      options.resetSpans();

      await repo.update(pagamento);

      const span = findSpan(options.getSpans(), 'db.pagamentos.update');
      expect(span).toBeDefined();
      expect(span?.attributes['db.system']).toBe(options.expectedDbSystem);
      expect(span?.attributes['db.operation.name']).toBe('UPDATE');
      expect(span?.attributes['db.collection.name']).toBe('pagamentos');
    });

    it('findById emits a db.pagamentos.findById span with correct attributes', async () => {
      await repo.findById(randomUUID());

      const span = findSpan(options.getSpans(), 'db.pagamentos.findById');
      expect(span).toBeDefined();
      expect(span?.attributes['db.system']).toBe(options.expectedDbSystem);
      expect(span?.attributes['db.operation.name']).toBe('SELECT');
      expect(span?.attributes['db.collection.name']).toBe('pagamentos');
    });

    it('findByExternalRef emits a db.pagamentos.findByExternalRef span with correct attributes', async () => {
      await repo.findByExternalRef('cs_test_anything');

      const span = findSpan(options.getSpans(), 'db.pagamentos.findByExternalRef');
      expect(span).toBeDefined();
      expect(span?.attributes['db.system']).toBe(options.expectedDbSystem);
      expect(span?.attributes['db.operation.name']).toBe('SELECT');
      expect(span?.attributes['db.collection.name']).toBe('pagamentos');
    });

    it('findByContribuicao emits a db.pagamentos.findByContribuicao span with correct attributes', async () => {
      await repo.findByContribuicao(randomUUID());

      const span = findSpan(options.getSpans(), 'db.pagamentos.findByContribuicao');
      expect(span).toBeDefined();
      expect(span?.attributes['db.system']).toBe(options.expectedDbSystem);
      expect(span?.attributes['db.operation.name']).toBe('SELECT');
      expect(span?.attributes['db.collection.name']).toBe('pagamentos');
    });

    it('findByPaymentIntentExternalRef emits a db.pagamentos.findByPaymentIntentExternalRef span with correct attributes', async () => {
      await repo.findByPaymentIntentExternalRef('pi_test_anything');

      const span = findSpan(options.getSpans(), 'db.pagamentos.findByPaymentIntentExternalRef');
      expect(span).toBeDefined();
      expect(span?.attributes['db.system']).toBe(options.expectedDbSystem);
      expect(span?.attributes['db.operation.name']).toBe('SELECT');
      expect(span?.attributes['db.collection.name']).toBe('pagamentos');
    });

    it('findByChargeExternalRef emits a db.pagamentos.findByChargeExternalRef span with correct attributes', async () => {
      await repo.findByChargeExternalRef('ch_test_anything');

      const span = findSpan(options.getSpans(), 'db.pagamentos.findByChargeExternalRef');
      expect(span).toBeDefined();
      expect(span?.attributes['db.system']).toBe(options.expectedDbSystem);
      expect(span?.attributes['db.operation.name']).toBe('SELECT');
      expect(span?.attributes['db.collection.name']).toBe('pagamentos');
    });

    it('somarQuantidadesContribuicoesEmPagamentosAprovados emits a db.pagamentos.somarQuantidadesContribuicoesEmPagamentosAprovados span with correct attributes', async () => {
      await repo.somarQuantidadesContribuicoesEmPagamentosAprovados([randomUUID()]);

      const span = findSpan(
        options.getSpans(),
        'db.pagamentos.somarQuantidadesContribuicoesEmPagamentosAprovados',
      );
      expect(span).toBeDefined();
      expect(span?.attributes['db.system']).toBe(options.expectedDbSystem);
      expect(span?.attributes['db.operation.name']).toBe('SELECT');
      expect(span?.attributes['db.collection.name']).toBe('pagamentos');
    });

    it('findContribuintesFromLatestAprovadoPagamento emits a db.pagamentos.findContribuintesFromLatestAprovadoPagamento span with correct attributes', async () => {
      await repo.findContribuintesFromLatestAprovadoPagamento([randomUUID()]);

      const span = findSpan(
        options.getSpans(),
        'db.pagamentos.findContribuintesFromLatestAprovadoPagamento',
      );
      expect(span).toBeDefined();
      expect(span?.attributes['db.system']).toBe(options.expectedDbSystem);
      expect(span?.attributes['db.operation.name']).toBe('SELECT');
      expect(span?.attributes['db.collection.name']).toBe('pagamentos');
    });
  });
}

// ═══════════════ FACTORY ═══════════════

interface MakePagamentoOverrides {
  /** Pagamento id. Defaults to a fresh UUID per call. */
  id?: IdPagamento | string;
  /** IntencaoPagamento.idContribuicao. Defaults to a fresh UUID per call. */
  idContribuicao?: IdContribuicaoPagamento | string;
  /** Pagamento.criadoEm. Defaults to 2026-05-01T12:00:00.000Z. */
  criadoEm?: Date;
  /** Override Pagamento.status. Defaults to 'pendente'. */
  status?: Pagamento['status'];
  /** IntencaoPagamento.externalRef. Defaults to null. */
  externalRef?: string | null;
  /** IntencaoPagamento.paymentIntentExternalRef. Defaults to null. */
  paymentIntentExternalRef?: string | null;
  /** IntencaoPagamento.chargeExternalRef. Defaults to null. */
  chargeExternalRef?: string | null;
  /** IntencaoPagamento.contribuinte. Defaults to null (anonymous). */
  contribuinte?: Pagamento['intencao']['contribuinte'];
}

/**
 * Builds a Pagamento with sensible defaults for conformance testing.
 *
 * Uses `criarPagamentoPendente` (the canonical domain factory) so the
 * returned aggregate is structurally identical to what the saga produces
 * in production. Overrides cover the fields tests need to vary —
 * lifecycle status, identity, timestamps, and the intencao fields that
 * the webhook populates post-aprovado (externalRef + pi/ch refs +
 * contribuinte).
 *
 * Defaults to pendente; pass `status: 'aprovado'` (or `'rejeitado'`) to
 * mutate the lifecycle without going through the saga — appropriate for
 * repository tests where the persistence contract is the unit-under-test,
 * not the state machine.
 */
export function makePagamento(overrides: MakePagamentoOverrides = {}): Pagamento {
  const id = (overrides.id ?? randomUUID()) as IdPagamento;
  const idContribuicao = (overrides.idContribuicao ?? randomUUID()) as IdContribuicaoPagamento;
  const idCampanha = randomUUID();
  const criadoEm = overrides.criadoEm ?? new Date('2026-05-01T12:00:00.000Z');

  // Plan 0016 Phase 2 (aperture-eg1s2): multi-item cart shape. Build a
  // single-contribuição PIX cart (1 item, no surcharge) for conformance
  // defaults — repository tests focus on persistence, not cart
  // construction. Multi-item / cartão fixtures live in the per-cart
  // tests at tests/unit/pagamentos/multi-item-cart.test.ts.
  const item: ItemDoPagamento = criarItemContribuicao({
    id: randomUUID() as never,
    composicaoValoresItem: {
      tipo: 'contribuicao',
      idContribuicao,
      quantidade: 1,
      contributionUnitAmountCents: 8000 as never,
      feeUnitAmountCents: 400 as never,
      receiverUnitAmountCents: 8000 as never,
      lineContributionAmountCents: 8000 as never,
      lineFeeAmountCents: 400 as never,
      lineReceiverAmountCents: 8000 as never,
    },
    criadoEm,
  });

  const base = criarPagamentoPendente({
    idPagamento: id,
    idIntencaoPagamento: randomUUID() as never,
    items: [item],
    composicaoValoresAggregate: {
      idCampanha: idCampanha as never,
      totalContributionCents: 8000 as never,
      totalFeeCents: 400 as never,
      totalReceiverCents: 8000 as never,
      totalSurchargeCents: 0,
      totalPaidCents: 8400 as never,
      responsavelTaxa: 'contribuinte',
    },
    valorACobrarCents: 8400 as never,
    metodo: 'pix',
    criadoEm,
  });

  // Apply intencao-level overrides + (optionally) flip lifecycle status.
  // The domain factory only produces 'pendente' — for tests covering
  // repository behavior across lifecycle states (findByContribuicao,
  // findIdsContribuicoes..., findContribuintes...), we mutate here.
  const intencaoOverrides: Partial<Pagamento['intencao']> = {};
  if (overrides.externalRef !== undefined) intencaoOverrides.externalRef = overrides.externalRef;
  if (overrides.paymentIntentExternalRef !== undefined)
    intencaoOverrides.paymentIntentExternalRef = overrides.paymentIntentExternalRef;
  if (overrides.chargeExternalRef !== undefined)
    intencaoOverrides.chargeExternalRef = overrides.chargeExternalRef;
  if (overrides.contribuinte !== undefined) intencaoOverrides.contribuinte = overrides.contribuinte;

  const result: Pagamento = {
    ...base,
    ...(overrides.status !== undefined ? { status: overrides.status } : {}),
    intencao: { ...base.intencao, ...intencaoOverrides },
  };
  return result;
}

function findSpan(spans: ReadableSpan[], name: string): ReadableSpan | undefined {
  return spans.find((s) => s.name === name);
}
