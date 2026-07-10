/**
 * aperture-g1wl4 (part 1) — THROUGH-THE-ROUTER suite for PR #344
 * (aperture-yeauv: per-hop OPTIONAL idCampanha resolution).
 *
 * Rex's own unit suite (yeauv-resolve-campanha-administrada.test.ts) pins the
 * shared resolver DIRECTLY. This file deliberately does NOT touch the resolver
 * — every assertion goes through `appRouter.createCaller`, so the wiring of
 * each hop (schema → resolver arg → toTRPCError mapping) is what's under test.
 *
 * PER-HOP MATRIX (each procedure that gained idCampanha in #344), updated for
 * aperture-48mxt (W2 enforce — authed writes are campanha-addressed):
 *   1a. QUERIES + PUBLIC hops, bare (no idCampanha) → resolve the OLDEST
 *       campanha, even after a 2nd campanha is created mid-test
 *       (shared-bare-link back-compat pin — semantics UNCHANGED by W2);
 *   1b. the 11 AUTHED MUTATIONS (contribuicao.create/createBulk/update/delete/
 *       emitirUrlUploadImagemItem, eventoConvite.save, eventoListaDeConvidados.
 *       alterarPresenca/adicionarConvidado/salvarFormatoMensagem,
 *       painelMensagens.marcarLida/marcarTodasLidas) now REQUIRE
 *       `idCampanha: z.string().uuid()` — a bare authed write is rejected at
 *       the schema with BAD_REQUEST. The former bare→oldest write behavior is
 *       pinned EXPLICITLY instead: addressing the oldest campanha's id
 *       produces the effect the bare call used to;
 *   2. idCampanha = caller's SECOND campanha → resolves THAT one;
 *   3. idCampanha = another conta's campanha → rejected;
 *   4. idCampanha = unknown uuid            → rejected with the IDENTICAL
 *      shape as (3) — code AND message byte-equal (no existence oracle).
 *
 * REJECTION SHAPES (from the #344 diff):
 *   - authed hops via resolverCampanhaAdministrada (contribuicao.*,
 *     eventoConvite.get/save, eventoListaDeConvidados.get/alterarPresenca/
 *     adicionarConvidado/salvarFormatoMensagem):
 *       UNAUTHORIZED  'Campanha nao encontrada ou nao autorizada'
 *   - painelMensagens.* (slug-addressed authed, local mirror of the contract):
 *       UNAUTHORIZED  'Campanha nao encontrada ou nao autorizada'
 *   - eventoConvite.getPreview (PUBLIC slug hop):
 *       NOT_FOUND     'Campanha nao encontrada ou nao autorizada'
 *   - pagina.* (PUBLIC slug hops):
 *       NOT_FOUND     'Pagina nao encontrada'
 *
 * MONEY-PATH FINDING (reported, not papered over): the dispatch premise was
 * "checkout/pagamento procedures did NOT gain idCampanha". The actual #344
 * diff CONTRADICTS that for the pagina router: iniciarPagamentoContribuicao,
 * iniciarPagamentoCarrinho and obterSucessoPagamento ALL gained OPTIONAL
 * idCampanha (they share resolvePaginaBySlug). They are therefore covered by
 * the full matrix here. What genuinely did NOT change is the WITHDRAWAL money
 * surface — recebedor.criar / extrato.summary / extrato.list /
 * transferencia.solicitar / listMovimentacoes keep their REQUIRED
 * `idCampanha: z.string().uuid()` (no optional-absent → oldest-resolution
 * branch snuck into money movement); that is pinned below, plus a happy
 * bare checkout that still resolves the oldest campanha unchanged.
 *
 * RIG: mirrors Rex's yeauv buildRig (shared deps, addUser, and — banked
 * frozen-clock trap — a TICKING clock, +1s per read, so signup campanha and
 * campanhas.criar get strictly increasing criadaEm and 'oldest' is real, not
 * an id-tiebreak coin flip). Includes the 4 newer ServerDeps fields
 * (perfilCriadorRepository, listaDeConvidadosRepository, adminAllowedEmails,
 * objectStorage).
 *
 * NOTE on error identity: rejections are read as plain `{code, message}`
 * properties — deliberately NO `instanceof TRPCError`, which is fragile
 * across the apps/eunenem-server ↔ root-tests module boundary (see the
 * resolver header in resolve-campanha-administrada.ts).
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
  ctx: TrpcContext;
  idConta: string;
  slug: string;
  /** the signup-created campanha — always the OLDEST of the conta */
  campanhaSignup: { id: string };
}

interface Rig {
  deps: ServerDeps;
  anonCaller: Caller;
  addUser: (email: string) => Promise<RigUser>;
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
    // TICKING clock (banked frozen-clock trap): +1s per read so the signup
    // campanha and every campanhas.criar get strictly increasing criadaEm —
    // findByAdministrador's criada_em ASC 'oldest' is then deterministic.
    clock: (() => {
      let tick = 0;
      return () => new Date(Date.parse('2026-07-08T02:00:00.000Z') + 1000 * tick++);
    })(),
    sessionCookieName: SESSION_COOKIE,
    publicOrigin: 'http://localhost:3001',
    trustedHopCount: 0,
    logPiiHashSalt: '',
    webhookEventArchive: new WebhookEventArchiveMemory(),
    objectStorage: new ObjectStorageMemory(),
  };

  async function addUser(email: string): Promise<RigUser> {
    const idConta = randomUUID();
    const registro = await registrarContaUsuario(
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
        idConta,
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
    return {
      caller: appRouter.createCaller(ctx),
      ctx,
      idConta,
      slug: registro.usuario.slug as string,
      campanhaSignup: { id: registro.campanha.id as string },
    };
  }

  const anonCtx: TrpcContext = { deps, headers: new Headers(), resHeaders: new Headers() };

  return { deps, anonCaller: appRouter.createCaller(anonCtx), addUser };
}

/**
 * Await a rejection and read `{code, message}` off the thrown error as plain
 * properties (no instanceof — see file header). Fails the test if the call
 * unexpectedly resolves.
 */
async function captureRejection(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p;
  } catch (err) {
    const e = err as { code?: unknown; message?: unknown };
    return { code: String(e.code), message: String(e.message) };
  }
  throw new Error('esperava uma rejeicao, mas a chamada resolveu');
}

function uniqueEmail(prefix: string): string {
  return `g1wl4-${prefix}-${randomUUID()}@example.com`;
}

