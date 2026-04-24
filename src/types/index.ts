// ============================================================
// Types SyncFlow — générés depuis le schéma Supabase
// ============================================================

export type StatutCommande =
  | 'ouverte'
  | 'partiellement réceptionnée'
  | 'réceptionnée'
  | 'partiellement facturée'
  | 'soldée'
  | 'en anomalie';

export type StatutBE = 'reçu' | 'partiellement facturé' | 'facturé' | 'soldé' | 'en anomalie';

export type StatutFacture =
  | 'importée'
  | 'en cours de rapprochement'
  | 'partiellement rapprochée'
  | 'rapprochée'
  | 'en anomalie';

export type StatutValidation = 'proposé' | 'validé' | 'rejeté' | 'à revoir';

export type NiveauPriorite = 'faible' | 'moyenne' | 'haute' | 'critique';

export type StatutException = 'ouverte' | 'en cours' | 'résolue' | 'ignorée';

export type TypeException =
  | 'surfacturation quantité'
  | 'réception incomplète'
  | 'écart prix'
  | 'be introuvable'
  | 'ligne non rapprochée'
  | 'prix commande manquant'
  | 'quantité incohérente'
  | 'prix incohérent';

export type ModeMatch =
  | 'automatique_be_article'
  | 'automatique_be_designation'
  | 'automatique_article'
  | 'automatique_designation_prix'
  | 'manuel'
  | 'ventilation_manuelle';

// ── Entités ───────────────────────────────────────────────────────────────────

export interface Fournisseur {
  id: string;
  nom: string;
  aliases: string | null;
  email_domaine: string | null;
  actif: boolean;
  commentaire: string | null;
  created_at: string;
  updated_at: string;
}

export interface Commande {
  id: string;
  numero_commande_interne: string;
  fournisseur: string;
  date_commande: string | null;
  source_document: string | null;
  type_source: 'email' | 'pdf' | 'csv' | 'manuel';
  email_source_id: string | null;
  montant_total_commande: number | null;
  devise: string;
  fichier_pdf: string | null;
  statut_commande: StatutCommande;
  commentaire: string | null;
  created_at: string;
  updated_at: string;
}

export interface LigneCommande {
  id: string;
  commande_id: string;
  ligne_no: number;
  reference_article: string | null;
  designation: string | null;
  quantite_commandee: number;
  pu_commande: number | null;
  montant_ht_commande: number | null;
  quantite_receptionnee_reelle: number;
  quantite_facturee: number;
  quantite_restante_a_recevoir: number;
  quantite_restante_a_facturer: number;
  statut_ligne: string | null;
  commentaire: string | null;
  created_at: string;
  updated_at: string;
}

export interface BEReception {
  id: string;
  numero_be: string;
  fournisseur: string | null;
  date_bl: string | null;
  commande_id: string | null;
  statut_be: StatutBE;
  pdf_url: string | null;
  fichier_nom: string | null;
  email_source_id: string | null;
  message_id: string | null;
  commentaire: string | null;
  created_at: string;
  updated_at: string;
}

export type StatutRetour = 'a_retourner' | 'retourne' | 'avoir_demande' | 'avoir_recu';

export interface LigneBE {
  id: string;
  be_id: string;
  ligne_no: number;
  reference_article: string | null;
  designation: string | null;
  quantite_receptionnee: number;
  quantite_document_be: number | null;
  quantite_facturee: number;
  quantite_restante_a_facturer: number;
  ligne_commande_id: string | null;
  statut_ligne_be: string | null;
  statut_retour: StatutRetour | null;
  motif_retour: string | null;
  date_retour_effectif: string | null;
  date_avoir_demande: string | null;
  avoir_facture_id: string | null;
  hors_systeme: boolean;
  commentaire: string | null;
  created_at: string;
  updated_at: string;
}

export interface ContactFournisseur {
  id: string;
  fournisseur: string;
  nom: string | null;
  email: string;
  role: string | null;
  created_at: string;
}

