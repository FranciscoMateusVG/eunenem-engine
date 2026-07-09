/**
 * aperture-u38rz — determinism suite for the `campanhas.criar` tRPC mutation
 * (contract FROZEN by Rex on bead aperture-x0unf; implementation lands in a
 * sibling PR — this file will not compile until `campanhas.criar` exists on
 * the appRouter. The forward reference is intentional and expected).
 *
 * FROZEN CONTRACT (aperture-x0unf):
 *   - authenticated mutation, INPUT `{ titulo: string }` (trim, min 1,
 *     max 200 — mirrors CriarCampanhaInputSchema.titulo in
 *     src/use-cases/arrecadacao/criar-campanha.ts);
 *   - OUTPUT `{ id, titulo, slug, quantidadeMimos: null, criadaEm }` — the
 *     same card DTO shape as a `campanhas.list` `novas` element;
 *   - side effects: persists ONE Campanha administered by the AUTHED conta,
 *     carrying exactly ONE OpcaoContribuicao of tipo 'presente'.
 *
 * RIG: self-contained copy of the mebax-legacy-users.test.ts buildRig
 * (deliberately NOT imported — zero churn to that file while Rex is
 * mid-flight there). One deviation: the clock is ADVANCEABLE instead of
 * frozen, so the signup auto-created campanha and the criar-created campanha
 * get distinct `criadaEm` values and the list's `criadaEm DESC` ordering is
 * deterministic (a frozen clock would tie-break on insertion order only).
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
const UUID_ISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Authenticated tRPC rig — copied from mebax-legacy-users.test.ts (see file
 * header for why it is duplicated rather than shared). Real session token
 * from criarSessaoUsuario, cookie header, appRouter against memory repos.
 * `registrarContaUsuario` auto-creates the default Campanha, so a fresh user
 * starts with exactly one 2.0 campaign.
 *
 * Deviations from mebax's rig:
 *   - `advanceClock(ms)` mutates the deterministic clock so later writes get
 *     strictly newer `criadaEm` values (needed to pin `novas` ordering);
 *   - returns the `campanhaRepository` instance (side-effect assertions), the
 *     registrar result (usuario slug, conta id, signup campanha id), and the
 *     authed conta id;
 *   - supplies the four ServerDeps fields added AFTER mebax's rig was
 *     written (perfilCriadorRepository, listaDeConvidadosRepository,
 *     adminAllowedEmails, objectStorage) so the deps literal matches
 *     staging's ServerDeps today.
 */
