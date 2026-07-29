/**
 * aperture-qp12y — passwordless-only auth modal gate.
 *
 * Operator decision (2026-07-29): the auth modal offers EXACTLY three ways in —
 * Google OAuth, Microsoft OAuth, and email + magic link. The CONTINUAR →
 * password step (aperture-k4o0y) is removed, and it has ALREADY regressed back
 * once before ("for some crazy reason we returned with the continue button").
 * This spec is the absence gate that keeps it from returning a second time.
 *
 * Replaces e2e/k4o0y-email-login-boundary.spec.ts, which drove the removed
 * password UI. All server-side password tRPC procedures are retired; fixtures
 * authenticate through the same magic-link flow used by production.
 *
 * Why E2E and not unit: a unit test on AuthModalShell would pass against a
 * stale bundle. Only the built app proves what the deployed modal renders
 * (e2e-catches-what-lower-cant).
 */

import { randomUUID } from 'node:crypto';
import type { Locator } from '@playwright/test';
import { expect, test } from './fixtures.js';

// Direct BetterAuth email+password endpoints, retired since aperture-d7993.
// The magic-link endpoints are deliberately NOT in this list — they were
// restored as the primary email flow (PR #46).
const RETIRED_EMAIL_AUTH_PATHS = new Set(['/api/auth/sign-up/email', '/api/auth/sign-in/email']);
const RETIRED_PASSWORD_TRPC_PROCEDURES = [
  'auth.signUp',
  'auth.signIn',
  'auth.continuarComEmail',
] as const;

function trpcProcedures(url: string): string[] {
  const match = url.match(/\/api\/trpc\/([^?]+)/);
  return match?.[1]?.split(',') ?? [];
}

async function openAuthDialog(page: import('@playwright/test').Page): Promise<Locator> {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '→ criar minha lista grátis', exact: true }).click();
  const authDialog = page.getByRole('dialog', { name: 'entrar ou criar sua lista' });
  await expect(authDialog).toBeVisible();
  return authDialog;
}

test('auth modal offers only Google, Microsoft, and magic link — no password path exists', async ({
  page,
}) => {
  const authDialog = await openAuthDialog(page);

  // The three allowed entries.
  await expect(authDialog.getByRole('button', { name: 'Continuar com Google' })).toBeVisible();
  await expect(authDialog.getByRole('button', { name: 'Continuar com Microsoft' })).toBeVisible();
  await expect(authDialog.getByLabel('Seu e-mail')).toBeVisible();
  await expect(
    authDialog.getByRole('button', { name: 'ENVIAR LINK MÁGICO ♡', exact: true }),
  ).toBeVisible();

  // The forbidden path — CONTINUAR button and any password affordance. (The
  // subtitle copy "sem senha" is allowed; what must not exist is an INPUT.)
  await expect(authDialog.getByRole('button', { name: 'CONTINUAR', exact: true })).toHaveCount(0);
  await expect(authDialog.locator('input[type="password"]')).toHaveCount(0);
  await expect(authDialog.getByLabel('Sua senha — ou crie uma')).toHaveCount(0);
});

test('submitting an email sends a magic link and never reaches a password step', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8);
  const disposableEmail = `e2e-qp12y-${suffix}@e2e.local`;
  const observedAuthPaths: string[] = [];
  const observedTrpcProcedures: string[] = [];

  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith('/api/auth/')) {
      observedAuthPaths.push(pathname);
    }
    if (request.method() === 'POST') {
      observedTrpcProcedures.push(...trpcProcedures(request.url()));
    }
  });

  const authDialog = await openAuthDialog(page);
  await authDialog.getByLabel('Seu e-mail').fill(disposableEmail);

  const magicLinkResponse = page.waitForResponse((response) => {
    return (
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/auth/sign-in/magic-link'
    );
  });

  // Enter in the email field is the form submit — it must send the link, not
  // advance to a second step.
  await authDialog.getByLabel('Seu e-mail').press('Enter');
  await magicLinkResponse;

  // Whatever the send outcome (success copy or error banner), the modal must
  // never grow a password affordance.
  await expect(authDialog.locator('input[type="password"]')).toHaveCount(0);
  await expect(authDialog.getByRole('button', { name: 'CONTINUAR', exact: true })).toHaveCount(0);

  expect(observedAuthPaths).toContain('/api/auth/sign-in/magic-link');
  for (const retiredProcedure of RETIRED_PASSWORD_TRPC_PROCEDURES) {
    expect(
      observedTrpcProcedures,
      `auth modal must never call retired password procedure ${retiredProcedure}`,
    ).not.toContain(retiredProcedure);
  }
  for (const retiredPath of RETIRED_EMAIL_AUTH_PATHS) {
    expect(
      observedAuthPaths,
      `auth modal must never call retired Better Auth endpoint ${retiredPath}`,
    ).not.toContain(retiredPath);
  }
});

test('mobile auth controls expose at least 44px touch targets', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });

  const authDialog = await openAuthDialog(page);
  const closeButton = authDialog.getByRole('button', { name: 'Fechar', exact: true });

  await expect(closeButton).toBeVisible();
  // The card has a 220ms entrance scale — poll the settled geometry.
  await expect
    .poll(async () => (await closeButton.boundingBox())?.width ?? 0, {
      message: 'close control hit-area width',
    })
    .toBeGreaterThanOrEqual(44);
  await expect
    .poll(async () => (await closeButton.boundingBox())?.height ?? 0, {
      message: 'close control hit-area height',
    })
    .toBeGreaterThanOrEqual(44);
});
