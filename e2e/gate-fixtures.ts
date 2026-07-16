/**
 * Hermetic gate-walker seed (aperture — coverage-expansion).
 *
 * The five "gate" specs — w2-enforcement-gate, llol4-isolation-gates,
 * slug-isolation-gate, 118sb-clickthrough-gate, fblrt-fix-wave — were written
 * against a PERMANENT walker user pre-provisioned on a deployed target (their
 * beforeAll only LOGS IN via auth.continuarComEmail and self-heals a few bits).
 * Against a fresh LOCAL DB (docker Postgres :54320, spawned :3002 server) that
 * walker does not exist, so the specs either skip (no creds) or fail (login /
 * campanha-A assertions).
 *
 * `seedGateWalker()` closes that gap: it builds the EXACT walker + two campanhas
 * the specs assume, DIRECTLY through the engine's repositories / use-cases (NOT
 * the UI, NOT the tRPC server) against DATABASE_URL — mirroring the direct-repo
 * style of e2e/fixtures.ts + e2e/legacy-fixtures.ts. It is idempotent
 * (find-or-create at every step) because all five specs call it in their
 * beforeAll and the suite runs workers=1 against ONE shared DB, so it executes
 * up to five times per run and must converge to the same state every time.
 *
 * After it runs, each spec's existing login/self-heal logic finds everything
 * already correct: continuarComEmail LOGS IN (the walker exists with matching
 * credentials), me.needsOnboarding is already false (A's perfil_campanhas has a
 * baby name), the tutorial is already dismissed, both campanhas exist with the
 * right titles/slugs/perfis/convite.
 *
 * CONTRACT (see the task brief):
 *   WALKER   email=E2E_GATE_EMAIL senha=E2E_GATE_SENHA, nomeExibicao
 *            'Izzygate Walker', painel slug 'izzygate', tutorial complete,
 *            perfil_criadores nomeBebe 'Bebe Gate', EMPTY legado (pure 2.0).
 *   CAMPANHA A (OLDEST) titulo 'Lista de Izzygate Walker', slug=null, one gift
 *            'Presente do Gate 118sb' (11800, qty 1), NO convite, recebedor
 *            (pix), perfil_campanhas nomeBebe 'Bebe Um Gate' dataEvento
 *            2030-01-01 tipoEvento cha-bebe genero surpresa.
 *   CAMPANHA B (NEWER)  titulo 'Segunda Lista do Gate 118sb', slug 'gate-camp-b',
 *            NO gifts, convite/evento (presencial 2026-08-01, Rua das Flores),
 *            recebedor (pix), perfil_campanhas nomeBebe 'Bebe Dois Gate'
 *            dataEvento 2031-12-25 tipoEvento cha-bebe genero surpresa.
 *   INVARIANTS  A.slug === B.slug (== painel 'izzygate'); A.id !== B.id;
 *            A strictly older than B (creation order + explicit clocks);
 *            A and B perfis DIFFER (distinct nomeBebe).
 *
 * LOCAL dev DB only — this never touches staging/prod.
 */
import { randomUUID } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import { CampanhaRepositoryPostgres } from '../src/adapters/arrecadacao/campanha-repository.postgres.js';
import { ContribuicaoRepositoryPostgres } from '../src/adapters/arrecadacao/contribuicao-repository.postgres.js';
import { PerfilCampanhaRepositoryPostgres } from '../src/adapters/arrecadacao/perfil-campanha-repository.postgres.js';
import { RecebedorRepositoryPostgres } from '../src/adapters/arrecadacao/recebedor-repository.postgres.js';
import { createDatabase, type Database } from '../src/adapters/database.js';
import { ConviteRepositoryPostgres } from '../src/adapters/evento/convite-repository.postgres.js';
import { EventoRepositoryPostgres } from '../src/adapters/evento/evento-repository.postgres.js';
import {
  ID_PLATAFORMA_EUNENEM,
  PlataformaRepositoryMemory,
} from '../src/adapters/plataforma/repository.memory.js';
import { AuthServiceBetterAuth } from '../src/adapters/usuario/auth-service.better-auth.js';
import { PerfilCriadorRepositoryPostgres } from '../src/adapters/usuario/perfil-criador-repository.postgres.js';
import { UsuarioRepositoryPostgres } from '../src/adapters/usuario/repository.postgres.js';
import type { Campanha } from '../src/domain/arrecadacao/entities/campanha.js';
import { criarContribuicao } from '../src/domain/arrecadacao/entities/contribuicao.js';
import { criarPerfilCampanha } from '../src/domain/arrecadacao/entities/perfil-campanha.js';
import { criarRecebedorInicial } from '../src/domain/arrecadacao/entities/recebedor.js';
import { criarPerfilCriador } from '../src/domain/usuario/entities/perfil-criador.js';
import type { Usuario } from '../src/domain/usuario/entities/usuario.js';
import { conteudoPerfilCriadorVazio } from '../src/domain/usuario/value-objects/conteudo-perfil-criador.js';
import { NoopLogger } from '../src/observability/noop-logger.js';
import { noopTracer } from '../src/observability/tracer.js';
import { adicionarOpcaoContribuicao } from '../src/use-cases/arrecadacao/adicionar-opcao-contribuicao.js';
import { criarCampanha } from '../src/use-cases/arrecadacao/criar-campanha.js';
import { criarConvite } from '../src/use-cases/evento/criar-convite.js';
import { criarEvento } from '../src/use-cases/evento/criar-evento.js';
import { registrarContaUsuario } from '../src/use-cases/usuario/registrar-conta-usuario.js';

