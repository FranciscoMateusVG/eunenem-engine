import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  InvalidAdminSearchFilterError,
  InvalidAdminUserCursorError,
  listAdminUsers,
  searchAdminUsers,
} from '../../apps/eunenem-server/server/admin-user-search.js';
import { ID_PLATAFORMA_EUNENEM } from '../../src/index.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';

const PUBLIC_ORIGIN = 'https://staging.eunenem.com';
const CURSOR_SECRET = 'admin-user-search-test-secret';
const USER_IDS = [
  '31000000-0000-4000-8000-000000000001',
  '31000000-0000-4000-8000-000000000002',
  '31000000-0000-4000-8000-000000000003',
] as const;
const ACCOUNT_IDS = [
  '32000000-0000-4000-8000-000000000001',
  '32000000-0000-4000-8000-000000000002',
  '32000000-0000-4000-8000-000000000003',
] as const;
const CAMPAIGN_IDS = [
  '33000000-0000-4000-8000-000000000001',
  '33000000-0000-4000-8000-000000000002',
  '33000000-0000-4000-8000-000000000003',
] as const;
const OTHER_PLATFORM_ID = '34000000-0000-4000-8000-000000000001';

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
}, 60_000);

beforeEach(async () => {
  await testDb.db
    .deleteFrom('campanha_administradores')
    .where('campanha_id', 'in', [...CAMPAIGN_IDS])
    .execute();
  await testDb.db
    .deleteFrom('campanhas')
    .where('id', 'in', [...CAMPAIGN_IDS])
    .execute();
  await testDb.db
    .deleteFrom('usuarios')
    .where('id', 'in', [...USER_IDS])
    .execute();

  await testDb.db
    .insertInto('usuarios')
    .values([
      {
        id: USER_IDS[0],
        id_plataforma: ID_PLATAFORMA_EUNENEM,
        id_conta: ACCOUNT_IDS[0],
        email: 'admin-user-search-ana@example.test',
        nome_exibicao: 'Ana Silva',
        slug: 'ana-silva',
        criado_em: new Date('2026-09-01T12:00:00Z'),
      },
      {
        id: USER_IDS[1],
        id_plataforma: ID_PLATAFORMA_EUNENEM,
        id_conta: ACCOUNT_IDS[1],
        email: 'admin-user-search-bruno@example.test',
        nome_exibicao: 'Bruno Costa',
        slug: 'bruno-costa',
        criado_em: new Date('2026-09-02T12:00:00Z'),
      },
      {
        id: USER_IDS[2],
        id_plataforma: OTHER_PLATFORM_ID,
        id_conta: ACCOUNT_IDS[2],
        email: 'admin-user-search-ana-other@example.test',
        nome_exibicao: 'Ana Other',
        slug: 'ana-other',
        criado_em: new Date('2026-09-03T12:00:00Z'),
      },
    ])
    .execute();

  await testDb.db
    .insertInto('campanhas')
    .values([
      {
        id: CAMPAIGN_IDS[0],
        id_plataforma: ID_PLATAFORMA_EUNENEM,
        titulo: 'Chá do bebê',
        slug: 'cha-bebe',
      },
      {
        id: CAMPAIGN_IDS[1],
        id_plataforma: ID_PLATAFORMA_EUNENEM,
        titulo: 'Quarto novo',
        slug: 'quarto-novo',
      },
      {
        id: CAMPAIGN_IDS[2],
        id_plataforma: OTHER_PLATFORM_ID,
        titulo: 'Chá externo',
        slug: 'cha-externo',
      },
    ])
    .execute();
  await testDb.db
    .insertInto('campanha_administradores')
    .values([
      { campanha_id: CAMPAIGN_IDS[0], id_usuario: ACCOUNT_IDS[0] },
      { campanha_id: CAMPAIGN_IDS[1], id_usuario: ACCOUNT_IDS[0] },
      { campanha_id: CAMPAIGN_IDS[2], id_usuario: ACCOUNT_IDS[2] },
    ])
    .execute();
});

afterAll(async () => {
  await testDb.db
    .deleteFrom('campanha_administradores')
    .where('campanha_id', 'in', [...CAMPAIGN_IDS])
    .execute();
  await testDb.db
    .deleteFrom('campanhas')
    .where('id', 'in', [...CAMPAIGN_IDS])
    .execute();
  await testDb.db
    .deleteFrom('usuarios')
    .where('id', 'in', [...USER_IDS])
    .execute();
  await testDb.teardown();
});

