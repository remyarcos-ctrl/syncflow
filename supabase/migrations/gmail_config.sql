-- Table de configuration Gmail OAuth
-- À exécuter dans l'éditeur SQL Supabase

CREATE TABLE IF NOT EXISTS gmail_config (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                TEXT NOT NULL,
  access_token         TEXT,
  refresh_token        TEXT NOT NULL,
  token_expiry         TIMESTAMPTZ,
  last_sync_at         TIMESTAMPTZ,
  processed_thread_ids TEXT[] NOT NULL DEFAULT '{}',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Un seul enregistrement par déploiement
CREATE UNIQUE INDEX IF NOT EXISTS gmail_config_single_row ON gmail_config ((true));

-- Trigger updated_at
CREATE TRIGGER set_gmail_config_updated_at
  BEFORE UPDATE ON gmail_config
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- RLS : inaccessible depuis le client (service role uniquement)
ALTER TABLE gmail_config ENABLE ROW LEVEL SECURITY;
