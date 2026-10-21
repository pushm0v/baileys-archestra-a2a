import path from 'node:path'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, 'migrations')),
          ADMIN_EMAILS: 'boss@example.com, Second@Example.com',
          GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
          GOOGLE_CLIENT_SECRET: 'test-secret',
          SESSION_SECRET: 'test-session-secret',
        },
      },
    })),
  ],
  test: {
    setupFiles: ['./test/apply-migrations.ts'],
  },
})
