-- Catalogue des derniers prix connus par (référence, fournisseur)
CREATE TABLE IF NOT EXISTS prix_reference (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference_article text NOT NULL,
  fournisseur text NOT NULL,
  designation text,
  pu_last numeric(12,4) NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reference_article, fournisseur)
);

ALTER TABLE prix_reference ENABLE ROW LEVEL SECURITY;
CREATE POLICY "prix_reference_read"   ON prix_reference FOR SELECT USING (true);
CREATE POLICY "prix_reference_write"  ON prix_reference FOR ALL    USING (true);

-- Trigger : met à jour le catalogue à chaque création/modif de ligne commande avec un prix
CREATE OR REPLACE FUNCTION sync_prix_reference()
RETURNS trigger AS $$
DECLARE
  v_fournisseur text;
BEGIN
  IF NEW.reference_article IS NOT NULL AND NEW.pu_commande IS NOT NULL THEN
    SELECT fournisseur INTO v_fournisseur FROM commandes WHERE id = NEW.commande_id;
    IF v_fournisseur IS NOT NULL THEN
      INSERT INTO prix_reference (reference_article, fournisseur, designation, pu_last, updated_at)
      VALUES (NEW.reference_article, v_fournisseur, NEW.designation, NEW.pu_commande, now())
      ON CONFLICT (reference_article, fournisseur) DO UPDATE
        SET pu_last     = EXCLUDED.pu_last,
            designation = COALESCE(EXCLUDED.designation, prix_reference.designation),
            updated_at  = now();
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trigger_sync_prix ON lignes_commande;
CREATE TRIGGER trigger_sync_prix
AFTER INSERT OR UPDATE OF pu_commande ON lignes_commande
FOR EACH ROW EXECUTE FUNCTION sync_prix_reference();

-- Peupler le catalogue depuis les données existantes
INSERT INTO prix_reference (reference_article, fournisseur, designation, pu_last, updated_at)
SELECT DISTINCT ON (lc.reference_article, c.fournisseur)
  lc.reference_article,
  c.fournisseur,
  lc.designation,
  lc.pu_commande,
  lc.updated_at
FROM lignes_commande lc
JOIN commandes c ON c.id = lc.commande_id
WHERE lc.reference_article IS NOT NULL
  AND lc.pu_commande IS NOT NULL
  AND c.fournisseur IS NOT NULL
ORDER BY lc.reference_article, c.fournisseur, lc.updated_at DESC
ON CONFLICT (reference_article, fournisseur) DO UPDATE
  SET pu_last     = EXCLUDED.pu_last,
      designation = COALESCE(EXCLUDED.designation, prix_reference.designation),
      updated_at  = EXCLUDED.updated_at;
