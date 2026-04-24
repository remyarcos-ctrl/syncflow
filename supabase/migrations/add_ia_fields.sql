-- Migration: champs IA pour les exceptions, factures et résumé dashboard
ALTER TABLE exceptions ADD COLUMN IF NOT EXISTS explication_ia text;
ALTER TABLE exceptions ADD COLUMN IF NOT EXISTS suggestion_ia text;
ALTER TABLE factures    ADD COLUMN IF NOT EXISTS anomalie_ia text;

CREATE TABLE IF NOT EXISTS rapport_ia (
  id         uuid primary key default uuid_generate_v4(),
  date_rapport date not null default current_date,
  contenu    text not null,
  created_at timestamptz not null default now()
);
