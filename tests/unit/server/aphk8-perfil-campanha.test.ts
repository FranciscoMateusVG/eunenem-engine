/**
 * aperture-aphk8 (W1a) — perfilCampanha router + perfil-router shim tests.
 *
 * Covers the frozen contract:
 *   - perfilCampanha.get / perfilCampanha.atualizar round-trip on an owned
 *     campanha (dates ISO on the wire);
 *   - all-null DTO for a perfil-less campanha;
 *   - IDOR: another user's campanha → UNAUTHORIZED (non-leaking);
 *   - per-campanha isolation: writing campanha B's perfil never touches A's;
 *   - perfil.getPerfilPublicoBySlug: bare → OLDEST campanha's perfil
 *     (post-backfill semantics — seeded via perfilCampanha.atualizar);
 *     present idCampanha → THAT campanha's perfil; a foreign idCampanha →
 *     non-leaking NOT_FOUND.
 *
 * Rig: self-contained copy of the buildRig convention from
 * dxljo-campanhas-list-selfonly.test.ts (+ perfilCampanhaRepository), with a
 * mutable clock (u38rz's advanceClock) so a 2nd campanha is strictly NEWER
 * and the oldest-campanha resolution is deterministic.
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
const TEST_PASSWORD = 'senha-teste-123';

type Caller = ReturnType<typeof appRouter.createCaller>;

interface RigUser {
  caller: Caller;
  /** The signup-created campanha — the OLDEST of the conta. */
  idCampanha: string;
  /** The usuario's painel slug (public identity). */
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

  let now = new Date('2026-07-08T02:00:00.000Z');
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

/** Full content payload — dates as ISO strings, mimicking the wire. */
const CONTEUDO_INPUT = {
  nomeBebe: 'Helena',
  relacao: 'Mãe',
  historia: 'Uma espera cheia de amor.',
  dataNascimento: '2026-09-15T00:00:00.000Z',
  tipoEvento: 'cha-bebe' as const,
  genero: 'menina' as const,
  dataEvento: '2026-08-01T00:00:00.000Z',
  fotoPerfilKey: 'campanha/helena/perfil.jpg',
  fotoCapaKey: null,
  fotoHistoriaKey: null,
};

