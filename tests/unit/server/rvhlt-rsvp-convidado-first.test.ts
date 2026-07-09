/**
 * aperture-rvhlt (fblrt §3.3.1) — public RSVP convidado-first resolution.
 *
 * THE BUG: the public RSVP pair (eventoListaDeConvidados.getParaConfirmar +
 * confirmarPresenca) resolved slug → OLDEST campanha → evento → lista and
 * then searched for the convidado — so a guest link for any NON-oldest
 * campanha's convidado always missed (RSVP for a 2nd campanha impossible).
 *
 * THE FIX: resolve FROM the convidado (findByConvidadoId → lista → evento →
 * campanha) and use the slug ONLY as a validation cross-check.
 *
 * Matrix:
 *   A. THE BUG SCENARIO — a convidado on the NON-oldest campanha's lista:
 *      getParaConfirmar resolves them and confirmarPresenca lands on THAT
 *      lista (asserted by content, not just status).
 *   B. Back-compat — a convidado on the OLDEST campanha's lista keeps
 *      working (existing guest links unchanged).
 *   C. Cross-check — the same convidado under a DIFFERENT user's slug →
 *      NOT_FOUND (wrong slug behaves like unknown convidado; no oracle).
 *   D. Unknown convidado → NOT_FOUND.
 *
 * Rig: the dxljo/yeauv buildRig convention + direct repository saves for the
 * evento/lista aggregates (domain factories — the RSVP path under test is
 * the RESOLUTION, not evento creation).
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
import { criarEvento } from '../../../src/domain/evento/entities/evento.js';
import {
  type Convidado,
  criarListaDeConvidados,
} from '../../../src/domain/evento/entities/lista-de-convidados.js';
import type { DataHoraEvento } from '../../../src/domain/evento/value-objects/data-hora-evento.js';
import type {
  IdCampanha as IdCampanhaEvento,
  IdConvidado,
  IdEvento,
  IdListaDeConvidados,
} from '../../../src/domain/evento/value-objects/ids.js';
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
  slug: string;
}

interface Rig {
  deps: ServerDeps;
  anonCaller: Caller;
  addUser: (email: string) => Promise<RigUser>;
  /** Save an evento+lista holding `convidados` onto `idCampanha` directly. */
  seedListaParaCampanha: (
    idCampanha: string,
    convidados: readonly Convidado[],
  ) => Promise<{ idLista: string }>;
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
  const eventoRepository = new EventoRepositoryMemory();
  const listaDeConvidadosRepository = new ListaDeConvidadosRepositoryMemory();
  const pagamentoRepository = new PagamentoRepositoryMemory();
  const pagamentoProvider = new PagamentoProviderFake();

  // TICKING clock — consecutive campanha creations get strictly increasing
  // criadaEm so oldest-wins ordering is real (the frozen-clock trap).
  const clock = (() => {
    let tick = 0;
    return () => new Date(Date.parse('2026-07-08T02:00:00.000Z') + 1000 * tick++);
  })();

  const deps: ServerDeps = {
    db: {} as never,
    auth: {} as never,
    authService,
    usuarioRepository,
    perfilCriadorRepository: new PerfilCriadorRepositoryMemory(),
    plataformaRepository,
    campanhaRepository,
    contribuicaoRepository: new ContribuicaoRepositoryMemory(),
    recebedorRepository,
    eventoRepository,
    conviteRepository: new ConviteRepositoryMemory(),
    listaDeConvidadosRepository,
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
    clock,
    sessionCookieName: SESSION_COOKIE,
    publicOrigin: 'http://localhost:3001',
    trustedHopCount: 0,
    logPiiHashSalt: '',
    webhookEventArchive: new WebhookEventArchiveMemory(),
    objectStorage: new ObjectStorageMemory(),
  };

  async function addUser(email: string): Promise<RigUser> {
    const idUsuario = randomUUID();
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
        idUsuario,
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
    const usuario = await usuarioRepository.findUsuarioById(idUsuario as never);
    if (!usuario) throw new Error('setup: usuario nao encontrado pos-registro');
    const ctx: TrpcContext = {
      deps,
      headers: new Headers({ cookie: `${SESSION_COOKIE}=${encodeURIComponent(sessao.token)}` }),
      resHeaders: new Headers(),
    };
    return { caller: appRouter.createCaller(ctx), slug: usuario.slug };
  }

  async function seedListaParaCampanha(
    idCampanha: string,
    convidados: readonly Convidado[],
  ): Promise<{ idLista: string }> {
    const agora = clock();
    const evento = criarEvento({
      id: randomUUID() as IdEvento,
      idCampanha: idCampanha as IdCampanhaEvento,
      tipoEvento: 'cha-bebe',
      modalidade: 'presencial',
      dataHora: '2026-09-01T15:00:00.000Z' as DataHoraEvento,
      endereco: null,
      criadoEm: agora,
      atualizadoEm: agora,
    });
    await eventoRepository.save(evento);
    const lista = criarListaDeConvidados({
      id: randomUUID() as IdListaDeConvidados,
      idEvento: evento.id,
      formatoMensagemConvite: 'texto',
      convidados,
      criadoEm: agora,
      atualizadoEm: agora,
    });
    await listaDeConvidadosRepository.save(lista);
    return { idLista: lista.id };
  }

  const anonCtx: TrpcContext = { deps, headers: new Headers(), resHeaders: new Headers() };
  return { deps, anonCaller: appRouter.createCaller(anonCtx), addUser, seedListaParaCampanha };
}

