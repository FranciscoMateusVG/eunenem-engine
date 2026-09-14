import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LegacyUserEntry } from '../../apps/eunenem-server/lib/legacy-users.js';
import {
  InvalidAdminLegacyUserCursorError,
  InvalidAdminLegacyUserQueryError,
  listAdminLegacyUsers,
} from '../../apps/eunenem-server/server/admin-legacy-users.js';
import { ID_PLATAFORMA_EUNENEM } from '../../src/index.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';

const CURSOR_SECRET = 'admin-legacy-users-cursor-test-secret';
const OTHER_PLATFORM_ID = '4a000000-0000-4000-8000-000000000099';
const IDS = {
  authOnly: '4a000000-0000-4000-8000-000000000001',
  profile: '4a000000-0000-4000-8000-000000000002',
  duplicateA: '4a000000-0000-4000-8000-000000000003',
  duplicateB: '4a000000-0000-4000-8000-000000000004',
  partial: '4a000000-0000-4000-8000-000000000005',
  otherTenant: '4a000000-0000-4000-8000-000000000006',
  profileAccount: '4b000000-0000-4000-8000-000000000002',
  otherTenantAccount: '4b000000-0000-4000-8000-000000000006',
} as const;

const legacyEntries: readonly LegacyUserEntry[] = [
  {
    email: ' Alpha@example.test ',
    utm: 'alpha-a',
    nome: 'Campaign title, not a person',
    mimos: 1,
  },
  {
    email: 'alpha@example.test',
    utm: 'alpha-b',
    nome: 'Another campaign title',
    mimos: 2,
  },
  { email: 'beta@example.test', utm: null, nome: null, mimos: null },
  { email: 'delta@example.test', utm: null, nome: null, mimos: null },
  { email: 'epsilon@example.test', utm: null, nome: null, mimos: null },
  { email: 'gamma@example.test', utm: null, nome: null, mimos: null },
];

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
}, 60_000);

beforeEach(async () => {
  const userIds = [
    IDS.authOnly,
    IDS.profile,
    IDS.duplicateA,
    IDS.duplicateB,
    IDS.partial,
    IDS.otherTenant,
  ];
  await testDb.db.deleteFrom('contas').where('id_usuario', 'in', userIds).execute();
  await testDb.db.deleteFrom('usuarios').where('id', 'in', userIds).execute();
  await testDb.db.deleteFrom('users').where('id', 'in', userIds).execute();

  await testDb.db
    .insertInto('users')
    .values([
      {
        id: IDS.authOnly,
        id_plataforma: ID_PLATAFORMA_EUNENEM,
        email: 'beta@example.test',
        name: 'Ignored BetterAuth Name',
        email_verified: true,
        created_at: new Date('2026-09-01T10:00:00Z'),
      },
      {
        id: IDS.profile,
        id_plataforma: ID_PLATAFORMA_EUNENEM,
        email: 'GAMMA@example.test',
        name: 'Ignored BetterAuth Profile Name',
        email_verified: true,
        created_at: new Date('2026-09-02T10:00:00Z'),
      },
      {
        id: IDS.duplicateA,
        id_plataforma: ID_PLATAFORMA_EUNENEM,
        email: 'delta@example.test',
        name: 'Duplicate A',
        email_verified: true,
      },
      {
        id: IDS.duplicateB,
        id_plataforma: ID_PLATAFORMA_EUNENEM,
        email: 'DELTA@example.test',
        name: 'Duplicate B',
        email_verified: true,
      },
      {
        id: IDS.otherTenant,
        id_plataforma: OTHER_PLATFORM_ID,
        email: 'ALPHA@example.test',
        name: 'Other tenant',
        email_verified: true,
      },
    ])
    .execute();

  await testDb.db
    .insertInto('usuarios')
    .values([
      {
        id: IDS.profile,
        id_plataforma: ID_PLATAFORMA_EUNENEM,
        id_conta: IDS.profileAccount,
        email: 'gamma@example.test',
        nome_exibicao: 'Gamma Person',
        slug: 'gamma-legacy-test',
      },
      {
        id: IDS.partial,
        id_plataforma: ID_PLATAFORMA_EUNENEM,
        id_conta: '4b000000-0000-4000-8000-000000000005',
        email: 'epsilon@example.test',
        nome_exibicao: 'Partial Person',
        slug: 'partial-legacy-test',
      },
      {
        id: IDS.otherTenant,
        id_plataforma: OTHER_PLATFORM_ID,
        id_conta: IDS.otherTenantAccount,
        email: 'ALPHA@example.test',
        nome_exibicao: 'Other Tenant Person',
        slug: 'other-tenant-legacy-test',
      },
    ])
    .execute();

  await testDb.db
    .insertInto('contas')
    .values([
      {
        id: IDS.profileAccount,
        id_usuario: IDS.profile,
        permissoes: [],
        criada_em: new Date('2026-09-03T10:00:00Z'),
      },
      {
        id: IDS.otherTenantAccount,
        id_usuario: IDS.otherTenant,
        permissoes: [],
      },
    ])
    .execute();
});

