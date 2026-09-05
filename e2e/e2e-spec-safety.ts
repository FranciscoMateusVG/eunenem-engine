/**
 * Exhaustive safety classification for every Playwright spec.
 *
 * Remote runs intentionally exercise a deployed instance instead of spawning
 * the local fake-provider servers. A spec classified as `money-movement` must
 * therefore be excluded unless the deliberate interactive override is valid.
 * Keeping the safe specs in this manifest too is load-bearing: adding a new
 * spec without classifying it makes the manifest regression fail instead of
 * silently creating an unguarded payment path.
 */
export const E2E_SPEC_SAFETY = [
  { file: '118sb-clickthrough-gate.spec.ts', safety: 'non-payment' },
  {
    file: '4uvgf-admin-estorno.spec.ts',
    safety: 'money-movement',
    capability: 'Confirms a Stripe or Inter refund through admin.pagamentos.estornar.',
  },
  { file: '8bac7-postlogin-routing.spec.ts', safety: 'non-payment' },
  { file: '8bac7-welcome-optout.spec.ts', safety: 'non-payment' },
  { file: '8jcec-campanhas-multicampanha.spec.ts', safety: 'non-payment' },
  {
    file: 'a4pqt-inter-pix-expiry.spec.ts',
    safety: 'money-movement',
    capability: 'Creates a PIX checkout and dispatches its reconciliation worker.',
  },
  {
    file: 'a4pqt-inter-pix-refund.spec.ts',
    safety: 'money-movement',
    capability: 'Creates, reconciles, and refunds PIX payments.',
  },
  { file: 'acr3t-switcher-mobile.spec.ts', safety: 'non-payment' },
  // Deliberately safe: only denied anonymous/non-admin approval attempts with
  // an impossible id. Keeping this runnable remotely preserves the auth gate.
  { file: 'admin-authz-denial.spec.ts', safety: 'non-payment' },
  { file: 'admin-grouped-legacy.spec.ts', safety: 'non-payment' },
  { file: 'admin-pagamento-multi-item.spec.ts', safety: 'non-payment' },
  { file: 'cross-user-denial.spec.ts', safety: 'non-payment' },
  { file: 'd3tlf-convidados-save-deadend.spec.ts', safety: 'non-payment' },
  { file: 'fblrt-fix-wave.spec.ts', safety: 'non-payment' },
  { file: 'g1wl4-islegacy-routing.spec.ts', safety: 'non-payment' },
  { file: 'gf733-cart-no-persist-regression.spec.ts', safety: 'non-payment' },
  { file: 'gf733-onboarding-no-silent-loop-regression.spec.ts', safety: 'non-payment' },
  {
    file: 'kuw0o-pix-qr-checkout.spec.ts',
    safety: 'money-movement',
    capability: 'Creates and reconciles PIX checkouts through the payment composition root.',
  },
  { file: 'llol4-isolation-gates.spec.ts', safety: 'non-payment' },
  { file: 'n06ca-invite-required-date.spec.ts', safety: 'non-payment' },
  { file: 'ohum1-personalizar-palette-only.spec.ts', safety: 'non-payment' },
  { file: 'painel-adicionar-qty.spec.ts', safety: 'non-payment' },
  { file: 'painel-editar-mimo-qty-changed.spec.ts', safety: 'non-payment' },
  { file: 'painel-editar-mimo.spec.ts', safety: 'non-payment' },
  { file: 'qp12y-passwordless-only-gate.spec.ts', safety: 'non-payment' },
  {
    file: 'r5y94-repasse-admin-flow.spec.ts',
    safety: 'money-movement',
    capability: 'Approves, retries, and manually settles real PIX payouts.',
  },
  { file: 'slug-isolation-gate.spec.ts', safety: 'non-payment' },
  {
    file: 'stripe-webhook-cartao.spec.ts',
    safety: 'money-movement',
    capability: 'Posts a signed card settlement webhook and advances payment state.',
  },
  {
    file: 'stripe-webhook-pix.spec.ts',
    safety: 'money-movement',
    capability: 'Posts a signed PIX settlement webhook and advances payment state.',
  },
  { file: 'tqp4t-postlogin-routing-gaps.spec.ts', safety: 'non-payment' },
  { file: 'u38rz-nova-lista-create.spec.ts', safety: 'non-payment' },
  {
    file: 'visitor-cart-checkout.spec.ts',
    safety: 'money-movement',
    capability: 'Creates an external checkout through pagina.iniciarPagamentoCarrinho.',
  },
  { file: 'visitor-esgotada.spec.ts', safety: 'non-payment' },
  {
    file: 'visitor-legacy-unsold-ids.spec.ts',
    safety: 'money-movement',
    capability:
      'Finalizes a cart; waitForRequest observes but does not abort the checkout mutation.',
  },
  // Deliberately safe: malformed checkout inputs assert validation rejection
  // before any provider call.
  { file: 'w2-enforcement-gate.spec.ts', safety: 'non-payment' },
] as const satisfies readonly E2ESpecSafetyEntry[];

