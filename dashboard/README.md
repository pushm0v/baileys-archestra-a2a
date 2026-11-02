# WhatsApp Bridge dashboard

A Cloudflare Worker for running many WhatsApp numbers with the bridge: add numbers, link them by QR or pairing code, set their agents and group routes, and watch their status and logs live. People sign in with Google, Zitadel, or either, limited to the email domains you allow, and each has a role: viewer, operator or admin.

The WhatsApp sessions don't run on Cloudflare. They run in **runners**, which are the bridge's Docker image started with `node src/runner.mjs` on your own server or Kubernetes. A runner starts one bridge process per number and dials out to the dashboard over a WebSocket, so it needs no open ports.

```
Browser ──Google / Zitadel sign-in──▶ Worker (API + UI)
   ▲                          ├─ D1: users, runners, numbers, routes, audit log
   │ live status, QR codes    ├─ D1: chats, messages, human agents, handoffs, MCP keys
   │                          ├─ /mcp ◀── Archestra agents (human follow-up tool)
   │                          └─ Durable Object "Hub" ◀──WebSocket── Runner (your server)
   └──────────────────────────────────┘                               ├─ bridge process: number A
                                                                      └─ bridge process: number B
```

- **Tokens stay on the runner.** For each number and route, the dashboard stores only the *name* of an env var on the runner (default `ARCHESTRA_TOKEN`). The runner looks up the value itself.
- **A dashboard outage doesn't stop numbers.** The runner caches the last settings it received and keeps running them, reconnecting to the dashboard with backoff.
- **Several runners.** Each number is assigned to one runner. Moving a number to another runner starts a fresh session there, so it has to be linked again.

## Setup

Requirements: a Cloudflare account, Node.js 22+, and a sign-in client in Google Cloud, in Zitadel, or in both. The login page shows a button for each one you configure.

### 1. Sign-in clients

#### Google

In Google Cloud Console → **APIs & Services**:

1. **OAuth consent screen**: set it up (External or Internal); the `openid` and `email` scopes are enough.
2. **Credentials → Create credentials → OAuth client ID**, type **Web application**.
3. **Authorized redirect URIs**: add `https://<your worker domain>/auth/callback`, and `http://localhost:8787/auth/callback` for local development.

Keep the client ID and client secret.

#### Zitadel

In the Zitadel console, in the project you want to use (or a new one):

