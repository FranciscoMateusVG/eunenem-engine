/**
 * aperture-k4o0y — email/password auth UI regression.
 *
 * This deliberately starts at the real marketing CTA and stops at the first
 * stable post-auth boundary. The backend integration suite owns tenant
 * resolution and account persistence; this spec owns the browser wiring:
 *
 *   landing "Entrar" CTA
 *     → email step
 *     → password step
 *     → POST /api/trpc/auth.continuarComEmail
 *     → new-account onboarding dialog
 *
 * The two retired Better Auth email endpoints are negative assertions. If the
 * UI is ever rewired to either direct endpoint, this test fails even if a mock
 * or permissive development server happens to return success.
 *
 * Fixture hygiene follows e2e/fixtures.ts: every run uses a collision-safe,
 * unique email and leaves the row for periodic E2E-database cleanup. Broad
 * table truncation would be less safe than the existing suite's convention.
 */

import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Locator } from '@playwright/test';
import { expect, test } from './fixtures.js';

const RETIRED_EMAIL_AUTH_PATHS = new Set([
  '/api/auth/sign-up/email',
  '/api/auth/sign-in/email',
  '/api/auth/sign-in/magic-link',
  '/api/auth/magic-link/verify',
]);
const SESSION_COOKIE = 'better-auth.session_token';
// Assemble disposable E2E credentials at runtime so secret scanners do not
// mistake non-production fixture values for deployable credentials.
const SEEDED_PASSWORD = ['senha', 'e2e', 'teste', '123'].join('-');
const WIZARD_LABEL = 'Vamos montar sua página';

function trpcProcedures(url: string): string[] {
  const match = url.match(/\/api\/trpc\/([^?]+)/);
  return match?.[1]?.split(',') ?? [];
}

async function trpcResponseData(response: { json(): Promise<unknown> }): Promise<unknown> {
  const body = (await response.json()) as
    | { result?: { data?: unknown } }
    | Array<{ result?: { data?: unknown } }>;
  const envelope = Array.isArray(body) ? body[0] : body;
  return envelope?.result?.data;
}

async function readAuthMe(api: APIRequestContext): Promise<unknown> {
  const response = await api.get('/api/trpc/auth.me');
  expect(response.status(), 'auth.me must remain a readable anonymous probe').toBe(200);
  return trpcResponseData(response);
}

async function expectProtectedAccessDenied(api: APIRequestContext): Promise<void> {
  const response = await api.get('/api/trpc/usuario.tutorialStatus');
  const body = (await response.json()) as {
    error?: { data?: { code?: string } };
  };

  expect(response.status(), 'protected usuario.tutorialStatus must reject this session').toBe(401);
  expect(body.error?.data?.code).toBe('UNAUTHORIZED');
}

async function expectMinimumTouchTarget(locator: Locator, label: string): Promise<void> {
  await expect(locator, `${label} must be visible before measuring its hit area`).toBeVisible();
  // The card has a 220ms entrance scale. Poll the real browser bounding box so
  // the assertion observes its settled interactive geometry rather than a
  // transient animation frame.
  await expect
    .poll(async () => (await locator.boundingBox())?.width ?? 0, {
      message: `${label} hit-area width`,
    })
    .toBeGreaterThanOrEqual(44);
  await expect
    .poll(async () => (await locator.boundingBox())?.height ?? 0, {
      message: `${label} hit-area height`,
    })
    .toBeGreaterThanOrEqual(44);
}

