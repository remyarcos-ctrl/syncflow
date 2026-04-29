-- Actions proposées par Teddy (mode supervisé)
CREATE TABLE IF NOT EXISTS teddy_actions_proposees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type_action text NOT NULL,
  description text NOT NULL,
  entite_type text,
  entite_id text,
  payload jsonb DEFAULT '{}',
  statut text NOT NULL DEFAULT 'proposée', -- proposée | approuvée | rejetée | annulée
  risque text NOT NULL DEFAULT 'low',       -- low | medium | high
  resultat text,
  created_at timestamptz DEFAULT now(),
  executed_at timestamptz
);

ALTER TABLE teddy_actions_proposees ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow all" ON teddy_actions_proposees FOR ALL USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_teddy_actions_statut ON teddy_actions_proposees(statut);
CREATE INDEX IF NOT EXISTS idx_teddy_actions_created ON teddy_actions_proposees(created_at DESC);
