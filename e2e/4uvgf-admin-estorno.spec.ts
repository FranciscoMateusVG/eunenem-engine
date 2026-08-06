/**
 * aperture-4uvgf — admin refund surface (EstornoBlock) E2E.
 *
 * The /admin/pagamento/:id detail page renders PagamentoCard, which now
 * carries EstornoBlock (apps/eunenem-server/pages/components/eunenem/admin/
 * EstornoBlock.tsx): a red "estornar pagamento" trigger opening a confirm
 * modal whose confirm button is GATED by an irreversibility-acknowledgment
 * checkbox. The mutation (`admin.pagamentos.estornar`) is a thin
 * adminProcedure wrapper over the estornarPagamento use-case — the 409
 * lançamento gate, status guard and provenance routing all live there.
 *
 * Three walks (Stripe provenance — :3002's empty STRIPE_* env binds the fake
 * payment adapter, whose refundarPagamento defaults to 'aceito'):
 *   1. HAPPY — aprovado pagamento (no transferred lançamentos) → CTA →
 *      ack-gated confirm → result strip 'pagamento estornado' → DB status
 *      settles 'estornado'.
 *   2. 409 GATE — aprovado pagamento WITH a transferido lançamento → confirm
 *      → inline role=alert 'estorno bloqueado…' and DB status STAYS aprovado.
 *   3. RBAC — raw POST to the mutation as non-admin + logged-out → [401,403],
 *      no side effect (mirrors r5y94 walk 5).
 *
 * Inter-provenance walk deliberately SKIPPED: unit tests cover the Inter
 * rail, and no seed helper exists for an aprovado Inter pagamento (would
 * need hand-built transacao_externa JSON + e2e ref binding + the :3004
 * fake PIX server).
 *
 * State assertions are AUTHORITATIVE against the DB (pagamentos.status);
 * the UI is exercised for every CTA + the operator-facing copy. DB access
 * opens its own connection (destroyed in finally).
 */

import { randomUUID } from 'node:crypto';
import { request as pwRequest } from '@playwright/test';
import { sql } from 'kysely';
import { createDatabase, type Database } from '../src/adapters/database.js';
import { expect, test } from './fixtures.js';
import { buildSeedGiftRepos, seedMultiItemApprovedPagamento } from './seed-helpers.js';

const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://frame:frame@localhost:54320/frame';

const BLOCKED_COPY =
  'estorno bloqueado: o repasse deste pagamento já foi transferido ao recebedor.';

/**
 * Seed ONE aprovado pagamento (single contribuição item) via the proven
 * multi-item helper. transacaoExterna stays null → the use-case routes it
 * down the Stripe/historic rail (provedor 'stripe' is the default).
 */
async function seedAprovadoPagamento(
  db: Database,
  seed: { idCampanha: string; idOpcaoPresentes: string },
): Promise<string> {
  const repos = buildSeedGiftRepos(db);
  const { pagamentoId } = await seedMultiItemApprovedPagamento(repos, {
    idCampanha: seed.idCampanha,
    idOpcaoPresentes: seed.idOpcaoPresentes,
    items: [{ nome: `Estorno Alvo ${randomUUID().slice(0, 8)}`, valorCents: 5000 }],
  });
  return pagamentoId;
}

/** Read the pagamento's status straight from the DB (authoritative). */
async function getPagamentoStatus(db: Database, idPagamento: string): Promise<string | undefined> {
  const result = await sql<{ status: string }>`
    SELECT status FROM pagamentos WHERE id = ${idPagamento}
  `.execute(db);
  return result.rows[0]?.status;
}

/**
 * Arm the 409 gate: insert one `credito_saldo_recebedor` lançamento for the
 * pagamento with `transferido_em` STAMPED — exactly what
 * `hasLancamentosTransferidos` (livro-repository.postgres.ts) probes for
 * (`id_pagamento = X AND transferido_em IS NOT NULL`). The only FK on
 * lancamentos_financeiros is id_item_pagamento → intencao_items(id), so the
 * row hangs off the pagamento's real seeded item.
 */
async function armTransferidoLancamento(
  db: Database,
  args: { idPagamento: string; idCampanha: string },
): Promise<void> {
  const item = await sql<{ id: string; id_contribuicao: string | null }>`
    SELECT id, id_contribuicao FROM intencao_items
      WHERE id_pagamento = ${args.idPagamento}
      LIMIT 1
  `.execute(db);
  const row = item.rows[0];
  if (!row) throw new Error(`no intencao_items row for pagamento ${args.idPagamento}`);

  await sql`
    INSERT INTO lancamentos_financeiros
      (id, id_pagamento, id_item_pagamento, id_contribuicao, id_campanha,
       tipo, amount_cents, criado_em, transferido_em)
    VALUES
      (${randomUUID()}, ${args.idPagamento}, ${row.id},
       ${row.id_contribuicao ?? randomUUID()}, ${args.idCampanha},
       'credito_saldo_recebedor', 100, NOW(), NOW())
  `.execute(db);
}