export type E2ESpecSafety = 'non-payment' | 'money-movement';

export interface E2ESpecSafetyEntry {
  readonly file: `${string}.spec.ts`;
  readonly safety: E2ESpecSafety;
  readonly capability?: string;
}

export const REMOTE_MONEY_MOVEMENT_SPECS = E2E_SPEC_SAFETY.filter(
  (entry) => entry.safety === 'money-movement',
);

export const REMOTE_MONEY_MOVEMENT_SPEC_GLOBS = REMOTE_MONEY_MOVEMENT_SPECS.map(
  (entry) => `**/${entry.file}`,
);

export const REMOTE_MONEY_MOVEMENT_OVERRIDE_ENV =
  'E2E_OPERATOR_ALLOW_REMOTE_MONEY_MOVEMENT' as const;
export const REMOTE_MONEY_MOVEMENT_OVERRIDE_ACK =
  'I_ACKNOWLEDGE_THIS_RUN_CAN_MOVE_REAL_MONEY' as const;

export interface MoneyMovementPolicyInput {
  readonly isRemote: boolean;
  readonly overrideValue?: string;
  readonly isCi: boolean;
  readonly stdinIsTty: boolean;
  readonly stdoutIsTty: boolean;
  readonly argv: readonly string[];
}

export interface MoneyMovementPolicy {
  readonly remoteMoneyMovementAllowed: boolean;
  readonly excludedSpecGlobs: readonly string[];
  readonly reason: 'local-fake-provider' | 'remote-blocked' | 'remote-interactive-override';
}

/**
 * Resolve the payment-spec policy before Playwright imports a test module.
 *
 * The override proves a deliberate interactive invocation, not the identity of
 * the human at the keyboard. That residual is explicit: a process running as
 * the same OS user can emulate a TTY. The defended failure modes are accidental
 * activation and normal CI/non-interactive automation.
 */
export function resolveMoneyMovementPolicy(input: MoneyMovementPolicyInput): MoneyMovementPolicy {
  const hasOverride = input.overrideValue !== undefined && input.overrideValue.length > 0;

  if (!input.isRemote) {
    if (hasOverride) {
      throw new Error(
        `${REMOTE_MONEY_MOVEMENT_OVERRIDE_ENV} must be unset for local fake-provider runs.`,
      );
    }
    return {
      remoteMoneyMovementAllowed: true,
      excludedSpecGlobs: [],
      reason: 'local-fake-provider',
    };
  }

  if (!hasOverride) {
    const directlySelected = REMOTE_MONEY_MOVEMENT_SPECS.filter((entry) =>
      input.argv.some((argument) => argument.includes(entry.file)),
    );
    if (directlySelected.length > 0) {
      throw new Error(
        `Direct remote selection of money-movement specs is blocked before collection: ${directlySelected.map((entry) => entry.file).join(', ')}`,
      );
    }
    if (input.argv.includes('--pass-with-no-tests')) {
      throw new Error(
        '--pass-with-no-tests is forbidden on guarded remote runs because it can hide a blocked direct selection.',
      );
    }
    return {
      remoteMoneyMovementAllowed: false,
      excludedSpecGlobs: REMOTE_MONEY_MOVEMENT_SPEC_GLOBS,
      reason: 'remote-blocked',
    };
  }

  if (input.overrideValue !== REMOTE_MONEY_MOVEMENT_OVERRIDE_ACK) {
    throw new Error(
      `${REMOTE_MONEY_MOVEMENT_OVERRIDE_ENV} was set, but its acknowledgement is invalid.`,
    );
  }
  if (input.isCi) {
    throw new Error(`${REMOTE_MONEY_MOVEMENT_OVERRIDE_ENV} is forbidden in CI.`);
  }
  if (!input.stdinIsTty || !input.stdoutIsTty) {
    throw new Error(
      `${REMOTE_MONEY_MOVEMENT_OVERRIDE_ENV} requires an interactive stdin and stdout TTY.`,
    );
  }

  return {
    remoteMoneyMovementAllowed: true,
    excludedSpecGlobs: [],
    reason: 'remote-interactive-override',
  };
}

export function logMoneyMovementPolicy(policy: MoneyMovementPolicy): void {
  if (policy.reason === 'remote-blocked') {
    const files = REMOTE_MONEY_MOVEMENT_SPECS.map((entry) => entry.file).join(', ');
    console.log(
      `[e2e-safety] remote money-movement blocked; excluded ${REMOTE_MONEY_MOVEMENT_SPECS.length} specs: ${files}`,
    );
    return;
  }

  if (policy.reason === 'remote-interactive-override') {
    console.warn(
      '[e2e-safety] DANGER: interactive remote money-movement override accepted; tests may move real money.',
    );
    return;
  }

  console.log('[e2e-safety] local fake-provider run; money-movement specs enabled.');
}
