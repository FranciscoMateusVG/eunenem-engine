/**
 * aperture-mu1v9 (fblrt W3-c, PR1) — eventos as the SINGLE SOURCE for
 * tipo_evento + event date.
 *
 * Covers the frozen contract:
 *   - wizard write (perfilCampanha.atualizar with tipoEvento/dataEvento)
 *     SEEDS a partial eventos row (modalidade null); perfilCampanha.get
 *     returns the pair FROM eventos; eventoConvite.get sees the same
 *     tipo/data;
 *   - a full eventoConvite.save followed by a perfilCampanha.atualizar date
 *     change updates the SAME evento row, PRESERVING modalidade/endereco;
 *   - single-source: after any interleaving of the two writers, the page
 *     date (perfilCampanha.get.dataEvento) equals the convite date
 *     (eventoConvite.get evento.dataHoraIso) — and same for tipoEvento;
 *   - domain-strict pin: eventoConvite.save still REJECTS a null/absent
 *     modalidade. (dataHoraIso null is ACCEPTED on save — that is the
 *     PRE-EXISTING 20260708_035 behavior "date/time optional on the
 *     convite"; see the DEVIATION note on the test below.)
 *
 * Rig: self-contained copy of the buildRig convention from
 * aphk8-perfil-campanha.test.ts (mutable clock via advanceClock).
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

type Caller = ReturnType<typeof appRouter.createCaller>;

interface RigUser {
  caller: Caller;
  idCampanha: string;
  slug: string;
}

interface Rig {
  anonCaller: Caller;
  addUser: (email: string, nomeExibicao: string) => Promise<RigUser>;
  advanceClock: (ms: number) => void;
}

async function buildRig(): Promise<Rig> {
  const observability: Observability = {
    logger: new NoopLogger(),
    tracer: noopTracer(),
  };

  let now = new Date('2026-07-10T02:00:00.000Z');
  const clock = () => now;
  const advanceClock = (ms: number) => {
    now = new Date(now.getTime() + ms);
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
    clock,
    sessionCookieName: SESSION_COOKIE,
    publicOrigin: 'http://localhost:3001',
    trustedHopCount: 0,
    logPiiHashSalt: '',
    webhookEventArchive: new WebhookEventArchiveMemory(),
    objectStorage: new ObjectStorageMemory(),
  };

  async function addUser(userEmail: string, nomeExibicao: string): Promise<RigUser> {
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
        nomeExibicao,
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
    const caller = appRouter.createCaller(ctx);
    const { novas } = await caller.campanhas.list();
    const card = novas[0];
    if (!card) throw new Error('signup saga did not create a campanha');
    return { caller, idCampanha: card.id, slug: card.slug };
  }

  const anonCtx: TrpcContext = { deps, headers: new Headers(), resHeaders: new Headers() };
  return { anonCaller: appRouter.createCaller(anonCtx), addUser, advanceClock };
}

/** Wizard-style whole-content payload — dates as ISO strings (wire shape). */
const CONTEUDO_INPUT = {
  nomeBebe: 'Helena',
  relacao: 'Mãe',
  historia: 'Uma espera cheia de amor.',
  dataNascimento: '2026-09-15T00:00:00.000Z',
  tipoEvento: 'cha-bebe' as const,
  genero: 'menina' as const,
  dataEvento: '2026-08-01T00:00:00.000Z',
  fotoPerfilKey: null,
  fotoCapaKey: null,
  fotoHistoriaKey: null,
};

/** Full convite save payload — modalidade + dataHora present. */
const CONVITE_INPUT = {
  tipoEvento: 'cha-fraldas' as const,
  modalidade: 'presencial' as const,
  dataHoraIso: '2026-08-15T16:00:00.000Z',
  endereco: 'Salão das Flores, 123',
  remetente: 'Mari',
  nomeExibido: 'Helena',
  mensagem: 'Venha celebrar conosco!',
  paleta: 'lilas' as const,
  fonte: 'patrick' as const,
  modelo: 'scrapbook' as const,
};

