/**
 * Executable oracle for `docs/analytics/relatorios-diarios.sql`
 * (aperture-ai8vg). The pack is loaded VERBATIM from the repo file and run
 * against the shared test Postgres (tests/helpers/test-db — the existing
 * container; no prod query, no new harness). Everything happens on ONE
 * pinned connection inside a transaction that is rolled back, so the
 * TRUNCATE + seed never leak into other files.
 *
 * What it pins (Izzy gate on PR #113):
 *   §3  origem is 'desconhecida' for EVERY row; day cut is America/Sao_Paulo.
 *   §4b first item = MIN(criada_em) per campanha, then campanhas per day
 *       (a campanha with two items counts once).
 *   §7  cohort base = ALL `users` (LEFT JOIN: a bounce with no `usuarios`
 *       row stays in cadastros, provisionados excludes it); every step is
 *       bounded by [cadastro_em, cadastro_em + W] (lower AND upper);
 *       one account counts once per step (multi-campanha / multi-item);
 *       maturity uses the last cadastro TIMESTAMP + W vs now(): complete
 *       and censored are separate, mutually exclusive columns.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ID_PLATAFORMA_EUNENEM } from '../../src/adapters/plataforma/repository.memory.js';
import { createTestDatabase, type TestDatabase } from '../helpers/test-db.js';

const SQL_PATH = new URL('../../docs/analytics/relatorios-diarios.sql', import.meta.url);

/** Strip full-line comments, split on `;`, keep the statements in file order. */
function carregarConsultas(texto: string): string[] {
  return texto
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// W = 30 days, as declared in the SQL pack (§7 `w AS (SELECT 30 AS dias)`).
const DIA_MS = 86_400_000;
const AGORA = new Date();
/** `d(40)` = 40 days before the run; `h` shifts by hours. */
const d = (dias: number, h = 0) => new Date(AGORA.getTime() - dias * DIA_MS + h * 3_600_000);

/** Calendar day in America/Sao_Paulo as YYYY-MM-DD. */
function diaSp(t: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(t);
}
/** pg parses `date` into a local-midnight Date; normalise either shape. */
function diaCol(v: unknown): string {
  if (v instanceof Date) {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  return String(v).slice(0, 10);
}
const n = (v: unknown) => Number(v);

// Cohort D40: U1 full journey, U2 bounce (no usuarios row), U3 provisioned but
// every fact outside the window (one before cadastro, one after cadastro+W).
const U1 = randomUUID();
const C1 = randomUUID();
const U2 = randomUUID();
const U3 = randomUUID();
const C3 = randomUUID();
// Cohort D30+2h: censored by the TIMESTAMP rule although dia+W may already be
// "today" — the boundary Izzy asked for.
const U4 = randomUUID();
const C4 = randomUUID();
// Cohort D10: censored, no facts.
const U5 = randomUUID();
const C5 = randomUUID();

const K1 = randomUUID(); // U1's list (two items → once per account)
const K3 = randomUUID(); // item after U3's window (cadastro + 31d)
const K3B = randomUUID(); // item before U3's cadastro
const K4 = randomUUID();
const K5 = randomUUID(); // no admin; TZ-cut fixture for §3 + two items same day for §4b
const K5_CRIADA_UTC = new Date('2026-06-10T02:30:00.000Z'); // = 2026-06-09 in SP

const CAD_D40 = d(40);
const CAD_D30 = d(30, 2);
const CAD_D10 = d(10);

type Linha = Record<string, unknown>;
const resultados: Linha[][] = [];
let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
  const consultas = carregarConsultas(readFileSync(SQL_PATH, 'utf8'));
  expect(consultas).toHaveLength(9); // §1 §2 §3 §4 §4b §4c §5 §6 §7

  await testDb.db.connection().execute(async (conn) => {
    await sql`BEGIN`.execute(conn);
    try {
      await sql`TRUNCATE users, usuarios, campanhas, campanha_administradores,
        opcoes_contribuicao, contribuicoes, perfil_campanhas, eventos, convites,
        pagamentos, sessions, convidados CASCADE`.execute(conn);

      const P = ID_PLATAFORMA_EUNENEM;
      const user = (id: string, at: Date) => ({
        id,
        id_plataforma: P,
        email: `${id}@oracle.test`,
        name: 'Oracle',
        created_at: at,
        updated_at: at,
      });
      await conn
        .insertInto('users')
        .values([
          user(U1, CAD_D40),
          user(U2, CAD_D40),
          user(U3, CAD_D40),
          user(U4, CAD_D30),
          user(U5, CAD_D10),
        ])
        .execute();

      const usuario = (id: string, conta: string, onboarding: Date | null) => ({
        id,
        id_plataforma: P,
        id_conta: conta,
        email: `${id}@oracle.test`,
        nome_exibicao: 'Oracle',
        slug: `oracle-${id.slice(0, 8)}`,
        onboarding_concluido_em: onboarding,
      });
      await conn
        .insertInto('usuarios')
        .values([
          usuario(U1, C1, d(39)),
          usuario(U3, C3, null),
          usuario(U4, C4, null),
          usuario(U5, C5, null),
        ])
        .execute();

      const campanha = (id: string, at: Date) => ({
        id,
        id_plataforma: P,
        titulo: 'Oracle',
        slug: `oracle-${id.slice(0, 8)}`,
        criada_em: at,
      });
      await conn
        .insertInto('campanhas')
        .values([
          campanha(K1, d(39)),
          campanha(K3, d(39)),
          campanha(K3B, d(42)),
          campanha(K4, d(29)),
          campanha(K5, K5_CRIADA_UTC),
        ])
        .execute();
      await conn
        .insertInto('campanha_administradores')
        .values([
          { campanha_id: K1, id_usuario: C1 },
          { campanha_id: K3, id_usuario: C3 },
          { campanha_id: K3, id_usuario: C1 }, // multi-admin: C1 also on K3
          { campanha_id: K3B, id_usuario: C3 },
          { campanha_id: K4, id_usuario: C4 },
        ])
        .execute();

      const opcoes = [K1, K3, K3B, K4, K5].map((k) => ({
        id: randomUUID(),
        campanha_id: k,
        tipo: 'presente',
      }));
      await conn.insertInto('opcoes_contribuicao').values(opcoes).execute();
      const opcao = (k: string) => opcoes.find((o) => o.campanha_id === k)?.id ?? '';
      const item = (k: string, at: Date) => ({
        id: randomUUID(),
        campanha_id: k,
        id_opcao_contribuicao: opcao(k),
        nome: 'Item',
        valor: 100,
        quantidade: 1,
        criada_em: at,
      });
      await conn
        .insertInto('contribuicoes')
        .values([
          item(K1, d(38)),
          item(K1, d(37)), // second item: K1 counts once in §4b, U1 once in §7
          item(K3, d(9)), // U3: cadastro + 31d → outside the upper bound
          item(K3B, d(41)), // U3: before cadastro → outside the lower bound
          item(K4, d(29)),
          item(K5, d(38)),
          item(K5, d(38, 1)),
        ])
        .execute();

      await conn
        .insertInto('perfil_campanhas')
        .values({
          id: randomUUID(),
          id_campanha: K1,
          nome_bebe: 'Oracle',
          criado_em: d(36),
          atualizado_em: d(36),
        })
        .execute();

      const E1 = randomUUID();
      await conn
        .insertInto('eventos')
        .values({ id: E1, id_campanha: K1, criado_em: d(35), atualizado_em: d(35) })
        .execute();
      await conn
        .insertInto('convites')
        .values({
          id: randomUUID(),
          id_evento: E1,
          fonte: 'patrick',
          mensagem: 'Oracle',
          modelo: 'scrapbook',
          nome_exibido: 'Oracle',
          paleta: 'lilas',
          remetente: 'Oracle',
          criado_em: d(35),
          atualizado_em: d(35),
        })
        .execute();

      const pag = d(34);
      await sql`
        INSERT INTO pagamentos (
          id, status, criado_em, atualizado_em, intencao_id, intencao_id_campanha,
          intencao_metodo, intencao_criada_em, intencao_total_contribution_cents,
          intencao_total_fee_cents, intencao_total_receiver_cents,
          intencao_total_surcharge_cents, intencao_total_paid_cents
        ) VALUES (
          ${randomUUID()}::uuid, 'aprovado', ${pag}, ${pag}, ${randomUUID()}::uuid, ${K1}::uuid,
          'pix', ${pag}, 1800, 100, 1700, 100, 2000
        )`.execute(conn);

      await conn
        .insertInto('sessions')
        .values({
          id: randomUUID(),
          user_id: U1,
          token: randomUUID(),
          expires_at: d(-1),
          created_at: d(38),
          updated_at: d(38),
        })
        .execute();

      for (const consulta of consultas) {
        const r = await sql.raw<Linha>(consulta).execute(conn);
        resultados.push(r.rows);
      }
    } finally {
      await sql`ROLLBACK`.execute(conn);
    }
  });
}, 90_000);

