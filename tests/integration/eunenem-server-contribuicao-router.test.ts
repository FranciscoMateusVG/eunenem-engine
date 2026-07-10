/**
 * Integration test for the contribuicao tRPC router (aperture-d6atj).
 *
 * Validates the full HTTP-tRPC pipeline end-to-end:
 *   - Session resolution (cookie → idUsuario → idConta → campanha → opção presente)
 *   - Multi-tenant boundary (user B cannot mutate user A's contribuicoes)
 *   - Sold-slot guards (Plan 0015/0016: update is unguarded; delete refuses
 *     slots with an aprovado pagamento referencing them)
 *   - Error mapping (domain errors → tRPCError codes)
 *
 * Uses in-memory adapters (no Postgres dependency — fast, hermetic). The
 * Postgres-specific paths are covered by `contribuicao-repository.postgres.test.ts`
 * + the fluxo tests in `tests/integration/fluxo-*.test.ts`. This suite's
 * concern is the tRPC layer and the use-cases' guard discipline, not the
 * adapter wiring.
 */

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerDeps } from '../../apps/eunenem-server/server/auth/setup.js';
import type { TrpcContext } from '../../apps/eunenem-server/server/trpc/context.js';
import { appRouter } from '../../apps/eunenem-server/server/trpc/router.js';
import { CampanhaRepositoryMemory } from '../../src/adapters/arrecadacao/campanha-repository.memory.js';
import { ContribuicaoRepositoryMemory } from '../../src/adapters/arrecadacao/contribuicao-repository.memory.js';
import { PerfilCampanhaRepositoryMemory } from '../../src/adapters/arrecadacao/perfil-campanha-repository.memory.js';
import { RecebedorRepositoryMemory } from '../../src/adapters/arrecadacao/recebedor-repository.memory.js';
import { PagamentoRepositoryMemory } from '../../src/adapters/pagamentos/repository.memory.js';
import {
  ID_PLATAFORMA_EUNENEM,
  PlataformaRepositoryMemory,
} from '../../src/adapters/plataforma/repository.memory.js';
import { ObjectStorageMemory } from '../../src/adapters/storage/object-storage.memory.js';
import { AuthServiceMemoria } from '../../src/adapters/usuario/auth-service.memory.js';
import { UsuarioRepositoryMemory } from '../../src/adapters/usuario/repository.memory.js';
import { criarRecebedorInicial } from '../../src/domain/arrecadacao/entities/recebedor.js';
import { criarItemContribuicao } from '../../src/domain/pagamentos/entities/item-do-pagamento.js';
import {
  criarPagamentoPendente,
  type Pagamento,
} from '../../src/domain/pagamentos/entities/pagamento.js';
import { NoopLogger } from '../../src/observability/noop-logger.js';
import type { Observability } from '../../src/observability/observability.js';
import { noopTracer } from '../../src/observability/tracer.js';
import { criarSessaoUsuario } from '../../src/use-cases/usuario/criar-sessao-usuario.js';
import { registrarContaUsuario } from '../../src/use-cases/usuario/registrar-conta-usuario.js';

const SESSION_COOKIE = 'better-auth.session_token';

interface TestRig {
  /**
   * Caller factory — given a session cookie (or undefined for anonymous),
   * returns a tRPC caller bound to a fresh per-request context. This is
   * the same boundary `fetchRequestHandler` would normally cross at the
   * HTTP layer, minus the JSON serialization (the procedure inputs are
   * already validated by the same Zod schemas, so we exercise everything
   * but the HTTP envelope).
   *
   * Going through `createCaller` lets the integration test run from the
   * root tests/ directory without needing `@trpc/server/adapters/fetch`
   * (which lives only in apps/eunenem-server/node_modules — the engine
   * package doesn't take a hard dep on it).
   */
  callerFor: (cookieHeader?: string) => ReturnType<typeof appRouter.createCaller>;
  /** Per-user fixtures captured by `seedUserWithCampanha`. */
  users: Record<string, SeededUser>;
}

interface SeededUser {
  readonly idUsuario: string;
  readonly idConta: string;
  readonly idCampanha: string;
  readonly idOpcaoPresentes: string;
  readonly token: string;
  readonly cookieHeader: string;
}

/**
 * Build a fresh Hono app wired to the real `appRouter` over an in-memory
 * dependency graph. Each test invokes `buildTestRig()` so state is per-test.
 */