afterAll(async () => {
  await testDb.teardown();
});

describe('admin legacy-user evidence query', () => {
  it('groups normalized legacy membership and classifies only coherent tenant evidence', async () => {
    const page = await listAdminLegacyUsers(testDb.db, {
      platformId: ID_PLATAFORMA_EUNENEM,
      entries: legacyEntries,
      cursor: null,
      limit: 100,
      cursorSecret: CURSOR_SECRET,
    });

    expect(page.totalCount).toBe(5);
    expect(page.counts).toEqual({
      somente_legado: 1,
      conta_2_0: 1,
      perfil_2_0: 1,
      evidencia_inconsistente: 2,
    });
    expect(page.items.map(({ email, status }) => ({ email, status }))).toEqual([
      { email: 'alpha@example.test', status: 'somente_legado' },
      { email: 'beta@example.test', status: 'conta_2_0' },
      { email: 'delta@example.test', status: 'evidencia_inconsistente' },
      { email: 'epsilon@example.test', status: 'evidencia_inconsistente' },
      { email: 'gamma@example.test', status: 'perfil_2_0' },
    ]);

    expect(page.items[0]).toEqual({
      email: 'alpha@example.test',
      nomeExibicao: null,
      idConta: null,
      legacyCampaignCount: 2,
      status: 'somente_legado',
      evidencedAt: null,
    });
    expect(page.items[1]).toMatchObject({
      nomeExibicao: null,
      idConta: null,
      status: 'conta_2_0',
      evidencedAt: '2026-09-01T10:00:00.000Z',
    });
    expect(page.items[2]).toMatchObject({
      nomeExibicao: null,
      idConta: null,
      evidencedAt: null,
    });
    expect(page.items[4]).toEqual({
      email: 'gamma@example.test',
      nomeExibicao: 'Gamma Person',
      idConta: IDS.profileAccount,
      legacyCampaignCount: 1,
      status: 'perfil_2_0',
      evidencedAt: '2026-09-03T10:00:00.000Z',
    });
  });

  it('binds cursor to the normalized filter and computes counts before paging', async () => {
    const first = await listAdminLegacyUsers(testDb.db, {
      platformId: ID_PLATAFORMA_EUNENEM,
      entries: legacyEntries,
      cursor: null,
      limit: 2,
      cursorSecret: CURSOR_SECRET,
    });
    expect(first.items.map((item) => item.email)).toEqual([
      'alpha@example.test',
      'beta@example.test',
    ]);
    expect(first.totalCount).toBe(5);
    expect(first.counts.evidencia_inconsistente).toBe(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await listAdminLegacyUsers(testDb.db, {
      platformId: ID_PLATAFORMA_EUNENEM,
      entries: legacyEntries,
      cursor: first.nextCursor,
      limit: 2,
      cursorSecret: CURSOR_SECRET,
    });
    expect(second.items.map((item) => item.email)).toEqual([
      'delta@example.test',
      'epsilon@example.test',
    ]);

    await expect(
      listAdminLegacyUsers(testDb.db, {
        platformId: ID_PLATAFORMA_EUNENEM,
        entries: legacyEntries,
        query: 'gamma',
        cursor: first.nextCursor,
        limit: 2,
        cursorSecret: CURSOR_SECRET,
      }),
    ).rejects.toBeInstanceOf(InvalidAdminLegacyUserCursorError);

    const opaqueEntries: readonly LegacyUserEntry[] = [
      {
        email: 'pii-filter-canary-one@example.test',
        utm: null,
        nome: null,
        mimos: null,
      },
      {
        email: 'pii-filter-canary-two@example.test',
        utm: null,
        nome: null,
        mimos: null,
      },
    ];
    const opaqueCursorPage = await listAdminLegacyUsers(testDb.db, {
      platformId: ID_PLATAFORMA_EUNENEM,
      entries: opaqueEntries,
      query: 'pii-filter-canary',
      cursor: null,
      limit: 1,
      cursorSecret: CURSOR_SECRET,
    });
    expect(opaqueCursorPage.nextCursor).not.toBeNull();
    if (opaqueCursorPage.nextCursor === null) throw new Error('expected opaque cursor');
    const decodedCursor = Buffer.from(opaqueCursorPage.nextCursor, 'base64url').toString('utf8');
    expect(decodedCursor).not.toContain('pii-filter-canary');
    expect(decodedCursor).not.toContain('pii-filter-canary-one@example.test');
    expect(Object.keys(JSON.parse(decodedCursor))).toEqual([
      'version',
      'queryBinding',
      'positionBinding',
      'authentication',
    ]);

    const tamperedPayload = JSON.parse(decodedCursor) as { positionBinding: string };
    tamperedPayload.positionBinding = `${tamperedPayload.positionBinding.slice(0, -1)}${
      tamperedPayload.positionBinding.endsWith('A') ? 'B' : 'A'
    }`;
    await expect(
      listAdminLegacyUsers(testDb.db, {
        platformId: ID_PLATAFORMA_EUNENEM,
        entries: opaqueEntries,
        query: 'pii-filter-canary',
        cursor: Buffer.from(JSON.stringify(tamperedPayload), 'utf8').toString('base64url'),
        limit: 2,
        cursorSecret: CURSOR_SECRET,
      }),
    ).rejects.toBeInstanceOf(InvalidAdminLegacyUserCursorError);

    await expect(
      listAdminLegacyUsers(testDb.db, {
        platformId: ID_PLATAFORMA_EUNENEM,
        entries: legacyEntries,
        cursor: 'not-a-valid-cursor',
        limit: 2,
        cursorSecret: CURSOR_SECRET,
      }),
    ).rejects.toBeInstanceOf(InvalidAdminLegacyUserCursorError);

    const byPersonName = await listAdminLegacyUsers(testDb.db, {
      platformId: ID_PLATAFORMA_EUNENEM,
      entries: legacyEntries,
      query: '  GAMMA P  ',
      cursor: null,
      limit: 25,
      cursorSecret: CURSOR_SECRET,
    });
    expect(byPersonName.items).toHaveLength(1);
    expect(byPersonName.items[0]?.status).toBe('perfil_2_0');
    expect(byPersonName.counts).toEqual({
      somente_legado: 0,
      conta_2_0: 0,
      perfil_2_0: 1,
      evidencia_inconsistente: 0,
    });

    const inconsistentByDomainName = await listAdminLegacyUsers(testDb.db, {
      platformId: ID_PLATAFORMA_EUNENEM,
      entries: legacyEntries,
      query: 'partial p',
      cursor: null,
      limit: 25,
      cursorSecret: CURSOR_SECRET,
    });
    expect(inconsistentByDomainName.items).toEqual([
      expect.objectContaining({
        email: 'epsilon@example.test',
        status: 'evidencia_inconsistente',
        nomeExibicao: null,
      }),
    ]);

    await expect(
      listAdminLegacyUsers(testDb.db, {
        platformId: ID_PLATAFORMA_EUNENEM,
        entries: legacyEntries,
        query: 'bad\u0000query',
        cursor: null,
        limit: 25,
        cursorSecret: CURSOR_SECRET,
      }),
    ).rejects.toBeInstanceOf(InvalidAdminLegacyUserQueryError);
  });
});
