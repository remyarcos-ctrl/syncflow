-- Stock TEMPS RÉEL sur stocks_cl.
-- product/state (« État du stock ») = snapshot mis à jour à minuit. La fiche produit
-- porte le stock temps réel + le floating (réservé). La Phase B (sync_stock_moves.js)
-- lit désormais la fiche pour les réfs contrôlées et écrit le temps réel ici.
alter table public.stocks_cl
  add column if not exists floating numeric,
  add column if not exists stock_source text default 'etat';
-- 'etat'  = snapshot product/state (minuit)
-- 'fiche' = stock temps réel lu sur la fiche produit (Phase B)
comment on column public.stocks_cl.stock_cl is 'Stock dispo. source=fiche → temps réel ; source=etat → snapshot minuit (product/state)';
comment on column public.stocks_cl.floating is 'Quantité flottante (réservée) lue sur la fiche produit';
comment on column public.stocks_cl.ventes is 'Ventes 90j (compteur affiché sur la fiche, fiable)';
