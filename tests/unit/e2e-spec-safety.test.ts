import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  E2E_SPEC_SAFETY,
  logMoneyMovementPolicy,
  REMOTE_MONEY_MOVEMENT_OVERRIDE_ACK,
  REMOTE_MONEY_MOVEMENT_SPEC_GLOBS,
  REMOTE_MONEY_MOVEMENT_SPECS,
  resolveMoneyMovementPolicy,
} from '../../e2e/e2e-spec-safety.js';

const e2eDir = fileURLToPath(new URL('../../e2e', import.meta.url));

describe('exhaustive E2E spec safety manifest', () => {
  it('classifies every Playwright spec exactly once', () => {
    const filesOnDisk = readdirSync(e2eDir)
      .filter((file) => file.endsWith('.spec.ts'))
      .sort();
    const manifestFiles = E2E_SPEC_SAFETY.map((entry) => entry.file).sort();

    expect(new Set(manifestFiles).size).toBe(manifestFiles.length);
    expect(manifestFiles).toEqual(filesOnDisk);
  });

  it('derives every remote exclusion from the destructive manifest', () => {
    expect(REMOTE_MONEY_MOVEMENT_SPECS.length).toBeGreaterThan(0);
    expect(REMOTE_MONEY_MOVEMENT_SPEC_GLOBS).toEqual(
      REMOTE_MONEY_MOVEMENT_SPECS.map((entry) => `**/${entry.file}`),
    );
    for (const entry of REMOTE_MONEY_MOVEMENT_SPECS) {
      expect(entry.capability).toBeTruthy();
    }
  });
});

describe('remote money-movement policy', () => {
  const baseInput = {
    isRemote: true,
    isCi: false,
    stdinIsTty: false,
    stdoutIsTty: false,
    argv: [] as string[],
  };

  it('excludes every destructive spec on an ordinary remote run', () => {
    expect(resolveMoneyMovementPolicy(baseInput)).toEqual({
      remoteMoneyMovementAllowed: false,
      excludedSpecGlobs: REMOTE_MONEY_MOVEMENT_SPEC_GLOBS,
      reason: 'remote-blocked',
    });
  });

  it('rejects an explicitly named destructive spec even when safe specs are also selected', () => {
    expect(() =>
      resolveMoneyMovementPolicy({
        ...baseInput,
        argv: ['e2e/qp12y-passwordless-only-gate.spec.ts', 'e2e/r5y94-repasse-admin-flow.spec.ts'],
      }),
    ).toThrow(/Direct remote selection.*r5y94-repasse-admin-flow\.spec\.ts/);
  });

  it('rejects --pass-with-no-tests while the remote guard is active', () => {
    expect(() =>
      resolveMoneyMovementPolicy({ ...baseInput, argv: ['--pass-with-no-tests'] }),
    ).toThrow(/forbidden on guarded remote runs/);
  });

  it('rejects a wrong, CI-supplied, or non-interactive override', () => {
    expect(() => resolveMoneyMovementPolicy({ ...baseInput, overrideValue: 'yes-really' })).toThrow(
      /acknowledgement is invalid/,
    );
    expect(() =>
      resolveMoneyMovementPolicy({
        ...baseInput,
        overrideValue: REMOTE_MONEY_MOVEMENT_OVERRIDE_ACK,
        isCi: true,
        stdinIsTty: true,
        stdoutIsTty: true,
      }),
    ).toThrow(/forbidden in CI/);
    expect(() =>
      resolveMoneyMovementPolicy({
        ...baseInput,
        overrideValue: REMOTE_MONEY_MOVEMENT_OVERRIDE_ACK,
      }),
    ).toThrow(/interactive stdin and stdout TTY/);
  });

  it('allows the exact acknowledgement only in an interactive non-CI remote run', () => {
    expect(
      resolveMoneyMovementPolicy({
        ...baseInput,
        overrideValue: REMOTE_MONEY_MOVEMENT_OVERRIDE_ACK,
        stdinIsTty: true,
        stdoutIsTty: true,
      }),
    ).toEqual({
      remoteMoneyMovementAllowed: true,
      excludedSpecGlobs: [],
      reason: 'remote-interactive-override',
    });
  });

  it('keeps local fake-provider specs enabled and rejects a stale override', () => {
    expect(resolveMoneyMovementPolicy({ ...baseInput, isRemote: false })).toEqual({
      remoteMoneyMovementAllowed: true,
      excludedSpecGlobs: [],
      reason: 'local-fake-provider',
    });
    expect(() =>
      resolveMoneyMovementPolicy({
        ...baseInput,
        isRemote: false,
        overrideValue: REMOTE_MONEY_MOVEMENT_OVERRIDE_ACK,
      }),
    ).toThrow(/must be unset/);
  });

  it('logs visible exclusions and never prints the override value', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    logMoneyMovementPolicy(resolveMoneyMovementPolicy(baseInput));
    logMoneyMovementPolicy({
      remoteMoneyMovementAllowed: true,
      excludedSpecGlobs: [],
      reason: 'remote-interactive-override',
    });

    expect(log).toHaveBeenCalledWith(expect.stringContaining('excluded'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('r5y94-repasse-admin-flow.spec.ts'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('DANGER'));
    expect(JSON.stringify([...log.mock.calls, ...warn.mock.calls])).not.toContain(
      REMOTE_MONEY_MOVEMENT_OVERRIDE_ACK,
    );
  });
});
