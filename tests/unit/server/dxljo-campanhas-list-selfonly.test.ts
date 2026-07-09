/**
 * aperture-dxljo — `campanhas.list` SELF-ONLY lock-in (locks Cipher's ses0u
 * leak-sweep condition): the legacy `legado[]` detection is keyed EXCLUSIVELY
 * on the authenticated session's email. No caller can read another identity's
 * legacy entry — not by being a different user, not by passing an email, not
 * anonymously.
 *
 * Rig: self-contained copy of the buildRig(email) convention from
 * tests/unit/mebax-legacy-users.test.ts (zero churn to that file), extended
 * with the four newer ServerDeps fields (perfilCriadorRepository,
 * listaDeConvidadosRepository, adminAllowedEmails, objectStorage — memory /
 * empty instances) and an addUser() helper so two users can share ONE deps
 * graph — the leak test is only meaningful when the legacy-listed user and
 * the attacker coexist in the same rig.
 *
 * Matrix:
 *   A. user whose email IS in the legacy snapshot (the committed stub's
 *      operator email) → list() returns THEIR legado entry.
 *   B. a DIFFERENT authed user in the SAME rig (random email, not in the
 *      snapshot) → legado is EMPTY — user A's entry does not leak.
 *   C. enumeration lock: the procedure declares NO input. Passing an
 *      unexpected { email: victim } arg must either be rejected by a
 *      validation layer or be IGNORED — either way the RESULT stays scoped
 *      to the caller's own session (the attacker never receives the
 *      victim's entry).
 *   D. anonymous → UNAUTHORIZED, no partial data.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ServerDeps } from '../../../apps/eunenem-server/server/auth/setup.js';
import type { TrpcContext } from '../../../apps/eunenem-server/server/trpc/context.js';
import { appRouter } from '../../../apps/eunenem-server/server/trpc/router.js';
import { CampanhaRepositoryMemory } from '../../../src/adapters/arrecadacao/campanha-repository.memory.js';
import { ContribuicaoRepositoryMemory } from '../../../src/adapters/arrecadacao/contribuicao-repository.memory.js';
import { PerfilCampanhaRepositoryMemory } from '../../../src/adapters/arrecadacao/perfil-campanha-repository.memory.js';
import { RecebedorRepositoryMemory } from '../../../src/adapters/arrecadacao/recebedor-repository.memory.js';
import { ConviteRepositoryMemory } from '../../../src/adapters/evento/convite-repository.memory.js';
import { EventoRepositoryMemory } from '../../../src/adapters/evento/evento-repository.memory.js';
import { ListaDeConvidadosRepositoryMemory } from '../../../src/adapters/evento/lista-de-convidados-repository.memory.js';
import { PagamentoEventPublisherMemory } from '../../../src/adapters/pagamentos/event-publisher.memory.js';
import { LivroFinanceiroRepositoryMemory } from '../../../src/adapters/pagamentos/financeiro/livro-repository.memory.js';
import { PagamentoProviderFake } from '../../../src/adapters/pagamentos/provider.fake.js';
import { PagamentoRepositoryMemory } from '../../../src/adapters/pagamentos/repository.memory.js';
import {
  ID_PLATAFORMA_EUNENEM,
  PlataformaRepositoryMemory,
} from '../../../src/adapters/plataforma/repository.memory.js';
import { ObjectStorageMemory } from '../../../src/adapters/storage/object-storage.memory.js';
import {
  ProvedorRegraTaxaMemory,
  REGRAS_TAXA_SEED,
} from '../../../src/adapters/taxas/regra-provider.memory.js';
import { AuthServiceMemoria } from '../../../src/adapters/usuario/auth-service.memory.js';
import { DadosRecebimentoRepositoryMemory } from '../../../src/adapters/usuario/dados-recebimento-repository.memory.js';
import { PerfilCriadorRepositoryMemory } from '../../../src/adapters/usuario/perfil-criador-repository.memory.js';
import { UsuarioRepositoryMemory } from '../../../src/adapters/usuario/repository.memory.js';
import { ResgatePendenteRepositoryMemory } from '../../../src/adapters/usuario/resgate-pendente-repository.memory.js';
import { WebhookEventArchiveMemory } from '../../../src/adapters/webhook-archive/webhook-event-archive.memory.js';
import { NoopLogger } from '../../../src/observability/noop-logger.js';
import type { Observability } from '../../../src/observability/observability.js';
import { noopTracer } from '../../../src/observability/tracer.js';
import { criarSessaoUsuario } from '../../../src/use-cases/usuario/criar-sessao-usuario.js';
import { registrarContaUsuario } from '../../../src/use-cases/usuario/registrar-conta-usuario.js';

const SESSION_COOKIE = 'better-auth.session_token';
const TEST_PASSWORD = 'senha-teste-123';

/** The committed stub's single entry — the only email in the POC snapshot. */
const LEGACY_STUB_EMAIL = 'franciscomateusvg@gmail.com';