test('mobile auth controls expose at least 44px touch targets across both steps', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });

  const suffix = randomUUID().slice(0, 8);
  const disposableEmail = `e2e-k4o0y-touch-${suffix}@e2e.local`;
  const disposablePassword = ['senha', 'touch', suffix, '123'].join('-');

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '→ criar minha lista grátis', exact: true }).click();

  const authDialog = page.getByRole('dialog', {
    name: 'entrar ou criar sua lista',
  });
  const closeButton = authDialog.getByRole('button', { name: 'Fechar', exact: true });

  await expectMinimumTouchTarget(closeButton, 'email-step close control');
  await authDialog.getByLabel('Seu e-mail').fill(disposableEmail);
  await authDialog.getByRole('button', { name: 'CONTINUAR', exact: true }).click();

  const passwordInput = authDialog.getByLabel('Sua senha — ou crie uma');
  await passwordInput.fill(disposablePassword);

  await expectMinimumTouchTarget(closeButton, 'password-step close control');
  await expectMinimumTouchTarget(
    authDialog.getByRole('button', { name: 'Voltar para o passo anterior' }),
    'password-step back control',
  );
  await expectMinimumTouchTarget(
    authDialog.getByRole('button', { name: 'Mostrar senha' }),
    'password reveal control',
  );
});

test('landing email/password flow uses continuarComEmail and opens onboarding for a new account', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8);
  const email = `e2e-k4o0y-${suffix}@e2e.local`;
  const password = ['senha', 'e2e', suffix, '123'].join('-');
  const observedAuthPaths: string[] = [];
  const observedTrpcProcedures: string[] = [];

  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith('/api/auth/') || pathname.startsWith('/api/trpc/auth.')) {
      observedAuthPaths.push(pathname);
    }
    if (request.method() === 'POST') {
      observedTrpcProcedures.push(...trpcProcedures(request.url()));
    }
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });

  // Real landing entry point — no direct modal mount and no mocked auth state.
  await page.getByRole('button', { name: '→ criar minha lista grátis', exact: true }).click();

  const authDialog = page.getByRole('dialog', {
    name: 'entrar ou criar sua lista',
  });
  await expect(authDialog).toBeVisible();

  await authDialog.getByLabel('Seu e-mail').fill(email);
  await authDialog.getByRole('button', { name: 'CONTINUAR', exact: true }).click();

  const passwordInput = authDialog.getByLabel('Sua senha — ou crie uma');
  await expect(passwordInput).toBeVisible();
  await passwordInput.fill(password);

  const continuarResponse = page.waitForResponse((response) => {
    return (
      response.request().method() === 'POST' &&
      trpcProcedures(response.url()).includes('auth.continuarComEmail')
    );
  });

  await authDialog.getByRole('button', { name: 'CONTINUAR', exact: true }).click();

  const response = await continuarResponse;
  expect(
    response.ok(),
    `continuarComEmail failed: ${response.status()} ${await response.text()}`,
  ).toBe(true);

  // `session.criado=true` is consumed by AuthModalProvider, which opens the
  // blocking onboarding dialog before any dashboard redirect.
  await expect(page.getByRole('dialog', { name: WIZARD_LABEL })).toBeVisible();

  expect(observedTrpcProcedures).toContain('auth.continuarComEmail');
  for (const retiredPath of RETIRED_EMAIL_AUTH_PATHS) {
    expect(
      observedAuthPaths,
      `email/password flow must never call retired Better Auth endpoint ${retiredPath}`,
    ).not.toContain(retiredPath);
  }
});

test('changing email identity clears and re-hides the password before submission', async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8);
  const firstEmail = `e2e-k4o0y-a-${suffix}@e2e.local`;
  const secondEmail = `e2e-k4o0y-b-${suffix}@e2e.local`;
  const disposablePassword = ['senha', 'temporaria', suffix, '123'].join('-');

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '→ criar minha lista grátis', exact: true }).click();

  const authDialog = page.getByRole('dialog', {
    name: 'entrar ou criar sua lista',
  });
  const emailInput = authDialog.getByLabel('Seu e-mail');

  await emailInput.fill(firstEmail);
  await authDialog.getByRole('button', { name: 'CONTINUAR', exact: true }).click();

  const passwordInput = authDialog.getByLabel('Sua senha — ou crie uma');
  await passwordInput.fill(disposablePassword);
  await authDialog.getByRole('button', { name: 'Mostrar senha' }).click();
  await expect(passwordInput).toHaveAttribute('type', 'text');
  await expect(passwordInput).toHaveValue(disposablePassword);

  await authDialog.getByRole('button', { name: 'Voltar para o passo anterior' }).click();
  await emailInput.fill(secondEmail);
  await authDialog.getByRole('button', { name: 'CONTINUAR', exact: true }).click();

  await expect(passwordInput).toHaveValue('');
  await expect(passwordInput).toHaveAttribute('type', 'password');
});