const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://frame:frame@localhost:54320/frame';

// ── Contract constants (kept in exact sync with the five specs) ──────────────
const NOME_EXIBICAO = 'Izzygate Walker';
const WALKER_SLUG = 'izzygate';
const TITULO_A = `Lista de ${NOME_EXIBICAO}`;
const TITULO_B = 'Segunda Lista do Gate 118sb';
const SLUG_CAMP_B = 'gate-camp-b';

const GIFT_A_NOME = 'Presente do Gate 118sb';
const GIFT_A_VALOR = 11_800;

const USER_PERFIL_NOME_BEBE = 'Bebe Gate';
const BEBE_A = 'Bebe Um Gate';
const BEBE_B = 'Bebe Dois Gate';
const DATA_EVENTO_A = new Date('2030-01-01T12:00:00.000Z');
const DATA_EVENTO_B = new Date('2031-12-25T12:00:00.000Z');

// A strictly older than B: fixed, ordered creation timestamps guarantee the
// (criada_em ASC, id ASC) ordering that findFirstByAdministrador uses picks A
// as "oldest" regardless of UUID tiebreak.
const CLOCK_A = new Date('2024-01-01T00:00:00.000Z');
const CLOCK_B = new Date('2024-02-01T00:00:00.000Z');

function buildDeps(db: Database) {
  const observability = { logger: new NoopLogger(), tracer: noopTracer() };
  const recebedorRepository = new RecebedorRepositoryPostgres(db);
  return {
    db,
    observability,
    recebedorRepository,
    usuarioRepository: new UsuarioRepositoryPostgres(db),
    plataformaRepository: new PlataformaRepositoryMemory(),
    campanhaRepository: new CampanhaRepositoryPostgres(db, recebedorRepository),
    contribuicaoRepository: new ContribuicaoRepositoryPostgres(db),
    perfilCampanhaRepository: new PerfilCampanhaRepositoryPostgres(db),
    perfilCriadorRepository: new PerfilCriadorRepositoryPostgres(db),
    eventoRepository: new EventoRepositoryPostgres(db),
    conviteRepository: new ConviteRepositoryPostgres(db),
    authService: new AuthServiceBetterAuth(db, { clock: () => new Date() }),
  };
}

type Deps = ReturnType<typeof buildDeps>;

/** PIX receiver-data with the canonical valid test CPF (checksum-valid; the
 *  pix row-level CHECK requires cpf_titular since migration 20260709). */
function dadosRecebedorPix(nomeTitular: string) {
  return {
    metodo: 'pix' as const,
    nomeTitular,
    cpfTitular: '11144477735',
    tipoChavePix: 'cpf' as const,
    chavePix: '11144477735',
  };
}

/** Ensure the campanha has ONE active recebedor (idempotent — no duplicate). */
async function ensureRecebedor(deps: Deps, campanha: Campanha): Promise<void> {
  const existing = await deps.recebedorRepository.findAtivoByCampanhaId(campanha.id);
  if (existing) return;
  await deps.recebedorRepository.save(
    criarRecebedorInicial({
      id: randomUUID() as never,
      idCampanha: campanha.id,
      dadosRecebedor: dadosRecebedorPix(NOME_EXIBICAO),
      criadaEm: CLOCK_A,
    }),
  );
}

/** The 'presente' opcao a campanha's gifts hang off. Adds one if absent
 *  (criarCampanha yields an EMPTY campanha; registrarContaUsuario's default
 *  campanha already has it). Returns the campanha refreshed with the opcao. */
async function ensurePresenteOpcao(deps: Deps, campanha: Campanha): Promise<Campanha> {
  const presente = campanha.opcoes.find((o) => o.tipo === 'presente');
  if (presente) return campanha;
  return adicionarOpcaoContribuicao(
    { campanhaRepository: deps.campanhaRepository, observability: deps.observability },
    { idCampanha: campanha.id, idOpcao: randomUUID() as never, tipo: 'presente' },
  );
}

