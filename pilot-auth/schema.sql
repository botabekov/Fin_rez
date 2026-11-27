CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  stage TEXT NOT NULL CHECK(stage IN ('verify', 'set_password', 'active')),
  expires_at INTEGER NOT NULL,
  user_id TEXT,
  email TEXT,
  purpose TEXT CHECK(purpose IN ('register', 'recover')),
  provider_token TEXT
);

CREATE INDEX IF NOT EXISTS sessions_by_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_by_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS request_limits (
  bucket TEXT PRIMARY KEY,
  requests INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_metrics (
  day TEXT NOT NULL,
  event TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY(day, event)
);
