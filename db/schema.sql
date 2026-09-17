-- mark-status · סכימת בסיס נתונים (PostgreSQL 12+)
-- יוצר סכימה נפרדת, לא נוגע בשום טבלה קיימת. בטוח להרצה חוזרת.

CREATE SCHEMA IF NOT EXISTS mark_status;
SET search_path TO mark_status;

CREATE TABLE IF NOT EXISTS clients (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT        NOT NULL,
  subtitle    TEXT,
  token       TEXT        NOT NULL UNIQUE,
  version     TEXT        DEFAULT '1.0',
  is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS items (
  id           BIGSERIAL PRIMARY KEY,
  client_id    BIGINT      NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  title        TEXT        NOT NULL,
  description  TEXT,
  status       TEXT        NOT NULL DEFAULT 'work'
               CHECK (status IN ('work','wait','block','done')),
  icon         TEXT        NOT NULL DEFAULT 'circle',
  owner        TEXT,
  stage        TEXT,
  blocker      TEXT,
  bullets      JSONB       NOT NULL DEFAULT '[]'::JSONB,
  sort_order   INT         NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS items_client_idx ON items (client_id, sort_order);

CREATE TABLE IF NOT EXISTS questions (
  id          BIGSERIAL PRIMARY KEY,
  client_id   BIGINT      NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  title       TEXT        NOT NULL,
  body        TEXT,
  sort_order  INT         NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS questions_client_idx ON questions (client_id, sort_order);

CREATE TABLE IF NOT EXISTS history (
  id          BIGSERIAL PRIMARY KEY,
  client_id   BIGINT      NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  item_id     BIGINT      REFERENCES items(id) ON DELETE SET NULL,
  item_title  TEXT,
  change      TEXT        NOT NULL,
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS history_client_idx ON history (client_id, changed_at DESC);

CREATE OR REPLACE FUNCTION mark_status.touch_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS items_touch ON items;
CREATE TRIGGER items_touch BEFORE UPDATE ON items
  FOR EACH ROW EXECUTE FUNCTION mark_status.touch_updated_at();

DROP TRIGGER IF EXISTS clients_touch ON clients;
CREATE TRIGGER clients_touch BEFORE UPDATE ON clients
  FOR EACH ROW EXECUTE FUNCTION mark_status.touch_updated_at();

RESET search_path;
