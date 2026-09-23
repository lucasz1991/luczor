import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('../../src', import.meta.url)) } },
  test: {
    globals: true,
    root: fileURLToPath(new URL('../..', import.meta.url)),
    include: ['tests/integration/memoryModelAcceptance.test.ts'],
    setupFiles: ['tests/setup/testglobals.ts'],
    fileParallelism: false,
    testTimeout: 20 * 60_000,
  },
})
