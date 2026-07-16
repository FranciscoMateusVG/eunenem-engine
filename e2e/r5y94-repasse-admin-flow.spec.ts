/**
 * aperture-r5y94 — Repasse (Inter PIX payout) admin flow E2E.
 *
 * Click-every-CTA browser walks over the /admin/repasses payout machine, driving
 * the deterministic fake transfer rail via the aperture-4ifbm magic-chave hook
 * (recebedor chave = `e2e-outcome-<OUTCOME>[-search-hit]@fake…` → forced
 * pagarPix outcome). Requires `EUNENEM_FAKE_E2E_MAGIC='true'` on the webServer
 * (wired in playwright.config.ts) and the fake transferencia provider (the
 * default off production).
 *
 * Five walks:
 *   1. HAPPY   — solicitado → Aprovar → fake pago → status pago + lançamento settled.
 *   2. RETRY   — forced rejeitado → falhou → Reprocessar (chave swapped to pago) → pago.
 *   3. CANCEL  — forced rejeitado → falhou → Cancelar → funds return to disponível.
 *   4. MANUAL  — seeded verificando+needs-manual+candidates → candidate list +
 *                scary duplicate-pay warning + Marcar como pago (codigoSolicitacao) → pago.
 *   5. RBAC    — logged-out + non-admin denied at /admin/repasses AND at the mutation.
 *
 * State assertions are AUTHORITATIVE against the DB (the async pg-boss executar
 * job settles out-of-band); the UI is exercised for every CTA + the operator-
 * facing copy. DB observation opens its own connection (destroyed in finally).
 */

import { request as pwRequest } from '@playwright/test';
import { expect, test } from './fixtures.js';
import {
  getLancamentoById,
  getLancamentosForRepasse,
  getRepasseRow,
  openSeedDb,
  seedCampanhaOwner,
  seedSolicitadoRepasse,
  seedVerificandoNeedsManual,
  setRecebedorChave,
} from './repasse-seed.js';

const AMOUNT = 7350;
const chave = (marker: string) => `e2e-outcome-${marker}@fake.eunenem.test`;

/** Poll the DB until the repasse reaches `status`, or fail loudly. */
async function expectRepasseStatus(
  db: ReturnType<typeof openSeedDb>,
  idRepasse: string,
  status: string,
): Promise<void> {
  await expect
    .poll(async () => (await getRepasseRow(db, idRepasse))?.status, {
      message: `repasse ${idRepasse} should reach ${status}`,
      timeout: 20_000,
      intervals: [200, 300, 500, 1000],
    })
    .toBe(status);
}

/** Open the aprovar confirm modal and confirm — the approve = pay handoff. */
async function aprovar(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: 'Aprovar repasse' }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirmar aprovação de repasse' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Confirmar aprovação' }).click();
  await expect(dialog).toBeHidden();
}

