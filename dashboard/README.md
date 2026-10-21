# WhatsApp Bridge dashboard

A Cloudflare Worker for running many WhatsApp numbers with the bridge: add numbers, link them by QR or pairing code, set their agents and group routes, and watch their status and logs live. Admins sign in with Google.

The WhatsApp sessions don't run on Cloudflare. They run in **runners**, which are the bridge's Docker image started with `node src/runner.mjs` on your own server or Kubernetes. A runner starts one bridge process per number and dials out to the dashboard over a WebSocket, so it needs no open ports.

```
Browser ──Google sign-in──▶ Worker (API + UI)
   ▲                          ├─ D1: admins, runners, numbers, routes, audit log
   │ live status, QR codes    └─ Durable Object "Hub" ◀──WebSocket── Runner (your server)
   └──────────────────────────────────┘                               ├─ bridge process: number A
                                                                      └─ bridge process: number B
```

- **Tokens stay on the runner.** For each number and route, the dashboard stores only the *name* of an env var on the runner (default `ARCHESTRA_TOKEN`). The runner looks up the value itself.
- **A dashboard outage doesn't stop numbers.** The runner caches the last settings it received and keeps running them, reconnecting to the dashboard with backoff.
- **Several runners.** Each number is assigned to one runner. Moving a number to another runner starts a fresh session there, so it has to be linked again.

## Setup

Requirements: a Cloudflare account, Node.js 22+, and a Google Cloud project for the sign-in client.

### 1. Google sign-in client

In Google Cloud Console → **APIs & Services**:

1. **OAuth consent screen**: set it up (External or Internal); the `openid` and `email` scopes are enough.
2. **Credentials → Create credentials → OAuth client ID**, type **Web application**.
3. **Authorized redirect URIs**: add `https://<your worker domain>/auth/callback`, and `http://localhost:8787/auth/callback` for local development.

Keep the client ID and client secret.

### 2. Configure and deploy

```bash
cd dashboard
npm install
npx wrangler d1 create whatsapp-dashboard   # paste the database_id into wrangler.jsonc
```

Edit `wrangler.jsonc`:

- `ADMIN_EMAILS`: the default admins' Google emails, comma-separated. They can always sign in and can't be removed from the dashboard. Other admins can be added in the dashboard (**Admins** page).
- `GOOGLE_CLIENT_ID`: from step 1.

Then:

```bash
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put SESSION_SECRET        # e.g. the output of: openssl rand -base64 32
npm run deploy                                # applies D1 migrations, then deploys
```

To deploy from GitHub instead, use the manual **Deploy dashboard** workflow (`.github/workflows/deploy-dashboard.yml`), which needs the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets.

### 3. Add a runner

Sign in, open **Runners**, add one, and copy its token (it is shown once; **New token** issues another and disconnects the old one). Start it on your server:

```bash
# Docker
docker run -d --name wa-runner --restart unless-stopped -v wa-runner:/data \
  -e DASHBOARD_URL=https://<your worker domain> -e RUNNER_TOKEN=<token> \
  -e ARCHESTRA_URL=https://archestra.example.com -e ARCHESTRA_TOKEN=<token> \
  ghcr.io/pushm0v/baileys-archestra-a2a:0.3.0 node src/runner.mjs

# Docker Compose (from the repo root): cp .env.runner.example .env.runner, fill it in, then
docker compose --profile runner up -d runner

# Helm
helm upgrade --install wa-runner charts/baileys-archestra-a2a -n whatsapp --create-namespace \
  --set mode=runner --set runner.dashboardUrl=https://<your worker domain> --set runner.token=<token> \
  --set archestra.url=https://archestra.example.com --set archestra.token=<token>
```

Extra tokens go in as more env vars (e.g. `-e SALES_TOKEN=…`, or `extraEnv` in Helm) and are referred to by name in the dashboard. Each number is its own Node process, so plan for roughly 100–150 MiB of memory per number.

### 4. Add numbers

**Numbers → Add number**: pick the runner, set the default agent, and save. The page then shows a QR code to scan (WhatsApp → Linked devices → Link a device), or a pairing code to type on the phone. Once the number is linked, **Pick from groups** lists its groups so you can add routes without copying group IDs.

Saving settings restarts that number's bridge process, which keeps its session, so no new scan is needed. **Re-pair** logs the number out and shows a new QR code. **Delete** logs it out of WhatsApp and removes its session from the runner.

## Security notes

- Sign-in uses Google's OpenID Connect code flow with PKCE, `state` and `nonce`. The ID token's signature, issuer, audience and `email_verified` are checked, and the email must be in `ADMIN_EMAILS` or added on the Admins page.
- Sessions are HMAC-signed `__Host-` cookies (`HttpOnly`, `Secure`, `SameSite=Lax`) valid for 12 hours. Admin access is re-checked on every request, so removing an admin takes effect at once, and their open live connections are closed.
- Requests that change anything, and the live WebSocket, must come from the dashboard's own origin. Pages are served with a strict Content-Security-Policy.
- Runner tokens are stored only as SHA-256 hashes. A runner can only report on numbers assigned to it.
- QR codes and recent log lines live only in the hub's private Durable Object storage, never in D1. A QR code is deleted once its number is linked or stopped. Every change is recorded on the **Activity** page.

## Development

```bash
cp .dev.vars.example .dev.vars    # fill in both values
npm run db:migrate:local
npm run dev                       # http://localhost:8787
npm test                          # Workers runtime tests (Vitest)
npm run typecheck
```

Run a runner against it with `DASHBOARD_URL=http://localhost:8787` from the repo root: `node src/runner.mjs`.
