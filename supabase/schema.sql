-- ============================================================
-- SyncFlow – Schéma Supabase
-- Rapprochement 3 voies : Commandes ↔ BEs ↔ Factures
-- ============================================================

-- Extensions
create extension if not exists "uuid-ossp";

-- ============================================================
-- FOURNISSEURS
-- ============================================================
create table if not exists fournisseurs (
  id          uuid primary key default uuid_generate_v4(),
  nom         text not null,
  aliases     text,
  email_domaine text,
  actif       boolean not null default true,
  commentaire text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ============================================================
-- COMMANDES
-- ============================================================
create table if not exists commandes (
  id                        uuid primary key default uuid_generate_v4(),
  numero_commande_interne   text not null unique,
  fournisseur               text not null,
  date_commande             date,
  source_document           text,
  type_source               text not null default 'manuel'
                              check (type_source in ('email','pdf','csv','manuel')),
  email_source_id           text,
  montant_total_commande    numeric(15,2),
  devise                    text not null default 'EUR',
  fichier_pdf               text,
  statut_commande           text not null default 'ouverte'
                              check (statut_commande in (
                                'ouverte','partiellement réceptionnée','réceptionnée',
                                'partiellement facturée','soldée','en anomalie'
                              )),
  commentaire               text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

-- ============================================================
-- LIGNES COMMANDE
-- ============================================================
create table if not exists lignes_commande (
  id                              uuid primary key default uuid_generate_v4(),
  commande_id                     uuid not null references commandes(id) on delete cascade,
  ligne_no                        integer not null default 1,
  reference_article               text,
  designation                     text,
  quantite_commandee              numeric(15,3) not null default 0,
  pu_commande                     numeric(15,4),
  montant_ht_commande             numeric(15,2),
  quantite_receptionnee_reelle    numeric(15,3) not null default 0,
  quantite_facturee               numeric(15,3) not null default 0,
  quantite_restante_a_recevoir    numeric(15,3) not null default 0,
  quantite_restante_a_facturer    numeric(15,3) not null default 0,
  statut_ligne                    text default 'ouverte',
  commentaire                     text,
  created_at                      timestamptz not null default now(),
  updated_at                      timestamptz not null default now()
);

-- ============================================================
-- BE RECEPTIONS (Bordereaux d'Expédition)
-- ============================================================
create table if not exists be_receptions (
  id              uuid primary key default uuid_generate_v4(),
  numero_be       text not null,
  fournisseur     text,
  date_bl         date,
  commande_id     uuid references commandes(id) on delete set null,
  statut_be       text not null default 'reçu'
                    check (statut_be in ('reçu','partiellement facturé','facturé','soldé','en anomalie')),
  pdf_url         text,
  fichier_nom     text,
  email_source_id text,
  message_id      text,
  commentaire     text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ============================================================
-- LIGNES BE
-- ============================================================
create table if not exists lignes_be (
  id                          uuid primary key default uuid_generate_v4(),
  be_id                       uuid not null references be_receptions(id) on delete cascade,
  ligne_no                    integer not null default 1,
  reference_article           text,
  designation                 text,
  quantite_receptionnee       numeric(15,3) not null default 0,
  quantite_facturee           numeric(15,3) not null default 0,
  quantite_restante_a_facturer numeric(15,3) not null default 0,
  statut_ligne_be             text default 'reçu',
  commentaire                 text,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

-- ============================================================
-- FACTURES
-- ============================================================
create table if not exists factures (
  id                    uuid primary key default uuid_generate_v4(),
  numero_facture        text not null,
  fournisseur           text,
  date_facture          date,
  statut_facture        text not null default 'importée'
                          check (statut_facture in (
                            'importée','en cours de rapprochement',
                            'partiellement rapprochée','rapprochée','en anomalie'
                          )),
  total_ht              numeric(15,2),
  total_tva             numeric(15,2),
  total_ttc             numeric(15,2),
  devise                text not null default 'EUR',
  taux_rapprochement    numeric(5,2) not null default 0,
  pdf_url               text,
  fichier_nom           text,
  email_source_id       text,
  message_id            text,
  commentaire           text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- ============================================================
-- LIGNES FACTURE
-- ============================================================
create table if not exists lignes_facture (
  id                  uuid primary key default uuid_generate_v4(),
  facture_id          uuid not null references factures(id) on delete cascade,
  ligne_no            integer not null default 1,
  reference_article   text,
  designation         text,
  quantite_facturee   numeric(15,3) not null default 0,
  pu_facture          numeric(15,4),
  montant_ht          numeric(15,2),
  tva_taux            numeric(5,2),
  numero_be_detecte   text,
  commentaire         text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- ============================================================
-- LIAISON BE ↔ COMMANDE  (many-to-many)
-- ============================================================
create table if not exists liaison_be_commande (
  id          uuid primary key default uuid_generate_v4(),
  be_id       uuid not null references be_receptions(id) on delete cascade,
  commande_id uuid not null references commandes(id) on delete cascade,
  commentaire text,
  created_at  timestamptz not null default now(),
  unique(be_id, commande_id)
);

-- ============================================================
-- LIAISON FACTURE ↔ COMMANDE  (many-to-many)
-- ============================================================
create table if not exists liaison_facture_commande (
  id          uuid primary key default uuid_generate_v4(),
  facture_id  uuid not null references factures(id) on delete cascade,
  commande_id uuid not null references commandes(id) on delete cascade,
  commentaire text,
  created_at  timestamptz not null default now(),
  unique(facture_id, commande_id)
);

-- ============================================================
-- RAPPROCHEMENTS (lignes 3 voies)
-- ============================================================
create table if not exists rapprochements (
  id                  uuid primary key default uuid_generate_v4(),
  facture_id          uuid references factures(id) on delete cascade,
  ligne_facture_id    uuid references lignes_facture(id) on delete cascade,
  be_id               uuid references be_receptions(id) on delete set null,
  ligne_be_id         uuid references lignes_be(id) on delete set null,
  commande_id         uuid references commandes(id) on delete set null,
  ligne_commande_id   uuid references lignes_commande(id) on delete set null,
  quantite_rapprochee numeric(15,3),
  montant_rapproche   numeric(15,2),
  mode_match          text not null default 'manuel'
                        check (mode_match in (
                          'automatique_be_article','automatique_be_designation',
                          'automatique_article','automatique_designation_prix',
                          'manuel','ventilation_manuelle'
                        )),
  score_match         numeric(5,2),
  statut_validation   text not null default 'proposé'
                        check (statut_validation in ('proposé','validé','rejeté','à revoir')),
  valide_par          text,
  date_validation     timestamptz,
  commentaire         text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- ============================================================
-- EXCEPTIONS / ANOMALIES
-- ============================================================
create table if not exists exceptions (
  id                uuid primary key default uuid_generate_v4(),
  facture_id        uuid references factures(id) on delete cascade,
  be_id             uuid references be_receptions(id) on delete set null,
  commande_id       uuid references commandes(id) on delete set null,
  ligne_facture_id  uuid references lignes_facture(id) on delete set null,
  ligne_be_id       uuid references lignes_be(id) on delete set null,
  type_exception    text not null
                      check (type_exception in (
                        'surfacturation quantité','réception incomplète','écart prix',
                        'be introuvable','ligne non rapprochée','prix commande manquant',
                        'quantité incohérente','prix incohérent'
                      )),
  niveau_priorite   text not null default 'moyenne'
                      check (niveau_priorite in ('faible','moyenne','haute','critique')),
  statut_exception  text not null default 'ouverte'
                      check (statut_exception in ('ouverte','en cours','résolue','ignorée')),
  motif             text,
  valeur_attendue   numeric(15,4),
  valeur_obtenue    numeric(15,4),
  ecart             numeric(15,4),
  commentaire       text,
  resolu_par        text,
  date_resolution   timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- ============================================================
-- FILE QUEUE (traitement PDF en file d'attente)
-- ============================================================
create table if not exists file_queue (
  id            uuid primary key default uuid_generate_v4(),
  message_id    text not null,
  sujet         text,
  expediteur    text,
  fournisseur   text,
  filename      text,
  attachment_id text,
  pdf_url       text,
  be_id         uuid references be_receptions(id) on delete set null,
  statut        text not null default 'en_attente'
                  check (statut in ('en_attente','en_cours','traité','doublon','erreur')),
  tentatives    integer not null default 0,
  erreur        text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ============================================================
-- JOURNAL ACTIVITE
-- ============================================================
create table if not exists journal_activite (
  id            uuid primary key default uuid_generate_v4(),
  type_action   text,
  utilisateur   text,
  entite_type   text,
  entite_id     uuid,
  details_action text,
  created_at    timestamptz not null default now()
);

-- ============================================================
-- REGLES NOTIFICATIONS
-- ============================================================
create table if not exists regles_notifications (
  id                  uuid primary key default uuid_generate_v4(),
  nom_regle           text not null,
  type_alerte         text not null
                        check (type_alerte in (
                          'exception_critique','documents_manquants','facture_manquante',
                          'be_manquant','ecart_prix','ecart_quantite',
                          'commande_non_livree','facture_non_rapprochee'
                        )),
  destinataires       text not null,
  type_destinataires  text not null default 'emails_fixes'
                        check (type_destinataires in (
                          'emails_fixes','emails_acheteurs',
                          'email_fournisseur','emails_acheteurs_et_fournisseur'
                        )),
  acheteurs_emails    text,
  actif               boolean not null default true,
  inclure_details     boolean not null default true,
  frequence           text not null default 'immediat'
                        check (frequence in ('immediat','quotidien','hebdomadaire')),
  heure_envoi         text,
  jour_semaine        text
                        check (jour_semaine in (
                          'lundi','mardi','mercredi','jeudi','vendredi','samedi','dimanche'
                        )),
  commentaire         text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- ============================================================
-- TEMPLATES EMAILS
-- ============================================================
create table if not exists templates_emails (
  id              uuid primary key default uuid_generate_v4(),
  nom_template    text not null,
  type_document   text not null
                    check (type_document in ('be_manquant','facture_manquante','les_deux')),
  sujet           text not null,
  corps           text not null,
  signature       text,
  actif           boolean not null default true,
  par_defaut      boolean not null default false,
  commentaire     text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ============================================================
-- DEMANDES DOCUMENTS
-- ============================================================
create table if not exists demandes_documents (
  id                      uuid primary key default uuid_generate_v4(),
  nom_regle               text not null,
  type_document_reclame   text not null
                            check (type_document_reclame in ('be_manquant','facture_manquante','les_deux')),
  fournisseur             text,
  jours_avant_relance     integer not null default 7,
  emails_fournisseur      text not null,
  emails_fixes            text,
  template_id             uuid references templates_emails(id) on delete set null,
  message_personnalise    text,
  frequence               text not null default 'quotidien'
                            check (frequence in ('immediat','quotidien','hebdomadaire')),
  actif                   boolean not null default true,
  derniere_execution      timestamptz,
  commentaire             text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

-- ============================================================
-- INDEXES pour les performances
-- ============================================================
create index if not exists idx_commandes_fournisseur on commandes(fournisseur);
create index if not exists idx_commandes_statut on commandes(statut_commande);
create index if not exists idx_commandes_date on commandes(date_commande);
create index if not exists idx_lignes_commande_commande_id on lignes_commande(commande_id);
create index if not exists idx_be_fournisseur on be_receptions(fournisseur);
create index if not exists idx_be_statut on be_receptions(statut_be);
create index if not exists idx_be_commande_id on be_receptions(commande_id);
create index if not exists idx_lignes_be_be_id on lignes_be(be_id);
create index if not exists idx_factures_fournisseur on factures(fournisseur);
create index if not exists idx_factures_statut on factures(statut_facture);
create index if not exists idx_factures_date on factures(date_facture);
create index if not exists idx_lignes_facture_facture_id on lignes_facture(facture_id);
create index if not exists idx_rapprochements_facture on rapprochements(facture_id);
create index if not exists idx_rapprochements_be on rapprochements(be_id);
create index if not exists idx_rapprochements_commande on rapprochements(commande_id);
create index if not exists idx_exceptions_facture on exceptions(facture_id);
create index if not exists idx_exceptions_statut on exceptions(statut_exception);
create index if not exists idx_exceptions_priorite on exceptions(niveau_priorite);
create index if not exists idx_journal_created on journal_activite(created_at desc);
create index if not exists idx_liaison_be_cmd_be on liaison_be_commande(be_id);
create index if not exists idx_liaison_be_cmd_cmd on liaison_be_commande(commande_id);
create index if not exists idx_liaison_fact_cmd_fact on liaison_facture_commande(facture_id);
create index if not exists idx_liaison_fact_cmd_cmd on liaison_facture_commande(commande_id);

-- ============================================================
-- TRIGGERS updated_at
-- ============================================================
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$ declare
  t text;
begin
  foreach t in array array[
    'fournisseurs','commandes','lignes_commande','be_receptions','lignes_be',
    'factures','lignes_facture','rapprochements','exceptions','file_queue',
    'regles_notifications','templates_emails','demandes_documents'
  ] loop
    execute format(
      'create trigger trg_%s_updated_at before update on %s for each row execute function set_updated_at()',
      t, t
    );
  end loop;
end $$;

-- ============================================================
-- RLS (Row Level Security) — désactivé par défaut, à activer selon auth Supabase
-- ============================================================
-- alter table commandes enable row level security;
-- (configurer les policies selon le besoin)
