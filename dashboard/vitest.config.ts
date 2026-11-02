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
          ALLOWED_DOMAINS: 'example.com',
          GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
          GOOGLE_CLIENT_SECRET: 'test-secret',
          ZITADEL_ISSUER: 'https://auth.example.com',
          ZITADEL_CLIENT_ID: 'zitadel-client',
          ZITADEL_CLIENT_SECRET: 'zitadel-secret',
          ZITADEL_LABEL: 'Example SSO',
          ZITADEL_ROLE_MAPPING: 'admin=wa-admin, operator=wa-operator, viewer=wa-viewer, viewer=staff',
          SESSION_SECRET: 'test-session-secret',
        },
      },
    })),
  ],
  test: {
    setupFiles: ['./test/apply-migrations.ts'],
  },
})