async function buildRig(email: string) {
  const observability: Observability = {
    logger: new NoopLogger(),
    tracer: noopTracer(),
  };

  let now = new Date('2026-07-07T02:00:00.000Z');
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
    plataformaRepository,
    campanhaRepository,
    contribuicaoRepository,
    recebedorRepository,
    eventoRepository,
    conviteRepository,
    pagamentoRepository,
    pagamentoProvider,
    checkoutSessionProvider: pagamentoProvider,
    pagamentoEventPublisher,
    livroFinanceiroRepository,
    provedorRegraTaxa: new ProvedorRegraTaxaMemory(REGRAS_TAXA_SEED),
    dadosRecebimentoRepository: new DadosRecebimentoRepositoryMemory(),
    resgatePendenteRepository: new ResgatePendenteRepositoryMemory(),
    perfilCriadorRepository: new PerfilCriadorRepositoryMemory(),
    perfilCampanhaRepository: new PerfilCampanhaRepositoryMemory(),
    listaDeConvidadosRepository: new ListaDeConvidadosRepositoryMemory(),
    adminAllowedEmails: new Set<string>(),
    objectStorage: new ObjectStorageMemory(),
    observability,
    clock,
    sessionCookieName: SESSION_COOKIE,
    publicOrigin: 'http://localhost:3001',
    trustedHopCount: 0,
    logPiiHashSalt: '',
    webhookEventArchive: new WebhookEventArchiveMemory(),
  };

  const idUsuario = randomUUID();
  const idConta = randomUUID();
  const registro = await registrarContaUsuario(
    {
      usuarioRepository,
      plataformaRepository,
      campanhaRepository,
      recebedorRepository,
      authService,
      clock,
      observability,
    },
    {
      idUsuario,
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

  const authedCtx: TrpcContext = {
    deps,
    headers: new Headers({
      cookie: `${SESSION_COOKIE}=${encodeURIComponent(sessao.token)}`,
    }),
    resHeaders: new Headers(),
  };
  const anonCtx: TrpcContext = { deps, headers: new Headers(), resHeaders: new Headers() };

  return {
    caller: appRouter.createCaller(authedCtx),
    anonCaller: appRouter.createCaller(anonCtx),
    campanhaRepository,
    idConta,
    registro,
    advanceClock,
  };
}

describe('campanhas.criar (router contract — frozen on aperture-x0unf)', () => {
  it('happy path: authed caller gets the FULL card DTO back', async () => {
    const email = `u38rz-${randomUUID()}@example.com`;
    const { caller, registro } = await buildRig(email);

    const out = await caller.campanhas.criar({ titulo: 'Lista da Helena' });

    expect(out.id, 'id is a uuid-ish string').toMatch(UUID_ISH);
    expect(out.titulo).toBe('Lista da Helena');
    expect(out.slug, 'slug is the USUARIO painel slug from signup').toBe(registro.usuario.slug);
    // Strict null — toBeNull() rejects undefined and 0 alike.
    expect(out.quantidadeMimos, 'POC: mimo count is strict null').toBeNull();
    expect(typeof out.criadaEm).toBe('string');
    expect(
      Number.isNaN(Date.parse(out.criadaEm)),
      'criadaEm must be a parseable ISO-8601 string',
    ).toBe(false);
  });

  it("side-effect: persists the campanha for the authed conta with exactly ONE 'presente' opcao", async () => {
    const email = `u38rz-${randomUUID()}@example.com`;
    const { caller, campanhaRepository, idConta } = await buildRig(email);

    const out = await caller.campanhas.criar({ titulo: 'Lista da Helena' });

    const campanha = await campanhaRepository.findById(out.id);
    expect(campanha, 'campanha must exist in the repository after criar').not.toBeNull();
    expect(campanha?.idsAdministradores).toContain(idConta);
    expect(campanha?.opcoes).toHaveLength(1);
    expect(campanha?.opcoes[0]?.tipo).toBe('presente');
  });

  it('list-integration: novas carries BOTH campanhas, criadaEm DESC (new one first)', async () => {
    const email = `u38rz-${randomUUID()}@example.com`;
    const { caller, registro, advanceClock } = await buildRig(email);

    // Distinct timestamp — campanhas.list sorts `novas` by criadaEm DESC
    // (apps/eunenem-server/server/trpc/campanhas-router.ts), so the criar'd
    // campanha must come FIRST once it is strictly newer than the signup one.
    advanceClock(60_000);
    const out = await caller.campanhas.criar({ titulo: 'Lista da Helena' });

    const lista = await caller.campanhas.list();
    expect(lista.novas).toHaveLength(2);
    expect(lista.novas.map((c) => c.id)).toEqual([out.id, registro.campanha.id]);
  });

  it('UNAUTHORIZED without a session (no anonymous writes)', async () => {
    const email = `u38rz-anon-${randomUUID()}@example.com`;
    const { anonCaller } = await buildRig(email);

    await expect(anonCaller.campanhas.criar({ titulo: 'Lista da Helena' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  describe('BAD_REQUEST validation (titulo: trim + min 1 + max 200)', () => {
    it('empty titulo rejects', async () => {
      const { caller } = await buildRig(`u38rz-${randomUUID()}@example.com`);
      await expect(caller.campanhas.criar({ titulo: '' })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    });

    it('whitespace-only titulo rejects (schema trims BEFORE min(1))', async () => {
      const { caller } = await buildRig(`u38rz-${randomUUID()}@example.com`);
      await expect(caller.campanhas.criar({ titulo: '   ' })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    });

    it('201-char titulo rejects (over the max(200) bound)', async () => {
      const { caller } = await buildRig(`u38rz-${randomUUID()}@example.com`);
      await expect(caller.campanhas.criar({ titulo: 'a'.repeat(201) })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    });

    it('exactly-200-char titulo SUCCEEDS (boundary is inclusive)', async () => {
      const { caller } = await buildRig(`u38rz-${randomUUID()}@example.com`);
      const titulo = 'a'.repeat(200);
      const out = await caller.campanhas.criar({ titulo });
      expect(out.titulo).toBe(titulo);
    });
  });

  describe('saga compensation (seam frozen by Rex on aperture-x0unf, 2026-07-08)', () => {
    // The saga: step 1 = criarCampanha persists the campanha (save #1);
    // step 2 = adicionarOpcaoContribuicao does findById + save (save #2, the
    // 'presente' step). Rex's catch compensates by deleting the half-created
    // campanha. Injection = arm the repo AFTER rig setup (signup itself
    // saves!) so save #1 post-arm succeeds and save #2 post-arm throws.
    it('a failure during the presente step rejects AND leaves NO orphan campanha', async () => {
      const email = `u38rz-saga-${randomUUID()}@example.com`;
      const { caller, campanhaRepository, registro, idConta } = await buildRig(email);

      // Baseline BEFORE arming — the compensation must restore exactly this.
      // (Deliberately no assumption about what the singular resolver returns
      // for a recebedor-less signup campanha: memory returns undefined there,
      // postgres returns the campanha — divergence reported to Rex 2026-07-08.
      // Invariance, not a fixed value, is the compensation contract.)
      const singularAntes = await campanhaRepository.findByAdministrador(idConta as never);

      const saveOriginal = campanhaRepository.save.bind(campanhaRepository);
      let savesAposArmar = 0;
      let idCondenada: string | undefined;
      campanhaRepository.save = async (campanha, context) => {
        savesAposArmar += 1;
        if (savesAposArmar === 1) {
          // criarCampanha's persist — let it through, remember the doomed id.
          idCondenada = campanha.id;
          return saveOriginal(campanha, context);
        }
        // The 'presente'-opcao save — the injected downstream failure.
        throw new Error('falha injetada no passo presente (u38rz)');
      };

      try {
        await expect(caller.campanhas.criar({ titulo: 'Lista condenada' })).rejects.toThrow();
      } finally {
        campanhaRepository.save = saveOriginal;
      }

      // The compensation must have removed the half-created campanha…
      expect(idCondenada, 'the first armed save must have fired').toBeDefined();
      if (idCondenada) {
        expect(
          await campanhaRepository.findById(idCondenada as never),
          'NO orphan: the half-created campanha must be gone',
        ).toBeUndefined();
      }
      // …and the conta must be exactly where it started: only the signup
      // campanha, and the single-resolve answer UNCHANGED from the baseline.
      const restantes = await campanhaRepository.findCampanhasByAdministrador(idConta as never);
      expect(restantes.map((c) => c.id)).toEqual([registro.campanha.id]);
      const singularDepois = await campanhaRepository.findByAdministrador(idConta as never);
      expect(singularDepois).toEqual(singularAntes);
    });
  });
});
