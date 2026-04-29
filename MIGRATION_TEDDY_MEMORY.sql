-- Mémoire longue durée de Teddy : faits appris et préférences persistées
CREATE TABLE IF NOT EXISTS teddy_memory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cle text NOT NULL UNIQUE,
  valeur text NOT NULL,
  categorie text NOT NULL DEFAULT 'general',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE teddy_memory ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow all" ON teddy_memory FOR ALL USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION update_teddy_memory_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS teddy_memory_updated_at ON teddy_memory;
CREATE TRIGGER teddy_memory_updated_at
  BEFORE UPDATE ON teddy_memory
  FOR EACH ROW EXECUTE FUNCTION update_teddy_memory_updated_at();
