import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { TrpcContext } from '../../apps/eunenem-server/server/trpc/context.js';
import { appRouter } from '../../apps/eunenem-server/server/trpc/router.js';
import { ID_PLATAFORMA_EUNENEM } from '../../src/index.js';
import { adminAuthOverrides } from '../helpers/admin-auth.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';

let t: TestDatabase;
const ids: string[] = [];
const now = new Date('2037-10-30T16:18:10Z');
beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  if (ids.length) await t.db.deleteFrom('usuarios').where('id', 'in', ids).execute();
  await t.teardown();
});
function caller(allowed = true) {
  const a = adminAuthOverrides();
  return appRouter.createCaller({
    headers: a.headers,
    resHeaders: new Headers(),
    deps: {
      ...a.depsOverrides,
      db: t.db,
      clock: () => now,
      ...(allowed ? {} : { adminAllowedEmails: new Set() }),
    },
  } as unknown as TrpcContext);
}
async function user(
  date: string,
  email?: string,
  inactive = false,
  platformId = ID_PLATAFORMA_EUNENEM,
  name = 'Cliente',
) {
  const id = randomUUID();
  ids.push(id);
  await t.db
    .insertInto('usuarios')
    .values({
      id,
      id_conta: randomUUID(),
      id_plataforma: platformId,
      email: email ?? `${id}@customer.invalid`,
      nome_exibicao: name,
      slug: id.slice(0, 30),
      criado_em: new Date(date),
      desativado_em: inactive ? now : null,
    })
    .execute();
}
it('estatísticas restringem admin e excluem QA/desativados, calendário SP e semanas zero', async () => {
  await expect(caller(false).admin.estatisticas()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  const before = await caller().admin.estatisticas();
  await user('2037-10-01T02:59:59Z'); // setembro SP
  await user('2037-10-01T03:00:00Z');
  await user('2037-10-05T02:59:59Z'); // domingo
  await user('2037-10-05T03:00:00Z'); // segunda
  await user('2037-10-10T12:00:00Z', 'franciscomateusvg+fixture@gmail.com');
  await user('2037-10-10T12:00:00Z', 'aperture-fixture@customer.invalid');
  await user('2037-10-10T12:00:00Z', undefined, true);
  await user('2037-11-01T12:00:00Z'); // futuro
  await user('2037-10-10T12:00:00Z', 'franciscomateusvg@gmail.com');
  await user('2037-10-10T12:00:00Z', 'nobody@example.com');
  await user('2037-10-10T12:00:00Z', 'nobody@qa.local');
  await user('2037-10-10T12:00:00Z', 'nobody@qa.test');
  await user('2037-10-10T12:00:00Z', undefined, false, ID_PLATAFORMA_EUNENEM, 'Fixture interna');
  // Do not infer QA from an admin-like email/name outside explicit rules.
  await user('2037-08-10T12:00:00Z', 'admin@customer.invalid');
  const other = randomUUID();
  await user('2037-10-10T12:00:00Z', undefined, false, other);

  const p = await caller().admin.estatisticas();
  expect(p.total - before.total).toBe(5);
  expect(p.excluidos - before.excluidos).toBe(7);
  expect(p.meses.find((x) => x.de === '2037-09-01')?.novos).toBe(1);
  expect(p.meses.find((x) => x.de === '2037-10-01')?.novos).toBe(3);
  expect(p.semanas.find((x) => x.de === '2037-09-28')).toMatchObject({
    novos: 3,
    variacaoPct: null,
    media4Semanas: 0.75,
  });
  expect(p.semanas.find((x) => x.de === '2037-10-05')).toMatchObject({
    novos: 1,
    variacaoPct: -66.67,
    media4Semanas: 1,
  });
  expect(p.semanas.at(-1)).toMatchObject({ parcial: true, novos: 0 });
  expect(p.meses).toHaveLength(12);
  expect(p.semanas).toHaveLength(12);
});