export interface Facture {
  id: string;
  numero_facture: string;
  fournisseur: string | null;
  date_facture: string | null;
  statut_facture: StatutFacture;
  total_ht: number | null;
  total_tva: number | null;
  total_ttc: number | null;
  devise: string;
  taux_rapprochement: number;
  pdf_url: string | null;
  fichier_nom: string | null;
  email_source_id: string | null;
  message_id: string | null;
  commentaire: string | null;
  anomalie_ia: string | null;
  created_at: string;
  updated_at: string;
}

export interface LigneFacture {
  id: string;
  facture_id: string;
  ligne_no: number;
  reference_article: string | null;
  designation: string | null;
  quantite_facturee: number;
  pu_facture: number | null;
  montant_ht: number | null;
  tva_taux: number | null;
  numero_be_detecte: string | null;
  commentaire: string | null;
  created_at: string;
  updated_at: string;
}

export interface LiaisonBECommande {
  id: string;
  be_id: string;
  commande_id: string;
  commentaire: string | null;
  created_at: string;
}

export interface LiaisonFactureCommande {
  id: string;
  facture_id: string;
  commande_id: string;
  commentaire: string | null;
  created_at: string;
}

export interface Rapprochement {
  id: string;
  facture_id: string | null;
  ligne_facture_id: string | null;
  be_id: string | null;
  ligne_be_id: string | null;
  commande_id: string | null;
  ligne_commande_id: string | null;
  quantite_rapprochee: number | null;
  montant_rapproche: number | null;
  mode_match: ModeMatch;
  score_match: number | null;
  statut_validation: StatutValidation;
  valide_par: string | null;
  date_validation: string | null;
  commentaire: string | null;
  created_at: string;
  updated_at: string;
}

export interface Exception {
  id: string;
  facture_id: string | null;
  be_id: string | null;
  commande_id: string | null;
  ligne_facture_id: string | null;
  ligne_be_id: string | null;
  type_exception: TypeException;
  niveau_priorite: NiveauPriorite;
  statut_exception: StatutException;
  motif: string | null;
  valeur_attendue: number | null;
  valeur_obtenue: number | null;
  ecart: number | null;
  commentaire: string | null;
  explication_ia: string | null;
  suggestion_ia: string | null;
  resolu_par: string | null;
  date_resolution: string | null;
  created_at: string;
  updated_at: string;
}

export interface JournalActivite {
  id: string;
  type_action: string | null;
  utilisateur: string | null;
  entite_type: string | null;
  entite_id: string | null;
  details_action: string | null;
  created_at: string;
}

export interface RegleNotification {
  id: string;
  nom_regle: string;
  type_alerte: string;
  destinataires: string;
  type_destinataires: string;
  acheteurs_emails: string | null;
  actif: boolean;
  inclure_details: boolean;
  frequence: string;
  heure_envoi: string | null;
  jour_semaine: string | null;
  commentaire: string | null;
  created_at: string;
  updated_at: string;
}

export interface TemplateEmail {
  id: string;
  nom_template: string;
  type_document: string;
  sujet: string;
  corps: string;
  signature: string | null;
  actif: boolean;
  par_defaut: boolean;
  commentaire: string | null;
  created_at: string;
  updated_at: string;
}

export interface DemandeDocument {
  id: string;
  nom_regle: string;
  type_document_reclame: string;
  fournisseur: string | null;
  jours_avant_relance: number;
  emails_fournisseur: string;
  emails_fixes: string | null;
  template_id: string | null;
  message_personnalise: string | null;
  frequence: string;
  actif: boolean;
  derniere_execution: string | null;
  commentaire: string | null;
  created_at: string;
  updated_at: string;
}

export interface FileQueue {
  id: string;
  message_id: string;
  sujet: string | null;
  expediteur: string | null;
  fournisseur: string | null;
  filename: string | null;
  attachment_id: string | null;
  pdf_url: string | null;
  be_id: string | null;
  statut: 'en_attente' | 'en_cours' | 'traité' | 'doublon' | 'erreur';
  tentatives: number;
  erreur: string | null;
  created_at: string;
  updated_at: string;
}
