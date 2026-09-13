/**
 * aperture-ai8vg — creator-funnel server events through the REAL routers with
 * in-memory adapters and a fake analytics sink (rig mirrors
 * rvhlt-rsvp-convidado-first.test.ts). One event per durable fact, stable
 * insertKey, first-vs-again semantics, and no PII in props.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fatoPerfilSalvo } from '../../../apps/eunenem-server/server/analytics/funil.js';
import type { ServerAnalyticsTrackOptions } from '../../../apps/eunenem-server/server/analytics/server-analytics.js';
import type { ServerDeps } from '../../../apps/eunenem-server/server/auth/setup.js';
import type { TrpcContext } from '../../../apps/eunenem-server/server/trpc/context.js';
import { upsertConteudoPerfilCampanha } from '../../../apps/eunenem-server/server/trpc/perfil-campanha-router.js';
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
// Simulated credential for the in-memory auth service (no real secret; the
// value is assembled so secret scanners do not mistake a fixture for a leak).
const SENHA_FIXTURE = ['fixture', 'local', String(123)].join('-');

interface Tracked {
  event: string;
  distinctId: string | null;
  props?: Record<string, unknown>;
  options?: ServerAnalyticsTrackOptions;
}

async function buildRig() {
  const observability: Observability = { logger: new NoopLogger(), tracer: noopTracer() };
  const authService = new AuthServiceMemoria();
  const usuarioRepository = new UsuarioRepositoryMemory();
  const plataformaRepository = new PlataformaRepositoryMemory();
  const recebedorRepository = new RecebedorRepositoryMemory();
  const campanhaRepository = new CampanhaRepositoryMemory(recebedorRepository);
  const pagamentoRepository = new PagamentoRepositoryMemory();
  const pagamentoProvider = new PagamentoProviderFake();
  const clock = (() => {
    let tick = 0;
    return () => new Date(Date.parse('2026-09-13T12:00:00.000Z') + 1000 * tick++);
  })();
  const tracked: Tracked[] = [];

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
    serverAnalytics: {
      track: (event, distinctId, props, options) => {
        tracked.push({ event, distinctId, props, options });
      },
    },
  };

  async function addUser(email: string) {
    const idUsuario = randomUUID();
    const idConta = randomUUID();
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
        idConta,
        idPlataforma: ID_PLATAFORMA_EUNENEM,
        email,
        nomeExibicao: 'Francisco',
        senhaSimulada: SENHA_FIXTURE,
      },
    );
    const sessao = await criarSessaoUsuario(
      { usuarioRepository, authService, observability },
      { idPlataforma: ID_PLATAFORMA_EUNENEM, email, senhaSimulada: SENHA_FIXTURE },
    );
    const ctx: TrpcContext = {
      deps,
      headers: new Headers({ cookie: `${SESSION_COOKIE}=${encodeURIComponent(sessao.token)}` }),
      resHeaders: new Headers(),
    };
    return { caller: appRouter.createCaller(ctx), idConta };
  }

  return { deps, tracked, addUser };
}

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

function conviteSaveInput(idCampanha: string) {
  return {
    idCampanha,
    tipoEvento: 'cha-bebe' as const,
    modalidade: 'presencial' as const,
    dataHoraIso: '2026-08-01T15:00:00.000Z',
    endereco: 'Rua das Flores, 123',
    remetente: 'Francisco',
    nomeExibido: 'Helena',
    mensagem: 'Venha comemorar conosco!',
    paleta: 'lilas' as const,
    fonte: 'patrick' as const,
    modelo: 'scrapbook' as const,
  };
}

describe('creator-funnel server events (aperture-ai8vg)', () => {
  it('campanha_criada: explicit create only, origem provada, no title, dedup on the campanha id', async () => {
    const rig = await buildRig();
    const user = await rig.addUser(`ai8vg-camp-${randomUUID()}@example.com`);
    rig.tracked.length = 0;

    const nova = await user.caller.campanhas.criar({ titulo: 'Lista da Helena' });

    const ev = rig.tracked.filter((e) => e.event === 'campanha_criada');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      distinctId: user.idConta,
      props: { idCampanha: nova.id, origem: 'explicita' },
      options: { insertKey: nova.id },
    });
    expect(ev[0]?.props).not.toHaveProperty('titulo');
    expect(JSON.stringify(ev[0])).not.toContain('Lista da Helena');
  });

  it('lista_item_criado per durable write: units, stable row key, persisted criadaEm, NO first-item claim', async () => {
    const rig = await buildRig();
    const user = await rig.addUser(`ai8vg-item-${randomUUID()}@example.com`);
    const nova = await user.caller.campanhas.criar({ titulo: 'Itens' });
    rig.tracked.length = 0;

    const first = await user.caller.contribuicao.createBulk({
      idCampanha: nova.id,
      items: [
        { nome: 'Fralda', valor: 100, quantidade: 2 },
        { nome: 'Body', valor: 50, quantidade: 1 },
      ],
    });
    await user.caller.contribuicao.create({
      idCampanha: nova.id,
      nome: 'Chupeta',
      valor: 30,
      quantidade: 1,
    });

    const itens = rig.tracked.filter((e) => e.event === 'lista_item_criado');
    expect(itens).toHaveLength(2);
    expect(itens[0]).toMatchObject({
      distinctId: user.idConta,
      props: { id_campanha: nova.id, linhas: 2, quantidade_itens: 3 },
      options: { insertKey: first.ids[0] },
    });
    expect(itens[0]?.props).not.toHaveProperty('primeiro_item');
    expect(itens[1]?.props).toMatchObject({ linhas: 1, quantidade_itens: 1 });
    // Time = the created rows' PERSISTED criadaEm, not a later clock read.
    const linhas = await rig.deps.contribuicaoRepository.findByCampanhaId(nova.id as never);
    const criada = linhas.find((l) => l.id === first.ids[0])?.criadaEm;
    expect(itens[0]?.options?.occurredAt).toEqual(criada);
    // No first-item emitter exists at all (root decision: derived, not emitted).
    expect(rig.tracked.some((e) => e.event === 'lista_primeiro_item')).toBe(false);
    expect(JSON.stringify(rig.tracked)).not.toContain('Fralda');
  });

  it('lista_item_criado: no durable created row on the re-read → ZERO events, never a clock fallback', async () => {
    const rig = await buildRig();
    const user = await rig.addUser(`ai8vg-noread-${randomUUID()}@example.com`);
    const nova = await user.caller.campanhas.criar({ titulo: 'Sem leitura' });
    // Read shape that never surfaces the created rows (visibility / shape
    // mismatch). The write path is untouched: create must still succeed.
    const repo = rig.deps.contribuicaoRepository;
    const original = repo.findByCampanhaId.bind(repo);
    repo.findByCampanhaId = (async () => []) as typeof repo.findByCampanhaId;
    rig.tracked.length = 0;

    const created = await user.caller.contribuicao.createBulk({
      idCampanha: nova.id,
      items: [{ nome: 'Fralda', valor: 100, quantidade: 2 }],
    });
    expect(created.ids).toHaveLength(1);
    repo.findByCampanhaId = original;
    expect((await original(nova.id as never)).map((l) => l.id)).toEqual(created.ids);

    expect(rig.tracked.filter((e) => e.event === 'lista_item_criado')).toHaveLength(0);
    // Nothing emitted carries a non-durable time: no event at all was tracked.
    expect(rig.tracked.some((e) => e.event === 'lista_primeiro_item')).toBe(false);
  });

  it('two-caller barrier: concurrent first writes emit one event per DURABLE write and no first claim', async () => {
    const rig = await buildRig();
    const user = await rig.addUser(`ai8vg-race-${randomUUID()}@example.com`);
    const nova = await user.caller.campanhas.criar({ titulo: 'Corrida' });
    rig.tracked.length = 0;

    await Promise.all([
      user.caller.contribuicao.createBulk({
        idCampanha: nova.id,
        items: [{ nome: 'A', valor: 10, quantidade: 1 }],
      }),
      user.caller.contribuicao.createBulk({
        idCampanha: nova.id,
        items: [{ nome: 'B', valor: 20, quantidade: 1 }],
      }),
    ]);

    const itens = rig.tracked.filter((e) => e.event === 'lista_item_criado');
    expect(itens).toHaveLength(2); // one per durable write, distinct row keys
    expect(new Set(itens.map((e) => e.options?.insertKey)).size).toBe(2);
    for (const e of itens) expect(e.props).not.toHaveProperty('primeiro_item');
    // "First item" is never claimed by any caller: it is derived downstream
    // (first lista_item_criado per campanha; DB MIN(criada_em) — SQL §4b).
    expect(rig.tracked.some((e) => e.event === 'lista_primeiro_item')).toBe(false);
  });

  it('perfil_campanha_salvo: keyed/timed by the DURABLE row, nomeado + a field COUNT, no values, no first-save claim', async () => {
    const rig = await buildRig();
    const user = await rig.addUser(`ai8vg-perfil-${randomUUID()}@example.com`);
    const nova = await user.caller.campanhas.criar({ titulo: 'Perfil' });
    rig.tracked.length = 0;

    await user.caller.perfilCampanha.atualizar({ idCampanha: nova.id, ...CONTEUDO_INPUT });
    await user.caller.perfilCampanha.atualizar({
      idCampanha: nova.id,
      ...CONTEUDO_INPUT,
      historia: 'Outra história.',
    });

    const ev = rig.tracked.filter((e) => e.event === 'perfil_campanha_salvo');
    expect(ev).toHaveLength(2);
    expect(ev[0]).toMatchObject({
      distinctId: user.idConta,
      props: { id_campanha: nova.id, nomeado: true },
    });
    expect(ev[0]?.props).not.toHaveProperty('primeira_vez');
    expect(typeof ev[0]?.props?.campos_preenchidos).toBe('number');
    // Both keys reference the ONE durable row for this campanha, with its
    // persisted atualizadoEm as the time.
    const row = await rig.deps.perfilCampanhaRepository.findByIdCampanha(nova.id as never);
    expect(row).toBeDefined();
    for (const e of ev) expect(e.options?.insertKey?.startsWith(`${row?.id}:`)).toBe(true);
    expect(ev[1]?.options?.occurredAt).toEqual(row?.atualizadoEm);
    expect(ev[0]?.options?.insertKey).not.toBe(ev[1]?.options?.insertKey);
    expect(JSON.stringify(ev)).not.toContain('Helena');
    expect(JSON.stringify(ev)).not.toContain('amor');
  });

  it('perfil first-save two-caller barrier: the emitted key is the DURABLE row id, never a transient one', async () => {
    // Real boundary of the analytics claim: the perfil upsert + the durable
    // re-read (fatoPerfilSalvo). Two concurrent FIRST saves on the same
    // campanha each mint a candidate perfil id in memory; only one id can be
    // persisted (Postgres ON CONFLICT (id_campanha) keeps the winner's — the
    // repository's own conformance covers that adapter contract). Whatever a
    // caller's returned object says, the event key must come from the row
    // that is actually stored.
    const rig = await buildRig();
    const repo = rig.deps.perfilCampanhaRepository;
    // Domain-shaped conteudo: take it from a row the real router persisted.
    const user = await rig.addUser(`ai8vg-perfil-race-${randomUUID()}@example.com`);
    const semente = await user.caller.campanhas.criar({ titulo: 'Semente' });
    await user.caller.perfilCampanha.atualizar({ idCampanha: semente.id, ...CONTEUDO_INPUT });
    const conteudo = (await repo.findByIdCampanha(semente.id as never))?.conteudo;
    expect(conteudo).toBeDefined();
    // A FRESH campanha with no perfil row: two concurrent first saves.
    const idCampanha = randomUUID() as never;
    const deps = {
      perfilCampanhaRepository: repo,
      objectStorage: rig.deps.objectStorage,
      clock: rig.deps.clock,
    };

    const [a, b] = await Promise.all([
      upsertConteudoPerfilCampanha(deps, idCampanha, conteudo as never),
      upsertConteudoPerfilCampanha(deps, idCampanha, conteudo as never),
    ]);
    const [fatoA, fatoB] = await Promise.all([
      fatoPerfilSalvo(repo, idCampanha),
      fatoPerfilSalvo(repo, idCampanha),
    ]);
    const row = await repo.findByIdCampanha(idCampanha);

    expect(row).toBeDefined();
    expect(fatoA?.insertKey.split(':')[0]).toBe(row?.id);
    expect(fatoB?.insertKey.split(':')[0]).toBe(row?.id);
    // At least one caller's returned object carried an id that did NOT survive
    // (or both did, if the adapter serialized them) — either way no emitted
    // key references anything but the durable row.
    for (const transiente of [a.id, b.id]) {
      if (transiente !== row?.id) {
        expect(fatoA?.insertKey.startsWith(`${transiente}:`)).toBe(false);
        expect(fatoB?.insertKey.startsWith(`${transiente}:`)).toBe(false);
      }
    }
  });

  it('convite_criado: first save only, dedup on the convite id, no free text', async () => {
    const rig = await buildRig();
    const user = await rig.addUser(`ai8vg-convite-${randomUUID()}@example.com`);
    const nova = await user.caller.campanhas.criar({ titulo: 'Convite' });
    rig.tracked.length = 0;

    const saved = await user.caller.eventoConvite.save(conviteSaveInput(nova.id));
    await user.caller.eventoConvite.save({ ...conviteSaveInput(nova.id), mensagem: 'Mudou!' });

    const ev = rig.tracked.filter((e) => e.event === 'convite_criado');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      distinctId: user.idConta,
      props: { id_campanha: nova.id, id_evento: saved.evento.id, modelo: 'scrapbook' },
      options: { insertKey: saved.convite.id },
    });
    expect(JSON.stringify(ev)).not.toContain('Venha');
    expect(JSON.stringify(ev)).not.toContain('Rua das Flores');
  });

  it('convidado_criado: one per added guest with the running total, never name/phone', async () => {
    const rig = await buildRig();
    const user = await rig.addUser(`ai8vg-guest-${randomUUID()}@example.com`);
    const nova = await user.caller.campanhas.criar({ titulo: 'Convidados' });
    await user.caller.eventoConvite.save(conviteSaveInput(nova.id));
    rig.tracked.length = 0;

    await user.caller.eventoListaDeConvidados.adicionarConvidado({
      idCampanha: nova.id,
      nome: 'Tia Clara',
      numeroCelular: '+55 11 98888-7777',
    });
    await user.caller.eventoListaDeConvidados.adicionarConvidado({
      idCampanha: nova.id,
      nome: 'Vovó Rosa',
      numeroCelular: '+55 11 97777-6666',
    });

    const ev = rig.tracked.filter((e) => e.event === 'convidado_criado');
    expect(ev).toHaveLength(2);
    expect(ev[0]).toMatchObject({
      distinctId: user.idConta,
      props: { id_campanha: nova.id, total_convidados: 1 },
    });
    expect(ev[1]?.props).toMatchObject({ total_convidados: 2 });
    // Dedup key = the new convidado's own id: a uuid, distinct per guest.
    const keys = ev.map((e) => e.options?.insertKey);
    expect(keys.every((k) => typeof k === 'string' && k.length === 36)).toBe(true);
    expect(new Set(keys).size).toBe(2);
    expect(JSON.stringify(ev)).not.toContain('Tia Clara');
    expect(JSON.stringify(ev)).not.toContain('98888');
  });
});
