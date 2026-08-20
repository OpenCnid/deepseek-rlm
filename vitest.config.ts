import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/**/tests/**/*.spec.ts', 'scripts/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/*.integration.spec.ts', '**/*.e2e.spec.ts'],
    testTimeout: 15_000,
  },
})
