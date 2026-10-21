-- Admins added from the dashboard. Admins listed in ADMIN_EMAILS (wrangler.jsonc) are not stored here.
CREATE TABLE users (
  email      TEXT PRIMARY KEY,
  added_by   TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Hosts that run bridge processes. Only a SHA-256 hash of each runner token is stored.
CREATE TABLE runners (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER
);

-- One row per WhatsApp number. Tokens are never stored: token_ref names an env var on the runner.
CREATE TABLE numbers (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  runner_id        TEXT REFERENCES runners(id) ON DELETE SET NULL,
  enabled          INTEGER NOT NULL DEFAULT 1,
  agent_id         TEXT NOT NULL,
  archestra_url    TEXT,
  token_ref        TEXT,
  allowed_numbers  TEXT NOT NULL DEFAULT '[]',
  media_types      TEXT,
  max_media_mb     INTEGER,
  media_inline     TEXT,
  agent_timeout_ms INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX numbers_runner ON numbers(runner_id);

-- Group / phone number -> agent routes for one WhatsApp number (same fields as routes.json)
CREATE TABLE routes (
  number_id       TEXT NOT NULL REFERENCES numbers(id) ON DELETE CASCADE,
  key             TEXT NOT NULL,
  name            TEXT,
  agent_id        TEXT NOT NULL,
  url             TEXT,
  token_ref       TEXT,
  trigger         TEXT NOT NULL DEFAULT 'mention',
  allowed_numbers TEXT,
  PRIMARY KEY (number_id, key)
);

CREATE TABLE audit_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     INTEGER NOT NULL,
  email  TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT
);
CREATE INDEX audit_log_at ON audit_log(at);
