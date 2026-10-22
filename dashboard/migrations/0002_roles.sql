-- Roles. Every user who signs in from an allowed domain gets a row; role NULL means they are
-- waiting for an admin to give them access. Admins can also invite an email ahead of time.
-- Existing dashboard admins keep full access.
CREATE TABLE users_new (
  email         TEXT PRIMARY KEY,
  role          TEXT CHECK (role IN ('admin', 'operator', 'viewer')),
  invited_by    TEXT,
  created_at    INTEGER NOT NULL,
  updated_by    TEXT,
  updated_at    INTEGER,
  last_login_at INTEGER
);
INSERT INTO users_new (email, role, invited_by, created_at) SELECT email, 'admin', added_by, created_at FROM users;
DROP TABLE users;
ALTER TABLE users_new RENAME TO users;