type Caller = ReturnType<typeof appRouter.createCaller>;

/**
 * Authenticated tRPC rig against memory repos (mebax convention). Returns an
 * addUser() so multiple authed users share the SAME deps graph, each with a
 * real session token from criarSessaoUsuario.
 */
async function buildRig(email: string): Promise<{
  caller: Caller;
  anonCaller: Caller;
  addUser: (email: string) => Promise<Caller>;
}> {
  const observability: Observability = {
    logger: new NoopLogger(),
    tracer: noopTracer(),
  };

  const authService = new AuthServiceMemoria();
  const usuarioRepository = new UsuarioRepositoryMemory();
  const plataformaRepository = new PlataformaRepositoryMemory();
  const recebedorRepository = new RecebedorRepositoryMemory();
  const campanhaRepository = new CampanhaRepositoryMemory(recebedorRepository);
  const contribuicaoRepository = new ContribuicaoRepositoryMemory();
  const eventoRepository = new EventoRepositoryMemory();
  const conviteRepository = new ConviteRepositoryMemory();
  const pagamentoRepository = new PagamentoRepositoryMemory();
  const pagamentoProvider = new PagamentoProviderFake();
  const pagamentoEventPublisher = new PagamentoEventPublisherMemory();
  const livroFinanceiroRepository = new LivroFinanceiroRepositoryMemory(
    recebedorRepository,
    pagamentoRepository,
  );

  const deps: ServerDeps = {
    db: {} as never,
    auth: {} as never,
    authService,
    usuarioRepository,
    perfilCriadorRepository: new PerfilCriadorRepositoryMemory(),
    perfilCampanhaRepository: new PerfilCampanhaRepositoryMemory(),
    plataformaRepository,
    campanhaRepository,
    contribuicaoRepository,
    recebedorRepository,
    eventoRepository,
    conviteRepository,
    listaDeConvidadosRepository: new ListaDeConvidadosRepositoryMemory(),
    pagamentoRepository,
    pagamentoProvider,
    checkoutSessionProvider: pagamentoProvider,
    pagamentoEventPublisher,
    livroFinanceiroRepository,
    provedorRegraTaxa: new ProvedorRegraTaxaMemory(REGRAS_TAXA_SEED),
    dadosRecebimentoRepository: new DadosRecebimentoRepositoryMemory(),
    resgatePendenteRepository: new ResgatePendenteRepositoryMemory(),
    observability,
    adminAllowedEmails: new Set<string>(),
    clock: () => new Date('2026-07-07T02:00:00.000Z'),
    sessionCookieName: SESSION_COOKIE,
    publicOrigin: 'http://localhost:3001',
    trustedHopCount: 0,
    logPiiHashSalt: '',
    webhookEventArchive: new WebhookEventArchiveMemory(),
    objectStorage: new ObjectStorageMemory(),
  };

  async function addUser(userEmail: string): Promise<Caller> {
    await registrarContaUsuario(
      {
        usuarioRepository,
        plataformaRepository,
        campanhaRepository,
        recebedorRepository,
        authService,
        clock: deps.clock,
        observability,
      },
      {
        idUsuario: randomUUID(),
        idConta: randomUUID(),
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        email: userEmail,
        nomeExibicao: 'Francisco',
        senhaSimulada: TEST_PASSWORD,
      },
    );
    const sessao = await criarSessaoUsuario(
      { usuarioRepository, authService, observability },
      { idPlataforma: ID_PLATAFORMA_EUNENEM, email: userEmail, senhaSimulada: TEST_PASSWORD },
    );
    const ctx: TrpcContext = {
      deps,
      headers: new Headers({
        cookie: `${SESSION_COOKIE}=${encodeURIComponent(sessao.token)}`,
      }),
      resHeaders: new Headers(),
    };
    return appRouter.createCaller(ctx);
  }

  const caller = await addUser(email);
  const anonCtx: TrpcContext = { deps, headers: new Headers(), resHeaders: new Headers() };

  return { caller, anonCaller: appRouter.createCaller(anonCtx), addUser };
}

