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
 * Six walks (Stripe provenance runs on :3002 — empty STRIPE_* env binds the
 * fake payment adapter, whose refundarPagamento defaults to 'aceito'):
 *   1. HAPPY — aprovado → CTA → ack-gated confirm → result strip 'pagamento
 *      estornado' → DB status settles 'estornado'.
 *   2. 409 GATE — aprovado WITH a transferido lançamento → confirm → inline
 *      role=alert 'estorno bloqueado…' and DB status STAYS aprovado.
 *   3. RBAC — raw POST as non-admin + logged-out → [401,403], no side effect
 *      (mirrors r5y94 walk 5).
 *   4. ACK RESET (cancel) — aperture-irhxi hold 1: ack the warning → Cancel →
 *      reopen → confirm DISABLED again (fresh ack required per attempt).
 *   5. ACK RESET (backdrop) — same, dismissed via backdrop click.
 *   6. INTER UI — aperture-irhxi hold 2: an Inter-provenance pagamento (hand-
 *      built transacao_externa + devolução row) shows NO Stripe reason select
 *      and, on a TERMINAL failed devolução, the result strip reads failure
 *      ('requer ação manual') — never the contradictory amber 'aguardando o
 *      banco'.
 *
 * NOTE — this spec covers the admin REFUND UI's rendering of every state,
 * seeding the Inter pagamento via direct SQL (makeInterWithDevolucao). The
 * LITERAL end-to-end Inter journey (real checkout → webhook → estorno) is a
 * separate B8 substrate concern (fake txid ≠ production authoritative
 * txid=UUID-without-hyphens) tracked under aperture-a4pqt.
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
 * Promote a seeded Stripe-rail aprovado pagamento to INTER provenance +
 * attach a devolução record in a chosen terminal/pending state — the
 * fixture no seed helper builds (documented gap from the first pass).
 * The estorno use-case's bindingMatches triple-check needs
 * transacao_externa.id === intencao_e2e_external_ref AND
 * transacao_externa.amountCents === the aggregate total; we mirror both
 * off the persisted row so the Inter refund path is reachable, then seed
 * the pix_cobranca_devolucoes row the UI reads via devolucaoStatus.
 */
