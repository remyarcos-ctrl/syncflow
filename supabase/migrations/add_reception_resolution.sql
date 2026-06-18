-- ============================================================
-- reception_resolution : étiquetage des anomalies du contrôle réception
-- (BE ② vs commande ①). Tout ce qui est hors fonctionnement habituel
-- remonte et reste visible — on le CLASSE, on ne le cache pas.
-- classement : 'à classer' | 'pièce détachée' | 'sur-livraison Colombi'
--             | 'hors-commande Colombi' | 'commandé autrement' | 'résolu'
-- ============================================================

create table if not exists reception_resolution (
  id                uuid primary key default gen_random_uuid(),
  be_id             uuid not null,
  reference_article text not null,
  classement        text not null default 'à classer',
  note              text,
  updated_at        timestamptz not null default now(),
  unique (be_id, reference_article)
);

create index if not exists idx_reception_resolution_be on reception_resolution (be_id);

alter table reception_resolution enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'reception_resolution' and policyname = 'allow all reception_resolution'
  ) then
    create policy "allow all reception_resolution" on reception_resolution
      for all using (true) with check (true);
  end if;
end $$;
