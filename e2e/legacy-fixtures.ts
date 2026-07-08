/**
 * Shared LEGACY-user Playwright fixture (aperture-8jcec, extracted for reuse
 * by aperture-8bac7).
 *
 * Provides `legacyContext` / `legacyPage` — a browser context authenticated
 * as the user whose email matches the repo-shipped
 * `legacy-1.0-users.json` snapshot (the multicampanha 1.0-card path). Fresh
 * context per test = empty localStorage = deterministic first-visit state.
 *
 * The seed is IDEMPOTENT and SELF-HEALING across dev-DB states:
 *   - fresh DB → registrarContaUsuario creates user + campanha (+ recebedor).
 *   - user already exists (e.g. the OPERATOR's own OAuth dev login, which
 *     leaves NO credential `accounts` row — root-caused 2026-07-07) → repair:
 *     upsert the credential row with OUR password hash (mirrors criarConta's
 *     write shape: provider_id='credential', account_id=`{plataforma}::{email}`)
 *     and seed a campanha via the criarCampanha use-case if the conta owns
 *     none (so 2.0-card assertions hold).
 * LOCAL dev DB only — this never touches staging/prod.
 */
import { randomUUID } from 'node:crypto';
import { type BrowserContext, test as base, type Page } from '@playwright/test';
import { hashPassword } from 'better-auth/crypto';
import { CampanhaRepositoryPostgres } from '../src/adapters/arrecadacao/campanha-repository.postgres.js';
import { ContribuicaoRepositoryPostgres } from '../src/adapters/arrecadacao/contribuicao-repository.postgres.js';
import { RecebedorRepositoryPostgres } from '../src/adapters/arrecadacao/recebedor-repository.postgres.js';
import { createDatabase, type Database } from '../src/adapters/database.js';
import {
  ID_PLATAFORMA_EUNENEM,
  PlataformaRepositoryMemory,
} from '../src/adapters/plataforma/repository.memory.js';
import { AuthServiceBetterAuth } from '../src/adapters/usuario/auth-service.better-auth.js';
import { UsuarioRepositoryPostgres } from '../src/adapters/usuario/repository.postgres.js';
import { criarRecebedorInicial } from '../src/domain/arrecadacao/entities/recebedor.js';
import { NoopLogger } from '../src/observability/noop-logger.js';
import { noopTracer } from '../src/observability/tracer.js';
import { criarCampanha } from '../src/use-cases/arrecadacao/criar-campanha.js';
import { criarSessaoUsuario } from '../src/use-cases/usuario/criar-sessao-usuario.js';
import { registrarContaUsuario } from '../src/use-cases/usuario/registrar-conta-usuario.js';

const SESSION_COOKIE = 'better-auth.session_token';
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://frame:frame@localhost:54320/frame';
const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3002';

/** MUST match the repo-shipped legacy-1.0-users.json entry (case differs on
 *  purpose — the whole point is the case-insensitive match, spec §4). */
export const LEGACY_EMAIL = 'FranciscoMateusVG@gmail.com';
const LEGACY_PASSWORD = 'senha-e2e-legacy-walker-123';

function buildSeedDeps(db: Database) {
  const recebedorRepository = new RecebedorRepositoryPostgres(db);
  return {
    usuarioRepository: new UsuarioRepositoryPostgres(db),
    plataformaRepository: new PlataformaRepositoryMemory(),
    campanhaRepository: new CampanhaRepositoryPostgres(db, recebedorRepository),
    recebedorRepository,
    contribuicaoRepository: new ContribuicaoRepositoryPostgres(db),
    authService: new AuthServiceBetterAuth(db, { clock: () => new Date() }),
    clock: () => new Date(),
    observability: { logger: new NoopLogger(), tracer: noopTracer() },
  };
}