function buildTestRig(): TestRig {
  const observability: Observability = {
    logger: new NoopLogger(),
    tracer: noopTracer(),
  };

  const usuarioRepository = new UsuarioRepositoryMemory();
  const plataformaRepository = new PlataformaRepositoryMemory();
  const authService = new AuthServiceMemoria();
  const recebedorRepository = new RecebedorRepositoryMemory();
  const campanhaRepository = new CampanhaRepositoryMemory(recebedorRepository);
  const contribuicaoRepository = new ContribuicaoRepositoryMemory();
  // Plan 0016 (aperture-eg1s2): contribuicao.list / create / update / delete
  // all reach pagamentoRepository.somarQuantidadesContribuicoesEm-
  // PagamentosAprovados to derive the esgotada/quantidadeRestante predicate.
  // Real in-memory repo (empty = nothing sold) — the previous omission left
  // it undefined and every projection path threw.
  const pagamentoRepository = new PagamentoRepositoryMemory();
  // aperture-tua9o: contribuicao.emitirUrlUploadImagemItem reaches
  // ctx.deps.objectStorage to mint the presigned PUT URL. In-memory fake
  // mints deterministic memory:// URLs + records every call.
  const objectStorage = new ObjectStorageMemory();

  // Minimal ServerDeps shape — only the fields actually read by the
  // contribuicao/auth routers. `auth` is unused by contribuicao-router so
  // we stub it just enough to satisfy the type.
  const deps: ServerDeps = {
    db: {} as never,
    auth: {} as never,
    authService,
    usuarioRepository,
    perfilCampanhaRepository: new PerfilCampanhaRepositoryMemory(),
    plataformaRepository,
    campanhaRepository,
    contribuicaoRepository,
    recebedorRepository,
    pagamentoRepository,
    objectStorage,
    observability,
    clock: () => new Date(),
    sessionCookieName: SESSION_COOKIE,
  };

  const callerFor: TestRig['callerFor'] = (cookieHeader) => {
    const headers = new Headers();
    if (cookieHeader) headers.set('cookie', cookieHeader);
    const ctx: TrpcContext = {
      deps,
      headers,
      resHeaders: new Headers(),
    };
    return appRouter.createCaller(ctx);
  };

  const rig: TestRig = { callerFor, users: {} };

  // Stash deps on the rig so seeders can reach them without re-plumbing.
  (rig as TestRig & { deps: ServerDeps }).deps = deps;

  return rig;
}

/** Sign up a user, create their campanha with one `presente` opção, sign them in, return the session cookie. */
async function seedUserWithCampanha(
  rig: TestRig,
  params: { handle: string; email: string },
): Promise<SeededUser> {
  const deps = (rig as TestRig & { deps: ServerDeps }).deps;
  const idUsuario = randomUUID();
  const idConta = randomUUID();

  // Post-rebase onto aperture-p8i01: `registrarContaUsuario` is now a saga
  // that auto-creates the default Campanha + 'presente' OpcaoContribuicao.
  // We extract idCampanha/idOpcaoPresentes from the saga result rather than
  // calling `criarCampanha` + `adicionarOpcaoContribuicao` ourselves (which
  // would produce a second campanha and confuse `findByAdministrador`).
  const { campanha } = await registrarContaUsuario(
    {
      usuarioRepository: deps.usuarioRepository,
      plataformaRepository: deps.plataformaRepository,
      campanhaRepository: deps.campanhaRepository,
      recebedorRepository: deps.recebedorRepository,
      authService: deps.authService,
      clock: deps.clock,
      observability: deps.observability,
    },
    {
      idUsuario,
      idConta,
      idPlataforma: ID_PLATAFORMA_EUNENEM,
      email: params.email,
      nomeExibicao: params.handle,
      senhaSimulada: 'senha-teste-123',
    },
  );

  const idCampanha = campanha.id;
  const opcaoPresentes = campanha.opcoes.find((o) => o.tipo === 'presente');
  if (!opcaoPresentes) {
    throw new Error('Saga did not create the presente opcao');
  }
  const idOpcaoPresentes = opcaoPresentes.id;

  // Saga creates campanha WITHOUT a recebedor (user has no PIX at signup).
  // The d6atj `findByAdministrador` (memory adapter) returns undefined when
  // there's no active recebedor — would surface as CampanhaAusenteError in
  // the contribuicao-router. Attach an initial recebedor directly so the
  // rig represents a user with PIX configured (don't re-run `criarCampanha`
  // — that would wipe the saga's opcoes by re-saving with `opcoes: []`).
  const recebedorInicial = criarRecebedorInicial({
    id: randomUUID(),
    idCampanha,
    dadosRecebedor: {
      metodo: 'pix',
      nomeTitular: params.handle,
      tipoChavePix: 'email',
      chavePix: params.email,
    },
    criadaEm: deps.clock(),
  });
  await deps.recebedorRepository.save(recebedorInicial);

  const sessao = await criarSessaoUsuario(
    {
      usuarioRepository: deps.usuarioRepository,
      authService: deps.authService,
      observability: deps.observability,
    },
    {
      idPlataforma: ID_PLATAFORMA_EUNENEM,
      email: params.email,
      senhaSimulada: 'senha-teste-123',
    },
  );

  const seeded: SeededUser = {
    idUsuario,
    idConta,
    idCampanha,
    idOpcaoPresentes,
    token: sessao.token,
    cookieHeader: `${SESSION_COOKIE}=${encodeURIComponent(sessao.token)}`,
  };
  rig.users[params.handle] = seeded;
  return seeded;
}

