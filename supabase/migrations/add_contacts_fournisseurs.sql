CREATE TABLE IF NOT EXISTS contacts_fournisseurs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fournisseur text NOT NULL,
  nom text,
  email text NOT NULL,
  role text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contacts_fournisseurs_fournisseur ON contacts_fournisseurs (fournisseur);
