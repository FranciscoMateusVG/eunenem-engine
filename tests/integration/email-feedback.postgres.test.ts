import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EmailFeedbackPostgres } from '../../src/adapters/email/email-feedback.postgres.js';
import { createTestObservability, type TestObservability } from '../helpers/observability.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';

let testDb: TestDatabase;
let feedback: EmailFeedbackPostgres;
let obs: TestObservability;

beforeAll(async () => {
  testDb = await createTestDatabase();
  feedback = new EmailFeedbackPostgres(testDb.db);
  obs = createTestObservability();
}, 180000);
afterAll(async () => {
  await obs?.shutdown();
  await testDb?.teardown();
});
beforeEach(() => obs.reset());

/** Seeds a lifecycle occurrence + delivery the way the backend dispatcher does. */
async function seedLifecycleDelivery(db: TestDatabase['db']) {
  const tenantId = randomUUID();
  const userId = randomUUID();
  const eventId = randomUUID();
  const deliveryId = randomUUID();
  await db
    .insertInto('lifecycle_email_events')
    .values({
      id: eventId,
      tenant_id: tenantId,
      type: 'payment_received',
      subject_id: randomUUID(),
      occurred_at: new Date(),
    })
    .execute();
  await db
    .insertInto('lifecycle_email_deliveries')
    .values({
      id: deliveryId,
      event_id: eventId,
      tenant_id: tenantId,
      user_id: userId,
      type: 'payment_received',
    })
    .execute();
  return { tenantId, userId, deliveryId };
}

describe('EmailFeedbackPostgres', () => {
  it('stores a rating + comment bound to the delivery, copying tenant/user/type from it', async () => {
    const d = await seedLifecycleDelivery(testDb.db);
    expect(await feedback.save({ deliveryId: d.deliveryId, nota: 4, comentario: 'amei ♡' })).toBe(
      'saved',
    );
    const row = await testDb.db
      .selectFrom('email_feedback')
      .selectAll()
      .where('delivery_id', '=', d.deliveryId)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      tenant_id: d.tenantId,
      user_id: d.userId,
      type: 'payment_received',
      nota: 4,
      comentario: 'amei ♡',
    });
    expect(await feedback.findByDeliveryId(d.deliveryId)).toEqual({
      nota: 4,
      comentario: 'amei ♡',
    });
  });

  it('answering again edits the single row (idempotent per delivery)', async () => {
    const d = await seedLifecycleDelivery(testDb.db);
    await feedback.save({ deliveryId: d.deliveryId, nota: 2, comentario: null });
    await feedback.save({ deliveryId: d.deliveryId, nota: 5, comentario: 'mudei de ideia' });
    const rows = await testDb.db
      .selectFrom('email_feedback')
      .select(['nota', 'comentario'])
      .where('delivery_id', '=', d.deliveryId)
      .execute();
    expect(rows).toEqual([{ nota: 5, comentario: 'mudei de ideia' }]);
  });

  it('accepts a comment without a rating, and the reverse', async () => {
    const a = await seedLifecycleDelivery(testDb.db);
    const b = await seedLifecycleDelivery(testDb.db);
    expect(
      await feedback.save({ deliveryId: a.deliveryId, nota: null, comentario: 'só um recado' }),
    ).toBe('saved');
    expect(await feedback.save({ deliveryId: b.deliveryId, nota: 1, comentario: null })).toBe(
      'saved',
    );
    expect(await feedback.findByDeliveryId(a.deliveryId)).toEqual({
      nota: null,
      comentario: 'só um recado',
    });
  });

  it('an unknown delivery writes nothing', async () => {
    const id = randomUUID();
    expect(await feedback.save({ deliveryId: id, nota: 3, comentario: null })).toBe(
      'delivery_not_found',
    );
    expect(await feedback.findByDeliveryId(id)).toBeNull();
  });

  it('the database rejects out-of-range ratings and empty answers', async () => {
    const d = await seedLifecycleDelivery(testDb.db);
    await expect(
      feedback.save({ deliveryId: d.deliveryId, nota: 6, comentario: null }),
    ).rejects.toThrow();
    await expect(
      feedback.save({ deliveryId: d.deliveryId, nota: null, comentario: null }),
    ).rejects.toThrow();
    await expect(
      feedback.save({ deliveryId: d.deliveryId, nota: 3, comentario: 'x'.repeat(1001) }),
    ).rejects.toThrow();
  });

  it('emits db spans without the comment text', async () => {
    const d = await seedLifecycleDelivery(testDb.db);
    await feedback.save({ deliveryId: d.deliveryId, nota: 5, comentario: 'segredo' });
    await feedback.findByDeliveryId(d.deliveryId);
    const spans = obs.getSpans();
    const save = spans.find((s) => s.name === 'db.email_feedback.save');
    expect(save?.attributes).toMatchObject({
      'db.system': 'postgresql',
      'db.operation.name': 'upsert',
      'db.collection.name': 'email_feedback',
    });
    expect(spans.find((s) => s.name === 'db.email_feedback.findByDeliveryId')).toBeDefined();
    expect(JSON.stringify(spans.map((s) => s.attributes))).not.toContain('segredo');
  });
});
