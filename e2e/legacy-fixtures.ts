/**
 * Shared LEGACY-user Playwright fixture (aperture-8jcec, extracted for reuse
 * by aperture-8bac7).
 *
 * Provides `legacyContext` / `legacyPage` — a browser context authenticated
 * as the user whose email matches the repo-shipped
 * `legacy-1.0-users.json` snapshot (the multicampanha 1.0-card path). Fresh
 * context per test = empty localStorage = deterministic first-visit state.
 *
 * The seed is IDEMPOTENT and SELF-HEALING across dev-DB states. Authentication
 * uses the real magic-link handler; auth.me provisions a fresh domain identity
 * through the production self-heal path. Existing identities reuse that path's
 * signed session. We only repair missing domain campanha/recebedor data.
 * LOCAL dev DB only — this never touches staging/prod.
 */
import { randomUUID } from 'node:crypto';
import { type BrowserContext, test as base, type Page } from '@playwright/test';
import { CampanhaRepositoryPostgres } from '../src/adapters/arrecadacao/campanha-repository.postgres.js';
import { RecebedorRepositoryPostgres } from '../src/adapters/arrecadacao/recebedor-repository.postgres.js';
import { createDatabase, type Database } from '../src/adapters/database.js';
import {
  ID_PLATAFORMA_EUNENEM,
  PlataformaRepositoryMemory,
} from '../src/adapters/plataforma/repository.memory.js';
import { UsuarioRepositoryPostgres } from '../src/adapters/usuario/repository.postgres.js';
import { criarRecebedorInicial } from '../src/domain/arrecadacao/entities/recebedor.js';
import { NoopLogger } from '../src/observability/noop-logger.js';
import { noopTracer } from '../src/observability/tracer.js';
import { criarCampanha } from '../src/use-cases/arrecadacao/criar-campanha.js';
import {
  browserCookieFor,
  type MagicLinkSession,
  mintMagicLinkSession,
} from './magic-link-auth.js';

const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://frame:frame@localhost:54320/frame';
const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3002';

/** MUST match the repo-shipped legacy-1.0-users.json entry (case differs on
 *  purpose — the whole point is the case-insensitive match, spec §4). */
export const LEGACY_EMAIL = 'FranciscoMateusVG@gmail.com';
const LEGACY_NAME = 'Legacy Walker E2E';

function buildSeedDeps(db: Database) {
  const recebedorRepository = new RecebedorRepositoryPostgres(db);
  return {
    usuarioRepository: new UsuarioRepositoryPostgres(db),
    plataformaRepository: new PlataformaRepositoryMemory(),
    campanhaRepository: new CampanhaRepositoryPostgres(db, recebedorRepository),
    recebedorRepository,
    clock: () => new Date(),
    observability: { logger: new NoopLogger(), tracer: noopTracer() },
  };
}

/** Magic-link login + domain-data repair for the legacy-matching user. */
export async function mintLegacySession(baseURL: string = BASE_URL): Promise<MagicLinkSession> {
  const db = createDatabase(DATABASE_URL);
  const deps = buildSeedDeps(db);
  try {
    const session = await mintMagicLinkSession(db, {
      email: LEGACY_EMAIL,
      name: LEGACY_NAME,
      baseURL,
    });
    const usuario = await deps.usuarioRepository.findUsuarioByEmail(
      ID_PLATAFORMA_EUNENEM as never,
      LEGACY_EMAIL.toLowerCase(),
    );
    if (!usuario) {
      throw new Error(`legacy seed: auth.me did not provision ${LEGACY_EMAIL.toLowerCase()}`);
    }

    const campanhas = await deps.campanhaRepository.findCampanhasByAdministrador(usuario.idConta);
    const campanha =
      campanhas[0] ??
      (await criarCampanha(deps, {
        id: randomUUID() as never,
        idPlataforma: ID_PLATAFORMA_EUNENEM as never,
        idsAdministradores: [usuario.idConta] as never,
        titulo: 'Lista do Legacy Walker (2.0)',
      }));
    const recebedor = await deps.recebedorRepository.findAtivoByCampanhaId(campanha.id);
    if (!recebedor) {
      await deps.recebedorRepository.save(
        criarRecebedorInicial({
          id: randomUUID() as never,
          idCampanha: campanha.id,
          dadosRecebedor: {
            metodo: 'pix',
            nomeTitular: LEGACY_NAME,
            cpfTitular: '11144477735',
            tipoChavePix: 'email',
            chavePix: LEGACY_EMAIL,
          },
          criadaEm: deps.clock(),
        }),
      );
    }
    return session;
  } finally {
    await db.destroy();
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
    const resolvedBaseURL = baseURL ?? BASE_URL;
    const session = await mintLegacySession(resolvedBaseURL);
    const context = await browser.newContext();
    await context.addCookies([browserCookieFor(session, resolvedBaseURL)]);
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
