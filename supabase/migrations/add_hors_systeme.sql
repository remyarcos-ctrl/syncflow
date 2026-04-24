-- Ligne BE reçue sans commande correspondante dans le système
ALTER TABLE lignes_be ADD COLUMN IF NOT EXISTS hors_systeme boolean NOT NULL DEFAULT false;
