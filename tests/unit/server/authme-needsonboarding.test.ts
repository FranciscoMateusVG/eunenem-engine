/**
 * aperture-lrl1h — `auth.me.needsOnboarding` derives from "has ANY named
 * campanha", not the OLDEST campanha's nomeBebe, and latches once onboarded.
 *
 * The bug (operator-found, live): needsOnboarding was `(oldestCampanha.nomeBebe
 * ?? '').trim().length === 0`, so a non-legacy user whose OLDEST campanha had an
 * empty nomeBebe but who owned NEWER named lists was wrongly routed to the
 * onboarding wizard. Fix: needsOnboarding means "the user has NO usable campaign
 * at all" — false as soon as ANY campanha has a non-empty nomeBebe. Gap 4: an
 * editable nomeBebe must not un-onboard a user with a list, so once onboarding
 * is observed it latches (onboarding_concluido_em) and clearing nomeBebe no
 * longer re-fires the wizard.
 *
 * Rig mirrors authme-islegacy.test.ts (self-contained in-memory deps graph),
 * seeding campanhas + perfis through the real tRPC callers (campanhas.criar +
 * perfilCampanha.atualizar) — the same real signal path the wizard uses.
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
import { ResgatePendenteRepositoryMemory } from '../../../src/adapters/arrecadacao/resgate-pendente-repository.memory.js';
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
import { PerfilCriadorRepositoryMemory } from '../../../src/adapters/usuario/perfil-criador-repository.memory.js';
import { UsuarioRepositoryMemory } from '../../../src/adapters/usuario/repository.memory.js';
import { WebhookEventArchiveMemory } from '../../../src/adapters/webhook-archive/webhook-event-archive.memory.js';
import { NoopLogger } from '../../../src/observability/noop-logger.js';
import type { Observability } from '../../../src/observability/observability.js';
import { noopTracer } from '../../../src/observability/tracer.js';
import { criarSessaoUsuario } from '../../../src/use-cases/usuario/criar-sessao-usuario.js';
import { registrarContaUsuario } from '../../../src/use-cases/usuario/registrar-conta-usuario.js';

const SESSION_COOKIE = 'better-auth.session_token';
// aperture-lrl1h — a per-run random value (NOT a literal) so GitGuardian's
// generic-password detector has nothing to flag; the value only needs to be
// consistent between registration and session creation within a test run.
const TEST_PASSWORD = `pw-${randomUUID()}`;

type Caller = ReturnType<typeof appRouter.createCaller>;

/** The full nomeBebe payload perfilCampanha.atualizar expects. */
function perfilInput(idCampanha: string, nomeBebe: string | null) {
  return {
    idCampanha,
    nomeBebe,
    relacao: null,
    historia: null,
    dataNascimento: null,
    tipoEvento: null,
    genero: null,
    dataEvento: null,
    fotoPerfilKey: null,
    fotoCapaKey: null,
    fotoHistoriaKey: null,
  };
}

async function buildRig(email: string): Promise<Caller> {
  const observability: Observability = { logger: new NoopLogger(), tracer: noopTracer() };
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
      email,
      nomeExibicao: 'Francisco',
      senhaSimulada: TEST_PASSWORD,
    },
  );
  const sessao = await criarSessaoUsuario(
    { usuarioRepository, authService, observability },
    { idPlataforma: ID_PLATAFORMA_EUNENEM, email, senhaSimulada: TEST_PASSWORD },
  );
  const ctx: TrpcContext = {
    deps,
    headers: new Headers({ cookie: `${SESSION_COOKIE}=${encodeURIComponent(sessao.token)}` }),
    resHeaders: new Headers(),
  };
  return appRouter.createCaller(ctx);
}

describe('auth.me.needsOnboarding (aperture-lrl1h)', () => {
  it('fresh signup (auto-created blank campanha) → needsOnboarding=true', async () => {
    const caller = await buildRig(`fresh-${randomUUID()}@example.com`);
    const me = await caller.auth.me();
    expect(me?.needsOnboarding).toBe(true);
  });

  it('any named campanha → needsOnboarding=false', async () => {
    const caller = await buildRig(`named-${randomUUID()}@example.com`);
    const list = await caller.campanhas.list();
    const idCampanha = list.novas[0]?.id;
    if (!idCampanha) throw new Error('seed: expected an auto-created campanha');

    await caller.perfilCampanha.atualizar(perfilInput(idCampanha, 'Aurora'));

    const me = await caller.auth.me();
    expect(me?.needsOnboarding).toBe(false);
  });

  it('GAP 1 — oldest campanha blank but a NEWER campanha is named → needsOnboarding=false', async () => {
    const caller = await buildRig(`multi-${randomUUID()}@example.com`);
    // The auto-created campanha is the OLDEST — leave it blank.
    // Create a NEWER campanha and name ONLY that one.
    const cardB = await caller.campanhas.criar({ titulo: 'Segundo bebê' });
    await caller.perfilCampanha.atualizar(perfilInput(cardB.id, 'Aurora'));

    const me = await caller.auth.me();
    // Has a usable (named) campaign — must NOT be sent to the wizard even though
    // the oldest campanha is still blank.
    expect(me?.needsOnboarding).toBe(false);
  });

  it('GAP 4 — clearing nomeBebe after onboarding does NOT re-fire the wizard (latch)', async () => {
    const caller = await buildRig(`latch-${randomUUID()}@example.com`);
    const list = await caller.campanhas.list();
    const idCampanha = list.novas[0]?.id;
    if (!idCampanha) throw new Error('seed: expected an auto-created campanha');

    // Onboard (name the campanha) + read auth.me once so the latch is set.
    await caller.perfilCampanha.atualizar(perfilInput(idCampanha, 'Aurora'));
    const meOnboarded = await caller.auth.me();
    expect(meOnboarded?.needsOnboarding).toBe(false);

    // Now clear the baby name via the editable profile field.
    await caller.perfilCampanha.atualizar(perfilInput(idCampanha, null));

    // The latch must keep them onboarded — an editable field cannot un-onboard.
    const meAfterClear = await caller.auth.me();
    expect(meAfterClear?.needsOnboarding).toBe(false);
  });
});
