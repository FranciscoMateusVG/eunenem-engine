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
    testTimeout: 30000, // Testcontainers needs time to spin up
  },
});
