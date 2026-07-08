/**
 * aperture — `auth.me.isLegacy` legacy-first routing signal.
 *
 * The bug (operator-found, live): a fresh-signup user whose email is in the 1.0
 * legacy list lands on the onboarding WIZARD (empty profile → needsOnboarding
 * =true) instead of /campanhas, where their 1.0 card belongs. The frontend
 * routes a legacy user to /campanhas BEFORE the needsOnboarding gate — but only
 * if the backend hands it the signal. This suite pins that signal:
 *   - isLegacy is TRUE iff the caller's OWN email matches the legacy snapshot,
 *     via the SAME matcher campanhas.list uses (buscarCampanhasLegado).
 *   - it is SELF-ONLY: keyed on the authenticated session's email, never a
 *     client input, never another identity's entry.
 *   - it is INDEPENDENT of needsOnboarding: a fresh legacy signup carries BOTH
 *     needsOnboarding=true AND isLegacy=true (the exact broken scenario).
 *
 * Rig: the buildRig(email) convention from dxljo-campanhas-list-selfonly.test.ts
 * (self-contained; two users can share ONE deps graph so the leak case is real).
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ServerDeps } from '../../../apps/eunenem-server/server/auth/setup.js';
import type { TrpcContext } from '../../../apps/eunenem-server/server/trpc/context.js';
import { appRouter } from '../../../apps/eunenem-server/server/trpc/router.js';
import { CampanhaRepositoryMemory } from '../../../src/adapters/arrecadacao/campanha-repository.memory.js';
import { ContribuicaoRepositoryMemory } from '../../../src/adapters/arrecadacao/contribuicao-repository.memory.js';
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

/** The committed stub's single legacy entry — the only email in the snapshot. */
const LEGACY_STUB_EMAIL = 'franciscomateusvg@gmail.com';

type Caller = ReturnType<typeof appRouter.createCaller>;

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

describe('auth.me.isLegacy (legacy-first routing signal)', () => {
  it('THE BUG SCENARIO: a fresh legacy signup carries BOTH needsOnboarding=true AND isLegacy=true', async () => {
    const { caller } = await buildRig(LEGACY_STUB_EMAIL);

    const me = await caller.auth.me();

    // A freshly-registered user has no creator profile yet → the wizard gate
    // would fire; isLegacy is what lets the frontend route to /campanhas first.
    expect(me?.needsOnboarding).toBe(true);
    expect(me?.isLegacy).toBe(true);
  });

  it('a non-legacy user → isLegacy=false', async () => {
    const { caller } = await buildRig(`not-legacy-${randomUUID()}@example.com`);

    const me = await caller.auth.me();

    expect(me?.isLegacy).toBe(false);
  });

  it('case-insensitive match: legacy email in a different case still → isLegacy=true', async () => {
    const { caller } = await buildRig(LEGACY_STUB_EMAIL.toUpperCase());

    const me = await caller.auth.me();

    expect(me?.isLegacy).toBe(true);
  });

  it('SELF-ONLY: a non-legacy user in the SAME rig as a legacy user gets isLegacy=false (no leak)', async () => {
    const rig = await buildRig(LEGACY_STUB_EMAIL);
    const otherCaller = await rig.addUser(`other-${randomUUID()}@example.com`);

    // Sanity: the legacy user coexists in this rig and IS flagged.
    const legacyMe = await rig.caller.auth.me();
    expect(legacyMe?.isLegacy).toBe(true);

    const otherMe = await otherCaller.auth.me();
    expect(otherMe?.isLegacy).toBe(false);
  });

  it('anonymous caller → me is null (no isLegacy leak to logged-out probes)', async () => {
    const { anonCaller } = await buildRig(LEGACY_STUB_EMAIL);

    await expect(anonCaller.auth.me()).resolves.toBeNull();
  });
});
