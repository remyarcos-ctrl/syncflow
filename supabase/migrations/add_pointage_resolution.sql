-- ============================================================
-- pointage_resolution : suivi des décisions sur les écarts de
-- pointage (② BL papier vs ③ saisie log Centralink).
-- Principe : ③ fait foi par défaut ; un écart est REMONTÉ pour
-- analyse/décision, jamais corrigé en silence. Cette table garde
-- l'état de traitement de chaque écart (par BE + référence).
-- ============================================================

create table if not exists pointage_resolution (
  id                uuid primary key default gen_random_uuid(),
  numero_be         text not null,
  reference_article text not null,
  statut            text not null default 'à analyser',
    -- à analyser | vérifié | corrigé | accepté | ignoré
  note              text,
  resolu_par        text,
  updated_at        timestamptz not null default now(),
  unique (numero_be, reference_article)
);

create index if not exists idx_pointage_resolution_be on pointage_resolution (numero_be);

alter table pointage_resolution enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'pointage_resolution' and policyname = 'allow all pointage_resolution'
  ) then
    create policy "allow all pointage_resolution" on pointage_resolution
      for all using (true) with check (true);
  end if;
end $$;
