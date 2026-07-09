/**
 * aperture-aphk8 (W1a) — campanha slug procedures.
 *
 * Covers the frozen contract:
 *   - campanhas.definirSlug: happy path + normalization (trim/lowercase);
 *     'slug_formato_invalido' | 'slug_reservado' | 'slug_em_uso' BAD_REQUEST
 *     messages (EXACT strings — frontend switches on them);
 *   - em_uso is PER-CONTA only: the same conta's OTHER campanha conflicts, a
 *     DIFFERENT conta using the same slug is ALLOWED;
 *   - campanhas.validarSlug mirrors the checks but NEVER throws for a
 *     taken/invalid slug (only auth errors throw);
 *   - pagina.resolverCampanhaSlug: PUBLIC (slug, campanhaSlug) → idCampanha;
 *     wrong-user-slug → non-leaking NOT_FOUND;
 *   - campanhas.list cards carry campanhaSlug + hasRecebedor.
 *
 * Rig: self-contained copy of the dxljo/u38rz buildRig convention with
 * perfilCampanhaRepository added and a mutable clock for deterministic
 * campanha ordering.
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

describe('campanhas.definirSlug (aperture-aphk8)', () => {
  it('happy path: normalizes (trim + lowercase), persists, and returns the slug', async () => {
    const rig = await buildRig();
    const { caller, idCampanha } = await rig.addUser('slug-a@example.com', 'Ana');

    const out = await caller.campanhas.definirSlug({ idCampanha, slug: '  Minha-Lista ' });
    expect(out).toEqual({ slug: 'minha-lista' });

    const { novas } = await caller.campanhas.list();
    expect(novas[0]?.campanhaSlug).toBe('minha-lista');
  });

  it('card nomeBebe (fblrt amendment #2): null while blank, set after perfilCampanha.atualizar', async () => {
    const rig = await buildRig();
    const { caller, idCampanha } = await rig.addUser('slug-nb@example.com', 'Nina');

    // Fresh campanha → blank perfil → nomeBebe null (the canonical
    // blank-perfil signal the "completar" affordance keys on).
    const antes = await caller.campanhas.list();
    expect(antes.novas[0]?.nomeBebe).toBeNull();

    await caller.perfilCampanha.atualizar({
      idCampanha,
      nomeBebe: 'Aurora',
      relacao: null,
      historia: null,
      dataNascimento: null,
      tipoEvento: null,
      genero: null,
      dataEvento: null,
      fotoPerfilKey: null,
      fotoCapaKey: null,
      fotoHistoriaKey: null,
    });

    const depois = await caller.campanhas.list();
    expect(depois.novas[0]?.nomeBebe).toBe('Aurora');

    // A SECOND campanha stays blank — the signal is per-campanha, not
    // per-conta (the whole point of the fblrt isolation epic).
    const cardB = await caller.campanhas.criar({ titulo: 'Segunda do bebe' });
    expect(cardB.nomeBebe).toBeNull();
    const comSegunda = await caller.campanhas.list();
    expect(comSegunda.novas.find((c) => c.id === cardB.id)?.nomeBebe).toBeNull();
    expect(comSegunda.novas.find((c) => c.id === idCampanha)?.nomeBebe).toBe('Aurora');
  });

  it("formato: too-short / leading-digit → BAD_REQUEST 'slug_formato_invalido'", async () => {
    const rig = await buildRig();
    const { caller, idCampanha } = await rig.addUser('slug-b@example.com', 'Bia');

    for (const bad of ['ab', '1abc', 'tem espaço', 'MAIUS!']) {
      await expect(caller.campanhas.definirSlug({ idCampanha, slug: bad })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'slug_formato_invalido',
      });
    }
  });

  it("reservado: RESERVED_SLUGS ∪ {'c','sucesso'} → BAD_REQUEST 'slug_reservado'", async () => {
    const rig = await buildRig();
    const { caller, idCampanha } = await rig.addUser('slug-c@example.com', 'Caio');

    // 'c' fails the min-3 FORMAT check first by regex length — assert the
    // reserved words that pass the format gate.
    for (const reserved of ['admin', 'pagina', 'sucesso', 'painel']) {
      await expect(
        caller.campanhas.definirSlug({ idCampanha, slug: reserved }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'slug_reservado' });
    }
  });

  it("em_uso: the SAME conta's OTHER campanha holds it → 'slug_em_uso'; re-setting the same campanha is allowed", async () => {
    const rig = await buildRig();
    const { caller, idCampanha } = await rig.addUser('slug-d@example.com', 'Duda');

    await caller.campanhas.definirSlug({ idCampanha, slug: 'lista-da-duda' });

    rig.advanceClock(60_000);
    const cardB = await caller.campanhas.criar({ titulo: 'Segunda lista' });
    await expect(
      caller.campanhas.definirSlug({ idCampanha: cardB.id, slug: 'lista-da-duda' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'slug_em_uso' });

    // Idempotent re-set of the SAME campanha's own slug is NOT a conflict.
    await expect(
      caller.campanhas.definirSlug({ idCampanha, slug: 'lista-da-duda' }),
    ).resolves.toEqual({ slug: 'lista-da-duda' });
  });

  it('per-conta uniqueness only: a DIFFERENT conta may use the same slug', async () => {
    const rig = await buildRig();
    const a = await rig.addUser('slug-e1@example.com', 'Elisa');
    const b = await rig.addUser('slug-e2@example.com', 'Enzo');

    await a.caller.campanhas.definirSlug({ idCampanha: a.idCampanha, slug: 'meu-cha' });
    await expect(
      b.caller.campanhas.definirSlug({ idCampanha: b.idCampanha, slug: 'meu-cha' }),
    ).resolves.toEqual({ slug: 'meu-cha' });
  });

  it("IDOR/anon: someone else's campanha or no session → UNAUTHORIZED", async () => {
    const rig = await buildRig();
    const a = await rig.addUser('slug-f1@example.com', 'Flora');
    const b = await rig.addUser('slug-f2@example.com', 'Fabio');

    await expect(
      b.caller.campanhas.definirSlug({ idCampanha: a.idCampanha, slug: 'roubado' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      rig.anonCaller.campanhas.definirSlug({ idCampanha: a.idCampanha, slug: 'anonimo' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});

describe('campanhas.validarSlug (aperture-aphk8)', () => {
  it('mirrors the checks WITHOUT throwing: formato / reservado / em_uso / disponivel', async () => {
    const rig = await buildRig();
    const { caller, idCampanha } = await rig.addUser('slug-g@example.com', 'Gabi');

    expect(await caller.campanhas.validarSlug({ idCampanha, slug: 'ab' })).toEqual({
      disponivel: false,
      motivo: 'formato',
    });
    expect(await caller.campanhas.validarSlug({ idCampanha, slug: 'admin' })).toEqual({
      disponivel: false,
      motivo: 'reservado',
    });

    rig.advanceClock(60_000);
    const cardB = await caller.campanhas.criar({ titulo: 'Segunda lista' });
    await caller.campanhas.definirSlug({ idCampanha: cardB.id, slug: 'ja-tomado' });
    expect(await caller.campanhas.validarSlug({ idCampanha, slug: 'ja-tomado' })).toEqual({
      disponivel: false,
      motivo: 'em_uso',
    });

    expect(await caller.campanhas.validarSlug({ idCampanha, slug: '  Livre-123 ' })).toEqual({
      disponivel: true,
      motivo: null,
    });

    // The campanha's OWN current slug validates as available (re-save flow).
    await caller.campanhas.definirSlug({ idCampanha, slug: 'meu-proprio' });
    expect(await caller.campanhas.validarSlug({ idCampanha, slug: 'meu-proprio' })).toEqual({
      disponivel: true,
      motivo: null,
    });
  });

  it('only AUTH errors throw', async () => {
    const rig = await buildRig();
    const a = await rig.addUser('slug-h@example.com', 'Hugo');

    await expect(
      rig.anonCaller.campanhas.validarSlug({ idCampanha: a.idCampanha, slug: 'qualquer' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});

describe('pagina.resolverCampanhaSlug (aperture-aphk8, PUBLIC)', () => {
  it('resolves (userSlug, campanhaSlug) → idCampanha for an anonymous visitor', async () => {
    const rig = await buildRig();
    const { caller, idCampanha, slug } = await rig.addUser('slug-i@example.com', 'Ivo');
    await caller.campanhas.definirSlug({ idCampanha, slug: 'cha-do-ivo' });

    const out = await rig.anonCaller.pagina.resolverCampanhaSlug({
      slug,
      campanhaSlug: 'cha-do-ivo',
    });
    expect(out).toEqual({ idCampanha });
  });

  it("wrong user-slug (someone else's campanhaSlug) → non-leaking NOT_FOUND", async () => {
    const rig = await buildRig();
    const a = await rig.addUser('slug-j1@example.com', 'Joana');
    const b = await rig.addUser('slug-j2@example.com', 'Jonas');
    await a.caller.campanhas.definirSlug({ idCampanha: a.idCampanha, slug: 'cha-da-joana' });

    // B's user-slug + A's campanha slug → 404 with the standard message.
    await expect(
      rig.anonCaller.pagina.resolverCampanhaSlug({
        slug: b.slug,
        campanhaSlug: 'cha-da-joana',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Pagina nao encontrada' });

    // Unknown user-slug → byte-equal 404.
    await expect(
      rig.anonCaller.pagina.resolverCampanhaSlug({
        slug: 'nao-existe',
        campanhaSlug: 'cha-da-joana',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Pagina nao encontrada' });

    // Known user, unknown campanhaSlug → byte-equal 404.
    await expect(
      rig.anonCaller.pagina.resolverCampanhaSlug({
        slug: a.slug,
        campanhaSlug: 'nunca-definido',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Pagina nao encontrada' });
  });
});

describe('campanhas.list card fields (aperture-aphk8)', () => {
  it('cards carry campanhaSlug (null until claimed) + hasRecebedor (false pre-bank-info)', async () => {
    const rig = await buildRig();
    const { caller, idCampanha } = await rig.addUser('slug-k@example.com', 'Karla');

    const before = await caller.campanhas.list();
    expect(before.novas[0]?.campanhaSlug).toBeNull();
    expect(before.novas[0]?.hasRecebedor).toBe(false);

    await caller.campanhas.definirSlug({ idCampanha, slug: 'lista-da-karla' });
    const after = await caller.campanhas.list();
    expect(after.novas[0]?.campanhaSlug).toBe('lista-da-karla');
    expect(after.novas[0]?.hasRecebedor).toBe(false);
  });
});