describe('admin user search — Postgres', () => {
  it('searches name, email and current campaign without N:N duplicates or cross-platform rows', async () => {
    const byName = await searchAdminUsers(testDb.db, {
      platformId: ID_PLATAFORMA_EUNENEM,
      query: 'Ana',
      publicOrigin: PUBLIC_ORIGIN,
      limit: 20,
    });
    expect(byName.map((row) => row.idConta)).toEqual([ACCOUNT_IDS[0]]);

    const byCampaign = await searchAdminUsers(testDb.db, {
      platformId: ID_PLATAFORMA_EUNENEM,
      query: 'novo',
      publicOrigin: PUBLIC_ORIGIN,
      limit: 20,
    });
    expect(byCampaign.map((row) => row.idConta)).toEqual([ACCOUNT_IDS[0]]);

    const byLink = await searchAdminUsers(testDb.db, {
      platformId: ID_PLATAFORMA_EUNENEM,
      query: `${PUBLIC_ORIGIN}/pagina/ana-silva/cha-bebe`,
      publicOrigin: PUBLIC_ORIGIN,
      limit: 20,
    });
    expect(byLink.map((row) => row.idConta)).toEqual([ACCOUNT_IDS[0]]);
  });

  it('rejects noncanonical URLs and treats SQL wildcard characters literally', async () => {
    await expect(
      searchAdminUsers(testDb.db, {
        platformId: ID_PLATAFORMA_EUNENEM,
        query: 'https://evil.example/pagina/ana-silva/cha-bebe',
        publicOrigin: PUBLIC_ORIGIN,
        limit: 20,
      }),
    ).rejects.toBeInstanceOf(InvalidAdminSearchFilterError);
    await expect(
      searchAdminUsers(testDb.db, {
        platformId: ID_PLATAFORMA_EUNENEM,
        query: `${PUBLIC_ORIGIN}/pagina/%61na-silva/cha-bebe`,
        publicOrigin: PUBLIC_ORIGIN,
        limit: 20,
      }),
    ).rejects.toBeInstanceOf(InvalidAdminSearchFilterError);

    const wildcard = await searchAdminUsers(testDb.db, {
      platformId: ID_PLATAFORMA_EUNENEM,
      query: '%_',
      publicOrigin: PUBLIC_ORIGIN,
      limit: 20,
    });
    expect(wildcard).toEqual([]);
  });

  it('applies campaign filters before deterministic pagination and exact count', async () => {
    const first = await listAdminUsers(testDb.db, {
      platformId: ID_PLATAFORMA_EUNENEM,
      cursor: null,
      limit: 1,
      sortBy: 'email',
      sortDir: 'asc',
      emailPrefix: 'admin-user-search-',
      campaignQuery: 'chá',
      publicOrigin: PUBLIC_ORIGIN,
      cursorSecret: CURSOR_SECRET,
    });
    expect(first.totalCount).toBe(1);
    expect(first.usuarios.map((row) => row.idConta)).toEqual([ACCOUNT_IDS[0]]);

    const all = await listAdminUsers(testDb.db, {
      platformId: ID_PLATAFORMA_EUNENEM,
      cursor: null,
      limit: 1,
      sortBy: 'email',
      sortDir: 'asc',
      emailPrefix: 'admin-user-search-',
      publicOrigin: PUBLIC_ORIGIN,
      cursorSecret: CURSOR_SECRET,
    });
    expect(all.totalCount).toBe(2);
    expect(all.nextCursor).not.toBeNull();
    await expect(
      listAdminUsers(testDb.db, {
        platformId: ID_PLATAFORMA_EUNENEM,
        cursor: all.nextCursor,
        limit: 1,
        sortBy: 'email',
        sortDir: 'asc',
        emailPrefix: 'admin-user-search-',
        campaignQuery: 'chá',
        publicOrigin: PUBLIC_ORIGIN,
        cursorSecret: CURSOR_SECRET,
      }),
    ).rejects.toBeInstanceOf(InvalidAdminUserCursorError);
  });
});
