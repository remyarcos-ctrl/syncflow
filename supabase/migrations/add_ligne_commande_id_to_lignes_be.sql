-- Migration : ajout de ligne_commande_id sur lignes_be
-- Nécessaire pour la logique de liaison BE ↔ Commande (scission, recalculateBalances)

alter table lignes_be
  add column if not exists ligne_commande_id uuid references lignes_commande(id) on delete set null;

create index if not exists idx_lignes_be_ligne_commande_id on lignes_be(ligne_commande_id);
