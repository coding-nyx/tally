-- Explicit release migration, independent of the optional Grok auth/database.
-- The runtime role needs SELECT/INSERT/UPDATE only. No direct agent SQL access.
CREATE TABLE IF NOT EXISTS tally_agent_workspaces (
  owner_id text PRIMARY KEY CHECK (length(owner_id) BETWEEN 1 AND 128),
  document jsonb NOT NULL CHECK (document->>'version' = '2'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
