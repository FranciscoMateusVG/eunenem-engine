import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
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
        'src/use-cases/criar-campanha.ts': {
          lines: 90,
          functions: 90,
          branches: 85,
        },
        'src/use-cases/adicionar-opcao-contribuicao.ts': {
          lines: 90,
          functions: 90,
          branches: 85,
        },
        'src/use-cases/criar-contribuicao.ts': {
          lines: 90,
          functions: 90,
          branches: 85,
        },
        'src/domain/usuario.ts': {
          lines: 90,
          functions: 90,
          branches: 85,
        },
        'src/use-cases/registrar-conta-usuario.ts': {
          lines: 90,
          functions: 90,
          branches: 85,
        },
        'src/use-cases/atualizar-perfil-usuario.ts': {
          lines: 90,
          functions: 90,
          branches: 85,
        },
        'src/use-cases/criar-sessao-usuario.ts': {
          lines: 90,
          functions: 90,
          branches: 85,
        },
        'src/use-cases/autorizar-permissao-usuario.ts': {
          lines: 90,
          functions: 90,
          branches: 85,
        },
      },
    },
    testTimeout: 30000, // Testcontainers needs time to spin up
  },
});
