import { describe, expect, it } from 'vitest';
import { shouldSpinPostgresContainer } from '../helpers/global-setup.js';

/**
 * Tests for aperture-epmps — the decision function gating whether
 * vitest's globalSetup spins a postgres testcontainer.
 *
 * Decision rules (first match wins):
 *   1. SKIP_DB_GLOBAL_SETUP=1 → false
 *   2. FORCE_DB_GLOBAL_SETUP=1 → true
 *   3. CLI test path args present → true iff any path mentions tests/integration
 *   4. No CLI test path args → true (full run default)
 */
describe('shouldSpinPostgresContainer (aperture-epmps)', () => {
  describe('explicit env overrides win first', () => {
    it('SKIP_DB_GLOBAL_SETUP=1 → false even when path mentions integration', () => {
      expect(
        shouldSpinPostgresContainer(['node', 'vitest', 'run', 'tests/integration/foo.test.ts'], {
          SKIP_DB_GLOBAL_SETUP: '1',
        }),
      ).toBe(false);
    });

    it('SKIP_DB_GLOBAL_SETUP=1 → false on full run too', () => {
      expect(shouldSpinPostgresContainer(['node', 'vitest', 'run'], { SKIP_DB_GLOBAL_SETUP: '1' })).toBe(
        false,
      );
    });

    it('FORCE_DB_GLOBAL_SETUP=1 → true even when path is unit-only', () => {
      expect(
        shouldSpinPostgresContainer(['node', 'vitest', 'run', 'tests/unit/foo.test.ts'], {
          FORCE_DB_GLOBAL_SETUP: '1',
        }),
      ).toBe(true);
    });

    it('SKIP wins over FORCE when both are set (first-match rule)', () => {
      expect(
        shouldSpinPostgresContainer(['node', 'vitest', 'run'], {
          SKIP_DB_GLOBAL_SETUP: '1',
          FORCE_DB_GLOBAL_SETUP: '1',
        }),
      ).toBe(false);
    });

    it('other values of the env vars do NOT trigger (only literal "1")', () => {
      expect(
        shouldSpinPostgresContainer(['node', 'vitest', 'run', 'tests/unit/foo.test.ts'], {
          SKIP_DB_GLOBAL_SETUP: 'true',
          FORCE_DB_GLOBAL_SETUP: 'yes',
        }),
      ).toBe(false); // unit-only path → false (env vars ignored)
    });
  });

  describe('CLI test path heuristic', () => {
    it('unit-only file path → false (the new DX win)', () => {
      expect(
        shouldSpinPostgresContainer(['node', 'vitest', 'run', 'tests/unit/foo.test.ts'], {}),
      ).toBe(false);
    });

    it('integration file path → true', () => {
      expect(
        shouldSpinPostgresContainer(
          ['node', 'vitest', 'run', 'tests/integration/usuario-repository.postgres.test.ts'],
          {},
        ),
      ).toBe(true);
    });

    it('mixed paths (unit + integration) → true', () => {
      expect(
        shouldSpinPostgresContainer(
          [
            'node',
            'vitest',
            'run',
            'tests/unit/foo.test.ts',
            'tests/integration/bar.test.ts',
          ],
          {},
        ),
      ).toBe(true);
    });

    it('unit directory path → false', () => {
      expect(shouldSpinPostgresContainer(['node', 'vitest', 'run', 'tests/unit/'], {})).toBe(false);
    });

    it('integration directory path → true', () => {
      expect(shouldSpinPostgresContainer(['node', 'vitest', 'run', 'tests/integration/'], {})).toBe(
        true,
      );
    });

    it('integration directory path without trailing slash → true', () => {
      expect(shouldSpinPostgresContainer(['node', 'vitest', 'run', 'tests/integration'], {})).toBe(
        true,
      );
    });

    it('absolute integration path → true', () => {
      expect(
        shouldSpinPostgresContainer(
          ['node', 'vitest', 'run', '/Users/x/projects/engine/tests/integration/foo.test.ts'],
          {},
        ),
      ).toBe(true);
    });

    it('absolute unit path → false', () => {
      expect(
        shouldSpinPostgresContainer(
          ['node', 'vitest', 'run', '/Users/x/projects/engine/tests/unit/foo.test.ts'],
          {},
        ),
      ).toBe(false);
    });

    it('parent dir tests/ → true (could include integration; safer to spin)', () => {
      expect(shouldSpinPostgresContainer(['node', 'vitest', 'run', 'tests/'], {})).toBe(true);
    });
  });

  describe('default (no path args)', () => {
    it('no CLI path → true (full run, container needed for backward compat)', () => {
      expect(shouldSpinPostgresContainer(['node', 'vitest', 'run'], {})).toBe(true);
    });

    it('only flags, no path → true (full run with flags only)', () => {
      expect(
        shouldSpinPostgresContainer(['node', 'vitest', 'run', '--reporter=verbose'], {}),
      ).toBe(true);
    });

    it('empty argv → true (defensive default)', () => {
      expect(shouldSpinPostgresContainer([], {})).toBe(true);
    });
  });

  describe('flag-only args are ignored when scanning for test paths', () => {
    it('--coverage + unit path → false (flag does not count as a path arg)', () => {
      expect(
        shouldSpinPostgresContainer(
          ['node', 'vitest', 'run', '--coverage', 'tests/unit/foo.test.ts'],
          {},
        ),
      ).toBe(false);
    });

    it('--reporter=verbose + integration path → true', () => {
      expect(
        shouldSpinPostgresContainer(
          ['node', 'vitest', 'run', '--reporter=verbose', 'tests/integration/foo.test.ts'],
          {},
        ),
      ).toBe(true);
    });

    it('flag without value followed by a path → path is correctly classified', () => {
      // 'tests/integration/foo.test.ts' is the path; --bail and the rest are flags.
      expect(
        shouldSpinPostgresContainer(
          ['node', 'vitest', 'run', '--bail', '1', 'tests/integration/foo.test.ts'],
          {},
        ),
      ).toBe(true);
    });

    it('flag value that does NOT contain "tests/" is NOT classified as a path arg', () => {
      // '1' isn't a path; only tests/unit/... is.
      expect(
        shouldSpinPostgresContainer(
          ['node', 'vitest', 'run', '--bail', '1', 'tests/unit/foo.test.ts'],
          {},
        ),
      ).toBe(false);
    });
  });
});