/** Upsert a campanha's per-campanha profile (idempotent via id_campanha
 *  UPSERT). Distinct nomeBebe per campanha is what proves G5/G6 isolation. */
async function seedPerfilCampanha(
  deps: Deps,
  campanha: Campanha,
  nomeBebe: string,
  dataEvento: Date,
): Promise<void> {
  await deps.perfilCampanhaRepository.save(
    criarPerfilCampanha({
      id: randomUUID() as never,
      idCampanha: campanha.id,
      conteudo: {
        ...conteudoPerfilCriadorVazio(),
        nomeBebe,
        tipoEvento: 'cha-bebe',
        genero: 'surpresa',
        dataEvento,
      },
      criadoEm: CLOCK_A,
    }),
  );
}

/** Attach the campanha's single gift if it is not already present. */
async function ensureGift(
  deps: Deps,
  campanha: Campanha,
  nome: string,
  valor: number,
): Promise<void> {
  const existentes = await deps.contribuicaoRepository.findByCampanhaId(campanha.id);
  if (existentes.some((c) => c.nome === nome)) return;
  const presente = campanha.opcoes.find((o) => o.tipo === 'presente');
  if (!presente) throw new Error('seedGateWalker: campanha lacks a "presente" opcao for the gift.');
  await deps.contribuicaoRepository.save(
    criarContribuicao({
      id: randomUUID() as never,
      idCampanha: campanha.id,
      idOpcaoContribuicao: presente.id,
      nome,
      valor: valor as never,
      quantidade: 1,
      criadaEm: CLOCK_A,
    }),
  );
}

/** Save the campanha's convite + evento (idempotent — skipped if present).
 *  criarEvento / criarConvite throw if the row already exists, so we guard
 *  on the repository reads first. */
async function ensureConvite(deps: Deps, campanha: Campanha): Promise<void> {
  const existingEvento = await deps.eventoRepository.findByIdCampanha(campanha.id as never);
  const evento =
    existingEvento ??
    (await criarEvento(
      {
        eventoRepository: deps.eventoRepository,
        campanhaRepository: deps.campanhaRepository,
        clock: () => CLOCK_B,
        observability: deps.observability,
      },
      {
        id: randomUUID() as never,
        idCampanha: campanha.id as never,
        tipoEvento: 'cha-bebe',
        modalidade: 'presencial',
        dataHora: new Date('2026-08-01T15:00:00.000Z'),
        endereco: 'Rua das Flores, 123',
      },
    ));

  const existingConvite = await deps.conviteRepository.findByIdEvento(evento.id as never);
  if (existingConvite) return;
  await criarConvite(
    {
      conviteRepository: deps.conviteRepository,
      eventoRepository: deps.eventoRepository,
      clock: () => CLOCK_B,
      observability: deps.observability,
    },
    {
      id: randomUUID() as never,
      idEvento: evento.id as never,
      remetente: 'Francisco',
      nomeExibido: 'Bebe Gate B',
      mensagem: 'Venha comemorar conosco!',
      paleta: 'lilas',
      fonte: 'patrick',
      modelo: 'scrapbook',
    },
  );
}

/** Upsert the BetterAuth credential row for an already-existing walker so
 *  email+password login (continuarComEmail → criarSessaoUsuario) verifies
 *  against OUR senha. Mirrors legacy-fixtures.repairExistingLegacyUser: the
 *  accounts write shape criarConta uses (provider_id='credential',
 *  account_id=`{plataforma}::{email}`). Only needed on the repair branch —
 *  registrarContaUsuario writes this row itself on first creation. */
