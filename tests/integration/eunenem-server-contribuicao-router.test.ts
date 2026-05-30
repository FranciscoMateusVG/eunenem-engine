/**
 * Integration test for the contribuicao tRPC router (aperture-d6atj).
 *
 * Validates the full HTTP-tRPC pipeline end-to-end:
 *   - Session resolution (cookie → idUsuario → idConta → campanha → opção presente)
 *   - Multi-tenant boundary (user B cannot mutate user A's contribuicoes)
 *   - Status guards (indisponivel contribuicoes are immutable)
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
import { RecebedorRepositoryMemory } from '../../src/adapters/arrecadacao/recebedor-repository.memory.js';
import {
  ID_PLATAFORMA_EUNENEM,
  PlataformaRepositoryMemory,
} from '../../src/adapters/plataforma/repository.memory.js';
import { AuthServiceMemoria } from '../../src/adapters/usuario/auth-service.memory.js';
import { UsuarioRepositoryMemory } from '../../src/adapters/usuario/repository.memory.js';
import { criarRecebedorInicial } from '../../src/domain/arrecadacao/entities/recebedor.js';
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

  // Minimal ServerDeps shape — only the fields actually read by the
  // contribuicao/auth routers. `auth` is unused by contribuicao-router so
  // we stub it just enough to satisfy the type.
  const deps: ServerDeps = {
    db: {} as never,
    auth: {} as never,
    authService,
    usuarioRepository,
    plataformaRepository,
    campanhaRepository,
    contribuicaoRepository,
    recebedorRepository,
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
    it('signed-in user can create 8 contribuicoes, list 8, update one, delete 2, list 6', async () => {
      const alice = await seedUserWithCampanha(rig, {
        handle: 'alice',
        email: 'alice@test.local',
      });
      const caller = rig.callerFor(alice.cookieHeader);

      const created = (await caller.contribuicao.create({
        nome: 'Fralda P',
        valor: 5000,
        qty: 8,
      })) as { ids: string[] };
      expect(created.ids).toHaveLength(8);

      const list1 = (await caller.contribuicao.list()) as Array<{
        id: string;
        nome: string;
        valor: number;
        status: string;
      }>;
      expect(list1).toHaveLength(8);
      expect(list1.every((i) => i.nome === 'Fralda P' && i.valor === 5000)).toBe(true);
      expect(list1.every((i) => i.status === 'disponivel')).toBe(true);

      const targetId = requireFirst(created.ids);
      const updated = (await caller.contribuicao.update({
        id: targetId,
        nome: 'Fralda M',
        valor: 7500,
      })) as { id: string; nome: string; valor: number };
      expect(updated.id).toBe(targetId);
      expect(updated.nome).toBe('Fralda M');
      expect(updated.valor).toBe(7500);

      const deleted = (await caller.contribuicao.delete({
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

      await aliceCaller.contribuicao.create({ nome: 'Fralda', valor: 3000, qty: 3 });

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
        nome: 'Fralda',
        valor: 3000,
        qty: 1,
      })) as { ids: string[] };
      const aliceItemId = requireFirst(create.ids);

      const err = await expectTrpcError(() =>
        bobCaller.contribuicao.update({ id: aliceItemId, nome: 'Hacked' }),
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
        nome: 'Fralda',
        valor: 3000,
        qty: 1,
      })) as { ids: string[] };
      const aliceItemId = requireFirst(create.ids);

      const err = await expectTrpcError(() =>
        bobCaller.contribuicao.delete({ ids: [aliceItemId] }),
      );
      expect(err.code).toBe('UNAUTHORIZED');
    });
  });

  describe('status guard — claimed contribuicoes are locked', () => {
    it('update on a claimed contribuicao → BAD_REQUEST contribuicao_locked', async () => {
      const alice = await seedUserWithCampanha(rig, {
        handle: 'alice',
        email: 'alice@test.local',
      });
      const deps = (rig as TestRig & { deps: ServerDeps }).deps;
      const caller = rig.callerFor(alice.cookieHeader);

      const create = (await caller.contribuicao.create({
        nome: 'Fralda',
        valor: 3000,
        qty: 1,
      })) as { ids: string[] };
      const itemId = requireFirst(create.ids);

      // Lock it via direct repo manipulation (simulates a checkout
      // associating a contribuinte and flipping status to indisponivel).
      const existing = await deps.contribuicaoRepository.findById(itemId);
      if (!existing) throw new Error('seed failed: contribuicao not found');
      await deps.contribuicaoRepository.save({
        ...existing,
        status: 'indisponivel',
        contribuinte: { nome: 'Visitante', email: 'v@test.local' },
      });

      const err = await expectTrpcError(() =>
        caller.contribuicao.update({ id: itemId, nome: 'New name' }),
      );
      expect(err.code).toBe('BAD_REQUEST');
      expect(err.message).toBe('contribuicao_locked');
    });

    it('delete on a claimed contribuicao → BAD_REQUEST contribuicao_locked', async () => {
      const alice = await seedUserWithCampanha(rig, {
        handle: 'alice',
        email: 'alice@test.local',
      });
      const deps = (rig as TestRig & { deps: ServerDeps }).deps;
      const caller = rig.callerFor(alice.cookieHeader);

      const create = (await caller.contribuicao.create({
        nome: 'Fralda',
        valor: 3000,
        qty: 1,
      })) as { ids: string[] };
      const itemId = requireFirst(create.ids);

      const existing = await deps.contribuicaoRepository.findById(itemId);
      if (!existing) throw new Error('seed failed: contribuicao not found');
      await deps.contribuicaoRepository.save({
        ...existing,
        status: 'indisponivel',
        contribuinte: { nome: 'Visitante', email: 'v@test.local' },
      });

      const err = await expectTrpcError(() => caller.contribuicao.delete({ ids: [itemId] }));
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
        caller.contribuicao.create({ nome: 'X', valor: 100, qty: 1 }),
      );
      expect(err.code).toBe('UNAUTHORIZED');
    });

    it('update without session → UNAUTHORIZED', async () => {
      const caller = rig.callerFor();
      const err = await expectTrpcError(() =>
        caller.contribuicao.update({ id: randomUUID(), nome: 'X' }),
      );
      expect(err.code).toBe('UNAUTHORIZED');
    });

    it('delete without session → UNAUTHORIZED', async () => {
      const caller = rig.callerFor();
      const err = await expectTrpcError(() => caller.contribuicao.delete({ ids: [randomUUID()] }));
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
        items: [{ nome: 'Fralda P', valor: 5000, qty: 1 }],
      })) as { ids: string[] };
      expect(result.ids).toHaveLength(1);

      const list = (await caller.contribuicao.list()) as Array<{ nome: string }>;
      expect(list).toHaveLength(1);
      expect(list[0]?.nome).toBe('Fralda P');
    });

    it('N=1 item, qty=10 → produces 10 contribuicoes from ONE bulk call', async () => {
      const alice = await seedUserWithCampanha(rig, {
        handle: 'alice',
        email: 'alice@test.local',
      });
      const caller = rig.callerFor(alice.cookieHeader);

      const result = (await caller.contribuicao.createBulk({
        items: [{ nome: 'Pacote Fraldas RN', valor: 8000, qty: 10 }],
      })) as { ids: string[] };
      expect(result.ids).toHaveLength(10);
      // Unique ids (no accidental dedup or repetition).
      expect(new Set(result.ids).size).toBe(10);

      const list = (await caller.contribuicao.list()) as Array<{ nome: string; valor: number }>;
      expect(list).toHaveLength(10);
      expect(list.every((i) => i.nome === 'Pacote Fraldas RN' && i.valor === 8000)).toBe(true);
    });

    it('N=10 items × qty=3 → produces 30 contribuicoes from one bulk call (kit chá de bebê)', async () => {
      const alice = await seedUserWithCampanha(rig, {
        handle: 'alice',
        email: 'alice@test.local',
      });
      const caller = rig.callerFor(alice.cookieHeader);

      const items = Array.from({ length: 10 }, (_, i) => ({
        nome: `Item kit ${i}`,
        valor: 1000 + i * 100,
        qty: 3,
      }));

      const result = (await caller.contribuicao.createBulk({ items })) as { ids: string[] };
      expect(result.ids).toHaveLength(30);
      expect(new Set(result.ids).size).toBe(30);

      const list = (await caller.contribuicao.list()) as Array<{ nome: string }>;
      expect(list).toHaveLength(30);
      // Every catalog name appears exactly qty=3 times.
      for (let i = 0; i < 10; i++) {
        const matches = list.filter((c) => c.nome === `Item kit ${i}`);
        expect(matches).toHaveLength(3);
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
        qty: 1,
      }));

      const result = (await caller.contribuicao.createBulk({ items })) as { ids: string[] };
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
        items: [
          { nome: 'A', valor: 100, qty: 2 },
          { nome: 'B', valor: 200, qty: 3 },
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
          items: [
            { nome: 'Valid', valor: 100, qty: 5 },
            { nome: 'Invalid', valor: -1, qty: 1 },
          ],
        }),
      );
      expect(err.code).toBe('BAD_REQUEST');

      // Zero rows persisted — the "Valid" item did NOT slip through.
      const list = (await caller.contribuicao.list()) as Array<unknown>;
      expect(list).toEqual([]);
    });

    it('anonymous createBulk → UNAUTHORIZED', async () => {
      const caller = rig.callerFor();
      const err = await expectTrpcError(() =>
        caller.contribuicao.createBulk({
          items: [{ nome: 'X', valor: 100, qty: 1 }],
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

      const created = (await caller.contribuicao.create({
        nome: 'Fralda P',
        valor: 5000,
        qty: 4,
      })) as { ids: string[] };
      expect(created.ids).toHaveLength(4);

      const list = (await caller.contribuicao.list()) as Array<{ nome: string }>;
      expect(list).toHaveLength(4);
      expect(list.every((i) => i.nome === 'Fralda P')).toBe(true);
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
        nome: 'Fralda',
        valor: 3000,
        qty: 1,
      })) as { ids: string[] };
      const aliceItemId = requireFirst(create.ids);

      // Bob's session resolves to bob's campanha → existing.idCampanha !==
      // session.idCampanha → ArrecadacaoNaoAutorizadoError → UNAUTHORIZED.
      // We deliberately surface authz before existence to keep the
      // "wrong tenant" signal consistent. NOT_FOUND would be wrong here
      // (the row exists; bob just doesn't own it).
      const err = await expectTrpcError(() =>
        bobCaller.contribuicao.update({ id: aliceItemId, nome: 'Hacked' }),
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
        caller.contribuicao.update({ id: randomUUID(), nome: 'X' }),
      );
      expect(err.code).toBe('NOT_FOUND');
    });
  });
});
