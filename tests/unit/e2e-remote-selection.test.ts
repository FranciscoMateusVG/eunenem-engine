import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const playwrightCli = createRequire(import.meta.url).resolve('@playwright/test/cli');
const destructiveSpec = 'e2e/r5y94-repasse-admin-flow.spec.ts';
const safeSpec = 'e2e/qp12y-passwordless-only-gate.spec.ts';

function runPlaywright(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.E2E_OPERATOR_ALLOW_REMOTE_MONEY_MOVEMENT;
  delete env.E2E_BASE_URL;
  Object.assign(env, environment);

  const result = spawnSync(process.execPath, [playwrightCli, 'test', ...args], {
    cwd: projectRoot,
    env,
    encoding: 'utf8',
    timeout: 20_000,
  });

  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

describe('Playwright remote money-movement selection', () => {
  it('keeps local fake-provider specs available', () => {
    const result = runPlaywright([destructiveSpec, '--list'], {});

    expect(result.status).toBe(0);
    expect(result.output).toContain('host=localhost verdict=LOCAL');
    expect(result.output).toContain('local fake-provider run; money-movement specs enabled');
    expect(result.output).toContain('Total: 5 tests in 1 file');
  });

  it('runs a safe remote selection while visibly excluding destructive specs', () => {
    const result = runPlaywright([safeSpec, '--list'], {
      E2E_BASE_URL: 'https://staging.invalid',
    });

    expect(result.status).toBe(0);
    expect(result.output).toContain('host=staging.invalid verdict=REMOTE');
    expect(result.output).toContain('remote money-movement blocked; excluded 9 specs');
    expect(result.output).toContain('r5y94-repasse-admin-flow.spec.ts');
    expect(result.output).toContain('Total: 3 tests in 1 file');
  });

  it('fails a direct remote destructive selection before any test can run', () => {
    const result = runPlaywright([destructiveSpec], {
      E2E_BASE_URL: 'https://staging.invalid',
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('host=staging.invalid verdict=REMOTE');
    expect(result.output).toContain('Direct remote selection of money-movement specs is blocked');
    expect(result.output).toContain('r5y94-repasse-admin-flow.spec.ts');
    expect(result.output).not.toContain('Running 5 tests');
  });

  it('fails if a destructive spec is named alongside a safe spec', () => {
    const result = runPlaywright([safeSpec, destructiveSpec, '--list'], {
      E2E_BASE_URL: 'https://staging.invalid',
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('Direct remote selection of money-movement specs is blocked');
    expect(result.output).not.toContain('Listing tests:');
  });

  it('rejects the Playwright flag that could hide a blocked direct selection', () => {
    const result = runPlaywright(['--list', '--pass-with-no-tests'], {
      E2E_BASE_URL: 'https://staging.invalid',
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('--pass-with-no-tests is forbidden on guarded remote runs');
  });

  it('blocks a deceptive localhost-looking remote hostname', () => {
    const result = runPlaywright([destructiveSpec, '--list'], {
      E2E_BASE_URL: 'https://my-localhost-staging.eunenem.com',
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('host=my-localhost-staging.eunenem.com verdict=REMOTE');
    expect(result.output).toContain('Direct remote selection of money-movement specs is blocked');
  });

  it('fails closed on a malformed target before Playwright collects tests', () => {
    const result = runPlaywright([safeSpec, '--list'], {
      E2E_BASE_URL: 'not a url',
    });

    expect(result.status).not.toBe(0);
    expect(result.output).toContain('host=<unparseable> verdict=REMOTE');
    expect(result.output).toContain('refusing to start Playwright (fail closed)');
    expect(result.output).not.toContain('Listing tests:');
  });
});
