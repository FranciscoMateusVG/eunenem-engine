import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServerDeps, loadEnv } from '../../apps/eunenem-server/server/auth/setup.js';
import type { TrpcContext } from '../../apps/eunenem-server/server/trpc/context.js';
import { appRouter } from '../../apps/eunenem-server/server/trpc/router.js';
import {
  AuthServiceBetterAuth,
  CatalogoAdminAuditPostgres,
  CatalogoRepositoryPostgres,
  ID_PLATAFORMA_EUCASEI,
  UsuarioRepositoryPostgres,
} from '../../src/index.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';

/**
 * P0 composition regression for aperture-eww0g.
 *
 * This deliberately uses the production composition root over real Postgres:
 * AuthServiceBetterAuth resolves the live bare cookie, UsuarioRepositoryPostgres
 * loads the foreign domain principal, adminProcedure applies the tenant gate,
 * and the real catalog repositories remain untouched. Keeping those layers in
 * one test prevents the lower-level resolver and stubbed-router suites from
 * both passing while production wiring accidentally bypasses either half.
 */
describe('foreign-tenant admin denial — real Postgres composition (aperture-eww0g)', () => {
  let testDb: TestDatabase;

  beforeAll(async () => {
    testDb = await createTestDatabase();
  }, 60_000);

  afterAll(async () => {
    await testDb.teardown();
  });

  it('rejects an allowlisted EUCASEI live session before catalog mutation or audit', async () => {
    const idUsuario = randomUUID();
    const idConta = randomUUID();
    const email = `foreign-admin-${idUsuario}@test.local`;
    const password = 'ForeignAdminComposition123!';
    const categorySlug = `foreign-admin-${randomUUID()}`;

    const deps = buildServerDeps(
      loadEnv({
        BETTER_AUTH_SECRET: 'test-secret-at-least-thirty-two-characters-long',
        BETTER_AUTH_URL: 'http://localhost:3001',
        TRUSTED_ORIGINS: 'http://localhost:3001',
        ADMIN_ALLOWED_EMAILS: email,
        DATABASE_URL: testDb.connectionUri,
        NODE_ENV: 'test',
        LEGACY_SITE_ORIGIN: 'https://eunenem.com',
      }),
    );

    try {
      expect(deps.authService).toBeInstanceOf(AuthServiceBetterAuth);
      expect(deps.usuarioRepository).toBeInstanceOf(UsuarioRepositoryPostgres);
      expect(deps.catalogoRepository).toBeInstanceOf(CatalogoRepositoryPostgres);
      expect(deps.catalogoAdminAudit).toBeInstanceOf(CatalogoAdminAuditPostgres);

      await deps.authService.criarConta({
        idUsuario: idUsuario as never,
        idPlataforma: ID_PLATAFORMA_EUCASEI as never,
        email: email as never,
        senha: password,
        nome: 'Foreign Allowlisted Admin' as never,
      });
      await deps.db
        .insertInto('usuarios')
        .values({
          id: idUsuario,
          id_plataforma: ID_PLATAFORMA_EUCASEI,
          id_conta: idConta,
          email,
          nome_exibicao: 'Foreign Allowlisted Admin',
          slug: `foreign-${idUsuario.slice(0, 12)}`,
          tutorial_completado_em: null,
          onboarding_concluido_em: null,
        })
        .execute();
      await deps.db
        .insertInto('contas')
        .values({
          id: idConta,
          id_usuario: idUsuario,
          permissoes: [],
        })
        .execute();

      const session = await deps.authService.iniciarSessao({
        idPlataforma: ID_PLATAFORMA_EUCASEI as never,
        email: email as never,
        senha: password,
      });
      const liveSessionsBefore = await deps.db
        .selectFrom('sessions')
        .selectAll()
        .where('user_id', '=', idUsuario)
        .orderBy('id')
        .execute();
      expect(liveSessionsBefore).toHaveLength(1);
      expect(liveSessionsBefore[0]?.token).toBe(session.token);

      const categoryBefore = await deps.db
        .selectFrom('catalogo_categorias')
        .select('id')
        .where('slug', '=', categorySlug)
        .executeTakeFirst();
      const auditBefore = await deps.db
        .selectFrom('catalogo_admin_audit_events')
        .select('id')
        .where('actor_usuario_id', '=', idUsuario)
        .execute();
      expect(categoryBefore).toBeUndefined();
      expect(auditBefore).toEqual([]);

      const headers = new Headers({
        cookie: `${deps.sessionCookieName}=${encodeURIComponent(session.token)}`,
      });
      const context: TrpcContext = {
        deps,
        headers,
        resHeaders: new Headers(),
      };

      await expect(
        appRouter.createCaller(context).admin.catalog.createCategory({
          slug: categorySlug,
          label: 'Must Not Be Created',
          position: 0,
        }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

      const categoryAfter = await deps.db
        .selectFrom('catalogo_categorias')
        .select('id')
        .where('slug', '=', categorySlug)
        .executeTakeFirst();
      const auditAfter = await deps.db
        .selectFrom('catalogo_admin_audit_events')
        .select('id')
        .where('actor_usuario_id', '=', idUsuario)
        .execute();
      const liveSessionsAfter = await deps.db
        .selectFrom('sessions')
        .selectAll()
        .where('user_id', '=', idUsuario)
        .orderBy('id')
        .execute();

      expect(categoryAfter).toBeUndefined();
      expect(auditAfter).toEqual([]);
      expect(liveSessionsAfter).toEqual(liveSessionsBefore);
    } finally {
      await deps.db
        .deleteFrom('catalogo_admin_audit_events')
        .where('actor_usuario_id', '=', idUsuario)
        .execute();
      await deps.db.deleteFrom('catalogo_categorias').where('slug', '=', categorySlug).execute();
      await deps.db.deleteFrom('contas').where('id_usuario', '=', idUsuario).execute();
      await deps.db.deleteFrom('usuarios').where('id', '=', idUsuario).execute();
      await deps.db.deleteFrom('users').where('id', '=', idUsuario).execute();
      await deps.db.destroy();
    }
  });
});
