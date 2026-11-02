-- Message recording, conversation export and human handoff.

-- Per-number switches. handoff_pause_minutes: how long the bot stays quiet in a chat after a
-- human was asked to follow up (NULL = default of 60, 0 = don't pause).
ALTER TABLE numbers ADD COLUMN record_messages INTEGER NOT NULL DEFAULT 1;
ALTER TABLE numbers ADD COLUMN handoff_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE numbers ADD COLUMN handoff_pause_minutes INTEGER;

-- One row per WhatsApp chat (direct chat or group) a number has talked in.
-- ref is the random chat_ref the bridge shows the agent; the handoff tool looks chats up by it.
CREATE TABLE chats (
  number_id    TEXT NOT NULL REFERENCES numbers(id) ON DELETE CASCADE,
  jid          TEXT NOT NULL,
  ref          TEXT UNIQUE,
  name         TEXT,
  phone        TEXT,
  is_group     INTEGER NOT NULL DEFAULT 0,
  first_at     INTEGER NOT NULL,
  last_at      INTEGER NOT NULL,
  paused_until INTEGER,
  PRIMARY KEY (number_id, jid)
);
CREATE INDEX chats_last ON chats(number_id, last_at);

-- Every message the bridge received for handling or sent. id comes from the bridge, so a batch
-- that is sent twice after a reconnect is only stored once.
CREATE TABLE messages (
  id          TEXT PRIMARY KEY,
  number_id   TEXT NOT NULL REFERENCES numbers(id) ON DELETE CASCADE,
  jid         TEXT NOT NULL,
  at          INTEGER NOT NULL,
  direction   TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  kind        TEXT NOT NULL,
  sender      TEXT,
  sender_name TEXT,
  text        TEXT,
  media       TEXT,
  wa_id       TEXT
);
CREATE INDEX messages_chat ON messages(number_id, jid, at);
CREATE INDEX messages_at ON messages(number_id, at);

-- People who get a WhatsApp alert when the agent asks for human follow-up
CREATE TABLE human_agents (
  id         TEXT PRIMARY KEY,
  number_id  TEXT NOT NULL REFERENCES numbers(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  phone      TEXT NOT NULL,
  topics     TEXT NOT NULL DEFAULT '[]',
  on_duty    INTEGER NOT NULL DEFAULT 1,
  position   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX human_agents_number ON human_agents(number_id);

CREATE TABLE handoffs (
  id          TEXT PRIMARY KEY,
  number_id   TEXT NOT NULL REFERENCES numbers(id) ON DELETE CASCADE,
  jid         TEXT NOT NULL,
  at          INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  summary     TEXT,
  topic       TEXT,
  urgency     TEXT NOT NULL DEFAULT 'normal',
  -- open: humans were alerted; failed: nobody could be alerted; resolved: closed from the dashboard
  status      TEXT NOT NULL CHECK (status IN ('open', 'failed', 'resolved')),
  notified    TEXT NOT NULL DEFAULT '[]',
  requested_by TEXT,
  resolved_by TEXT,
  resolved_at INTEGER
);
CREATE INDEX handoffs_chat ON handoffs(number_id, jid, at);
CREATE INDEX handoffs_status ON handoffs(number_id, status);

-- Keys Archestra uses to call the /mcp endpoint. Only a SHA-256 hash is stored.
CREATE TABLE mcp_keys (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER
);