describe('perfilCampanha router (aperture-aphk8)', () => {
  it('atualizar persists and get returns the saved per-campanha profile (ISO dates)', async () => {
    const rig = await buildRig();
    const { caller, idCampanha } = await rig.addUser('aphk8-a@example.com', 'Ana');

    const saved = await caller.perfilCampanha.atualizar({ idCampanha, ...CONTEUDO_INPUT });
    expect(saved.idCampanha).toBe(idCampanha);
    expect(saved.nomeBebe).toBe('Helena');
    expect(saved.dataNascimento).toBe('2026-09-15T00:00:00.000Z');

    const got = await caller.perfilCampanha.get({ idCampanha });
    expect(got.idCampanha).toBe(idCampanha);
    expect(got.nomeBebe).toBe('Helena');
    expect(got.relacao).toBe('Mãe');
    expect(got.historia).toBe('Uma espera cheia de amor.');
    expect(got.tipoEvento).toBe('cha-bebe');
    expect(got.genero).toBe('menina');
    expect(got.dataEvento).toBe('2026-08-01T00:00:00.000Z');
    expect(got.dataNascimento).toBe('2026-09-15T00:00:00.000Z');
    // Split Url (display) / Key (round-trip) — aperture-qjgfr convention.
    expect(got.fotoPerfilKey).toBe('campanha/helena/perfil.jpg');
    expect(got.fotoPerfilUrl).toBe('memory://eunenem-perfil-fotos/campanha/helena/perfil.jpg');
    expect(got.fotoCapaKey).toBeNull();
    expect(got.fotoCapaUrl).toBeNull();
  });

  it('get on a perfil-less campanha returns the all-null DTO (not an error)', async () => {
    const rig = await buildRig();
    const { caller, idCampanha } = await rig.addUser('aphk8-b@example.com', 'Bia');

    const got = await caller.perfilCampanha.get({ idCampanha });
    expect(got).toEqual({
      idCampanha,
      nomeBebe: null,
      relacao: null,
      historia: null,
      tipoEvento: null,
      genero: null,
      dataEvento: null,
      dataNascimento: null,
      fotoPerfilUrl: null,
      fotoCapaUrl: null,
      fotoHistoriaUrl: null,
      fotoPerfilKey: null,
      fotoCapaKey: null,
      fotoHistoriaKey: null,
      papais: null,
      corPrimaria: null,
      corAcento: null,
    });
  });

  it("IDOR: another user's campanha → UNAUTHORIZED for get AND atualizar", async () => {
    const rig = await buildRig();
    const vitima = await rig.addUser('aphk8-vitima@example.com', 'Vitoria');
    const atacante = await rig.addUser('aphk8-atacante@example.com', 'Xavier');

    await expect(
      atacante.caller.perfilCampanha.get({ idCampanha: vitima.idCampanha }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      atacante.caller.perfilCampanha.atualizar({
        idCampanha: vitima.idCampanha,
        ...CONTEUDO_INPUT,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    // And the anonymous caller gets the same lockout.
    await expect(
      rig.anonCaller.perfilCampanha.get({ idCampanha: vitima.idCampanha }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it("per-campanha isolation: writing campanha B's perfil never touches A's", async () => {
    const rig = await buildRig();
    const { caller, idCampanha: idCampanhaA } = await rig.addUser('aphk8-iso@example.com', 'Iris');

    await caller.perfilCampanha.atualizar({ idCampanha: idCampanhaA, ...CONTEUDO_INPUT });

    // Second lista for the SAME conta (strictly newer criadaEm).
    rig.advanceClock(60_000);
    const cardB = await caller.campanhas.criar({ titulo: 'Segunda lista' });

    await caller.perfilCampanha.atualizar({
      idCampanha: cardB.id,
      ...CONTEUDO_INPUT,
      nomeBebe: 'Miguel',
      genero: 'menino',
    });

    const gotA = await caller.perfilCampanha.get({ idCampanha: idCampanhaA });
    const gotB = await caller.perfilCampanha.get({ idCampanha: cardB.id });
    expect(gotA.nomeBebe).toBe('Helena');
    expect(gotA.genero).toBe('menina');
    expect(gotB.nomeBebe).toBe('Miguel');
    expect(gotB.genero).toBe('menino');
  });

  it('emitirUrlUploadFoto namespaces the key campanha/<idCampanha>/... and owner-gates', async () => {
    const rig = await buildRig();
    const { caller, idCampanha } = await rig.addUser('aphk8-foto@example.com', 'Fernanda');
    const outra = await rig.addUser('aphk8-foto2@example.com', 'Otavia');

    const out = await caller.perfilCampanha.emitirUrlUploadFoto({
      idCampanha,
      slot: 'perfil',
      contentType: 'image/jpeg',
    });
    expect(out.objectKey.startsWith(`campanha/${idCampanha}/perfil-`)).toBe(true);
    expect(out.objectKey.endsWith('.jpg')).toBe(true);
    expect(out.uploadUrl).toContain(out.objectKey);

    await expect(
      outra.caller.perfilCampanha.emitirUrlUploadFoto({
        idCampanha,
        slot: 'perfil',
        contentType: 'image/jpeg',
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});

describe('perfil.getPerfilPublicoBySlug per-campanha routing (aperture-aphk8)', () => {
  it("bare slug → the OLDEST campanha's perfil (post-backfill semantics)", async () => {
    const rig = await buildRig();
    const { caller, idCampanha, slug } = await rig.addUser('aphk8-pub@example.com', 'Paula');

    // Seed the OLDEST campanha's perfil via the new router (what the
    // migration backfill produces for existing users).
    await caller.perfilCampanha.atualizar({ idCampanha, ...CONTEUDO_INPUT });

    // A newer 2nd campanha with a DIFFERENT perfil must NOT win the bare read.
    rig.advanceClock(60_000);
    const cardB = await caller.campanhas.criar({ titulo: 'Segunda lista' });
    await caller.perfilCampanha.atualizar({
      idCampanha: cardB.id,
      ...CONTEUDO_INPUT,
      nomeBebe: 'Miguel',
    });

    const pub = await rig.anonCaller.perfil.getPerfilPublicoBySlug({ slug });
    expect(pub.slug).toBe(slug);
    expect(pub.nomeBebe).toBe('Helena'); // oldest campanha's content
    expect(pub.creatorName).toBe('Paula'); // still from the Usuario
  });

  it("present idCampanha → THAT campanha's perfil", async () => {
    const rig = await buildRig();
    const { caller, idCampanha, slug } = await rig.addUser('aphk8-pub2@example.com', 'Priscila');
    await caller.perfilCampanha.atualizar({ idCampanha, ...CONTEUDO_INPUT });

    rig.advanceClock(60_000);
    const cardB = await caller.campanhas.criar({ titulo: 'Segunda lista' });
    await caller.perfilCampanha.atualizar({
      idCampanha: cardB.id,
      ...CONTEUDO_INPUT,
      nomeBebe: 'Miguel',
    });

    const pub = await rig.anonCaller.perfil.getPerfilPublicoBySlug({
      slug,
      idCampanha: cardB.id,
    });
    expect(pub.nomeBebe).toBe('Miguel');
  });

  it('foreign idCampanha (not the slug conta) → non-leaking NOT_FOUND', async () => {
    const rig = await buildRig();
    const a = await rig.addUser('aphk8-pub3@example.com', 'Alice');
    const b = await rig.addUser('aphk8-pub4@example.com', 'Bruno');

    await expect(
      rig.anonCaller.perfil.getPerfilPublicoBySlug({
        slug: a.slug,
        idCampanha: b.idCampanha,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // Nonexistent id collapses to the SAME error.
    await expect(
      rig.anonCaller.perfil.getPerfilPublicoBySlug({
        slug: a.slug,
        idCampanha: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  // aperture-hsxim (W2 shed): perfil.atualizar is SLIM — nomeExibicao only.
  // The baby-half write path is EXCLUSIVELY perfilCampanha.atualizar; the
  // slim endpoint must not touch (and especially not WIPE — the upsert has
  // whole-content-replacement semantics) the campanha perfil.
  it('perfil.atualizar is slim: updates nomeExibicao, NEVER touches the campanha perfil', async () => {
    const rig = await buildRig();
    const { caller, idCampanha } = await rig.addUser('aphk8-shim@example.com', 'Sofia');

    // Baby content written via the canonical per-campanha path.
    await caller.perfilCampanha.atualizar({ idCampanha, ...CONTEUDO_INPUT });

    // Slim name update — baby fields are no longer part of the input.
    await caller.perfil.atualizar({ nomeExibicao: 'Sofia Mãe' });

    // The legacy-shaped read reflects BOTH: the new name and the (untouched)
    // campanha baby-half, read through from perfil_campanhas.
    const proprio = await caller.perfil.getPerfil();
    expect(proprio.creatorName).toBe('Sofia Mãe');
    expect(proprio.nomeBebe).toBe('Helena');

    // The campanha perfil survived the name change intact (no wipe).
    const porCampanha = await caller.perfilCampanha.get({ idCampanha });
    expect(porCampanha.nomeBebe).toBe('Helena');
    expect(porCampanha.tipoEvento).toBe('cha-bebe');

    // The atualizar RESPONSE itself carries the read-through baby-half.
    const resposta = await caller.perfil.atualizar({ nomeExibicao: 'Sofia Mamãe' });
    expect(resposta.creatorName).toBe('Sofia Mamãe');
    expect(resposta.nomeBebe).toBe('Helena');
  });
});

// ── aperture-3vc12: needsOnboarding re-key (fblrt design §1.5) ──────────────
// The gate's READ must match where the wizard WRITES. Pre-fix, auth.me read
// the legacy per-user perfil_criadores while the setup wizard writes the
// per-campanha perfil_campanhas (perfilCampanha.atualizar does NOT dual-write
// the legacy table) — a fresh signup completing the wizard stayed stuck at
// needsOnboarding=true forever: the onboarding loop.
describe('auth.me needsOnboarding source (aperture-3vc12)', () => {
  const conteudoVazio = {
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

  it('THE BUG SCENARIO: fresh signup + wizard via perfilCampanha.atualizar flips the gate', async () => {
    const rig = await buildRig();
    const { caller, idCampanha } = await rig.addUser('3vc12-a@example.com', 'Ana');

    // Fresh signup: blank perfil → gate on.
    expect((await caller.auth.me())?.needsOnboarding).toBe(true);

    // The setup wizard's actual write path (per-campanha, NO legacy dual-write).
    await caller.perfilCampanha.atualizar({ idCampanha, nomeBebe: 'Aurora', ...conteudoVazio });

    // Pre-fix this stayed true forever (gate read perfil_criadores).
    expect((await caller.auth.me())?.needsOnboarding).toBe(false);
  });

  it("ANY named campanha flips the gate — a NEWER campanha's perfil onboards even if the oldest is blank (aperture-lrl1h)", async () => {
    const rig = await buildRig();
    const { caller } = await rig.addUser('3vc12-b@example.com', 'Bia');
    rig.advanceClock(60_000);
    const segunda = await caller.campanhas.criar({ titulo: 'Segunda lista' });

    // aperture-lrl1h — the gate means "has NO usable campaign at all", so
    // naming the SECOND (newer) campanha onboards the user even though the
    // oldest campanha's perfil is still blank. (Pre-fix this keyed on the
    // oldest campanha only and wrongly stayed true — the false-wizard bug.)
    await caller.perfilCampanha.atualizar({
      idCampanha: segunda.id,
      nomeBebe: 'Bento',
      ...conteudoVazio,
    });
    expect((await caller.auth.me())?.needsOnboarding).toBe(false);
  });

  it('whitespace-only nomeBebe still needs onboarding (trim posture preserved)', async () => {
    const rig = await buildRig();
    const { caller, idCampanha } = await rig.addUser('3vc12-c@example.com', 'Caio');

    // nomeBebe is trim().min(1) at the input schema, so a whitespace-only
    // write is rejected upstream — assert the gate stays on when the perfil
    // row exists with a NULL nomeBebe (partial wizard: only photos saved).
    await caller.perfilCampanha.atualizar({ idCampanha, nomeBebe: null, ...conteudoVazio });
    expect((await caller.auth.me())?.needsOnboarding).toBe(true);
  });
});
