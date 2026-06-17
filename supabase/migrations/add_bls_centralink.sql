-- ============================================================
-- bls_centralink : références de bon de livraison vues côté Centralink
-- pour chaque commande (section « Bon de Livraison » de la page commande).
-- JSON : [{ "type": "be", "ref": "BE-26-06-0767" }, { "type": "note", "ref": "Oubli saisie - recep barcode" }]
--   type "be"   → vrai n° de BL → BE papier à scanner
--   type "note" → réception sans BL (note libre de la log) → à vérifier
-- Alimentée par le job sync_commandes (scrape Playwright).
-- ============================================================

alter table commandes add column if not exists bls_centralink text;
