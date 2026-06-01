import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // ONE Postgres container shared across every test file
    // (aperture-m4xaj). Spun up before any file runs; torn down after
    // all files complete. See tests/helpers/global-setup.ts.
    globalSetup: ['tests/helpers/global-setup.ts'],
    // Run test files sequentially so per-file beforeEach TRUNCATEs
    // don't race across files that touch overlapping tables. Tests
    // *within* a file still run sequentially per vitest's default.
    // Trade-off: total wall-clock is the sum of file runtimes (no
    // file-level parallelism). Acceptable today; revisit with
    // schema-per-file isolation if speed becomes a problem.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.generated.ts', 'src/index.ts', 'src/testing/**'],
      thresholds: {
        'src/domain/cat.ts': {
          lines: 90,
          functions: 90,
          branches: 85,
        },
        'src/use-cases/create-cat.ts': {
          lines: 90,
          functions: 90,
          branches: 85,
        },
        'src/use-cases/arrecadacao/criar-campanha.ts': {
          lines: 90,
          functions: 90,
          branches: 85,
        },
        'src/use-cases/arrecadacao/adicionar-opcao-contribuicao.ts': {
          lines: 90,
          functions: 90,
          branches: 85,
        },
        'src/use-cases/arrecadacao/criar-contribuicao.ts': {
          lines: 90,
          functions: 90,
          branches: 85,
        },
        'src/domain/usuario/usuario.ts': {
          lines: 90,
          functions: 90,
          branches: 85,
        },
        'src/use-cases/usuario/registrar-conta-usuario.ts': {
          lines: 90,
          functions: 90,
          branches: 85,
        },
        'src/use-cases/usuario/atualizar-perfil-usuario.ts': {
          lines: 90,
          functions: 90,
          branches: 85,
        },
        'src/use-cases/usuario/criar-sessao-usuario.ts': {
          lines: 90,
          functions: 90,
          branches: 85,
        },
        'src/use-cases/usuario/autorizar-permissao-usuario.ts': {
          lines: 90,
          functions: 90,
          branches: 85,
        },
      },
    },
    // No more per-file container startup — tests just connect to the
    // already-running shared container. testTimeout can come back down
    // closer to the actual test runtime; keep some headroom for
    // migration runs on cold-cache CI.
    testTimeout: 30000,
  },
});
