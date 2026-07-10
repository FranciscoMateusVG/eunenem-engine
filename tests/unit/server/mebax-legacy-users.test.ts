/**
 * aperture-mebax — baseline suite for the legacy-1.0 snapshot reader + the
 * `campanhas.list` tRPC contract (multicampanha migration bridge POC, epic
 * aperture-7hm2g).
 *
 * TEST SPLIT (agreed with Izzy, 2026-07-07): THIS file owns the baseline —
 * present → match, absent → empty, case-insensitive, optional-field
 * fallbacks, multiple-entries-same-email, seed integrity, and the
 * router-level contract shape. Izzy extends with adversarial edges
 * (whitespace extremes, unicode case-folding, malformed-entry schema
 * rejection) in her own suite (aperture-8jcec).
 *
 * DECLARED BEHAVIORS the adversarial suite builds on:
 *   - multiple entries sharing an email ALL return (one object per legacy
 *     campaign, spec §4);
 *   - matching = trim + default-locale toLowerCase() on BOTH sides;
 *   - malformed JSON throws AT MODULE LOAD (boot-loud), so runtime never
 *     sees a half-valid snapshot;
 *   - `nome` fallback is applied SERVER-side (DTO never carries an empty
 *     nome); `utm`/`mimos` are null-passthrough.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buscarCampanhasLegado,
  LEGACY_USERS_SEED,
  type LegacyUserEntry,
  LegacyUserEntrySchema,
  NOME_FALLBACK_LEGADO,
} from '../../../apps/eunenem-server/lib/legacy-users.js';
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
import { PagamentoEventPublisherMemory } from '../../../src/adapters/pagamentos/event-publisher.memory.js';
import { LivroFinanceiroRepositoryMemory } from '../../../src/adapters/pagamentos/financeiro/livro-repository.memory.js';
import { PagamentoProviderFake } from '../../../src/adapters/pagamentos/provider.fake.js';
import { PagamentoRepositoryMemory } from '../../../src/adapters/pagamentos/repository.memory.js';
import {
  ID_PLATAFORMA_EUNENEM,
  PlataformaRepositoryMemory,
} from '../../../src/adapters/plataforma/repository.memory.js';
import {
  ProvedorRegraTaxaMemory,
  REGRAS_TAXA_SEED,
} from '../../../src/adapters/taxas/regra-provider.memory.js';
import { AuthServiceMemoria } from '../../../src/adapters/usuario/auth-service.memory.js';
import { UsuarioRepositoryMemory } from '../../../src/adapters/usuario/repository.memory.js';
import { WebhookEventArchiveMemory } from '../../../src/adapters/webhook-archive/webhook-event-archive.memory.js';
import { NoopLogger } from '../../../src/observability/noop-logger.js';
import type { Observability } from '../../../src/observability/observability.js';
import { noopTracer } from '../../../src/observability/tracer.js';
import { criarSessaoUsuario } from '../../../src/use-cases/usuario/criar-sessao-usuario.js';
import { registrarContaUsuario } from '../../../src/use-cases/usuario/registrar-conta-usuario.js';

// ────────────────────────────────────────────────────────────────────
//  (A) Pure matcher — buscarCampanhasLegado
// ────────────────────────────────────────────────────────────────────

const entrada = (overrides: Partial<LegacyUserEntry> & { email: string }): LegacyUserEntry => ({
  utm: null,
  nome: null,
  mimos: null,
  ...overrides,
});

describe('buscarCampanhasLegado (pure matcher)', () => {
  it('email present → returns the matching entry as a DTO', () => {
    const entries = [entrada({ email: 'a@x.com', nome: 'Lista da Ana', utm: 'ana', mimos: 7 })];
    const out = buscarCampanhasLegado('a@x.com', entries);
    expect(out).toEqual([{ email: 'a@x.com', nome: 'Lista da Ana', utm: 'ana', mimos: 7 }]);
  });

  it('email absent → empty array', () => {
    const entries = [entrada({ email: 'a@x.com' })];
    expect(buscarCampanhasLegado('b@x.com', entries)).toEqual([]);
  });

  it('match is CASE-INSENSITIVE on both sides', () => {
    const entries = [entrada({ email: 'MiXeD@CaSe.CoM' })];
    expect(buscarCampanhasLegado('mixed@case.com', entries)).toHaveLength(1);
    expect(buscarCampanhasLegado('MIXED@CASE.COM', entries)).toHaveLength(1);
    // and stored-lowercase vs queried-uppercase
    const lower = [entrada({ email: 'user@hotmail.com' })];
    expect(buscarCampanhasLegado('USER@HOTMAIL.COM', lower)).toHaveLength(1);
  });

  it('match trims surrounding whitespace on both sides', () => {
    const entries = [entrada({ email: '  padded@x.com ' })];
    expect(buscarCampanhasLegado('padded@x.com', entries)).toHaveLength(1);
    expect(buscarCampanhasLegado('  padded@x.com  ', entries)).toHaveLength(1);
  });

  it('nome fallback: absent nome → generic 1.0 label (never empty)', () => {
    const entries = [entrada({ email: 'a@x.com', nome: null })];
    const [dto] = buscarCampanhasLegado('a@x.com', entries);
    expect(dto?.nome).toBe(NOME_FALLBACK_LEGADO);
    expect(dto?.nome.length).toBeGreaterThan(0);
  });

  it('utm/mimos are null-passthrough when absent (card hides them)', () => {
    const entries = [entrada({ email: 'a@x.com' })];
    const [dto] = buscarCampanhasLegado('a@x.com', entries);
    expect(dto?.utm).toBeNull();
    expect(dto?.mimos).toBeNull();
  });

  it('MULTIPLE entries with the same email ALL return (one per legacy campaign)', () => {
    const entries = [
      entrada({ email: 'multi@x.com', nome: 'Lista 1', utm: 'l1' }),
      entrada({ email: 'multi@x.com', nome: 'Lista 2', utm: 'l2' }),
      entrada({ email: 'other@x.com', nome: 'Alheia' }),
    ];
    const out = buscarCampanhasLegado('multi@x.com', entries);
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.utm)).toEqual(['l1', 'l2']);
  });

  it('empty/blank query email → empty array (no accidental match on blank entries)', () => {
    const entries = [entrada({ email: 'a@x.com' })];
    expect(buscarCampanhasLegado('', entries)).toEqual([]);
    expect(buscarCampanhasLegado('   ', entries)).toEqual([]);
  });

  it('whitespace-only ENTRY never matches an empty/blank query (Izzy item #1 — one bad export row must not match everyone)', () => {
    const entries = [entrada({ email: '   ' })];
    expect(buscarCampanhasLegado('', entries)).toEqual([]);
    expect(buscarCampanhasLegado('   ', entries)).toEqual([]);
  });

  it("nome present-but-blank ('' / whitespace) also gets the fallback (Izzy item #2)", () => {
    const entries = [
      entrada({ email: 'a@x.com', nome: '' }),
      entrada({ email: 'a@x.com', nome: '   ' }),
    ];
    const out = buscarCampanhasLegado('a@x.com', entries);
    expect(out).toHaveLength(2);
    for (const dto of out) expect(dto.nome).toBe(NOME_FALLBACK_LEGADO);
  });

  it('mimos of 0 survives as 0, not null (falsy-zero trap)', () => {
    const entries = [entrada({ email: 'a@x.com', mimos: 0 })];
    expect(buscarCampanhasLegado('a@x.com', entries)[0]?.mimos).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────
//  (B) Seed integrity — the shipped POC snapshot
// ────────────────────────────────────────────────────────────────────

describe('legacy-1.0-users.json POC seed', () => {
  it('validates at module load and contains EXACTLY the operator email', () => {
    // LEGACY_USERS_SEED importing at all proves the boot-loud validation
    // passed; pin the POC content so an accidental edit is caught.
    expect(LEGACY_USERS_SEED).toHaveLength(1);
    expect(LEGACY_USERS_SEED[0]?.email).toBe('franciscomateusvg@gmail.com');
  });

  it('schema rejects a malformed entry (boot-loud posture, for Izzy to extend)', () => {
    expect(() => LegacyUserEntrySchema.parse({ utm: 'no-email' })).toThrow();
    expect(() => LegacyUserEntrySchema.parse({ email: '' })).toThrow();
    // Whitespace-only email dies at module load (Izzy item #1, schema belt).
    expect(() => LegacyUserEntrySchema.parse({ email: '   ' })).toThrow();
    expect(() => LegacyUserEntrySchema.parse({ email: 'a@x.com', mimos: -3 })).toThrow();
  });

  it('operator email matches through the default seed (the POC happy path)', () => {
    const out = buscarCampanhasLegado('FRANCISCOMATEUSVG@GMAIL.COM');
    expect(out).toHaveLength(1);
    expect(out[0]?.nome).toBe('Minha lista (EuNeném 1.0)');
  });
});

// ────────────────────────────────────────────────────────────────────
//  (C) Router-level — campanhas.list contract (authed caller, memory repos)
// ────────────────────────────────────────────────────────────────────

const SESSION_COOKIE = 'better-auth.session_token';
const TEST_PASSWORD = 'senha-teste-123';

/**
 * Authenticated tRPC rig — same convention as the zt9ch / convite router-auth
 * tests: real session token from criarSessaoUsuario, cookie header, appRouter
 * against memory repos. `registrarContaUsuario` auto-creates the default
 * Campanha, so a fresh user has exactly one 2.0 campaign.
 */