async function makeInterWithDevolucao(
  db: Database,
  idPagamento: string,
  devolucaoStatus: 'em_processamento' | 'devolvida' | 'nao_realizada' | 'rejeitada',
): Promise<void> {
  const e2eId = `E${randomUUID().replaceAll('-', '')}`.slice(0, 32);
  const idDevolucao = `D${randomUUID().replaceAll('-', '')}`.slice(0, 32);
  const paid = await sql<{ total: number }>`
    SELECT intencao_total_paid_cents AS total FROM pagamentos WHERE id = ${idPagamento}
  `.execute(db);
  const amountCents = Number(paid.rows[0]?.total ?? 5000);
  const transacao = JSON.stringify({
    id: e2eId,
    provedor: 'inter',
    status: 'aprovado',
    amountCents,
    criadaEm: new Date('2026-08-06T12:00:00.000Z').toISOString(),
  });
  await sql`
    UPDATE pagamentos
      SET transacao_externa = ${transacao}::jsonb,
          intencao_e2e_external_ref = ${e2eId}
      WHERE id = ${idPagamento}
  `.execute(db);
  await sql`
    INSERT INTO pix_cobranca_devolucoes
      (id, id_pagamento, e2e_id, id_devolucao, amount_cents, status, rtr_id,
       criado_em, atualizado_em)
    VALUES
      (${randomUUID()}, ${idPagamento}, ${e2eId}, ${idDevolucao}, ${amountCents},
       ${devolucaoStatus}, ${devolucaoStatus === 'em_processamento' ? null : 'RTRFAKE0001'},
       NOW(), NOW())
  `.execute(db);
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

  // aperture-irhxi QA (Izzy, hold 1): the irreversibility ack is PER-ATTEMPT.
  // The original bug: ack only reset on mutation success, so cancel/backdrop
  // → reopen arrived with confirm pre-armed. These two prove every reopen
  // re-gates, via BOTH dismiss paths.
  test('walk 4 — ack resets on CANCEL → reopen requires a fresh acknowledgment', async ({
    adminAuthenticatedPage: page,
    seededData,
  }) => {
    const db = createDatabase(DATABASE_URL);
    try {
      const idPagamento = await seedAprovadoPagamento(db, seededData);
      const { dialog } = await walkToArmedConfirm(page, idPagamento);
      // Armed (checkbox checked, confirm enabled) — now dismiss via Cancel.
      await dialog.getByRole('button', { name: 'cancelar' }).click();
      await expect(dialog).toBeHidden();

      // Reopen — the confirm must be DISABLED again (fresh ack required).
      await page
        .getByTestId('estorno-block')
        .getByRole('button', { name: 'estornar pagamento' })
        .click();
      const dialog2 = page.getByRole('dialog', { name: 'Confirmar estorno de pagamento' });
      await expect(dialog2).toBeVisible();
      await expect(dialog2.getByRole('checkbox')).not.toBeChecked();
      await expect(dialog2.getByRole('button', { name: 'confirmar estorno' })).toBeDisabled();

      // Never moved money.
      expect(await getPagamentoStatus(db, idPagamento)).toBe('aprovado');
    } finally {
      await db.destroy();
    }
  });

  test('walk 5 — ack resets on BACKDROP dismiss → reopen requires a fresh acknowledgment', async ({
    adminAuthenticatedPage: page,
    seededData,
  }) => {
    const db = createDatabase(DATABASE_URL);
    try {
      const idPagamento = await seedAprovadoPagamento(db, seededData);
      const { dialog } = await walkToArmedConfirm(page, idPagamento);
      // Dismiss by clicking the backdrop (top-left corner, outside the panel).
      await page.mouse.click(5, 5);
      await expect(dialog).toBeHidden();

      await page
        .getByTestId('estorno-block')
        .getByRole('button', { name: 'estornar pagamento' })
        .click();
      const dialog2 = page.getByRole('dialog', { name: 'Confirmar estorno de pagamento' });
      await expect(dialog2.getByRole('checkbox')).not.toBeChecked();
      await expect(dialog2.getByRole('button', { name: 'confirmar estorno' })).toBeDisabled();

      expect(await getPagamentoStatus(db, idPagamento)).toBe('aprovado');
    } finally {
      await db.destroy();
    }
  });

  // aperture-irhxi QA (Izzy, hold 2): Inter provenance UI — the reason
  // select is Stripe-only, and a TERMINAL devolução failure must never show
  // the amber "aguardando o banco" pending copy beside its red badge.
  test('walk 6 — Inter provenance: no Stripe reason select; terminal failure shows failure copy, not pending', async ({
    adminAuthenticatedPage: page,
    seededData,
  }) => {
    const db = createDatabase(DATABASE_URL);
    try {
      // (a) aprovado Inter pagamento with a still-pending devolução — the
      //     dialog must NOT show the Stripe reason select.
      const idPending = await seedAprovadoPagamento(db, seededData);
      await makeInterWithDevolucao(db, idPending, 'em_processamento');
      await page.goto(`/admin/pagamento/${idPending}`);
      const block = page.getByTestId('estorno-block');
      await expect(block).toBeVisible();
      // Devolução badge renders the persisted pending state.
      await expect(block.getByText('devolução em processamento')).toBeVisible();
      await block.getByRole('button', { name: 'estornar pagamento' }).click();
      const dialog = page.getByRole('dialog', { name: 'Confirmar estorno de pagamento' });
      await expect(dialog).toBeVisible();
      // Inter path collects nothing → NO reason select; copy names the Inter rail.
      await expect(dialog.getByRole('combobox')).toHaveCount(0);
      await expect(dialog.getByText(/devolução PIX \(Inter\)/i)).toBeVisible();
      await page.mouse.click(5, 5);
      await expect(dialog).toBeHidden();

      // (b) an ESTORNADO Inter pagamento whose devolução TERMINAL-FAILED:
      //     the result strip must read failure, NOT "aguardando o banco".
      const idFailed = await seedAprovadoPagamento(db, seededData);
      await makeInterWithDevolucao(db, idFailed, 'rejeitada');
      await sql`UPDATE pagamentos SET status = 'estornado' WHERE id = ${idFailed}`.execute(db);
      await page.goto(`/admin/pagamento/${idFailed}`);
      const failedBlock = page.getByTestId('estorno-block');
      await expect(failedBlock).toBeVisible();
      const strip = failedBlock.getByTestId('estorno-result');
      await expect(strip).toBeVisible();
      await expect(strip).toHaveText(/requer ação manual/i);
      await expect(strip).not.toHaveText(/aguardando o banco/i);
      // The red terminal devolução badge is present alongside it.
      await expect(failedBlock.getByText('devolução rejeitada')).toBeVisible();
    } finally {
      await db.destroy();
    }
  });
});