/**
 * Walk the shared UI path up to an ARMED confirm button: detail page →
 * estorno block → "estornar pagamento" → confirm dialog → verify the
 * ack-checkbox gate (confirm disabled until checked) → check it.
 */
async function walkToArmedConfirm(page: import('@playwright/test').Page, idPagamento: string) {
  await page.goto(`/admin/pagamento/${idPagamento}`);

  const block = page.getByTestId('estorno-block');
  await expect(block).toBeVisible();

  await block.getByRole('button', { name: 'estornar pagamento' }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirmar estorno de pagamento' });
  await expect(dialog).toBeVisible();

  // The irreversibility acknowledgment GATES the confirm — proof an
  // accidental click can't move money.
  const confirm = dialog.getByRole('button', { name: 'confirmar estorno' });
  await expect(confirm).toBeDisabled();
  await dialog.getByRole('checkbox').check();
  await expect(confirm).toBeEnabled();

  return { dialog, confirm };
}

test.describe('aperture-4uvgf — admin estorno (refund) walks', () => {
  test('walk 1 — Stripe provenance: ack-gated confirm → estornado result strip + DB status estornado', async ({
    adminAuthenticatedPage: page,
    seededData,
  }) => {
    const db = createDatabase(DATABASE_URL);
    try {
      const idPagamento = await seedAprovadoPagamento(db, seededData);

      const { dialog, confirm } = await walkToArmedConfirm(page, idPagamento);
      await confirm.click();

      // onSuccess closes the modal and the result strip shows the ACTUAL
      // refund outcome ('aceito' on the fake Stripe rail → settled copy).
      await expect(dialog).toBeHidden();
      const result = page.getByTestId('estorno-result');
      await expect(result).toBeVisible();
      await expect(result).toHaveText(/pagamento estornado/i);

      // DB is authoritative: the use-case persisted the transition.
      await expect
        .poll(async () => getPagamentoStatus(db, idPagamento), {
          message: `pagamento ${idPagamento} should reach estornado`,
          timeout: 20_000,
          intervals: [200, 300, 500, 1000],
        })
        .toBe('estornado');
    } finally {
      await db.destroy();
    }
  });

  test('walk 2 — 409 gate: transferred lançamento blocks the estorno with the inline alert; DB stays aprovado', async ({
    adminAuthenticatedPage: page,
    seededData,
  }) => {
    const db = createDatabase(DATABASE_URL);
    try {
      const idPagamento = await seedAprovadoPagamento(db, seededData);
      // Repasse money already left the house: transferido_em stamped.
      await armTransferidoLancamento(db, { idPagamento, idCampanha: seededData.idCampanha });

      const { dialog, confirm } = await walkToArmedConfirm(page, idPagamento);
      await confirm.click();

      // The mutation CONFLICTs (lancamento_ja_transferido) — the modal stays
      // open and surfaces the mapped operator copy as a role=alert.
      await expect(dialog.getByRole('alert')).toHaveText(BLOCKED_COPY);

      // Dismissing the modal keeps the error visible inline on the block.
      await dialog.getByRole('button', { name: 'cancelar' }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByRole('alert')).toHaveText(BLOCKED_COPY);

      // No money moved: the pagamento never left aprovado.
      expect(await getPagamentoStatus(db, idPagamento)).toBe('aprovado');
    } finally {
      await db.destroy();
    }
  });

  test('walk 3 — RBAC: estornar mutation denied to non-admin and logged-out (mirrors r5y94 walk 5)', async ({
    authenticatedPage: nonAdminPage,
    seededData,
    baseURL,
  }) => {
    const db = createDatabase(DATABASE_URL);
    try {
      const idPagamento = await seedAprovadoPagamento(db, seededData);
      const estornarInput = { idPagamento };

      // Non-admin (campaign owner) — server FORBIDS the money-moving mutation…
      const nonAdminDenied = await nonAdminPage.request.post(
        '/api/trpc/admin.pagamentos.estornar',
        { data: estornarInput },
      );
      expect(nonAdminDenied.ok(), 'non-admin estornar must be denied').toBe(false);
      expect([401, 403]).toContain(nonAdminDenied.status());

      // …and the AdminShell UX gate bounces a non-admin off the detail page.
      await nonAdminPage.goto(`/admin/pagamento/${idPagamento}`);
      await expect(nonAdminPage).not.toHaveURL(/\/admin\/pagamento/);

      // Logged-out (no session cookie) — mutation is UNAUTHORIZED.
      const anon = await pwRequest.newContext({ baseURL: baseURL ?? undefined });
      try {
        const anonDenied = await anon.post('/api/trpc/admin.pagamentos.estornar', {
          data: estornarInput,
        });
        expect(anonDenied.ok(), 'anonymous estornar must be denied').toBe(false);
        expect([401, 403]).toContain(anonDenied.status());
      } finally {
        await anon.dispose();
      }

      // No denied call had a side effect — the pagamento never left aprovado.
      expect(await getPagamentoStatus(db, idPagamento)).toBe('aprovado');
    } finally {
      await db.destroy();
    }
  });
});
