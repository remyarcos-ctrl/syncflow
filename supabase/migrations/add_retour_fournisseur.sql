-- Migration: retour fournisseur tracking on lignes_be
ALTER TABLE lignes_be
  ADD COLUMN IF NOT EXISTS statut_retour text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS motif_retour text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS date_retour_effectif date DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS date_avoir_demande date DEFAULT NULL;

-- Allowed values: a_retourner | retourne | avoir_demande | avoir_recu
ALTER TABLE lignes_be DROP CONSTRAINT IF EXISTS lignes_be_statut_retour_check;
ALTER TABLE lignes_be ADD CONSTRAINT lignes_be_statut_retour_check
  CHECK (statut_retour IN ('a_retourner', 'retourne', 'avoir_demande', 'avoir_recu'));