afterAll(async () => {
  await testDb.teardown();
});

const secao = (i: number) => resultados[i] ?? [];
const porDia = (linhas: Linha[], dia: string, col = 'dia') =>
  linhas.find((l) => diaCol(l[col]) === dia);

describe('relatorios-diarios.sql oracle (aperture-ai8vg)', () => {
  it('§1 cadastros/dia counts every users row (bounce included), cut in SP', () => {
    const s1 = secao(0);
    expect(n(porDia(s1, diaSp(CAD_D40))?.cadastros)).toBe(3);
    expect(n(porDia(s1, diaSp(CAD_D30))?.cadastros)).toBe(1);
    expect(n(porDia(s1, diaSp(CAD_D10))?.cadastros)).toBe(1);
    expect(s1.reduce((acc, l) => acc + n(l.cadastros), 0)).toBe(5);
  });

  it('§2 sessions are reported as present rows only', () => {
    const s2 = secao(1);
    expect(s2.reduce((acc, l) => acc + n(l.sessoes_presentes), 0)).toBe(1);
    expect(s2.reduce((acc, l) => acc + n(l.usuarios_com_sessao_presente), 0)).toBe(1);
  });

  it('§3 listas/dia: every row origem=desconhecida; UTC 02:30 lands on the previous SP day', () => {
    const s3 = secao(2);
    expect(s3.length).toBeGreaterThan(0);
    for (const l of s3) expect(l.origem).toBe('desconhecida');
    expect(s3.reduce((acc, l) => acc + n(l.listas), 0)).toBe(5);
    expect(n(porDia(s3, '2026-06-09')?.listas)).toBe(1);
    expect(porDia(s3, '2026-06-10')).toBeUndefined();
  });

  it('§4 three separate indicators, never summed', () => {
    const [l] = secao(3);
    expect(n(l?.listas_criadas)).toBe(5);
    expect(n(l?.listas_com_item)).toBe(5);
    expect(n(l?.listas_com_nome)).toBe(1);
  });

  it('§4b first item = MIN(criada_em) per campanha, then campanhas per day (two items → once)', () => {
    const s4b = secao(4);
    expect(n(porDia(s4b, diaSp(d(38)))?.listas_com_primeiro_item)).toBe(2); // K1 + K5
    expect(porDia(s4b, diaSp(d(37)))).toBeUndefined(); // K1's second item is not a first item
    expect(s4b.reduce((acc, l) => acc + n(l.listas_com_primeiro_item), 0)).toBe(5);
  });

  it('§4c/§5 personalização and convites by creation day', () => {
    expect(n(porDia(secao(5), diaSp(d(36)))?.listas_personalizadas)).toBe(1);
    expect(n(porDia(secao(6), diaSp(d(35)))?.convites_criados)).toBe(1);
  });

  it('§6 convidados state query runs (no timestamps exist → state only)', () => {
    const [l] = secao(7);
    expect(n(l?.convidados)).toBe(0);
    expect(n(l?.rsvp_respondidos)).toBe(0);
  });

  it('§7 cohort: LEFT JOIN keeps the bounce, steps are two-sided windows, one account per step', () => {
    const c = porDia(secao(8), diaSp(CAD_D40), 'dia_cadastro');
    expect(c).toBeDefined();
    expect(c?.coorte_completa).toBe(true);
    expect(c?.coorte_censurada).toBe(false);
    expect(n(c?.cadastros)).toBe(3); // U1 + U2 (bounce) + U3
    expect(n(c?.provisionados)).toBe(2); // bounce excluded here only
    expect(n(c?.onboarding)).toBe(1);
    // U1: two items in K1 + admin of K3 → once. U3: K3B item before cadastro
    // (lower bound) and K3 item at cadastro+31d (upper bound) → zero.
    expect(n(c?.lista_com_item)).toBe(1);
    expect(n(c?.personalizacao)).toBe(1);
    expect(n(c?.convite_criado)).toBe(1);
    expect(n(c?.pagamento_aprovado)).toBe(1);
  });

  it('§7 maturity: last cadastro TIMESTAMP + W vs now() — complete and censored are exclusive', () => {
    const s7 = secao(8);
    const c30 = porDia(s7, diaSp(CAD_D30), 'dia_cadastro');
    // cadastro_em + 30d = now + 2h → still censored even when dia + W is today.
    expect(c30?.coorte_completa).toBe(false);
    expect(c30?.coorte_censurada).toBe(true);
    expect(n(c30?.cadastros)).toBe(1);
    expect(n(c30?.lista_com_item)).toBe(1);
    const c10 = porDia(s7, diaSp(CAD_D10), 'dia_cadastro');
    expect(c10?.coorte_censurada).toBe(true);
    expect(n(c10?.lista_com_item)).toBe(0);
    for (const l of s7) expect(l.coorte_completa).not.toBe(l.coorte_censurada);
    expect(s7.reduce((acc, l) => acc + n(l.cadastros), 0)).toBe(5);
  });
});