test.describe('aperture-r5y94 — repasse admin payout walks', () => {
  test('walk 1 — happy path: Aprovar → fake pago → repasse pago + lançamento settled', async ({
    adminAuthenticatedPage: page,
  }) => {
    const db = openSeedDb();
    try {
      const owner = await seedCampanhaOwner(db, chave('pago'));
      const { idRepasse, idLancamento } = await seedSolicitadoRepasse(db, {
        idCampanha: owner.idCampanha,
        amountCents: AMOUNT,
      });

      await page.goto(`/admin/repasses/${idRepasse}`);
      // Starting state is visible before we act.
      await expect(page.getByRole('button', { name: 'Aprovar repasse' })).toBeVisible();

      await aprovar(page);

      // The pg-boss executar job settles pago out-of-band — DB is authoritative.
      await expectRepasseStatus(db, idRepasse, 'pago');
      const lanc = await getLancamentoById(db, idLancamento);
      expect(lanc?.transferido_em, 'lançamento must be settled at pago').not.toBeNull();
      expect(lanc?.id_repasse, 'settled lançamento stays claimed').toBe(idRepasse);

      // UI reflects pago after a reload.
      await page.reload();
      await expect(page.getByText('pago', { exact: true }).first()).toBeVisible();
      await expect(page.getByRole('button', { name: 'Aprovar repasse' })).toHaveCount(0);
    } finally {
      await db.destroy();
    }
  });

  test('walk 2 — falhou/retry: rejeitado → Reprocessar (chave→pago) → pago', async ({
    adminAuthenticatedPage: page,
  }) => {
    const db = openSeedDb();
    try {
      const owner = await seedCampanhaOwner(db, chave('rejeitado'));
      const { idRepasse, idLancamento } = await seedSolicitadoRepasse(db, {
        idCampanha: owner.idCampanha,
        amountCents: AMOUNT,
      });

      await page.goto(`/admin/repasses/${idRepasse}`);
      await aprovar(page);
      await expectRepasseStatus(db, idRepasse, 'falhou');

      // Swap the recebedor chave so the NEXT executar (per-call eval, 4ifbm)
      // resolves pago — the retry re-reads the recebedor fresh.
      await setRecebedorChave(db, owner.idRecebedor, chave('pago'));

      await page.reload();
      await expect(page.getByText('falhou', { exact: true }).first()).toBeVisible();
      await page.getByRole('button', { name: 'Reprocessar transferência' }).click();

      await expectRepasseStatus(db, idRepasse, 'pago');
      const lanc = await getLancamentoById(db, idLancamento);
      expect(lanc?.transferido_em, 'lançamento settled after retry').not.toBeNull();
      const row = await getRepasseRow(db, idRepasse);
      expect(row?.transfer_attempts, 'retry increments the attempt counter').toBeGreaterThanOrEqual(
        2,
      );

      await page.reload();
      await expect(page.getByText('pago', { exact: true }).first()).toBeVisible();
    } finally {
      await db.destroy();
    }
  });

  test('walk 3 — cancelar: falhou → Cancelar → funds return to disponível', async ({
    adminAuthenticatedPage: page,
  }) => {
    const db = openSeedDb();
    try {
      const owner = await seedCampanhaOwner(db, chave('rejeitado'));
      const { idRepasse, idLancamento } = await seedSolicitadoRepasse(db, {
        idCampanha: owner.idCampanha,
        amountCents: AMOUNT,
      });

      await page.goto(`/admin/repasses/${idRepasse}`);
      await aprovar(page);
      await expectRepasseStatus(db, idRepasse, 'falhou');

      await page.reload();
      await page.getByRole('button', { name: 'Cancelar repasse' }).click();
      const dialog = page.getByRole('dialog', { name: 'Confirmar cancelamento de repasse' });
      await expect(dialog).toBeVisible();
      // Irreversible-action copy is present in the confirm modal.
      await expect(dialog).toContainText('irreversível');
      await dialog.getByRole('button', { name: 'Confirmar cancelamento' }).click();
      await expect(dialog).toBeHidden();

      await expectRepasseStatus(db, idRepasse, 'cancelado');
      // Funds return: the claim lock is released (id_repasse back to NULL),
      // and the lançamento was never settled.
      const lanc = await getLancamentoById(db, idLancamento);
      expect(lanc?.id_repasse, 'cancel releases the funds-claim lock').toBeNull();
      expect(lanc?.transferido_em, 'cancelled repasse never settled').toBeNull();
      // Nothing stays claimed under the repasse.
      expect(await getLancamentosForRepasse(db, idRepasse)).toHaveLength(0);

      await page.reload();
      await expect(page.getByText('cancelado', { exact: true }).first()).toBeVisible();
    } finally {
      await db.destroy();
    }
  });

  test('walk 4 — manual resolution: candidate list + duplicate-pay warning + Marcar como pago', async ({
    adminAuthenticatedPage: page,
  }) => {
    const db = openSeedDb();
    try {
      const owner = await seedCampanhaOwner(db, chave('ambiguo-search-hit'));
      const CANDIDATE_CODE = `INTER-${'r5y94'}-${Date.now().toString(36)}`;
      const { idRepasse, idLancamento } = await seedVerificandoNeedsManual(db, {
        idCampanha: owner.idCampanha,
        amountCents: AMOUNT,
        candidates: [
          {
            codigoSolicitacao: CANDIDATE_CODE,
            valorCents: AMOUNT,
            chaveMascarada: 'e***@e***.com',
            descricaoPix: 'PIX recebido',
            dataMovimento: '2026-07-16',
          },
        ],
      });

      await page.goto(`/admin/repasses/${idRepasse}`);

      // needs-manual pill + panel render.
      await expect(page.getByText('ação manual', { exact: true }).first()).toBeVisible();
      await expect(page.getByText('resolução manual necessária').first()).toBeVisible();
      // The candidate list renders the persisted candidate (código + masked chave).
      await expect(page.getByText(CANDIDATE_CODE).first()).toBeVisible();
      await expect(page.getByText('e***@e***.com').first()).toBeVisible();

      // Marcar como falhou surfaces the scary duplicate-pay warning (do NOT confirm).
      await page.getByRole('button', { name: 'Marcar como falhou' }).click();
      const falhouDialog = page.getByRole('dialog', {
        name: 'Confirmar falha da transferência',
      });
      await expect(falhouDialog).toBeVisible();
      // The double-pay warning is the whole point of this modal: with candidates
      // present it escalates to a scary "pago em dobro" acknowledgment gate.
      await expect(falhouDialog).toContainText('pagamento em dobro');
      await expect(falhouDialog).toContainText('SEGUNDO PIX');
      // The confirm stays disabled until the operator acknowledges — proof the
      // gate can't be bypassed by an accidental click.
      await expect(falhouDialog.getByRole('button', { name: 'Confirmar falha' })).toBeDisabled();
      // Dismiss without confirming — we resolve as pago instead.
      await page.keyboard.press('Escape');
      await expect(falhouDialog).toBeHidden();

      // Marcar como pago requires a codigoSolicitacao; supply the candidate code.
      await page.getByRole('button', { name: 'Marcar como pago' }).click();
      const pagoDialog = page.getByRole('dialog', { name: 'Confirmar pagamento manual' });
      await expect(pagoDialog).toBeVisible();
      const codigoInput = pagoDialog.locator('#codigo-manual');
      await expect(codigoInput).toBeVisible();
      await codigoInput.fill(CANDIDATE_CODE);
      await pagoDialog.getByRole('button', { name: 'Confirmar pagamento' }).click();
      await expect(pagoDialog).toBeHidden();

      // Manual pago books the repasse + settles the lançamento.
      await expectRepasseStatus(db, idRepasse, 'pago');
      const row = await getRepasseRow(db, idRepasse);
      expect(row?.needs_manual_resolution, 'manual flag cleared on resolve').toBe(false);
      const lanc = await getLancamentoById(db, idLancamento);
      expect(lanc?.transferido_em, 'lançamento settled on manual pago').not.toBeNull();

      await page.reload();
      await expect(page.getByText('pago', { exact: true }).first()).toBeVisible();
    } finally {
      await db.destroy();
    }
  });

  test('walk 5 — RBAC: /admin/repasses + aprovar mutation denied to non-admin and logged-out', async ({
    authenticatedPage: nonAdminPage,
    baseURL,
  }) => {
    const db = openSeedDb();
    try {
      const owner = await seedCampanhaOwner(db, chave('pago'));
      const { idRepasse } = await seedSolicitadoRepasse(db, {
        idCampanha: owner.idCampanha,
        amountCents: AMOUNT,
      });
      const aprovarInput = { idRepasse, bankTransferRef: null };

      // Non-admin (campaign owner) — server FORBIDS the money-moving mutation…
      const nonAdminDenied = await nonAdminPage.request.post('/api/trpc/admin.repasses.aprovar', {
        data: aprovarInput,
      });
      expect(nonAdminDenied.ok(), 'non-admin aprovar must be denied').toBe(false);
      expect([401, 403]).toContain(nonAdminDenied.status());

      // …and the AdminShell UX gate bounces a non-admin off /admin/repasses.
      await nonAdminPage.goto('/admin/repasses');
      await expect(nonAdminPage).not.toHaveURL(/\/admin\/repasses/);

      // Logged-out (no session cookie) — mutation is UNAUTHORIZED.
      const anon = await pwRequest.newContext({ baseURL: baseURL ?? undefined });
      try {
        const anonDenied = await anon.post('/api/trpc/admin.repasses.aprovar', {
          data: aprovarInput,
        });
        expect(anonDenied.ok(), 'anonymous aprovar must be denied').toBe(false);
        expect([401, 403]).toContain(anonDenied.status());
      } finally {
        await anon.dispose();
      }

      // The repasse never left solicitado — no denied call had a side effect.
      expect((await getRepasseRow(db, idRepasse))?.status).toBe('solicitado');
    } finally {
      await db.destroy();
    }
  });
});