1. **New application** → type **Web**, authentication method **PKCE** (recommended; no secret to store) or **Code** (gives a client secret, sent with HTTP Basic auth).
2. **Redirect URIs**: `https://<your worker domain>/auth/callback`, and `http://localhost:8787/auth/callback` with **Development mode** on for local testing.
3. Keep the **Client ID** (and the client secret, for a Code app). The issuer is your instance URL, e.g. `https://auth.example.com`.
4. Optional, to manage dashboard roles in Zitadel: in the project, create roles (e.g. `wa-admin`, `wa-operator`, `wa-viewer`), grant them to people under **Authorizations**, and turn on **Assert Roles on Authentication** in the project settings. See [Roles from Zitadel](#roles-from-zitadel).

The dashboard reads Zitadel's endpoints from `<issuer>/.well-known/openid-configuration`, asks for the `openid email profile urn:zitadel:iam:org:projects:roles` scopes, and gets the email and roles from the ID token, or from userinfo when the app doesn't put them in the token. A user's email must be verified in Zitadel.

### 2. Configure and deploy

```bash
cd dashboard
npm install
npx wrangler d1 create whatsapp-dashboard   # paste the database_id into wrangler.jsonc
```

Edit `wrangler.jsonc`:

- `ADMIN_EMAILS`: the default admins' emails, comma-separated. They can always sign in and can't be changed from the dashboard. Everyone else gets a role on the **Users** page.
- `ALLOWED_DOMAINS`: the email domains that may sign in, comma-separated (e.g. `kitabisa.com`). Leave it empty to allow any domain; then only people an admin has invited can sign in. See [Users and roles](#users-and-roles).
- Google: `GOOGLE_CLIENT_ID` from step 1. Leave it empty to turn Google sign-in off.
- Zitadel: `ZITADEL_ISSUER` (e.g. `https://auth.example.com`) and `ZITADEL_CLIENT_ID`. Optional: `ZITADEL_LABEL` for the button text (e.g. `Kitabisa SSO`), and `ZITADEL_ROLE_MAPPING` (see [Roles from Zitadel](#roles-from-zitadel)). Leave `ZITADEL_ISSUER` empty to turn Zitadel sign-in off.

Then:

```bash
npx wrangler secret put SESSION_SECRET          # e.g. the output of: openssl rand -base64 32
npx wrangler secret put GOOGLE_CLIENT_SECRET    # with Google sign-in
npx wrangler secret put ZITADEL_CLIENT_SECRET   # only for a Zitadel "Code" app; skip it for PKCE
npm run deploy                                  # applies D1 migrations, then deploys
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

### 5. Conversations and export

With **Record messages** on (the default), each number's bridge sends every message to the dashboard, which stores it in D1:

- what users send in direct chats the bot answers (senders blocked by the allowlist are not recorded),
- every message in routed groups, including ones that don't @mention the bot (marked *not for the bot*),
- everything the bot sends: agent replies, bridge notices, human alerts,
- messages someone types on the linked phone itself (marked *sent from the phone*).

Attachments are recorded as their type, file name and size, not the file itself. If the dashboard is unreachable, the runner holds up to 20,000 messages in memory and sends them when it reconnects. They are lost if the runner restarts in the meantime.

On a number's page, **Conversations** lists its chats with a search box, opens a chat as a thread, and has **Download CSV** / **Download JSON Lines** for one chat or the whole number, with an optional date range. Exports are streamed, so large ones are fine. In CSV, text that starts like a spreadsheet formula (`=`, `+`, `-`, `@`) gets a leading `'`. Every export is logged in **Activity**.

Set `MESSAGE_RETENTION_DAYS` in `wrangler.jsonc` to delete older messages every night (a cron trigger at 03:17 UTC). The default `0` keeps them. Deleting a number deletes its conversations.

The same data is available from the API (operator role):

| | |
| --- | --- |
| `GET /api/numbers/:id/chats?q=&before=&limit=` | Chats, newest first |
| `GET /api/numbers/:id/chats/:jid` | One chat: messages (oldest first) and human follow-ups |
| `GET /api/numbers/:id/export?format=csv\|jsonl&jid=&from=&to=` | Download. `from`/`to` are dates (`2026-11-01`) or epoch milliseconds |
| `GET /api/numbers/:id/handoffs?status=open\|failed\|resolved` | Human follow-ups |

### 6. Human follow-up (handoff to a person)

The dashboard is also an MCP server. It gives Archestra agents a `request_human_followup` tool: when a WhatsApp user wants a person, the agent calls it, the dashboard alerts the number's human agents **on WhatsApp, from that same number**, and the bot stays quiet in that chat so the person can take over.

```
User ─▶ bridge ─▶ Archestra agent ──tool call (MCP)──▶ Worker /mcp
                  "[chat_ref=c…] I want a human"          │ looks up the chat, picks on-duty humans
                                                          ▼
Human agent ◀── WhatsApp alert ── bridge ◀── runner ◀── Hub  (and the bot pauses in that chat)
```

1. **Archestra page** (admins): create an MCP key. In Archestra, add a remote MCP server at `https://<dashboard>/mcp` with the header `Authorization: Bearer <key>`, and assign its tools to the agent.
2. **Number settings → Human follow-up**: turn on *Let the agent ask a human to follow up*, set how long the bot stays quiet (default 60 minutes, `0` to keep answering), and add the human agents: name, WhatsApp number, optional topics (e.g. `billing, refunds`) and whether they're on duty. Saving these doesn't restart the number.
3. Add to the agent's instructions something like: *"When the user wants to talk to a person, or you can't help them, call request_human_followup with the chat_ref from the start of their message, a short reason and a summary. Then tell them someone will contact them. Never show the chat_ref."*

How it works:

- With handoff on, the bridge puts a line like `[chat_ref=cX4f…]` at the start of every message it sends to the agent. Archestra doesn't pass anything about the WhatsApp chat to MCP tools, so the agent copies this value into the tool call. The ref is random, so a user can't make the agent act on someone else's chat, and the model never sees phone numbers it wasn't told.
- The tool alerts every on-duty agent whose topics include the requested topic, plus on-duty agents with no topics. If none match the topic, every on-duty agent is alerted. The alert has the customer's name and number, a `wa.me` link, the reason, the summary, the last 10 messages, and a link to the chat in the dashboard.
- A second request for the same chat within 10 minutes doesn't alert anyone again.
- If nobody is on duty, the number isn't running, or no alert could be delivered, the tool tells the agent so, and the request is still listed as *Nobody reached*.
- The chat page shows the follow-ups and has **Pause bot** / **Resume bot**. Resuming also marks open follow-ups as resolved. Pauses are kept on the runner, so they survive restarts. They end on their own when the time is up.
- A second tool, `list_human_agent_topics`, lets the agent see which topics are covered.

The human answers the customer from their own WhatsApp. Sending messages to people who never wrote to the number is something WhatsApp watches for spam, so ask your human agents to save the bot's number as a contact.

## Users and roles

| Role | Can |
| --- | --- |
| **viewer** | See numbers, runners, live status and logs. Not QR codes, since scanning one links the scanner's phone, and not conversations. |
| **operator** | Viewer, plus add, edit and delete numbers, link them (QR or pairing code), restart and re-pair them, read and export conversations, pause or resume the bot in a chat, and see **Activity**. |
| **admin** | Operator, plus add and remove runners, issue runner tokens, manage users, and create or revoke MCP keys for Archestra. |

There are two ways to give someone access, both on the **Users** page (admins only):

- **They sign in first.** With `ALLOWED_DOMAINS` set, anyone from those domains can sign in. They see "Waiting for access" and show up under **Waiting for a role**; pick a role and press **Give access**, and they can sign in.
- **Invite them.** Enter their email and a role. They can sign in straight away; send them the dashboard link (the dashboard doesn't send email).

Change a role from the list, **Revoke** to take access away (they stay listed as waiting), or **Remove** to delete them. Changes apply at once: open tabs reload with the new role, or are signed out. You can't change your own role, and default admins (`ADMIN_EMAILS`) can only be changed in `wrangler.jsonc`.

For a Google Workspace domain such as `kitabisa.com`, sign-in also checks Google's hosted-domain (`hd`) claim, so a personal Google account registered with a `@kitabisa.com` address is refused. To allow personal Gmail accounts, add `gmail.com`. Removing a domain from `ALLOWED_DOMAINS` takes access away from its users at once (shown as **Domain not allowed**). Default admins can always sign in, whatever their domain. Zitadel has no such claim: it is your own identity provider, so the verified email from Zitadel is checked against `ALLOWED_DOMAINS` directly.

A person is identified by their email, so someone with the same email in Google and Zitadel is one user with one role, whichever button they use.

### Roles from Zitadel

Without `ZITADEL_ROLE_MAPPING`, people who sign in with Zitadel get their role on the **Users** page, like Google users. To manage dashboard roles in Zitadel instead, map Zitadel project roles to dashboard roles in `wrangler.jsonc`:

```jsonc
"ZITADEL_ROLE_MAPPING": "admin=wa-admin, operator=wa-operator, viewer=wa-viewer, viewer=staff"
```

- Each entry is `<dashboard role>=<Zitadel role key>`. Several Zitadel roles can give the same dashboard role, and someone with several gets the highest.
- The role is set at every Zitadel sign-in (shown as *role set by zitadel* on the Users page). Someone with none of the mapped roles is refused, and any role they had is removed.
- A role taken away in Zitadel applies at their next sign-in. Sessions last up to 12 hours; to cut someone off at once, also use **Revoke** on the Users page.
- Changing a mapped user's role on the Users page only lasts until they sign in with Zitadel again.
- Default admins (`ADMIN_EMAILS`) don't need a Zitadel role.
- With mapping on, people don't need an invite when `ALLOWED_DOMAINS` is empty: their Zitadel role is what lets them in.

## Security notes

- Sign-in uses the OpenID Connect code flow with PKCE, `state` and `nonce`, for both Google and Zitadel. The ID token's signature (against the provider's published keys), issuer, audience, nonce and `email_verified` are checked. Which provider a callback belongs to comes from the signed sign-in cookie, not the URL. Zitadel's discovery document must name the configured issuer, and userinfo is only used when it describes the same user (`sub`) as the ID token. The email must be in `ADMIN_EMAILS`, or be from `ALLOWED_DOMAINS` (with a matching `hd` claim for Workspace domains) and have a role.
- Sessions are HMAC-signed `__Host-` cookies (`HttpOnly`, `Secure`, `SameSite=Lax`) valid for 12 hours. Each user's role is re-checked on every request, so a role change or removal takes effect at once, and their open live connections are closed. Every API route checks the role on the server; the UI only hides what a role can't use.
- Requests that change anything, and the live WebSocket, must come from the dashboard's own origin. Pages are served with a strict Content-Security-Policy.
- Runner tokens are stored only as SHA-256 hashes. A runner can only report on numbers assigned to it.
- MCP keys are stored only as SHA-256 hashes and only work on `/mcp`, which accepts no session cookies. The handoff tool can only act on chats whose random `chat_ref` it is given, and never returns phone numbers to the agent.
- Recorded conversations are customer data: only operators and admins can read or export them, and live updates about them are sent only to their tabs. Use `MESSAGE_RETENTION_DAYS` to limit how long they are kept.
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
