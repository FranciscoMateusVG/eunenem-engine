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
        'src/use-cases/create-fundraising-campaign.ts': {
          lines: 90,
          functions: 90,
          branches: 85,
        },
        'src/use-cases/add-fundraising-contribution-option.ts': {
          lines: 90,
          functions: 90,
          branches: 85,
        },
        'src/use-cases/create-fundraising-contribution.ts': {
          lines: 90,
          functions: 90,
          branches: 85,
        },
        'src/domain/user.ts': {
          lines: 90,
          functions: 90,
          branches: 85,
        },
        'src/use-cases/register-user-account.ts': {
          lines: 90,
          functions: 90,
          branches: 85,
        },
        'src/use-cases/update-user-profile.ts': {
          lines: 90,
          functions: 90,
          branches: 85,
        },
        'src/use-cases/create-user-session.ts': {
          lines: 90,
          functions: 90,
          branches: 85,
        },
        'src/use-cases/authorize-user-permission.ts': {
          lines: 90,
          functions: 90,
          branches: 85,
        },
      },
    },
    testTimeout: 30000, // Testcontainers needs time to spin up
  },
});
