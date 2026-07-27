import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CatalogoAdminAuditPostgres } from '../../src/adapters/catalogo-admin-audit/catalogo-admin-audit.postgres.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await testDb.teardown();
});

describe('CatalogoAdminAuditPostgres migration + adapter', () => {
  it('persists one append-only event with database-owned id and timestamp', async () => {
    const audit = new CatalogoAdminAuditPostgres(testDb.db);

    await audit.append({
      requestId: '29bbfaac-4135-4618-8578-9c029e1a67da',
      actorUsuarioId: 'c985441f-5204-4609-9e0c-b8f27452b1a5',
      action: 'catalog.list.items.replace',
      phase: 'succeeded',
      targetType: 'list',
      targetId: '8ab38d30-1434-41bd-8df0-fad6ff941c09',
      metadata: { itemCount: 3, productIds: ['a', 'b', 'c'] },
    });

    const result = await sql<{
      id: string;
      request_id: string;
      actor_usuario_id: string;
      action: string;
      phase: string;
      target_type: string | null;
      target_id: string | null;
      metadata: unknown;
      occurred_at: Date;
    }>`
      SELECT id, request_id, actor_usuario_id, action, phase,
             target_type, target_id, metadata, occurred_at
      FROM catalogo_admin_audit_events
      WHERE request_id = '29bbfaac-4135-4618-8578-9c029e1a67da'
    `.execute(testDb.db);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      request_id: '29bbfaac-4135-4618-8578-9c029e1a67da',
      actor_usuario_id: 'c985441f-5204-4609-9e0c-b8f27452b1a5',
      action: 'catalog.list.items.replace',
      phase: 'succeeded',
      target_type: 'list',
      target_id: '8ab38d30-1434-41bd-8df0-fad6ff941c09',
      metadata: { itemCount: 3, productIds: ['a', 'b', 'c'] },
    });
    expect(result.rows[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.rows[0]?.occurred_at).toBeInstanceOf(Date);
  });

  it('rejects UPDATE, DELETE and TRUNCATE at the database boundary', async () => {
    const audit = new CatalogoAdminAuditPostgres(testDb.db);
    await audit.append({
      requestId: 'c8ded59e-7915-4dce-b6b5-2bfa2650159f',
      actorUsuarioId: 'c985441f-5204-4609-9e0c-b8f27452b1a5',
      action: 'catalog.category.create',
      phase: 'requested',
      targetType: 'category',
      targetId: null,
      metadata: {},
    });

    await expect(
      sql`UPDATE catalogo_admin_audit_events SET phase = 'failed'`.execute(testDb.db),
    ).rejects.toThrow(/append-only/);
    await expect(sql`DELETE FROM catalogo_admin_audit_events`.execute(testDb.db)).rejects.toThrow(
      /append-only/,
    );
    await expect(
      sql`TRUNCATE TABLE catalogo_admin_audit_events`.execute(testDb.db),
    ).rejects.toThrow(/append-only/);

    const count = await sql<{ count: string }>`
      SELECT count(*)::text AS count
      FROM catalogo_admin_audit_events
      WHERE request_id = 'c8ded59e-7915-4dce-b6b5-2bfa2650159f'
    `.execute(testDb.db);
    expect(count.rows[0]?.count).toBe('1');
  });

  it('enforces lifecycle phases and creates forensic lookup indexes', async () => {
    await expect(
      sql`
      INSERT INTO catalogo_admin_audit_events
        (id, request_id, actor_usuario_id, action, phase)
      VALUES
        ('0e08d0a4-5cea-4a57-899f-a860fc0e45d3',
         '29bbfaac-4135-4618-8578-9c029e1a67da',
         'c985441f-5204-4609-9e0c-b8f27452b1a5',
         'catalog.product.create',
         'unknown')
    `.execute(testDb.db),
    ).rejects.toThrow();

    const indexes = await sql<{ indexname: string }>`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND tablename = 'catalogo_admin_audit_events'
    `.execute(testDb.db);
    expect(indexes.rows.map(({ indexname }) => indexname)).toEqual(
      expect.arrayContaining([
        'catalogo_admin_audit_events_pkey',
        'catalogo_admin_audit_events_request_occurred_idx',
        'catalogo_admin_audit_events_actor_occurred_idx',
        'catalogo_admin_audit_events_target_occurred_idx',
        'catalogo_admin_audit_events_action_occurred_idx',
        'catalogo_admin_audit_events_occurred_at_idx',
      ]),
    );
  });
});