async function buildRig(email: string) {
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
    perfilCampanhaRepository: new PerfilCampanhaRepositoryMemory(),
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
    resgatePendenteRepository: new ResgatePendenteRepositoryMemory(),
    observability,
    clock: () => new Date('2026-07-07T02:00:00.000Z'),
    sessionCookieName: SESSION_COOKIE,
    publicOrigin: 'http://localhost:3001',
    trustedHopCount: 0,
    logPiiHashSalt: '',
    webhookEventArchive: new WebhookEventArchiveMemory(),
  };

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
  };
}

describe('campanhas.list (router contract)', () => {
  it('returns the auto-created 2.0 campanha as a card DTO (novas) + empty legado for a non-legacy email', async () => {
    const email = `mebax-${randomUUID()}@example.com`;
    const { caller } = await buildRig(email);

    const out = await caller.campanhas.list();

    // novas: the signup saga auto-created "Lista de Francisco".
    expect(out.novas).toHaveLength(1);
    const card = out.novas[0];
    expect(card?.titulo).toBe('Lista de Francisco');
    expect(card?.slug, 'slug is the USUARIO painel slug').toMatch(/^francisco/);
    expect(card?.quantidadeMimos, 'POC: mimo count is null (card hides it)').toBeNull();
    expect(typeof card?.criadaEm).toBe('string');
    expect(
      Number.isNaN(Date.parse(card?.criadaEm ?? '')),
      'criadaEm must be a parseable ISO-8601 string',
    ).toBe(false);

    // legado: random example.com email is not in the snapshot.
    expect(out.legado).toEqual([]);
  });

  it('returns the 1.0 legacy card for the seeded operator email (case-insensitive)', async () => {
    // Register with a case-variant of the seeded email — proves the router
    // matches the REAL default snapshot case-insensitively end-to-end.
    const { caller } = await buildRig('FranciscoMateusVG@gmail.com');

    const out = await caller.campanhas.list();

    expect(out.legado).toHaveLength(1);
    expect(out.legado[0]).toEqual({
      email: 'franciscomateusvg@gmail.com',
      nome: 'Minha lista (EuNeném 1.0)',
      utm: null,
      mimos: null,
    });
    // And the mixed grid still carries the 2.0 side.
    expect(out.novas).toHaveLength(1);
  });

  it('UNAUTHORIZED without a session (no partial data for anonymous callers)', async () => {
    const email = `mebax-anon-${randomUUID()}@example.com`;
    const { anonCaller } = await buildRig(email);

    await expect(anonCaller.campanhas.list()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
});
