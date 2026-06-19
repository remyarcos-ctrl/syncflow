-- ============================================================
-- refs_sav : références de pièces détachées SAV, livrées AVEC les
-- commandes mais JAMAIS commandées dans Centralink (hors fonctionnement
-- habituel). Quand une de ces réfs ressort « hors-commande », la détection
-- la route vers le destinataire « SAV » (visible dans le centre, mais hors
-- réclamation Colombi). On classe une réf une fois → gérée pour toujours.
-- reference_article : stockée NORMALISÉE (majuscules, O→0, alphanum).
-- ============================================================

create table if not exists refs_sav (
  reference_article text primary key,   -- normalisée
  ref_label         text,               -- libellé d'origine (affichage)
  note              text,
  created_at        timestamptz not null default now()
);

alter table refs_sav enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where tablename = 'refs_sav' and policyname = 'allow all refs_sav'
  ) then
    create policy "allow all refs_sav" on refs_sav
      for all using (true) with check (true);
  end if;
end $$;