/**
 * Pull element 0 of a non-empty array. Lets the test stay strict (`noNonNullAssertion`
 * forbids `!` per biome.json) without scattering optional-chain noise in
 * every assertion. If the seed produced an empty array something is wrong
 * with the create procedure — surface that loudly.
 */
function requireFirst<T>(arr: readonly T[]): T {
  if (arr.length === 0) throw new Error('expected non-empty array, got empty');
  return arr[0] as T;
}

function requireAt<T>(arr: readonly T[], index: number): T {
  const v = arr[index];
  if (v === undefined) throw new Error(`expected index ${index} in array of length ${arr.length}`);
  return v;
}

/**
 * Build an `aprovado` Pagamento whose cart references `idContribuicao` with
 * the given `quantidade`. Plan 0015/0016: a slot is "locked" against delete
 * iff `somarQuantidadesContribuicoesEmPagamentosAprovados` returns a
 * positive sum for it — i.e. there's at least one aprovado pagamento item
 * pointing at the slot. This is the new way to represent the pre-0015
 * `status: 'indisponivel'` + contribuinte association the status guard
 * used to read (those fields were dropped from the Contribuicao entity).
 * Mirrors the fixture in tests/unit/arrecadacao/quantidade-restante.test.ts.
 */
function makeAprovadoPagamento(idContribuicao: string, quantidade: number): Pagamento {
  const item = criarItemContribuicao({
    id: randomUUID() as never,
    composicaoValoresItem: {
      tipo: 'contribuicao',
      idContribuicao: idContribuicao as never,
      quantidade,
      contributionUnitAmountCents: 100 as never,
      feeUnitAmountCents: 10 as never,
      receiverUnitAmountCents: 100 as never,
      lineContributionAmountCents: (100 * quantidade) as never,
      lineFeeAmountCents: (10 * quantidade) as never,
      lineReceiverAmountCents: (100 * quantidade) as never,
    },
    criadoEm: new Date(),
  });
  const base = criarPagamentoPendente({
    idPagamento: randomUUID() as never,
    idIntencaoPagamento: randomUUID() as never,
    items: [item],
    composicaoValoresAggregate: {
      idCampanha: randomUUID() as never,
      totalContributionCents: (100 * quantidade) as never,
      totalFeeCents: (10 * quantidade) as never,
      totalReceiverCents: (100 * quantidade) as never,
      totalSurchargeCents: 0,
      totalPaidCents: (110 * quantidade) as never,
      responsavelTaxa: 'contribuinte',
    },
    valorACobrarCents: (110 * quantidade) as never,
    metodo: 'pix',
    criadoEm: new Date(),
  });
  return { ...base, status: 'aprovado' as const };
}

// ── tRPC caller helpers ────────────────────────────────────────────────────

/**
 * Run a procedure that may throw a TRPCError and assert on the error code.
 * Mirrors what the HTTP layer would do: the fetchAdapter catches the throw
 * and serializes it as `{ error: { data: { code: 'UNAUTHORIZED', ... } } }`.
 * Here we just inspect the thrown object directly.
 */
