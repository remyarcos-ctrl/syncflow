-- ============================================================
-- saisies_cl : réceptions saisies par la log dans Centralink (③)
-- Sert à rapprocher avec le BE papier scanné (②) → détecte les
-- erreurs de pointage de la log (ex. 21 saisi vs 24 sur le BL).
-- Alimentée depuis Centralink par un job externe (scrape Playwright).
-- ============================================================

create table if not exists saisies_cl (
  id               uuid primary key default gen_random_uuid(),
  numero_be        text not null,
  reference_article text,
  ean13            text,
  quantite_recue   numeric not null default 0,
  commande_ref     text,
  source           text not null default 'centralink',
  updated_at       timestamptz not null default now()
);

create index if not exists idx_saisies_cl_numero_be on saisies_cl (numero_be);

alter table saisies_cl enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'saisies_cl' and policyname = 'allow all saisies_cl'
  ) then
    create policy "allow all saisies_cl" on saisies_cl
      for all using (true) with check (true);
  end if;
end $$;