async function repairCredential(
  db: Database,
  usuario: Usuario,
  email: string,
  senha: string,
): Promise<void> {
  const passwordHash = await hashPassword(senha);
  const accountId = `${ID_PLATAFORMA_EUNENEM}::${email.toLowerCase()}`;
  const existing = await db
    .selectFrom('accounts')
    .select('id')
    .where('provider_id', '=', 'credential')
    .where('account_id', '=', accountId)
    .executeTakeFirst();
  const now = new Date();
  if (existing) {
    await db
      .updateTable('accounts')
      .set({ password: passwordHash, updated_at: now })
      .where('id', '=', existing.id)
      .execute();
  } else {
    await db
      .insertInto('accounts')
      .values({
        id: randomUUID(),
        user_id: usuario.id,
        provider_id: 'credential',
        account_id: accountId,
        password: passwordHash,
        access_token: null,
        refresh_token: null,
        id_token: null,
        access_token_expires_at: null,
        refresh_token_expires_at: null,
        scope: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
  }
}

/**
 * Idempotently seed the full gate-walker contract. Safe to call in every
 * spec's beforeAll (find-or-create throughout). No-op when the gate creds are
 * unset — the specs skip in that case anyway, so seeding would be wasted work.
 */
export async function seedGateWalker(): Promise<void> {
  const email = process.env.E2E_GATE_EMAIL;
  const senha = process.env.E2E_GATE_SENHA;
  if (!email || !senha) return;

  const db = createDatabase(DATABASE_URL);
  const deps = buildDeps(db);
  try {
    // ── 1. Walker + campanha A (default "Lista de <nome>", pure 2.0 signup) ──
    let usuario: Usuario;
    const existing = await deps.usuarioRepository.findUsuarioByEmail(
      ID_PLATAFORMA_EUNENEM as never,
      email,
    );
    if (existing) {
      usuario = existing;
      await repairCredential(db, usuario, email, senha);
    } else {
      const res = await registrarContaUsuario(
        {
          usuarioRepository: deps.usuarioRepository,
          plataformaRepository: deps.plataformaRepository,
          campanhaRepository: deps.campanhaRepository,
          recebedorRepository: deps.recebedorRepository,
          authService: deps.authService,
          clock: () => CLOCK_A,
          observability: deps.observability,
        },
        {
          idUsuario: randomUUID() as never,
          idConta: randomUUID() as never,
          idPlataforma: ID_PLATAFORMA_EUNENEM as never,
          email,
          nomeExibicao: NOME_EXIBICAO,
          senhaSimulada: senha,
        },
      );
      usuario = res.usuario;
    }

    // Painel slug MUST be 'izzygate' (derived naturally from 'Izzygate Walker',
    // but forced defensively in case a collision-suffixed it).
    if (usuario.slug !== WALKER_SLUG) {
      await deps.usuarioRepository.atualizarSlugUsuario(usuario.id, WALKER_SLUG as never);
    }

    // Tutorial dismissed (guarded WHERE tutorial_completado_em IS NULL).
    await deps.usuarioRepository.marcarTutorialCompletado(usuario.id, CLOCK_A);

    // Legacy per-USER perfil (perfil_criadores) nomeBebe 'Bebe Gate'. Distinct
    // from perfil_campanhas; does NOT drive needsOnboarding (that reads the
    // oldest campanha's perfil_campanhas) — seeded to honor the contract.
    await deps.perfilCriadorRepository.save(
      criarPerfilCriador({
        id: randomUUID() as never,
        idUsuario: usuario.id,
        conteudo: { ...conteudoPerfilCriadorVazio(), nomeBebe: USER_PERFIL_NOME_BEBE },
        criadoEm: CLOCK_A,
      }),
    );

    // Resolve campanha A = the walker's oldest campanha titled TITULO_A.
    const campanhas = await deps.campanhaRepository.findCampanhasByAdministrador(usuario.idConta);
    let campanhaA = campanhas.find((c) => c.titulo === TITULO_A);
    if (!campanhaA) {
      throw new Error(
        `seedGateWalker: walker owns no "${TITULO_A}" — got ${JSON.stringify(campanhas.map((c) => c.titulo))}`,
      );
    }
    campanhaA = await ensurePresenteOpcao(deps, campanhaA);
    await ensureRecebedor(deps, campanhaA);
    await ensureGift(deps, campanhaA, GIFT_A_NOME, GIFT_A_VALOR);
    // A's perfil FIRST — needsOnboarding reads the OLDEST campanha's nomeBebe.
    await seedPerfilCampanha(deps, campanhaA, BEBE_A, DATA_EVENTO_A);

    // ── 2. Campanha B (newer): slug 'gate-camp-b', convite, distinct perfil ──
    let campanhaB = campanhas.find((c) => c.titulo === TITULO_B);
    if (!campanhaB) {
      campanhaB = await criarCampanha(
        {
          campanhaRepository: deps.campanhaRepository,
          recebedorRepository: deps.recebedorRepository,
          plataformaRepository: deps.plataformaRepository,
          clock: () => CLOCK_B,
          observability: deps.observability,
        },
        {
          id: randomUUID() as never,
          idPlataforma: ID_PLATAFORMA_EUNENEM as never,
          idsAdministradores: [usuario.idConta] as never,
          titulo: TITULO_B,
        },
      );
    }
    campanhaB = await ensurePresenteOpcao(deps, campanhaB);
    await ensureRecebedor(deps, campanhaB);
    await deps.campanhaRepository.updateSlug(campanhaB.id, SLUG_CAMP_B, null, false);
    await ensureConvite(deps, campanhaB);
    // B's perfil MUST differ from A's (the isolation axis) — distinct nomeBebe.
    await seedPerfilCampanha(deps, campanhaB, BEBE_B, DATA_EVENTO_B);
  } finally {
    await db.destroy();
  }
}
