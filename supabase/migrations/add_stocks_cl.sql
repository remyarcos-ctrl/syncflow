-- Stock Centralink par référence (scrapé depuis product/state + fiche article).
-- Sert au rapprochement stock vs réception et à écarter les faux surplus
-- (marchandise rentrée au BAR-CODE, qui ne passe pas par une réception de commande).
create table if not exists public.stocks_cl (
  reference_article   text primary key,
  ean13               text,
  titre               text,
  stock_cl            numeric,        -- quantité disponible actuelle (CL)
  prix_ht             numeric,
  has_barcode         boolean default false,  -- a des entrées bar-code (FIABLE)
  entrees_reception   numeric,        -- reconstruit depuis les mouvements (Centralink/Réception)
  entrees_barcode     numeric,        -- reconstruit (Barcode) — best-effort, peut être bruité
  ventes              numeric,        -- ventes (90 jours)
  reconstitue_ok      boolean,        -- la reconstruction (Σ entrées − ventes) retombe-t-elle sur stock_cl ?
  updated_at          timestamptz default now()
);