describe('campanhas.list self-only scoping (aperture-dxljo)', () => {
  it('A: a user whose email IS in the legacy snapshot receives THEIR legado entry', async () => {
    const { caller } = await buildRig(LEGACY_STUB_EMAIL);

    const out = await caller.campanhas.list();

    expect(out.legado).toEqual([
      {
        email: LEGACY_STUB_EMAIL,
        nome: 'Minha lista (EuNeném 1.0)',
        utm: null,
        mimos: null,
      },
    ]);
  });

  it('B: a DIFFERENT authed user in the SAME rig gets EMPTY legado — no cross-user leak', async () => {
    const rig = await buildRig(LEGACY_STUB_EMAIL);
    const attackerEmail = `dxljo-attacker-${randomUUID()}@example.com`;
    const attackerCaller = await rig.addUser(attackerEmail);

    // Sanity: the legacy-listed user coexists in this rig and DOES see it.
    const legacyOut = await rig.caller.campanhas.list();
    expect(legacyOut.legado).toHaveLength(1);

    const attackerOut = await attackerCaller.campanhas.list();
    expect(attackerOut.legado, 'another session must never receive the entry').toEqual([]);
    // Their own 2.0 side still works — empty legado is scoping, not a broken call.
    expect(attackerOut.novas).toHaveLength(1);
  });

  it('C: enumeration lock — an unexpected { email } arg cannot select another identity', async () => {
    const rig = await buildRig(LEGACY_STUB_EMAIL);
    const attackerCaller = await rig.addUser(`dxljo-enum-${randomUUID()}@example.com`);

    // The procedure declares NO input, so the client type is arg-less; force
    // an unexpected payload past the compiler the way a raw wire call could.
    const listWithArg = attackerCaller.campanhas.list as unknown as (
      input?: unknown,
    ) => Promise<{ legado: readonly { email: string }[] }>;

    let out: Awaited<ReturnType<typeof listWithArg>>;
    try {
      out = await listWithArg({ email: LEGACY_STUB_EMAIL });
    } catch {
      // A validation rejection is an equally acceptable lock: the arg was
      // refused outright, nothing leaked. (tRPC without .input() currently
      // IGNORES unknown input — the resolve branch below is what runs today.)
      return;
    }
    // The invariant: the RESULT is still scoped to the CALLER's session —
    // the victim's legacy entry is not selectable by payload.
    expect(out.legado).toEqual([]);
  });

  it('D: anonymous caller → UNAUTHORIZED, no partial data', async () => {
    const { anonCaller } = await buildRig(LEGACY_STUB_EMAIL);

    await expect(anonCaller.campanhas.list()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
});
