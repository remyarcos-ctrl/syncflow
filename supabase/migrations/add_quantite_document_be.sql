-- Stocke la quantité originale du document BE avant correction manuelle
ALTER TABLE lignes_be
  ADD COLUMN IF NOT EXISTS quantite_document_be numeric DEFAULT NULL;