/** Valid eventoConvite.save payload (idCampanha optionally threaded). */
function conviteSaveInput(nomeExibido: string, idCampanha?: string) {
  return {
    ...(idCampanha === undefined ? {} : { idCampanha }),
    tipoEvento: 'cha-bebe' as const,
    modalidade: 'presencial' as const,
    dataHoraIso: '2026-08-01T15:00:00.000Z',
    endereco: 'Rua das Flores, 123',
    remetente: 'Francisco',
    nomeExibido,
    mensagem: 'Venha comemorar conosco!',
    paleta: 'lilas' as const,
    fonte: 'patrick' as const,
    modelo: 'scrapbook' as const,
  };
}

// ── Owner-gate matrix driver (cases 3 + 4 for EVERY hop wired in #344) ──────
//
// For each hop: reject a foreign campanha id AND an unknown uuid, then assert
// the two rejections are byte-identical (code AND message) — the non-leaking
// contract: an attacker cannot use the error to probe campanha existence.

interface OwnerGateHop {
  name: string;
  /**
   * authed  — session-cookie hop via resolverCampanhaAdministrada
   * painel  — session + slug hop (painelMensagens local mirror)
   * public  — no-session slug hop (pagina / convite preview)
   */
  surface: 'authed' | 'painel' | 'public';
  expectedCode: 'UNAUTHORIZED' | 'NOT_FOUND';
  invoke: (args: { caller: Caller; slug: string }, idCampanha: string) => Promise<unknown>;
}

const OWNER_GATE_HOPS: OwnerGateHop[] = [
  // contribuicao (authed)
  {
    name: 'contribuicao.list',
    surface: 'authed',
    expectedCode: 'UNAUTHORIZED',
    invoke: ({ caller }, idCampanha) => caller.contribuicao.list({ idCampanha }),
  },
  {
    name: 'contribuicao.create',
    surface: 'authed',
    expectedCode: 'UNAUTHORIZED',
    invoke: ({ caller }, idCampanha) =>
      caller.contribuicao.create({ idCampanha, nome: 'Fralda', valor: 100, quantidade: 1 }),
  },
  {
    name: 'contribuicao.createBulk',
    surface: 'authed',
    expectedCode: 'UNAUTHORIZED',
    invoke: ({ caller }, idCampanha) =>
      caller.contribuicao.createBulk({
        idCampanha,
        items: [{ nome: 'Fralda', valor: 100, quantidade: 1 }],
      }),
  },
  {
    name: 'contribuicao.emitirUrlUploadImagemItem',
    surface: 'authed',
    expectedCode: 'UNAUTHORIZED',
    invoke: ({ caller }, idCampanha) =>
      caller.contribuicao.emitirUrlUploadImagemItem({ idCampanha, contentType: 'image/png' }),
  },
  {
    name: 'contribuicao.update',
    surface: 'authed',
    expectedCode: 'UNAUTHORIZED',
    invoke: ({ caller }, idCampanha) =>
      caller.contribuicao.update({ idCampanha, id: randomUUID(), nome: 'Fralda G' }),
  },
  {
    name: 'contribuicao.delete',
    surface: 'authed',
    expectedCode: 'UNAUTHORIZED',
    invoke: ({ caller }, idCampanha) =>
      caller.contribuicao.delete({ idCampanha, ids: [randomUUID()] }),
  },
  // eventoConvite (authed + public preview)
  {
    name: 'eventoConvite.get',
    surface: 'authed',
    expectedCode: 'UNAUTHORIZED',
    invoke: ({ caller }, idCampanha) => caller.eventoConvite.get({ idCampanha }),
  },
  {
    name: 'eventoConvite.save',
    surface: 'authed',
    expectedCode: 'UNAUTHORIZED',
    invoke: ({ caller }, idCampanha) =>
      caller.eventoConvite.save(conviteSaveInput('Helena', idCampanha)),
  },
  {
    name: 'eventoConvite.getPreview (PUBLIC)',
    surface: 'public',
    expectedCode: 'NOT_FOUND',
    invoke: ({ caller, slug }, idCampanha) => caller.eventoConvite.getPreview({ slug, idCampanha }),
  },
  // eventoListaDeConvidados (authed)
  {
    name: 'eventoListaDeConvidados.get',
    surface: 'authed',
    expectedCode: 'UNAUTHORIZED',
    invoke: ({ caller }, idCampanha) => caller.eventoListaDeConvidados.get({ idCampanha }),
  },
  {
    name: 'eventoListaDeConvidados.alterarPresenca',
    surface: 'authed',
    expectedCode: 'UNAUTHORIZED',
    invoke: ({ caller }, idCampanha) =>
      caller.eventoListaDeConvidados.alterarPresenca({
        idCampanha,
        idConvidado: randomUUID(),
        presenca: 'sim',
      }),
  },
  {
    name: 'eventoListaDeConvidados.adicionarConvidado',
    surface: 'authed',
    expectedCode: 'UNAUTHORIZED',
    invoke: ({ caller }, idCampanha) =>
      caller.eventoListaDeConvidados.adicionarConvidado({
        idCampanha,
        nome: 'Convidado',
        numeroCelular: '11999990000',
      }),
  },
  {
    name: 'eventoListaDeConvidados.salvarFormatoMensagem',
    surface: 'authed',
    expectedCode: 'UNAUTHORIZED',
    invoke: ({ caller }, idCampanha) =>
      caller.eventoListaDeConvidados.salvarFormatoMensagem({
        idCampanha,
        formatoMensagemConvite: 'texto',
      }),
  },
  // painelMensagens (authed, slug-addressed)
  {
    name: 'painelMensagens.list',
    surface: 'painel',
    expectedCode: 'UNAUTHORIZED',
    invoke: ({ caller, slug }, idCampanha) => caller.painelMensagens.list({ slug, idCampanha }),
  },
  {
    name: 'painelMensagens.marcarLida',
    surface: 'painel',
    expectedCode: 'UNAUTHORIZED',
    invoke: ({ caller, slug }, idCampanha) =>
      caller.painelMensagens.marcarLida({ slug, idCampanha, idPagamento: randomUUID() }),
  },
  {
    name: 'painelMensagens.marcarTodasLidas',
    surface: 'painel',
    expectedCode: 'UNAUTHORIZED',
    invoke: ({ caller, slug }, idCampanha) =>
      caller.painelMensagens.marcarTodasLidas({ slug, idCampanha }),
  },
  // pagina (public, slug-addressed) — includes the checkout money hops that
  // #344 DID extend (see file-header finding).
  {
    name: 'pagina.obterListaPresentes (PUBLIC)',
    surface: 'public',
    expectedCode: 'NOT_FOUND',
    invoke: ({ caller, slug }, idCampanha) =>
      caller.pagina.obterListaPresentes({ slug, idCampanha }),
  },
  {
    name: 'pagina.obterMural (PUBLIC)',
    surface: 'public',
    expectedCode: 'NOT_FOUND',
    invoke: ({ caller, slug }, idCampanha) => caller.pagina.obterMural({ slug, idCampanha }),
  },
  {
    name: 'pagina.iniciarPagamentoContribuicao (PUBLIC, checkout)',
    surface: 'public',
    expectedCode: 'NOT_FOUND',
    invoke: ({ caller, slug }, idCampanha) =>
      caller.pagina.iniciarPagamentoContribuicao({
        slug,
        idCampanha,
        idContribuicao: randomUUID(),
        metodo: 'pix',
      }),
  },
  {
    name: 'pagina.iniciarPagamentoCarrinho (PUBLIC, checkout)',
    surface: 'public',
    expectedCode: 'NOT_FOUND',
    invoke: ({ caller, slug }, idCampanha) =>
      caller.pagina.iniciarPagamentoCarrinho({
        slug,
        idCampanha,
        itens: [{ idContribuicao: randomUUID(), quantidade: 1 }],
        metodo: 'pix',
      }),
  },
  {
    name: 'pagina.obterSucessoPagamento (PUBLIC)',
    surface: 'public',
    expectedCode: 'NOT_FOUND',
    invoke: ({ caller, slug }, idCampanha) =>
      caller.pagina.obterSucessoPagamento({ slug, idCampanha, sessionId: 'cs_inexistente' }),
  },
];