function makeConvidado(nome: string): Convidado {
  return {
    id: randomUUID() as IdConvidado,
    nome,
    numeroCelular: '+55 11 98888-7777',
    presenca: 'nao_enviado',
  } as Convidado;
}

describe('public RSVP convidado-first resolution (aperture-rvhlt)', () => {
  it('A. THE BUG SCENARIO: a convidado on the NON-oldest campanha resolves + confirms on THAT lista', async () => {
    const rig = await buildRig();
    const user = await rig.addUser(`rvhlt-owner-${randomUUID()}@example.com`);
    const nova = await user.caller.campanhas.criar({ titulo: 'Segunda Lista (não-oldest)' });

    const convidado = makeConvidado('Convidada da Segunda');
    const { idLista } = await rig.seedListaParaCampanha(nova.id, [convidado]);

    // Pre-fix this threw NOT_FOUND (the slug resolved the OLDEST campanha,
    // which has no evento/lista at all — let alone this convidado).
    const out = await rig.anonCaller.eventoListaDeConvidados.getParaConfirmar({
      slug: user.slug,
      idConvidado: convidado.id,
    });
    expect(out.nome).toBe('Convidada da Segunda');
    // fblrt amendment #3: the output carries the convidado's OWN campanha
    // (the NON-oldest one) so the RSVP page can address the convite preview
    // at the right campanha. Strongest isolation assertion available here.
    expect(out.idCampanha).toBe(nova.id);

    const confirmada = await rig.anonCaller.eventoListaDeConvidados.confirmarPresenca({
      slug: user.slug,
      idConvidado: convidado.id,
      presenca: 'sim',
    });
    expect(confirmada.idCampanha).toBe(nova.id);

    // Content assertion: the presence landed on the NON-oldest campanha's
    // lista (the right lista, the right convidado).
    const listaDepois = await rig.deps.listaDeConvidadosRepository.findById(idLista as never);
    expect(listaDepois?.convidados.find((c) => c.id === convidado.id)?.presenca).toBe('sim');
  });

  it('B. back-compat: a convidado on the OLDEST campanha keeps working unchanged', async () => {
    const rig = await buildRig();
    const user = await rig.addUser(`rvhlt-oldest-${randomUUID()}@example.com`);
    // Signup created the (oldest) default campanha; find its id via auth.me.
    const me = await user.caller.auth.me();
    if (!me?.idCampanha) throw new Error('setup: oldest campanha ausente');
    // A second campanha exists too — proving oldest still resolves.
    await user.caller.campanhas.criar({ titulo: 'Distração' });

    const convidado = makeConvidado('Convidado do Oldest');
    await rig.seedListaParaCampanha(me.idCampanha, [convidado]);

    const out = await rig.anonCaller.eventoListaDeConvidados.getParaConfirmar({
      slug: user.slug,
      idConvidado: convidado.id,
    });
    expect(out.nome).toBe('Convidado do Oldest');
    expect(out.idCampanha).toBe(me.idCampanha);
  });

  it('C. cross-check: the convidado under a DIFFERENT user slug → NOT_FOUND (no oracle)', async () => {
    const rig = await buildRig();
    const owner = await rig.addUser(`rvhlt-own-${randomUUID()}@example.com`);
    const stranger = await rig.addUser(`rvhlt-str-${randomUUID()}@example.com`);
    const nova = await owner.caller.campanhas.criar({ titulo: 'Lista do Owner' });
    const convidado = makeConvidado('Convidada Cruzada');
    await rig.seedListaParaCampanha(nova.id, [convidado]);

    await expect(
      rig.anonCaller.eventoListaDeConvidados.getParaConfirmar({
        slug: stranger.slug,
        idConvidado: convidado.id,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await expect(
      rig.anonCaller.eventoListaDeConvidados.confirmarPresenca({
        slug: stranger.slug,
        idConvidado: convidado.id,
        presenca: 'sim',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('D. unknown convidado → NOT_FOUND', async () => {
    const rig = await buildRig();
    const user = await rig.addUser(`rvhlt-unk-${randomUUID()}@example.com`);

    await expect(
      rig.anonCaller.eventoListaDeConvidados.getParaConfirmar({
        slug: user.slug,
        idConvidado: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
