/**
 * aperture-yeauv — owner-gate + back-compat for the shared per-campanha
 * resolver (resolve-campanha-administrada.ts). This is the security centerpiece
 * of per-campanha routing: an authed caller may resolve ONLY a campanha they
 * administer, and a bare (idCampanha-absent) call MUST keep meaning the oldest.
 *
 *   - PRESENT + owned      → that campanha
 *   - PRESENT + not-owned  → CampanhaAcessoNegadoError (IDOR gate; non-leaking)
 *   - PRESENT + unknown id → CampanhaAcessoNegadoError (same error — no
 *                            existence oracle)
 *   - ABSENT               → the OLDEST campanha (criada_em ASC, #332) — hard
 *                            back-compat for bare URLs / old clients / Stripe
 *   - no session           → CampanhaAcessoNegadoError
 *
 * Rig: the buildRig(email) convention from the dxljo/authme suites, plus a
 * second campanha created via the campanhas.criar mutation so a conta has TWO
 * campanhas (oldest + newest) and a cross-owner rig for the IDOR case.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ServerDeps } from '../../../apps/eunenem-server/server/auth/setup.js';
import type { TrpcContext } from '../../../apps/eunenem-server/server/trpc/context.js';
import {
  CampanhaAcessoNegadoError,
  resolverCampanhaAdministrada,
} from '../../../apps/eunenem-server/server/trpc/resolve-campanha-administrada.js';
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

type Caller = ReturnType<typeof appRouter.createCaller>;

interface Rig {
  deps: ServerDeps;
  addUser: (email: string) => Promise<{ caller: Caller; ctx: TrpcContext }>;
}

async function buildRig(): Promise<Rig> {
  const observability: Observability = {
    logger: new NoopLogger(),
    tracer: noopTracer(),
  };

  const authService = new AuthServiceMemoria();
  const usuarioRepository = new UsuarioRepositoryMemory();
  const plataformaRepository = new PlataformaRepositoryMemory();
  const recebedorRepository = new RecebedorRepositoryMemory();
  const campanhaRepository = new CampanhaRepositoryMemory(recebedorRepository);
  const pagamentoRepository = new PagamentoRepositoryMemory();
  const pagamentoProvider = new PagamentoProviderFake();

  const deps: ServerDeps = {
    db: {} as never,
    auth: {} as never,
    authService,
    usuarioRepository,
    perfilCriadorRepository: new PerfilCriadorRepositoryMemory(),
    perfilCampanhaRepository: new PerfilCampanhaRepositoryMemory(),
    plataformaRepository,
    campanhaRepository,
    contribuicaoRepository: new ContribuicaoRepositoryMemory(),
    recebedorRepository,
    eventoRepository: new EventoRepositoryMemory(),
    conviteRepository: new ConviteRepositoryMemory(),
    listaDeConvidadosRepository: new ListaDeConvidadosRepositoryMemory(),
    pagamentoRepository,
    pagamentoProvider,
    checkoutSessionProvider: pagamentoProvider,
    pagamentoEventPublisher: new PagamentoEventPublisherMemory(),
    livroFinanceiroRepository: new LivroFinanceiroRepositoryMemory(
      recebedorRepository,
      pagamentoRepository,
    ),
    provedorRegraTaxa: new ProvedorRegraTaxaMemory(REGRAS_TAXA_SEED),
    dadosRecebimentoRepository: new DadosRecebimentoRepositoryMemory(),
    resgatePendenteRepository: new ResgatePendenteRepositoryMemory(),
    observability,
    adminAllowedEmails: new Set<string>(),
    // TICKING clock (not frozen): each call advances 1s so consecutive
    // campanha creations get strictly increasing criadaEm — the oldest-wins
    // ordering is then real, not an id-tiebreak coin flip. (A frozen clock
    // gave the signup campanha and campanhas.criar the SAME timestamp.)
    clock: (() => {
      let tick = 0;
      return () => new Date(Date.parse('2026-07-07T02:00:00.000Z') + 1000 * tick++);
    })(),
    sessionCookieName: SESSION_COOKIE,
    publicOrigin: 'http://localhost:3001',
    trustedHopCount: 0,
    logPiiHashSalt: '',
    webhookEventArchive: new WebhookEventArchiveMemory(),
    objectStorage: new ObjectStorageMemory(),
  };

  async function addUser(email: string): Promise<{ caller: Caller; ctx: TrpcContext }> {
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
    return { caller: appRouter.createCaller(ctx), ctx };
  }

  return { deps, addUser };
}

describe('resolverCampanhaAdministrada (owner-gate + back-compat)', () => {
  it('ABSENT idCampanha → resolves the OLDEST campanha (back-compat)', async () => {
    const rig = await buildRig();
    const { caller, ctx } = await rig.addUser(`owner-${randomUUID()}@example.com`);

    // Signup created campanha #1 (oldest). Create a 2nd (newer) campanha.
    const nova = await caller.campanhas.criar({ titulo: 'Segunda Lista' });
    const todas = await caller.campanhas.list();
    const oldest = [...todas.novas].sort(
      (a, b) => new Date(a.criadaEm).getTime() - new Date(b.criadaEm).getTime(),
    )[0];

    const { campanha } = await resolverCampanhaAdministrada(ctx);
    expect(campanha.id).toBe(oldest?.id);
    expect(campanha.id).not.toBe(nova.id); // the new list must NOT hijack bare
  });

  it('PRESENT idCampanha the caller owns → resolves THAT campanha', async () => {
    const rig = await buildRig();
    const { caller, ctx } = await rig.addUser(`owner-${randomUUID()}@example.com`);
    const nova = await caller.campanhas.criar({ titulo: 'Segunda Lista' });

    const { campanha } = await resolverCampanhaAdministrada(ctx, nova.id);
    expect(campanha.id).toBe(nova.id);
  });

  it('IDOR gate: PRESENT idCampanha owned by ANOTHER conta → CampanhaAcessoNegadoError', async () => {
    const rig = await buildRig();
    const victim = await rig.addUser(`victim-${randomUUID()}@example.com`);
    const attacker = await rig.addUser(`attacker-${randomUUID()}@example.com`);

    const victimCampanha = await victim.caller.campanhas.criar({ titulo: 'Lista da Vitima' });

    await expect(
      resolverCampanhaAdministrada(attacker.ctx, victimCampanha.id),
    ).rejects.toBeInstanceOf(CampanhaAcessoNegadoError);
  });

  it('no existence oracle: an UNKNOWN idCampanha → CampanhaAcessoNegadoError (same as not-owner)', async () => {
    const rig = await buildRig();
    const { ctx } = await rig.addUser(`owner-${randomUUID()}@example.com`);

    await expect(resolverCampanhaAdministrada(ctx, randomUUID())).rejects.toBeInstanceOf(
      CampanhaAcessoNegadoError,
    );
  });

  it('no session → CampanhaAcessoNegadoError', async () => {
    const rig = await buildRig();
    const anonCtx: TrpcContext = {
      deps: rig.deps,
      headers: new Headers(),
      resHeaders: new Headers(),
    };

    await expect(resolverCampanhaAdministrada(anonCtx, undefined)).rejects.toBeInstanceOf(
      CampanhaAcessoNegadoError,
    );
  });
});