describe('g1wl4 — per-hop idCampanha, THROUGH the router (PR #344 + aperture-48mxt W2 enforce)', () => {
  describe('owner gate: cross-owner vs unknown-id rejections are byte-identical (per hop)', () => {
    for (const hop of OWNER_GATE_HOPS) {
      it(`${hop.name} → ${hop.expectedCode}, no existence oracle`, async () => {
        const rig = await buildRig();
        const victim = await rig.addUser(uniqueEmail('victim'));
        const attacker = await rig.addUser(uniqueEmail('attacker'));

        // authed/painel: the ATTACKER addresses the VICTIM's campanha id.
        // public: the VICTIM's slug is queried with the ATTACKER's campanha
        // id (a real id — just belonging to another conta).
        const args =
          hop.surface === 'public'
            ? { caller: rig.anonCaller, slug: victim.slug }
            : { caller: attacker.caller, slug: attacker.slug };
        const foreignId =
          hop.surface === 'public' ? attacker.campanhaSignup.id : victim.campanhaSignup.id;

        const crossOwner = await captureRejection(hop.invoke(args, foreignId));
        const unknown = await captureRejection(hop.invoke(args, randomUUID()));

        expect(crossOwner.code, 'cross-owner rejection code').toBe(hop.expectedCode);
        expect(unknown.code, 'unknown-id must reject with the SAME code').toBe(crossOwner.code);
        expect(unknown.message, 'unknown-id must reject with the SAME message (byte-equal)').toBe(
          crossOwner.message,
        );
      });
    }
  });

  // ── contribuicao hops: aperture-48mxt (W2 enforce) — authed writes are
  // campanha-addressed; bare authed write = BAD_REQUEST. Queries keep the
  // bare→oldest default. ─────────────────────────────────────────────────────
  describe('contribuicao — authed writes require idCampanha (W2); bare QUERY still resolves the OLDEST', () => {
    it('create/list: bare create → BAD_REQUEST; create addressed to the oldest id lands on c1 (bare list ≡ oldest)', async () => {
      const rig = await buildRig();
      const user = await rig.addUser(uniqueEmail('contrib'));
      const c1 = user.campanhaSignup.id;
      // 2nd campanha created MID-TEST, before the calls under test.
      const c2 = (await user.caller.campanhas.criar({ titulo: 'Segunda Lista' })).id;

      // aperture-48mxt (W2 enforce): bare authed write is schema-rejected.
      await expect(
        user.caller.contribuicao.create({ nome: 'Item Bare', valor: 100, quantidade: 1 }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

      // The oldest-addressing behavior stays pinned — now explicitly.
      await user.caller.contribuicao.create({
        idCampanha: c1,
        nome: 'Item Bare',
        valor: 100,
        quantidade: 1,
      });

      const listC1 = await user.caller.contribuicao.list({ idCampanha: c1 });
      const listC2 = await user.caller.contribuicao.list({ idCampanha: c2 });
      const listBare = await user.caller.contribuicao.list();

      expect(listC1.map((i) => i.nome)).toContain('Item Bare');
      expect(listC2.map((i) => i.nome)).not.toContain('Item Bare');
      // bare list (QUERY — semantics unchanged) ≡ oldest-campanha list
      expect(listBare.map((i) => i.nome)).toEqual(listC1.map((i) => i.nome));
    });

    it('create/list with idCampanha=c2: targets the SECOND campanha, not the oldest', async () => {
      const rig = await buildRig();
      const user = await rig.addUser(uniqueEmail('contrib'));
      const c2 = (await user.caller.campanhas.criar({ titulo: 'Segunda Lista' })).id;

      await user.caller.contribuicao.create({
        idCampanha: c2,
        nome: 'Item C2',
        valor: 200,
        quantidade: 1,
      });

      const listC2 = await user.caller.contribuicao.list({ idCampanha: c2 });
      const listBare = await user.caller.contribuicao.list();

      expect(listC2.map((i) => i.nome)).toContain('Item C2');
      expect(listBare.map((i) => i.nome)).not.toContain('Item C2');
    });

    it('createBulk: bare → BAD_REQUEST (W2); idCampanha=c1 → oldest; idCampanha=c2 → second', async () => {
      const rig = await buildRig();
      const user = await rig.addUser(uniqueEmail('contrib'));
      const c1 = user.campanhaSignup.id;
      const c2 = (await user.caller.campanhas.criar({ titulo: 'Segunda Lista' })).id;

      // aperture-48mxt (W2 enforce): bare authed write is schema-rejected.
      await expect(
        user.caller.contribuicao.createBulk({
          items: [{ nome: 'Bulk Bare', valor: 100, quantidade: 1 }],
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

      // Oldest-addressing pinned explicitly (formerly the bare path).
      await user.caller.contribuicao.createBulk({
        idCampanha: c1,
        items: [{ nome: 'Bulk Bare', valor: 100, quantidade: 1 }],
      });
      await user.caller.contribuicao.createBulk({
        idCampanha: c2,
        items: [{ nome: 'Bulk C2', valor: 100, quantidade: 1 }],
      });

      const bare = (await user.caller.contribuicao.list()).map((i) => i.nome);
      const emC2 = (await user.caller.contribuicao.list({ idCampanha: c2 })).map((i) => i.nome);
      expect(bare).toContain('Bulk Bare');
      expect(bare).not.toContain('Bulk C2');
      expect(emC2).toContain('Bulk C2');
      expect(emC2).not.toContain('Bulk Bare');
    });

    it('update + delete: bare → BAD_REQUEST (W2); idCampanha=c1 operates on the oldest; idCampanha=c2 on the second', async () => {
      const rig = await buildRig();
      const user = await rig.addUser(uniqueEmail('contrib'));
      const c1 = user.campanhaSignup.id;
      const c2 = (await user.caller.campanhas.criar({ titulo: 'Segunda Lista' })).id;

      const [idC1] = (
        await user.caller.contribuicao.create({
          idCampanha: c1,
          nome: 'Alvo C1',
          valor: 100,
          quantidade: 1,
        })
      ).ids;
      const [idC2] = (
        await user.caller.contribuicao.create({
          idCampanha: c2,
          nome: 'Alvo C2',
          valor: 100,
          quantidade: 1,
        })
      ).ids;
      if (!idC1 || !idC2) throw new Error('setup: create não retornou ids');

      // aperture-48mxt (W2 enforce): bare authed writes are schema-rejected.
      await expect(
        user.caller.contribuicao.update({ id: idC1, nome: 'Alvo C1 v2' }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(user.caller.contribuicao.delete({ ids: [idC1] })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });

      // update through each addressed route (oldest pinned explicitly)
      await user.caller.contribuicao.update({ idCampanha: c1, id: idC1, nome: 'Alvo C1 v2' });
      await user.caller.contribuicao.update({ idCampanha: c2, id: idC2, nome: 'Alvo C2 v2' });
      expect((await user.caller.contribuicao.list()).map((i) => i.nome)).toContain('Alvo C1 v2');
      expect(
        (await user.caller.contribuicao.list({ idCampanha: c2 })).map((i) => i.nome),
      ).toContain('Alvo C2 v2');

      // delete through each addressed route
      await user.caller.contribuicao.delete({ idCampanha: c1, ids: [idC1] });
      await user.caller.contribuicao.delete({ idCampanha: c2, ids: [idC2] });
      expect((await user.caller.contribuicao.list()).map((i) => i.id)).not.toContain(idC1);
      expect(
        (await user.caller.contribuicao.list({ idCampanha: c2 })).map((i) => i.id),
      ).not.toContain(idC2);
    });

    it('emitirUrlUploadImagemItem: bare → BAD_REQUEST (W2); idCampanha=c1 and =c2 both resolve (owner-gate only — the use-case is campanha-agnostic)', async () => {
      const rig = await buildRig();
      const user = await rig.addUser(uniqueEmail('contrib'));
      const c1 = user.campanhaSignup.id;
      const c2 = (await user.caller.campanhas.criar({ titulo: 'Segunda Lista' })).id;

      // aperture-48mxt (W2 enforce): bare authed write is schema-rejected.
      await expect(
        user.caller.contribuicao.emitirUrlUploadImagemItem({ contentType: 'image/png' }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

      const emC1 = await user.caller.contribuicao.emitirUrlUploadImagemItem({
        idCampanha: c1,
        contentType: 'image/png',
      });
      const emC2 = await user.caller.contribuicao.emitirUrlUploadImagemItem({
        idCampanha: c2,
        contentType: 'image/png',
      });
      expect(emC1.uploadUrl.length).toBeGreaterThan(0);
      expect(emC2.uploadUrl.length).toBeGreaterThan(0);
    });
  });

  // ── eventoConvite hops — aperture-48mxt (W2 enforce): save (authed write)
  // requires idCampanha; get/getPreview (queries) keep the bare→oldest default.
  describe('eventoConvite — save requires idCampanha (W2); bare get/getPreview still pin the oldest', () => {
    it('save {idCampanha:c2} writes to the SECOND campanha; get bare still sees the (evento-less) oldest', async () => {
      const rig = await buildRig();
      const user = await rig.addUser(uniqueEmail('convite'));
      const c2 = (await user.caller.campanhas.criar({ titulo: 'Segunda Lista' })).id;

      await user.caller.eventoConvite.save(conviteSaveInput('Bebe C2', c2));

      const bare = await user.caller.eventoConvite.get();
      const emC2 = await user.caller.eventoConvite.get({ idCampanha: c2 });

      expect(bare.evento, 'oldest campanha has NO evento — bare must not see c2').toBeNull();
      expect(emC2.evento).not.toBeNull();
      expect(emC2.convite?.nomeExibido).toBe('Bebe C2');
    });

    it('save bare → BAD_REQUEST (W2); save addressed to the OLDEST id writes to c1 (even with a 2nd campanha present)', async () => {
      const rig = await buildRig();
      const user = await rig.addUser(uniqueEmail('convite'));
      const c1 = user.campanhaSignup.id;
      const c2 = (await user.caller.campanhas.criar({ titulo: 'Segunda Lista' })).id;

      // aperture-48mxt (W2 enforce): bare authed write is schema-rejected.
      await expect(
        user.caller.eventoConvite.save(conviteSaveInput('Bebe C1')),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

      // Oldest-addressing pinned explicitly (formerly the bare path).
      await user.caller.eventoConvite.save(conviteSaveInput('Bebe C1', c1));

      const bare = await user.caller.eventoConvite.get();
      const emC2 = await user.caller.eventoConvite.get({ idCampanha: c2 });
      expect(bare.convite?.nomeExibido).toBe('Bebe C1');
      expect(emC2.evento, 'the second campanha must stay evento-less').toBeNull();
    });

    it('getPreview (PUBLIC): bare → oldest campanha convite; idCampanha=c2 → the second', async () => {
      const rig = await buildRig();
      const user = await rig.addUser(uniqueEmail('convite'));
      const c1 = user.campanhaSignup.id;
      const c2 = (await user.caller.campanhas.criar({ titulo: 'Segunda Lista' })).id;

      // setup writes are campanha-addressed (W2 — save requires idCampanha)
      await user.caller.eventoConvite.save(conviteSaveInput('Bebe C1', c1));
      await user.caller.eventoConvite.save(conviteSaveInput('Bebe C2', c2));

      const bare = await rig.anonCaller.eventoConvite.getPreview({ slug: user.slug });
      const emC2 = await rig.anonCaller.eventoConvite.getPreview({
        slug: user.slug,
        idCampanha: c2,
      });
      expect(bare.convite?.nomeExibido).toBe('Bebe C1');
      expect(emC2.convite?.nomeExibido).toBe('Bebe C2');
    });
  });

  // ── eventoListaDeConvidados hops — aperture-48mxt (W2 enforce): the three
  // authed writes require idCampanha; get (query) keeps the bare→oldest default.
  describe('eventoListaDeConvidados — authed writes require idCampanha (W2); bare get still pins the oldest', () => {
    /** evento on BOTH campanhas so lista operations are reachable on each. */
    async function setupEventos(): Promise<{ rig: Rig; user: RigUser; c1: string; c2: string }> {
      const rig = await buildRig();
      const user = await rig.addUser(uniqueEmail('lista'));
      const c1 = user.campanhaSignup.id;
      const c2 = (await user.caller.campanhas.criar({ titulo: 'Segunda Lista' })).id;
      await user.caller.eventoConvite.save(conviteSaveInput('Bebe C1', c1));
      await user.caller.eventoConvite.save(conviteSaveInput('Bebe C2', c2));
      return { rig, user, c1, c2 };
    }

    it('adicionarConvidado: bare → BAD_REQUEST (W2); idCampanha=c1 lands on the oldest lista (bare GET), c2 stays isolated', async () => {
      const { user, c1, c2 } = await setupEventos();

      // aperture-48mxt (W2 enforce): bare authed write is schema-rejected.
      await expect(
        user.caller.eventoListaDeConvidados.adicionarConvidado({
          nome: 'Convidado C1',
          numeroCelular: '11999990001',
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

      // Oldest-addressing pinned explicitly (formerly the bare path).
      await user.caller.eventoListaDeConvidados.adicionarConvidado({
        idCampanha: c1,
        nome: 'Convidado C1',
        numeroCelular: '11999990001',
      });
      await user.caller.eventoListaDeConvidados.adicionarConvidado({
        idCampanha: c2,
        nome: 'Convidado C2',
        numeroCelular: '11999990002',
      });

      const bare = await user.caller.eventoListaDeConvidados.get();
      const emC2 = await user.caller.eventoListaDeConvidados.get({ idCampanha: c2 });

      expect(bare.lista?.convidados.map((c) => c.nome)).toEqual(['Convidado C1']);
      expect(emC2.lista?.convidados.map((c) => c.nome)).toEqual(['Convidado C2']);
    });

    it('alterarPresenca: bare → BAD_REQUEST (W2); idCampanha=c1 mutates the oldest lista convidado, =c2 the second', async () => {
      const { user, c1, c2 } = await setupEventos();

      const c1Add = await user.caller.eventoListaDeConvidados.adicionarConvidado({
        idCampanha: c1,
        nome: 'Convidado C1',
        numeroCelular: '11999990001',
      });
      const c2Add = await user.caller.eventoListaDeConvidados.adicionarConvidado({
        idCampanha: c2,
        nome: 'Convidado C2',
        numeroCelular: '11999990002',
      });
      const idC1 = c1Add.lista?.convidados[0]?.id;
      const idC2 = c2Add.lista?.convidados[0]?.id;
      if (!idC1 || !idC2) throw new Error('setup: adicionarConvidado não retornou convidado');

      // aperture-48mxt (W2 enforce): bare authed write is schema-rejected.
      await expect(
        user.caller.eventoListaDeConvidados.alterarPresenca({
          idConvidado: idC1,
          presenca: 'sim',
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

      // Oldest-addressing pinned explicitly (formerly the bare path).
      const emC1 = await user.caller.eventoListaDeConvidados.alterarPresenca({
        idCampanha: c1,
        idConvidado: idC1,
        presenca: 'sim',
      });
      const emC2 = await user.caller.eventoListaDeConvidados.alterarPresenca({
        idCampanha: c2,
        idConvidado: idC2,
        presenca: 'nao',
      });
      expect(emC1.lista?.convidados[0]?.presenca).toBe('sim');
      expect(emC2.lista?.convidados[0]?.presenca).toBe('nao');
    });

    it('salvarFormatoMensagem: bare → BAD_REQUEST (W2); idCampanha=c1 targets the oldest lista, =c2 the second', async () => {
      const { user, c1, c2 } = await setupEventos();
      // materialise both listas first (addressed — W2)
      await user.caller.eventoListaDeConvidados.adicionarConvidado({
        idCampanha: c1,
        nome: 'Convidado C1',
        numeroCelular: '11999990001',
      });
      await user.caller.eventoListaDeConvidados.adicionarConvidado({
        idCampanha: c2,
        nome: 'Convidado C2',
        numeroCelular: '11999990002',
      });

      // aperture-48mxt (W2 enforce): bare authed write is schema-rejected.
      await expect(
        user.caller.eventoListaDeConvidados.salvarFormatoMensagem({
          formatoMensagemConvite: 'texto',
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

      // Oldest-addressing pinned explicitly (formerly the bare path).
      await user.caller.eventoListaDeConvidados.salvarFormatoMensagem({
        idCampanha: c1,
        formatoMensagemConvite: 'texto',
      });
      await user.caller.eventoListaDeConvidados.salvarFormatoMensagem({
        idCampanha: c2,
        formatoMensagemConvite: 'convite_virtual',
      });

      const bare = await user.caller.eventoListaDeConvidados.get();
      const emC2 = await user.caller.eventoListaDeConvidados.get({ idCampanha: c2 });
      expect(bare.lista?.formatoMensagemConvite).toBe('texto');
      expect(emC2.lista?.formatoMensagemConvite).toBe('convite_virtual');
    });
  });

  // ── painelMensagens hops — aperture-48mxt (W2 enforce): marcarLida /
  // marcarTodasLidas (authed writes) require idCampanha; list (query) keeps
  // the bare→oldest default. ───────────────────────────────────────────────
  describe('painelMensagens — authed writes require idCampanha (W2); bare list still pins the oldest', () => {
    it('marcarLida discriminates the addressed campanha: bare → BAD_REQUEST (W2); idCampanha=c1 (oldest) trips the cross-tenant guard for a c2 pagamento; idCampanha=c2 does not', async () => {
      const rig = await buildRig();
      const user = await rig.addUser(uniqueEmail('painel'));
      const c1 = user.campanhaSignup.id;
      const c2 = (await user.caller.campanhas.criar({ titulo: 'Segunda Lista' })).id;

      // Seed a pagamento on c2 through the real checkout hop.
      const [idContribuicao] = (
        await user.caller.contribuicao.create({
          idCampanha: c2,
          nome: 'Presente C2',
          valor: 100,
          quantidade: 1,
        })
      ).ids;
      if (!idContribuicao) throw new Error('setup: create não retornou id');
      const { sessionId } = await rig.anonCaller.pagina.iniciarPagamentoContribuicao({
        slug: user.slug,
        idCampanha: c2,
        idContribuicao,
        metodo: 'pix',
      });
      const pagamento = await rig.deps.pagamentoRepository.findByExternalRef(sessionId);
      if (!pagamento) throw new Error('setup: pagamento não persistiu');

      // aperture-48mxt (W2 enforce): the BARE authed write is schema-rejected
      // before any campanha resolution happens.
      await expect(
        user.caller.painelMensagens.marcarLida({
          slug: user.slug,
          idPagamento: pagamento.id as string,
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

      // Addressing the OLDEST campanha explicitly (formerly the bare path):
      // the c2 pagamento fails the pagamento-belongs-to-campanha guard
      // (proves c1-addressing ≠ c2).
      const emC1 = await captureRejection(
        user.caller.painelMensagens.marcarLida({
          slug: user.slug,
          idCampanha: c1,
          idPagamento: pagamento.id as string,
        }),
      );
      expect(emC1.code).toBe('UNAUTHORIZED');
      expect(emC1.message).toBe('Pagamento nao encontrado ou nao autorizado');

      // idCampanha=c2 resolves the SECOND campanha → the guard passes and
      // the mark-as-read completes.
      const marcado = await user.caller.painelMensagens.marcarLida({
        slug: user.slug,
        idCampanha: c2,
        idPagamento: pagamento.id as string,
      });
      expect(typeof marcado.lidaEm).toBe('string');
    });

    it('list (bare QUERY) resolves; marcarTodasLidas: bare → BAD_REQUEST (W2), idCampanha=c1/c2 resolve (empty-queue shapes)', async () => {
      const rig = await buildRig();
      const user = await rig.addUser(uniqueEmail('painel'));
      const c1 = user.campanhaSignup.id;
      const c2 = (await user.caller.campanhas.criar({ titulo: 'Segunda Lista' })).id;

      // list is a QUERY — bare semantics unchanged by W2.
      await expect(user.caller.painelMensagens.list({ slug: user.slug })).resolves.toBeDefined();
      await expect(
        user.caller.painelMensagens.list({ slug: user.slug, idCampanha: c2 }),
      ).resolves.toBeDefined();

      // aperture-48mxt (W2 enforce): bare authed write is schema-rejected.
      await expect(
        user.caller.painelMensagens.marcarTodasLidas({ slug: user.slug }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

      // Oldest-addressing pinned explicitly (formerly the bare path).
      const emC1 = await user.caller.painelMensagens.marcarTodasLidas({
        slug: user.slug,
        idCampanha: c1,
      });
      const emC2 = await user.caller.painelMensagens.marcarTodasLidas({
        slug: user.slug,
        idCampanha: c2,
      });
      expect(emC1.marcadas).toBe(0);
      expect(emC2.marcadas).toBe(0);
    });
  });

  // ── pagina hops ───────────────────────────────────────────────────────────
  describe('pagina — bare pins the oldest; idCampanha addresses the second', () => {
    it('obterListaPresentes: bare → oldest items (2nd campanha created mid-test); idCampanha=c2 → its items', async () => {
      const rig = await buildRig();
      const user = await rig.addUser(uniqueEmail('pagina'));
      const c1 = user.campanhaSignup.id;
      const c2 = (await user.caller.campanhas.criar({ titulo: 'Segunda Lista' })).id;
      // setup writes are campanha-addressed (W2 — create requires idCampanha)
      await user.caller.contribuicao.create({
        idCampanha: c1,
        nome: 'Item C1',
        valor: 100,
        quantidade: 1,
      });
      await user.caller.contribuicao.create({
        idCampanha: c2,
        nome: 'Item C2',
        valor: 100,
        quantidade: 1,
      });

      const bare = await rig.anonCaller.pagina.obterListaPresentes({ slug: user.slug });
      const emC2 = await rig.anonCaller.pagina.obterListaPresentes({
        slug: user.slug,
        idCampanha: c2,
      });
      expect(bare.map((i) => i.nome)).toEqual(['Item C1']);
      expect(emC2.map((i) => i.nome)).toEqual(['Item C2']);
    });

    it('obterMural: bare and idCampanha=c2 both resolve (empty murals)', async () => {
      const rig = await buildRig();
      const user = await rig.addUser(uniqueEmail('pagina'));
      const c2 = (await user.caller.campanhas.criar({ titulo: 'Segunda Lista' })).id;

      await expect(rig.anonCaller.pagina.obterMural({ slug: user.slug })).resolves.toEqual([]);
      await expect(
        rig.anonCaller.pagina.obterMural({ slug: user.slug, idCampanha: c2 }),
      ).resolves.toEqual([]);
    });

    it('iniciarPagamentoContribuicao: bare pins the OLDEST — a c2 gift via bare fails the saga; via idCampanha=c2 it checks out', async () => {
      const rig = await buildRig();
      const user = await rig.addUser(uniqueEmail('pagina'));
      const c2 = (await user.caller.campanhas.criar({ titulo: 'Segunda Lista' })).id;
      const [idContribuicaoC2] = (
        await user.caller.contribuicao.create({
          idCampanha: c2,
          nome: 'Presente C2',
          valor: 100,
          quantidade: 1,
        })
      ).ids;
      if (!idContribuicaoC2) throw new Error('setup: create não retornou id');

      // bare resolves the oldest campanha → the saga refuses the c2 gift
      // (contribuição must belong to the resolved campanha).
      const bare = await captureRejection(
        rig.anonCaller.pagina.iniciarPagamentoContribuicao({
          slug: user.slug,
          idContribuicao: idContribuicaoC2,
          metodo: 'pix',
        }),
      );
      expect(bare.code).toBe('INTERNAL_SERVER_ERROR');

      // idCampanha=c2 resolves the second campanha → checkout succeeds.
      const ok = await rig.anonCaller.pagina.iniciarPagamentoContribuicao({
        slug: user.slug,
        idCampanha: c2,
        idContribuicao: idContribuicaoC2,
        metodo: 'pix',
      });
      expect(ok.sessionId.length).toBeGreaterThan(0);
      expect(ok.clientSecret.length).toBeGreaterThan(0);
      const pagamento = await rig.deps.pagamentoRepository.findByExternalRef(ok.sessionId);
      expect(pagamento?.intencao.idCampanha).toBe(c2);
    });

    it('iniciarPagamentoCarrinho: same per-campanha routing as the single-shot checkout', async () => {
      const rig = await buildRig();
      const user = await rig.addUser(uniqueEmail('pagina'));
      const c2 = (await user.caller.campanhas.criar({ titulo: 'Segunda Lista' })).id;
      const [idContribuicaoC2] = (
        await user.caller.contribuicao.create({
          idCampanha: c2,
          nome: 'Presente C2',
          valor: 100,
          quantidade: 1,
        })
      ).ids;
      if (!idContribuicaoC2) throw new Error('setup: create não retornou id');

      const bare = await captureRejection(
        rig.anonCaller.pagina.iniciarPagamentoCarrinho({
          slug: user.slug,
          itens: [{ idContribuicao: idContribuicaoC2, quantidade: 1 }],
          metodo: 'pix',
        }),
      );
      expect(bare.code).toBe('INTERNAL_SERVER_ERROR');

      const ok = await rig.anonCaller.pagina.iniciarPagamentoCarrinho({
        slug: user.slug,
        idCampanha: c2,
        itens: [{ idContribuicao: idContribuicaoC2, quantidade: 1 }],
        metodo: 'pix',
      });
      const pagamento = await rig.deps.pagamentoRepository.findByExternalRef(ok.sessionId);
      expect(pagamento?.intencao.idCampanha).toBe(c2);
    });

    it('obterSucessoPagamento: sessionId lookup works bare AND with idCampanha (the campanha arg only gates)', async () => {
      const rig = await buildRig();
      const user = await rig.addUser(uniqueEmail('pagina'));
      const c2 = (await user.caller.campanhas.criar({ titulo: 'Segunda Lista' })).id;
      const [idContribuicaoC2] = (
        await user.caller.contribuicao.create({
          idCampanha: c2,
          nome: 'Presente C2',
          valor: 100,
          quantidade: 1,
        })
      ).ids;
      if (!idContribuicaoC2) throw new Error('setup: create não retornou id');
      const { sessionId } = await rig.anonCaller.pagina.iniciarPagamentoContribuicao({
        slug: user.slug,
        idCampanha: c2,
        idContribuicao: idContribuicaoC2,
        metodo: 'pix',
      });

      // Matching campanha addressing — legitimate flow, holds before AND
      // after the aperture-jlvet cross-check lands.
      const emC2 = await rig.anonCaller.pagina.obterSucessoPagamento({
        slug: user.slug,
        idCampanha: c2,
        sessionId,
      });
      expect(emC2.giftName).toBe('Presente C2');

      // CIPHER RULING (aperture-jlvet, 2026-07-08): the sessionId-only lookup
      // is NOT benign — the payload carries contributor PII and the sessionId
      // leaks via success_url/analytics channels. The fix: after
      // findByExternalRef, pagamento.intencao.idCampanha must equal the
      // resolved campanha.id; mismatch → NOT_FOUND (fail-closed, no existence
      // reveal). The two it.fails sentinels below assert the FIXED behavior —
      // green-as-expected-fail today, they TRIP when jlvet lands: flip to it()
      // in the fix PR (the second-lander-flips choreography).
      //
      // ⚠️ DESIGN CONSTRAINT FOR THE FIX (flagged to Rex): post-fix, the BARE
      // success page resolves the OLDEST campanha — a checkout made against a
      // non-oldest campanha will NOT_FOUND on a bare success URL. The Stripe
      // success_url must therefore carry the campanha addressing
      // (/c/:idCampanha or ?idCampanha=) whenever the checkout was addressed.
      // Sentinel B pins exactly this edge.
    });

    // aperture-jlvet LANDED (PR #348) — both sentinels flipped to it(), asserting the FIXED behavior.
    it('jlvet sentinel A: CROSS-USER — campanha A sessionId under victim slug B → NOT_FOUND, zero PII', async () => {
      const rig = await buildRig();
      const owner = await rig.addUser(uniqueEmail('sucesso-owner'));
      const victim = await rig.addUser(uniqueEmail('sucesso-victim'));
      const [idContribuicao] = (
        await owner.caller.contribuicao.create({
          idCampanha: owner.campanhaSignup.id, // W2 — create requires idCampanha
          nome: 'Presente com PII',
          valor: 100,
          quantidade: 1,
        })
      ).ids;
      if (!idContribuicao) throw new Error('setup: create não retornou id');
      const { sessionId } = await rig.anonCaller.pagina.iniciarPagamentoContribuicao({
        slug: owner.slug,
        idContribuicao,
        metodo: 'pix',
      });

      // The leaked-token scenario: a valid sessionId replayed against a
      // DIFFERENT slug must behave exactly like a garbage sessionId.
      const crossSlug = await captureRejection(
        rig.anonCaller.pagina.obterSucessoPagamento({ slug: victim.slug, sessionId }),
      );
      const garbage = await captureRejection(
        rig.anonCaller.pagina.obterSucessoPagamento({
          slug: victim.slug,
          sessionId: 'cs_test_inexistente',
        }),
      );
      expect(crossSlug.code).toBe('NOT_FOUND');
      expect(crossSlug.code).toBe(garbage.code);
      expect(crossSlug.message).toBe(garbage.message);
    });

    it('jlvet sentinel B: same owner, BARE success URL for a NON-oldest campanha pagamento → NOT_FOUND (success_url must be campanha-addressed)', async () => {
      const rig = await buildRig();
      const user = await rig.addUser(uniqueEmail('sucesso-bare'));
      const c2 = (await user.caller.campanhas.criar({ titulo: 'Segunda p/ sucesso' })).id;
      const [idContribuicaoC2] = (
        await user.caller.contribuicao.create({
          idCampanha: c2,
          nome: 'Presente C2 sucesso',
          valor: 100,
          quantidade: 1,
        })
      ).ids;
      if (!idContribuicaoC2) throw new Error('setup: create não retornou id');
      const { sessionId } = await rig.anonCaller.pagina.iniciarPagamentoContribuicao({
        slug: user.slug,
        idCampanha: c2,
        idContribuicao: idContribuicaoC2,
        metodo: 'pix',
      });

      // Bare resolves the OLDEST campanha; the pagamento belongs to c2 —
      // post-jlvet this mismatch is fail-closed.
      const bare = await captureRejection(
        rig.anonCaller.pagina.obterSucessoPagamento({ slug: user.slug, sessionId }),
      );
      expect(bare.code).toBe('NOT_FOUND');
    });
  });

  // ── adversarial public hop (design fixed by the lead) ─────────────────────
  describe('adversarial: victim slug + attacker campanha id on the PUBLIC hops', () => {
    it('pagina.obterListaPresentes: attacker id on victim slug ≡ garbage id (byte-equal 404, zero cross-slug data)', async () => {
      const rig = await buildRig();
      const victim = await rig.addUser(uniqueEmail('victim'));
      const attacker = await rig.addUser(uniqueEmail('attacker'));
      // give the attacker campanha real data that must NEVER surface
      // (addressed — W2: create requires idCampanha)
      await attacker.caller.contribuicao.create({
        idCampanha: attacker.campanhaSignup.id,
        nome: 'Segredo do Atacante',
        valor: 100,
        quantidade: 1,
      });

      const comIdAtacante = await captureRejection(
        rig.anonCaller.pagina.obterListaPresentes({
          slug: victim.slug,
          idCampanha: attacker.campanhaSignup.id,
        }),
      );
      const comIdLixo = await captureRejection(
        rig.anonCaller.pagina.obterListaPresentes({ slug: victim.slug, idCampanha: randomUUID() }),
      );

      expect(comIdAtacante.code).toBe('NOT_FOUND');
      expect(comIdLixo.code).toBe(comIdAtacante.code);
      expect(comIdLixo.message).toBe(comIdAtacante.message);
      expect(comIdAtacante.message).not.toContain('Segredo');

      // sanity: the attacker's campanha IS reachable — via its OWN slug only.
      const própria = await rig.anonCaller.pagina.obterListaPresentes({
        slug: attacker.slug,
        idCampanha: attacker.campanhaSignup.id,
      });
      expect(própria.map((i) => i.nome)).toContain('Segredo do Atacante');
    });

    it('eventoConvite.getPreview: attacker id on victim slug ≡ garbage id (byte-equal 404, no cross-slug convite)', async () => {
      const rig = await buildRig();
      const victim = await rig.addUser(uniqueEmail('victim'));
      const attacker = await rig.addUser(uniqueEmail('attacker'));
      // addressed — W2: save requires idCampanha
      await attacker.caller.eventoConvite.save(
        conviteSaveInput('Convite do Atacante', attacker.campanhaSignup.id),
      );

      const comIdAtacante = await captureRejection(
        rig.anonCaller.eventoConvite.getPreview({
          slug: victim.slug,
          idCampanha: attacker.campanhaSignup.id,
        }),
      );
      const comIdLixo = await captureRejection(
        rig.anonCaller.eventoConvite.getPreview({ slug: victim.slug, idCampanha: randomUUID() }),
      );

      expect(comIdAtacante.code).toBe('NOT_FOUND');
      expect(comIdLixo.code).toBe(comIdAtacante.code);
      expect(comIdLixo.message).toBe(comIdAtacante.message);
      expect(comIdAtacante.message).not.toContain('Atacante');
    });
  });

  // ── money-path pins ───────────────────────────────────────────────────────
  describe('money path — withdrawal surface signatures unchanged; bare checkout unchanged', () => {
    it('recebedor.* keep REQUIRED uuid idCampanha — missing/non-uuid rejects BAD_REQUEST (no optional oldest-resolution branch)', async () => {
      const rig = await buildRig();
      const user = await rig.addUser(uniqueEmail('money'));

      const semId = await Promise.all([
        captureRejection(user.caller.recebedor.extrato.summary({} as never)),
        captureRejection(user.caller.recebedor.extrato.list({} as never)),
        captureRejection(user.caller.recebedor.transferencia.solicitar({} as never)),
        captureRejection(user.caller.recebedor.listMovimentacoes({} as never)),
        captureRejection(user.caller.recebedor.criar({} as never)),
      ]);
      for (const rejeicao of semId) {
        // BAD_REQUEST (schema) — NOT the resolver's UNAUTHORIZED. If any of
        // these ever flips to UNAUTHORIZED-on-missing-id, an optional
        // idCampanha (with the oldest-resolution default) leaked into the
        // money-withdrawal surface.
        expect(rejeicao.code).toBe('BAD_REQUEST');
      }

      // Still uuid-typed (like the W2-flipped authed writes; unlike the
      // still-optional z.string() QUERY hops).
      const naoUuid = await captureRejection(
        user.caller.recebedor.extrato.summary({ idCampanha: 'nao-e-uuid' } as never),
      );
      expect(naoUuid.code).toBe('BAD_REQUEST');
    });

    it('happy bare checkout still resolves the OLDEST campanha (pre-#344 behavior intact)', async () => {
      const rig = await buildRig();
      const user = await rig.addUser(uniqueEmail('money'));
      const c1 = user.campanhaSignup.id;
      // a 2nd campanha exists — the bare money path must NOT drift to it
      await user.caller.campanhas.criar({ titulo: 'Segunda Lista' });
      // setup write is campanha-addressed (W2 — create requires idCampanha)
      const [idContribuicao] = (
        await user.caller.contribuicao.create({
          idCampanha: c1,
          nome: 'Presente C1',
          valor: 100,
          quantidade: 1,
        })
      ).ids;
      if (!idContribuicao) throw new Error('setup: create não retornou id');

      const ok = await rig.anonCaller.pagina.iniciarPagamentoContribuicao({
        slug: user.slug,
        idContribuicao,
        metodo: 'pix',
      });
      expect(ok.sessionId.length).toBeGreaterThan(0);
      expect(ok.clientSecret.length).toBeGreaterThan(0);
      const pagamento = await rig.deps.pagamentoRepository.findByExternalRef(ok.sessionId);
      expect(pagamento?.intencao.idCampanha, 'bare checkout pins the oldest campanha').toBe(c1);
    });
  });
});