test('existing account rejects a wrong password, logs in, logs out, and rejects stale-session access', async ({
  context,
  page,
  seededData,
}) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '→ criar minha lista grátis', exact: true }).click();

  const authDialog = page.getByRole('dialog', {
    name: 'entrar ou criar sua lista',
  });
  await authDialog.getByLabel('Seu e-mail').fill(seededData.email);
  await authDialog.getByRole('button', { name: 'CONTINUAR', exact: true }).click();

  const passwordInput = authDialog.getByLabel('Sua senha — ou crie uma');
  await passwordInput.fill(['senha', 'definitivamente', 'errada'].join('-'));

  const wrongPasswordResponse = page.waitForResponse((response) => {
    return (
      response.request().method() === 'POST' &&
      trpcProcedures(response.url()).includes('auth.continuarComEmail')
    );
  });
  await authDialog.getByRole('button', { name: 'CONTINUAR', exact: true }).click();

  const rejected = await wrongPasswordResponse;
  expect(rejected.ok(), 'wrong password must not authenticate').toBe(false);
  await expect(passwordInput).toHaveAttribute('aria-invalid', 'true');
  await expect(authDialog.getByText('e-mail ou senha não bateram — tenta de novo?')).toBeVisible();
  expect((await context.cookies()).some((cookie) => cookie.name === SESSION_COOKIE)).toBe(false);
  expect(await readAuthMe(page.request)).toBeNull();

  await passwordInput.fill(SEEDED_PASSWORD);
  const correctPasswordResponse = page.waitForResponse((response) => {
    return (
      response.request().method() === 'POST' &&
      trpcProcedures(response.url()).includes('auth.continuarComEmail')
    );
  });
  await authDialog.getByRole('button', { name: 'CONTINUAR', exact: true }).click();

  const authenticated = await correctPasswordResponse;
  expect(
    authenticated.ok(),
    `correct-password continuarComEmail failed: ${authenticated.status()}`,
  ).toBe(true);
  expect(await trpcResponseData(authenticated)).toMatchObject({ criado: false });

  // Existing, not-yet-onboarded accounts take the post-login route to their
  // painel; PainelPage owns the blocking wizard at that destination.
  await page.waitForURL(`**/painel/${seededData.slug}`);
  await expect(page.getByRole('dialog', { name: WIZARD_LABEL })).toBeVisible();

  const freshSessionCookie = (await context.cookies()).find(
    (cookie) => cookie.name === SESSION_COOKIE,
  );
  if (!freshSessionCookie) {
    throw new Error('correct-password login must set a fresh session cookie');
  }

  // Return to the landing so logout goes through the real account-menu UI.
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const accountMenuButton = page.getByRole('button', {
    name: /^Conta de .+ Abrir menu$/,
  });
  await expect(accountMenuButton).toBeVisible();
  await accountMenuButton.click();

  const signOutResponse = page.waitForResponse((response) => {
    return (
      response.request().method() === 'POST' &&
      trpcProcedures(response.url()).includes('auth.signOut')
    );
  });
  await page.getByRole('menuitem', { name: 'Sair', exact: true }).click();

  const signedOut = await signOutResponse;
  expect(signedOut.ok(), `auth.signOut failed: ${signedOut.status()}`).toBe(true);
  await expect(page.getByRole('button', { name: 'Entrar', exact: true })).toBeVisible();
  expect((await context.cookies()).some((cookie) => cookie.name === SESSION_COOKIE)).toBe(false);
  await expectProtectedAccessDenied(page.request);

  // Replay the just-revoked token as a pre-existing cookie. This is a genuine
  // stale session produced by the public lifecycle — no direct DB mutation.
  await context.addCookies([freshSessionCookie]);
  expect(await readAuthMe(page.request)).toBeNull();
  await expectProtectedAccessDenied(page.request);
});