describe('mu1v9 — eventos as single source for tipo_evento + date', () => {
  it('wizard write seeds a PARTIAL evento; get + eventoConvite.get read the same pair', async () => {
    const rig = await buildRig();
    const { caller, idCampanha } = await rig.addUser('mu1v9-a@example.com', 'Ana');

    // Wizard write (SetupCampanhaWizard → perfilCampanha.atualizar).
    const saved = await caller.perfilCampanha.atualizar({ idCampanha, ...CONTEUDO_INPUT });

    // The atualizar RESPONSE already reflects the eventos-sourced pair.
    expect(saved.tipoEvento).toBe('cha-bebe');
    expect(saved.dataEvento).toBe('2026-08-01T00:00:00.000Z');

    // perfilCampanha.get returns the pair FROM eventos.
    const got = await caller.perfilCampanha.get({ idCampanha });
    expect(got.tipoEvento).toBe('cha-bebe');
    expect(got.dataEvento).toBe('2026-08-01T00:00:00.000Z');
    // Everything else still sourced from the perfil row.
    expect(got.nomeBebe).toBe('Helena');
    expect(got.dataNascimento).toBe('2026-09-15T00:00:00.000Z');

    // eventoConvite.get sees the SAME row — partial: modalidade/endereco null.
    const snapshot = await caller.eventoConvite.get({ idCampanha });
    expect(snapshot.evento).not.toBeNull();
    expect(snapshot.evento?.tipoEvento).toBe('cha-bebe');
    expect(snapshot.evento?.dataHoraIso).toBe('2026-08-01T00:00:00.000Z');
    expect(snapshot.evento?.modalidade).toBeNull();
    expect(snapshot.evento?.endereco).toBeNull();
    expect(snapshot.convite).toBeNull();
  });

  it('convite save then wizard date change: SAME row updated, modalidade/endereco PRESERVED', async () => {
    const rig = await buildRig();
    const { caller, idCampanha } = await rig.addUser('mu1v9-b@example.com', 'Bia');

    // Full convite save (modalidade + dataHora + endereco).
    const savedConvite = await caller.eventoConvite.save({ idCampanha, ...CONVITE_INPUT });
    const idEvento = savedConvite.evento?.id;
    expect(idEvento).toBeDefined();

    // Wizard now changes the date (and tipo).
    rig.advanceClock(60_000);
    await caller.perfilCampanha.atualizar({
      idCampanha,
      ...CONTEUDO_INPUT,
      tipoEvento: 'aniversario',
      dataEvento: '2026-09-01T12:00:00.000Z',
    });

    const snapshot = await caller.eventoConvite.get({ idCampanha });
    // Same evento row (no duplicate), pair updated…
    expect(snapshot.evento?.id).toBe(idEvento);
    expect(snapshot.evento?.tipoEvento).toBe('aniversario');
    expect(snapshot.evento?.dataHoraIso).toBe('2026-09-01T12:00:00.000Z');
    // …and the convite's where/how survived the wizard write.
    expect(snapshot.evento?.modalidade).toBe('presencial');
    expect(snapshot.evento?.endereco).toBe('Salão das Flores, 123');
    // The convite itself is untouched.
    expect(snapshot.convite?.remetente).toBe('Mari');
  });

  it('single source: after ANY interleaving, page date === convite date (and tipo)', async () => {
    const rig = await buildRig();
    const { caller, idCampanha, slug } = await rig.addUser('mu1v9-c@example.com', 'Carla');

    const assertConverged = async () => {
      const perfil = await caller.perfilCampanha.get({ idCampanha });
      const convite = await caller.eventoConvite.get({ idCampanha });
      const publico = await rig.anonCaller.perfil.getPerfilPublicoBySlug({ slug, idCampanha });
      expect(perfil.dataEvento).toBe(convite.evento?.dataHoraIso ?? null);
      expect(perfil.tipoEvento).toBe(convite.evento?.tipoEvento ?? null);
      // The PUBLIC page projection converges too.
      expect(publico.dataEvento).toBe(perfil.dataEvento);
      expect(publico.tipoEvento).toBe(perfil.tipoEvento);
    };

    // wizard → converged
    await caller.perfilCampanha.atualizar({ idCampanha, ...CONTEUDO_INPUT });
    await assertConverged();

    // convite save overwrites the pair → converged (eventos is THE source)
    rig.advanceClock(1_000);
    await caller.eventoConvite.save({ idCampanha, ...CONVITE_INPUT });
    await assertConverged();
    const afterConvite = await caller.perfilCampanha.get({ idCampanha });
    expect(afterConvite.dataEvento).toBe('2026-08-15T16:00:00.000Z');
    expect(afterConvite.tipoEvento).toBe('cha-fraldas');

    // wizard again (clears the date) → converged on null
    rig.advanceClock(1_000);
    await caller.perfilCampanha.atualizar({
      idCampanha,
      ...CONTEUDO_INPUT,
      tipoEvento: 'batizado',
      dataEvento: null,
    });
    await assertConverged();
    const afterClear = await caller.perfilCampanha.get({ idCampanha });
    expect(afterClear.dataEvento).toBeNull();
    expect(afterClear.tipoEvento).toBe('batizado');
  });

  it('domain-strict pin: eventoConvite.save REJECTS null/absent modalidade', async () => {
    const rig = await buildRig();
    const { caller, idCampanha } = await rig.addUser('mu1v9-d@example.com', 'Dora');

    // modalidade: null → BAD_REQUEST (input schema is non-nullable).
    await expect(
      caller.eventoConvite.save({
        idCampanha,
        ...CONVITE_INPUT,
        // biome-ignore lint/suspicious/noExplicitAny: invalid input on purpose
        modalidade: null as any,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    // modalidade absent → same rejection.
    const { modalidade: _omitted, ...semModalidade } = CONVITE_INPUT;
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: invalid input on purpose
      caller.eventoConvite.save({ idCampanha, ...semModalidade } as any),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    // DEVIATION NOTE (flagged in the PR): the mu1v9 spec asked to pin save
    // rejecting null dataHora as well, but dataHoraIso has been NULLABLE on
    // save since 20260708_035 ("date/time optional while creating/editing a
    // convite") — regressing that would break the shipped convite editor.
    // Pin the ACTUAL contract: null dataHoraIso is accepted, modalidade is not.
    const saved = await caller.eventoConvite.save({
      idCampanha,
      ...CONVITE_INPUT,
      dataHoraIso: null,
    });
    expect(saved.evento?.dataHoraIso).toBeNull();
    expect(saved.evento?.modalidade).toBe('presencial');
  });
});
