-- Vide processed_thread_ids pour forcer la re-détection de tous les messages.
-- À exécuter UNE SEULE FOIS après le passage du tracking thread → message IDs.
-- Les doublons sont gérés par la détection côté code (numero_commande_interne).
UPDATE gmail_config SET processed_thread_ids = '{}';