async function expectTrpcError(
  fn: () => Promise<unknown>,
): Promise<{ code: string; message: string }> {
  let thrown: unknown;
  try {
    await fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeDefined();
  // Duck-typed TRPCError shape. Avoids depending on `@trpc/server`'s
  // class identity (the root tests dir + the apps/eunenem-server router
  // resolve `@trpc/server` from different node_modules trees, so a real
  // `instanceof TRPCError` check is unreliable from this side).
  const err = thrown as { code?: string; message?: string };
  expect(typeof err.code).toBe('string');
  expect(typeof err.message).toBe('string');
  return { code: err.code as string, message: err.message as string };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('eunenem-server contribuicao tRPC router (aperture-d6atj)', () => {
  let rig: TestRig;

  beforeEach(() => {
    rig = buildTestRig();
  });

  afterEach(() => {
    // No-op — every test rebuilds the rig in beforeEach.
  });

  describe('happy path — create / list / update / delete', () => {
    it('signed-in user can create 8 slots, list 8, update one, delete 2, list 6', async () => {
      const alice = await seedUserWithCampanha(rig, {
        handle: 'alice',
        email: 'alice@test.local',
      });
      const caller = rig.callerFor(alice.cookieHeader);

      // Plan 0016 (aperture-putz5, locked decision #1): `create` produces
      // ONE row per call with `quantidade=N`, NOT N rows. To exercise the
      // multi-slot list/update/delete flow we createBulk 8 DISTINCT slots
      // (each quantidade=1) → 8 rows. (Pre-0016 this test used
      // `create({ quantidade: 8 })` to fan out into 8 identical rows — the
      // row-multiplier pattern that 0016 retired.)
      const created = (await caller.contribuicao.createBulk({
        idCampanha: alice.idCampanha,
        items: Array.from({ length: 8 }, (_, i) => ({
          nome: `Fralda P ${i}`,
          valor: 5000,
          quantidade: 1,
        })),
      })) as { ids: string[] };
      expect(created.ids).toHaveLength(8);

      const list1 = (await caller.contribuicao.list()) as Array<{
        id: string;
        nome: string;
        valor: number;
        quantidade: number;
        quantidadeRestante: number;
        indisponivel: boolean;
      }>;
      expect(list1).toHaveLength(8);
      expect(list1.every((i) => i.valor === 5000)).toBe(true);
      // Plan 0015 dropped contribuição.status; the projection now exposes a
      // derived `indisponivel` predicate (false when nothing is sold).
      expect(list1.every((i) => i.indisponivel === false)).toBe(true);
      expect(list1.every((i) => i.quantidade === 1 && i.quantidadeRestante === 1)).toBe(true);

      const targetId = requireFirst(created.ids);
      const updated = (await caller.contribuicao.update({
        idCampanha: alice.idCampanha,
        id: targetId,
        nome: 'Fralda M',
        valor: 7500,
      })) as { id: string; nome: string; valor: number };
      expect(updated.id).toBe(targetId);
      expect(updated.nome).toBe('Fralda M');
      expect(updated.valor).toBe(7500);

      const deleted = (await caller.contribuicao.delete({
        idCampanha: alice.idCampanha,
        ids: [requireAt(created.ids, 1), requireAt(created.ids, 2)],
      })) as { deletedIds: string[] };
      expect(deleted.deletedIds).toEqual([created.ids[1], created.ids[2]]);

      const list2 = (await caller.contribuicao.list()) as Array<{ id: string; nome: string }>;
      expect(list2).toHaveLength(6);
      const updatedItem = list2.find((i) => i.id === targetId);
      expect(updatedItem?.nome).toBe('Fralda M');
      expect(list2.some((i) => i.id === created.ids[1] || i.id === created.ids[2])).toBe(false);
    });
  });

  describe("multi-tenant boundary — user B cannot touch user A's contribuicoes", () => {
    it('user B sees no items of user A in list (scoped to own campanha)', async () => {
      const alice = await seedUserWithCampanha(rig, {
        handle: 'alice',
        email: 'alice@test.local',
      });
      const bob = await seedUserWithCampanha(rig, {
        handle: 'bob',
        email: 'bob@test.local',
      });
      const aliceCaller = rig.callerFor(alice.cookieHeader);
      const bobCaller = rig.callerFor(bob.cookieHeader);

      await aliceCaller.contribuicao.create({
        idCampanha: alice.idCampanha,
        nome: 'Fralda',
        valor: 3000,
        quantidade: 3,
      });

      const bobList = (await bobCaller.contribuicao.list()) as Array<unknown>;
      expect(bobList).toEqual([]);
    });

    it("user B cannot update user A's contribuicao → UNAUTHORIZED", async () => {
      const alice = await seedUserWithCampanha(rig, {
        handle: 'alice',
        email: 'alice@test.local',
      });
      const bob = await seedUserWithCampanha(rig, {
        handle: 'bob',
        email: 'bob@test.local',
      });

      const aliceCaller = rig.callerFor(alice.cookieHeader);
      const bobCaller = rig.callerFor(bob.cookieHeader);

      const create = (await aliceCaller.contribuicao.create({
        idCampanha: alice.idCampanha,
        nome: 'Fralda',
        valor: 3000,
        quantidade: 1,
      })) as { ids: string[] };
      const aliceItemId = requireFirst(create.ids);

      const err = await expectTrpcError(() =>
        bobCaller.contribuicao.update({
          idCampanha: bob.idCampanha,
          id: aliceItemId,
          nome: 'Hacked',
        }),
      );
      expect(err.code).toBe('UNAUTHORIZED');
    });

    it("user B cannot delete user A's contribuicao → UNAUTHORIZED", async () => {
      const alice = await seedUserWithCampanha(rig, {
        handle: 'alice',
        email: 'alice@test.local',
      });
      const bob = await seedUserWithCampanha(rig, {
        handle: 'bob',
        email: 'bob@test.local',
      });

      const aliceCaller = rig.callerFor(alice.cookieHeader);
      const bobCaller = rig.callerFor(bob.cookieHeader);

      const create = (await aliceCaller.contribuicao.create({
        idCampanha: alice.idCampanha,
        nome: 'Fralda',
        valor: 3000,
        quantidade: 1,
      })) as { ids: string[] };
      const aliceItemId = requireFirst(create.ids);

      const err = await expectTrpcError(() =>
        bobCaller.contribuicao.delete({ idCampanha: bob.idCampanha, ids: [aliceItemId] }),
      );
      expect(err.code).toBe('UNAUTHORIZED');
    });
  });

  describe('sold-slot guards (Plan 0015/0016)', () => {
    // Plan 0015 (aperture-ucgok) DROPPED the contribuição.status +
    // contribuinte fields and the update-time "locked" guard entirely. A
    // slot is now a pure admin-owned definition: editing it is allowed at
    // ANY time, even after sales (the existing pagamento snapshot preserves
    // the price the contribuinte actually paid). The old seed trick — flip
    // `status: 'indisponivel'` + attach `contribuinte` on the entity — no
    // longer represents anything (those fields don't exist), so "sold" is
    // now modeled by an `aprovado` Pagamento whose cart references the slot.
    it('update on a SOLD contribuicao still SUCCEEDS (Plan 0015 removed the update guard)', async () => {
      const alice = await seedUserWithCampanha(rig, {
        handle: 'alice',
        email: 'alice@test.local',
      });
      const deps = (rig as TestRig & { deps: ServerDeps }).deps;
      const caller = rig.callerFor(alice.cookieHeader);

      const create = (await caller.contribuicao.create({
        idCampanha: alice.idCampanha,
        nome: 'Fralda',
        valor: 3000,
        quantidade: 1,
      })) as { ids: string[] };
      const itemId = requireFirst(create.ids);

      // Mark the slot as sold: an aprovado pagamento referencing it.
      await deps.pagamentoRepository.save(makeAprovadoPagamento(itemId, 1));

      const updated = (await caller.contribuicao.update({
        idCampanha: alice.idCampanha,
        id: itemId,
        nome: 'New name',
      })) as { id: string; nome: string; indisponivel: boolean; quantidadeRestante: number };
      expect(updated.nome).toBe('New name');
      // quantidade=1 with 1 sold → esgotada → indisponivel true, restante 0.
      expect(updated.indisponivel).toBe(true);
      expect(updated.quantidadeRestante).toBe(0);
    });

    it('delete on a SOLD contribuicao → BAD_REQUEST contribuicao_locked', async () => {
      const alice = await seedUserWithCampanha(rig, {
        handle: 'alice',
        email: 'alice@test.local',
      });
      const deps = (rig as TestRig & { deps: ServerDeps }).deps;
      const caller = rig.callerFor(alice.cookieHeader);

      const create = (await caller.contribuicao.create({
        idCampanha: alice.idCampanha,
        nome: 'Fralda',
        valor: 3000,
        quantidade: 1,
      })) as { ids: string[] };
      const itemId = requireFirst(create.ids);

      // Plan 0016 (aperture-eg1s2): removerContribuicao refuses delete when
      // any aprovado pagamento sums >0 against the slot (referential
      // integrity for the lançamento ledger). Seed that sold state.
      await deps.pagamentoRepository.save(makeAprovadoPagamento(itemId, 1));

      const err = await expectTrpcError(() =>
        caller.contribuicao.delete({ idCampanha: alice.idCampanha, ids: [itemId] }),
      );
      expect(err.code).toBe('BAD_REQUEST');
      expect(err.message).toBe('contribuicao_locked');
    });
  });

  describe('anonymous requests', () => {
    it('list without session → UNAUTHORIZED', async () => {
      const caller = rig.callerFor();
      const err = await expectTrpcError(() => caller.contribuicao.list());
      expect(err.code).toBe('UNAUTHORIZED');
    });

    it('create without session → UNAUTHORIZED', async () => {
      const caller = rig.callerFor();
      const err = await expectTrpcError(() =>
        caller.contribuicao.create({
          idCampanha: randomUUID(),
          nome: 'X',
          valor: 100,
          quantidade: 1,
        }),
      );
      expect(err.code).toBe('UNAUTHORIZED');
    });

    it('update without session → UNAUTHORIZED', async () => {
      const caller = rig.callerFor();
      const err = await expectTrpcError(() =>
        caller.contribuicao.update({ idCampanha: randomUUID(), id: randomUUID(), nome: 'X' }),
      );
      expect(err.code).toBe('UNAUTHORIZED');
    });

    it('delete without session → UNAUTHORIZED', async () => {
      const caller = rig.callerFor();
      const err = await expectTrpcError(() =>
        caller.contribuicao.delete({ idCampanha: randomUUID(), ids: [randomUUID()] }),
      );
      expect(err.code).toBe('UNAUTHORIZED');
    });
  });

  describe('createBulk — bulk insert across M items × qty (aperture-d6atj fix-up)', () => {
    it('N=1 item, qty=1 → produces 1 contribuicao via single INSERT', async () => {
      const alice = await seedUserWithCampanha(rig, {
        handle: 'alice',
        email: 'alice@test.local',
      });
      const caller = rig.callerFor(alice.cookieHeader);

      const result = (await caller.contribuicao.createBulk({
        idCampanha: alice.idCampanha,
        items: [{ nome: 'Fralda P', valor: 5000, quantidade: 1 }],
      })) as { ids: string[] };
      expect(result.ids).toHaveLength(1);

      const list = (await caller.contribuicao.list()) as Array<{ nome: string }>;
      expect(list).toHaveLength(1);
      expect(list[0]?.nome).toBe('Fralda P');
    });

    it('N=1 item, quantidade=10 → produces ONE slot-row with quantidade=10', async () => {
      const alice = await seedUserWithCampanha(rig, {
        handle: 'alice',
        email: 'alice@test.local',
      });
      const caller = rig.callerFor(alice.cookieHeader);

      // Plan 0016 (aperture-putz5, locked decision #1): `quantidade=10` is
      // ONE row with `quantidade=10`, NOT 10 rows. Pre-0016 this fanned out
      // into 10 identical quantidade=1 rows (the retired row-multiplier).
      const result = (await caller.contribuicao.createBulk({
        idCampanha: alice.idCampanha,
        items: [{ nome: 'Pacote Fraldas RN', valor: 8000, quantidade: 10 }],
      })) as { ids: string[] };
      expect(result.ids).toHaveLength(1);

      const list = (await caller.contribuicao.list()) as Array<{
        nome: string;
        valor: number;
        quantidade: number;
        quantidadeRestante: number;
      }>;
      expect(list).toHaveLength(1);
      const [row] = list;
      expect(row?.nome).toBe('Pacote Fraldas RN');
      expect(row?.valor).toBe(8000);
      expect(row?.quantidade).toBe(10);
      // Nothing sold yet → full capacity remaining.
      expect(row?.quantidadeRestante).toBe(10);
    });

    it('N=10 items × quantidade=3 → produces 10 slot-rows, each quantidade=3 (kit chá de bebê)', async () => {
      const alice = await seedUserWithCampanha(rig, {
        handle: 'alice',
        email: 'alice@test.local',
      });
      const caller = rig.callerFor(alice.cookieHeader);

      const items = Array.from({ length: 10 }, (_, i) => ({
        nome: `Item kit ${i}`,
        valor: 1000 + i * 100,
        quantidade: 3,
      }));

      // Plan 0016 (locked decision #1): each catalog item is ONE slot-row
      // carrying its own `quantidade`. 10 items → 10 rows (not 30).
      const result = (await caller.contribuicao.createBulk({
        idCampanha: alice.idCampanha,
        items,
      })) as { ids: string[] };
      expect(result.ids).toHaveLength(10);
      expect(new Set(result.ids).size).toBe(10);

      const list = (await caller.contribuicao.list()) as Array<{
        nome: string;
        quantidade: number;
      }>;
      expect(list).toHaveLength(10);
      // Every catalog name appears exactly once, each carrying quantidade=3.
      for (let i = 0; i < 10; i++) {
        const matches = list.filter((c) => c.nome === `Item kit ${i}`);
        expect(matches).toHaveLength(1);
        expect(matches[0]?.quantidade).toBe(3);
      }
    });

    it('N=50 items × qty=1 → single bulk INSERT of 50 rows', async () => {
      const alice = await seedUserWithCampanha(rig, {
        handle: 'alice',
        email: 'alice@test.local',
      });
      const caller = rig.callerFor(alice.cookieHeader);

      const items = Array.from({ length: 50 }, (_, i) => ({
        nome: `Single ${i}`,
        valor: 100,
        quantidade: 1,
      }));

      const result = (await caller.contribuicao.createBulk({
        idCampanha: alice.idCampanha,
        items,
      })) as { ids: string[] };
      expect(result.ids).toHaveLength(50);

      const list = (await caller.contribuicao.list()) as Array<unknown>;
      expect(list).toHaveLength(50);
    });

    it('authorization: bulk items share the session-derived idCampanha/idOpcao', async () => {
      const alice = await seedUserWithCampanha(rig, {
        handle: 'alice',
        email: 'alice@test.local',
      });
      const deps = (rig as TestRig & { deps: ServerDeps }).deps;
      const caller = rig.callerFor(alice.cookieHeader);

      const result = (await caller.contribuicao.createBulk({
        idCampanha: alice.idCampanha,
        items: [
          { nome: 'A', valor: 100, quantidade: 2 },
          { nome: 'B', valor: 200, quantidade: 3 },
        ],
      })) as { ids: string[] };

      // Every persisted row carries alice's idCampanha + idOpcaoPresentes —
      // procedure derives them from session, client cannot override.
      for (const id of result.ids) {
        const row = await deps.contribuicaoRepository.findById(id);
        expect(row?.idCampanha).toBe(alice.idCampanha);
        expect(row?.idOpcaoContribuicao).toBe(alice.idOpcaoPresentes);
      }
    });

    it('all-or-nothing: invalid item (negative valor) → none persist', async () => {
      const alice = await seedUserWithCampanha(rig, {
        handle: 'alice',
        email: 'alice@test.local',
      });
      const caller = rig.callerFor(alice.cookieHeader);

      const err = await expectTrpcError(() =>
        caller.contribuicao.createBulk({
          idCampanha: alice.idCampanha,
          items: [
            { nome: 'Valid', valor: 100, quantidade: 5 },
            { nome: 'Invalid', valor: -1, quantidade: 1 },
          ],
        }),
      );
      expect(err.code).toBe('BAD_REQUEST');

      // Zero rows persisted — the "Valid" item did NOT slip through.
      const list = (await caller.contribuicao.list()) as Array<unknown>;
      expect(list).toEqual([]);
    });

    it('aperture-phbwo: item with valor=0 → BAD_REQUEST at the boundary, none persist', async () => {
      // Regression for the live curadoria bug: the tRPC boundary used to be
      // .nonnegative(), so a zero-priced catalog item passed the wire layer
      // and was rejected deeper by the domain use-case with a confusing
      // "Too small: expected number to be >0" message. The boundary is now
      // .positive() — a R$0 contribuição fails fast here, clearly. (The prior
      // negative-valor test only covers -1, which .nonnegative() already
      // rejected, so it never locked the valor=0 case.)
      const alice = await seedUserWithCampanha(rig, {
        handle: 'alice',
        email: 'alice@test.local',
      });
      const caller = rig.callerFor(alice.cookieHeader);

      const err = await expectTrpcError(() =>
        caller.contribuicao.createBulk({
          idCampanha: alice.idCampanha,
          items: [
            { nome: 'Valid', valor: 4990, quantidade: 1 },
            { nome: 'Zero-priced item', valor: 0, quantidade: 1 },
          ],
        }),
      );
      expect(err.code).toBe('BAD_REQUEST');

      // All-or-nothing: the valid item did NOT slip through.
      const list = (await caller.contribuicao.list()) as Array<unknown>;
      expect(list).toEqual([]);
    });

    it('aperture-phbwo: single create with valor=0 → BAD_REQUEST', async () => {
      const alice = await seedUserWithCampanha(rig, {
        handle: 'alice',
        email: 'alice@test.local',
      });
      const caller = rig.callerFor(alice.cookieHeader);

      const err = await expectTrpcError(() =>
        caller.contribuicao.create({
          idCampanha: alice.idCampanha,
          nome: 'Zero',
          valor: 0,
          quantidade: 1,
        }),
      );
      expect(err.code).toBe('BAD_REQUEST');
    });

    it('anonymous createBulk → UNAUTHORIZED', async () => {
      const caller = rig.callerFor();
      const err = await expectTrpcError(() =>
        caller.contribuicao.createBulk({
          idCampanha: randomUUID(),
          items: [{ nome: 'X', valor: 100, quantidade: 1 }],
        }),
      );
      expect(err.code).toBe('UNAUTHORIZED');
    });

    it('regression: legacy `create` procedure still works (now delegates to createBulk internally)', async () => {
      const alice = await seedUserWithCampanha(rig, {
        handle: 'alice',
        email: 'alice@test.local',
      });
      const caller = rig.callerFor(alice.cookieHeader);

      // Plan 0016 (locked decision #1): `create` produces ONE row with
      // `quantidade=N` (it delegates to createBulk with a single item),
      // NOT N rows. Pre-0016 this asserted 4 rows from the row-multiplier.
      const created = (await caller.contribuicao.create({
        idCampanha: alice.idCampanha,
        nome: 'Fralda P',
        valor: 5000,
        quantidade: 4,
      })) as { ids: string[] };
      expect(created.ids).toHaveLength(1);

      const list = (await caller.contribuicao.list()) as Array<{
        nome: string;
        quantidade: number;
      }>;
      expect(list).toHaveLength(1);
      expect(list[0]?.nome).toBe('Fralda P');
      expect(list[0]?.quantidade).toBe(4);
    });
  });

  describe('emitirUrlUploadImagemItem (aperture-tua9o)', () => {
    it('authed user gets a presigned result keyed under itens/', async () => {
      const alice = await seedUserWithCampanha(rig, {
        handle: 'alice',
        email: 'alice@test.local',
      });
      const caller = rig.callerFor(alice.cookieHeader);

      const result = (await caller.contribuicao.emitirUrlUploadImagemItem({
        idCampanha: alice.idCampanha,
        contentType: 'image/jpeg',
      })) as { uploadUrl: string; objectKey: string; publicUrl: string };

      expect(result.uploadUrl).toBeTruthy();
      expect(result.objectKey).toBeTruthy();
      expect(result.publicUrl).toBeTruthy();
      // Item images have NO slot — namespaced under itens/.
      expect(result.objectKey.startsWith('itens/')).toBe(true);
      expect(result.publicUrl).toContain(result.objectKey);
    });

    it('anonymous emitirUrlUploadImagemItem → UNAUTHORIZED', async () => {
      const caller = rig.callerFor();
      const err = await expectTrpcError(() =>
        caller.contribuicao.emitirUrlUploadImagemItem({
          idCampanha: randomUUID(),
          contentType: 'image/jpeg',
        }),
      );
      expect(err.code).toBe('UNAUTHORIZED');
    });
  });

  describe('cross-campanha unknown id', () => {
    it('update with id that exists in another campanha → UNAUTHORIZED (not NOT_FOUND)', async () => {
      const alice = await seedUserWithCampanha(rig, {
        handle: 'alice',
        email: 'alice@test.local',
      });
      const bob = await seedUserWithCampanha(rig, {
        handle: 'bob',
        email: 'bob@test.local',
      });
      const aliceCaller = rig.callerFor(alice.cookieHeader);
      const bobCaller = rig.callerFor(bob.cookieHeader);

      const create = (await aliceCaller.contribuicao.create({
        idCampanha: alice.idCampanha,
        nome: 'Fralda',
        valor: 3000,
        quantidade: 1,
      })) as { ids: string[] };
      const aliceItemId = requireFirst(create.ids);

      // Bob's session resolves to bob's campanha → existing.idCampanha !==
      // session.idCampanha → ArrecadacaoNaoAutorizadoError → UNAUTHORIZED.
      // We deliberately surface authz before existence to keep the
      // "wrong tenant" signal consistent. NOT_FOUND would be wrong here
      // (the row exists; bob just doesn't own it).
      const err = await expectTrpcError(() =>
        bobCaller.contribuicao.update({
          idCampanha: bob.idCampanha,
          id: aliceItemId,
          nome: 'Hacked',
        }),
      );
      expect(err.code).toBe('UNAUTHORIZED');
    });

    it('update with id that does not exist anywhere → NOT_FOUND', async () => {
      const alice = await seedUserWithCampanha(rig, {
        handle: 'alice',
        email: 'alice@test.local',
      });
      const caller = rig.callerFor(alice.cookieHeader);

      const err = await expectTrpcError(() =>
        caller.contribuicao.update({ idCampanha: alice.idCampanha, id: randomUUID(), nome: 'X' }),
      );
      expect(err.code).toBe('NOT_FOUND');
    });
  });
});