/** Register-or-REPAIR-then-login as the legacy-matching user (see header). */
export async function mintLegacySession(): Promise<string> {
  const db = createDatabase(DATABASE_URL);
  const deps = buildSeedDeps(db);
  try {
    try {
      const { campanha } = await registrarContaUsuario(deps, {
        idUsuario: randomUUID() as never,
        idConta: randomUUID() as never,
        idPlataforma: ID_PLATAFORMA_EUNENEM as never,
        email: LEGACY_EMAIL,
        nomeExibicao: 'Legacy Walker E2E',
        senhaSimulada: LEGACY_PASSWORD,
      });
      // Attach a recebedor so the auto-created campanha is "complete" and
      // surfaces as a 2.0 card (mirrors e2e/fixtures.ts step 2).
      await deps.recebedorRepository.save(
        criarRecebedorInicial({
          id: randomUUID() as never,
          idCampanha: campanha.id,
          dadosRecebedor: {
            metodo: 'pix',
            nomeTitular: 'Legacy Walker E2E',
            tipoChavePix: 'email',
            chavePix: LEGACY_EMAIL,
          },
          criadaEm: deps.clock(),
        }),
      );
    } catch {
      await repairExistingLegacyUser(db, deps);
    }
    const sessao = await criarSessaoUsuario(deps, {
      idPlataforma: ID_PLATAFORMA_EUNENEM as never,
      email: LEGACY_EMAIL,
      senhaSimulada: LEGACY_PASSWORD,
    });
    return sessao.token;
  } finally {
    await db.destroy();
  }
}

/** See mintLegacySession — the user-exists repair path. */
async function repairExistingLegacyUser(
  db: Database,
  deps: ReturnType<typeof buildSeedDeps>,
): Promise<void> {
  const emailLower = LEGACY_EMAIL.toLowerCase();

  const usuario = await db
    .selectFrom('usuarios')
    .select(['id', 'id_conta'])
    .where('email', '=', emailLower)
    .executeTakeFirst();
  if (!usuario) {
    throw new Error(
      `legacy seed: registrarContaUsuario failed but no usuarios row for ${emailLower} — ` +
        'the register error was NOT email-exists; investigate before rerunning.',
    );
  }

  // 1. Credential account upsert (BetterAuth `accounts`, provider 'credential').
  const passwordHash = await hashPassword(LEGACY_PASSWORD);
  const accountId = `${ID_PLATAFORMA_EUNENEM}::${emailLower}`;
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

  // 2. Campanha: an OAuth-created dev user owns none → 2.0-card assertions
  //    would fail on an empty grid. Seed one through the domain use-case.
  const campanhas = await deps.campanhaRepository.findCampanhasByAdministrador(
    usuario.id_conta as never,
  );
  if (campanhas.length === 0) {
    await criarCampanha(deps, {
      id: randomUUID() as never,
      idPlataforma: ID_PLATAFORMA_EUNENEM as never,
      idsAdministradores: [usuario.id_conta] as never,
      titulo: 'Lista do Legacy Walker (2.0)',
      dadosRecebedor: {
        metodo: 'pix',
        nomeTitular: 'Legacy Walker E2E',
        tipoChavePix: 'email',
        chavePix: emailLower,
      },
    });
  }
}

export interface LegacyFixtures {
  /** Context authenticated as the legacy-JSON-matching user. Fresh per test
   *  (fresh context = empty localStorage = deterministic first-visit state). */
  legacyContext: BrowserContext;
  legacyPage: Page;
}

export const test = base.extend<LegacyFixtures>({
  legacyContext: async ({ browser, baseURL }, use) => {
    const token = await mintLegacySession();
    const url = new URL(baseURL ?? BASE_URL);
    const context = await browser.newContext();
    await context.addCookies([
      {
        name: SESSION_COOKIE,
        value: encodeURIComponent(token),
        domain: url.hostname,
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
    await use(context);
    await context.close();
  },
  legacyPage: async ({ legacyContext }, use) => {
    const page = await legacyContext.newPage();
    await use(page);
    await page.close();
  },
});

export { expect } from '@playwright/test';
