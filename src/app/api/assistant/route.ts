import { NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getValidToken, sendEmail } from '@/lib/gmail-api';

export const maxDuration = 60;
const supabase = createClient(
  (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim(),
  (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '').trim(),
);

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL
  ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');

const SYSTEM = `Tu es Teddy, l'assistant IA de SyncFlow pour SD Équipements / Orchidée Innovation.
Tu peux consulter les données ET exécuter des actions (suppressions, matching, validations, prix, rapprochements, envoi d'emails).
Réponds toujours en français. Sois direct et efficace. L'utilisateur est Rémy Arcos.

════════════════════════════════════════
GESTION AUTONOME DES ANOMALIES
════════════════════════════════════════
Quand l'utilisateur te demande de "gérer les anomalies", "traiter les exceptions" ou "faire le ménage" :

ÉTAPE 1 — Inventaire : appelle list_exceptions(statut=ouverte), triées par priorité.
ÉTAPE 2 — Analyse : pour chaque exception, appelle get_exception_detail pour avoir le contexte complet.
ÉTAPE 3 — Classification en 3 catégories :
  ✅ AUTO (sans confirmation) :
     - "prix commande manquant" → catalogue disponible → mettre_a_jour_lignes_commande
     - "écart prix" avec écart ≤ 5% → corriger_ecart_prix + annoter_exception
  ⚠️ AVEC AVAL (présenter + attendre "ok") :
     - "écart prix" avec écart > 5% → montrer l'écart, proposer corriger_ecart_prix ou email
     - "be introuvable" → appeler rechercher_be_pour_facture, proposer forcer_rapprochement_manuel
     - "ligne non rapprochée" → rechercher_be_pour_facture, proposer forcer_rapprochement_manuel
     - "quantité incohérente" → montrer les valeurs, proposer correction
  📧 EMAIL FOURNISSEUR (rédiger + attendre confirmation) :
     - "surfacturation quantité" → email demande d'avoir
     - "réception incomplète" → email relance livraison
     - Tout écart que tu ne peux pas corriger toi-même

ÉTAPE 4 — Résumé structuré : "J'ai analysé X anomalies : Y résolvables auto, Z nécessitent ton aval, W nécessitent un email. Je traite les Y maintenant, OK pour les Z ?"
ÉTAPE 5 — Après confirmation : exécute, puis résoudre_exceptions pour clore chaque cas traité.

Pour FORCER UN RAPPROCHEMENT MANUEL tu as besoin de : facture_id + ligne_facture_id + be_id + ligne_be_id + quantite_rapprochee. Utilise get_exception_detail pour obtenir les IDs, et rechercher_be_pour_facture si be/ligne_be manquent.

════════════════════════════════════════
ANALYSE D'IMAGES (captures Centralink)
════════════════════════════════════════
1. Extrait numéro de commande + références articles + prix unitaires HT.
2. Si commande identifiable → mettre_a_jour_lignes_commande (commande + catalogue).
3. Sinon → mettre_a_jour_prix (catalogue uniquement).

════════════════════════════════════════
ENVOI D'EMAILS
════════════════════════════════════════
1. Compose l'email complet et affiche-le avant d'envoyer.
2. Demande confirmation → n'appelle envoyer_email qu'après "oui/ok/vas-y".
3. Si contact inconnu → get_contacts_fournisseur ou demande l'adresse.
4. Signature : "Cordialement,\\nRémy Arcos\\nSD Équipements"

════════════════════════════════════════
RÈGLES GÉNÉRALES
════════════════════════════════════════
- Suppressions : lire d'abord → décrire → demander confirmation → exécuter.
- Actions non destructives (matching, validation, prix, rapprochement, résolution) : exécution directe sans confirmation sauf si écart > 5%.
- Formate les montants en euros avec séparateur de milliers.
- Après chaque action réussie, note ce qui a changé en 1 ligne.

════════════════════════════════════════
FORMATAGE DES RÉPONSES
════════════════════════════════════════
LIENS : Quand tu mentionnes une entité par son numéro, utilise un lien markdown cliquable :
- Facture : [F-2025-042](/factures?q=F-2025-042)
- Commande : [BC-2025-001](/commandes?q=BC-2025-001)
- BE : [BL-2025-010](/be-receptions?q=BL-2025-010)
- Exception : [EX-001](/exceptions?q=EX-001)

GRAPHIQUES : Pour visualiser données chiffrées (tendances, évolutions, comparaisons), utilise un bloc chart :
\`\`\`chart
type: bar
title: Évolution prix CABLE XVB
labels: Jan,Fév,Mar,Avr,Mai
values: 1.20,1.35,1.30,1.28,1.40
\`\`\`
Types disponibles : bar, line. Labels et values séparés par des virgules. Max 12 points.

════════════════════════════════════════
MÉMOIRE PERSISTANTE
════════════════════════════════════════
Utilise sauvegarder_memoire_teddy pour retenir des faits importants :
- Prix négociés ou seuils d'acceptation par fournisseur
- Préférences de travail de Rémy
- Informations sur les fournisseurs clés
- Règles métier spécifiques à SD Équipements
Rappelle-toi de ce qui est déjà mémorisé (visible dans le système) avant de poser des questions déjà connues.

════════════════════════════════════════
PROACTIVITÉ
════════════════════════════════════════
Pendant toute conversation, si tu remarques quelque chose d'important (BE en retard, facture échue, doublon potentiel, anomalie), signale-le spontanément AVANT de répondre à la question principale. Une phrase suffit : "Au passage, j'ai remarqué que...".
Si c'est le PREMIER message de la conversation (aucun message assistant dans l'historique), appelle get_morning_brief en premier pour avoir le contexte complet du jour avant de répondre.

════════════════════════════════════════
WORKFLOWS EN CHAÎNE
════════════════════════════════════════
Tu peux enchaîner autant d'outils que nécessaire en une seule demande. Si l'utilisateur dit "traite toutes les factures non rapprochées", appelle lancer_matching en boucle pour chacune. Si il dit "exporte puis envoie-moi le rapport", enchaîne generer_rapport → exporter_donnees. Pas besoin de confirmation entre les étapes d'un même workflow sauf si une étape est destructive.

════════════════════════════════════════
MÉMOIRE DE SESSION
════════════════════════════════════════
Tu as accès à tout l'historique de la conversation en cours. Si l'utilisateur dit "la commande dont on parlait", "le fournisseur mentionné", retrouve l'info dans les messages précédents sans demander. Utilise le contexte de session pour éviter les questions redondantes.`;

const tools = [
  // ── Lecture ──────────────────────────────────────────────────────────────────
  {
    name: 'get_morning_brief',
    description: 'Résumé complet de la journée : exceptions actives par priorité, BEs anciens non facturés (>7j), rapprochements en attente avec score moyen, activité des dernières 24h, commandes en anomalie. Utiliser quand l\'utilisateur demande un briefing ou résumé du jour.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_kpis',
    description: 'KPIs globaux : factures par statut, taux moyen rapprochement, exceptions ouvertes, BEs en attente',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_factures',
    description: 'Liste les factures. Retourne id, numero, fournisseur, date, montant, statut, taux.',
    input_schema: {
      type: 'object',
      properties: {
        statut: { type: 'string', description: 'importée | en cours de rapprochement | partiellement rapprochée | rapprochée | en anomalie' },
        fournisseur: { type: 'string' },
        date_debut: { type: 'string', description: 'YYYY-MM-DD' },
        date_fin: { type: 'string', description: 'YYYY-MM-DD' },
        limit: { type: 'number', description: 'défaut 15, max 200' },
      },
      required: [],
    },
  },
  {
    name: 'list_be_receptions',
    description: 'Liste les bons d\'entrée. Retourne id, numero_be, fournisseur, date, statut.',
    input_schema: {
      type: 'object',
      properties: {
        statut: { type: 'string', description: 'reçu | partiellement facturé | facturé | soldé | en anomalie' },
        fournisseur: { type: 'string' },
        date_debut: { type: 'string' },
        date_fin: { type: 'string' },
        limit: { type: 'number', description: 'défaut 15, max 200' },
      },
      required: [],
    },
  },
  {
    name: 'list_commandes',
    description: 'Liste les commandes. Retourne id, numero, fournisseur, date, montant, statut.',
    input_schema: {
      type: 'object',
      properties: {
        statut: { type: 'string', description: 'ouverte | partiellement réceptionnée | réceptionnée | partiellement facturée | soldée | en anomalie' },
        fournisseur: { type: 'string' },
        limit: { type: 'number', description: 'défaut 15, max 200' },
      },
      required: [],
    },
  },
  {
    name: 'list_exceptions',
    description: 'Liste les exceptions. Retourne id, type, priorité, statut, motif, écart.',
    input_schema: {
      type: 'object',
      properties: {
        statut: { type: 'string', description: 'ouverte | en cours | résolue | ignorée' },
        type_exception: { type: 'string' },
        niveau_priorite: { type: 'string', description: 'faible | moyenne | haute | critique' },
        limit: { type: 'number' },
      },
      required: [],
    },
  },
  {
    name: 'list_rapprochements',
    description: 'Liste les rapprochements avec leur statut de validation.',
    input_schema: {
      type: 'object',
      properties: {
        statut_validation: { type: 'string', description: 'proposé | validé | rejeté | à revoir' },
        score_min: { type: 'number', description: 'Score minimum (0-1)' },
        limit: { type: 'number' },
      },
      required: [],
    },
  },
  {
    name: 'get_fournisseur_stats',
    description: 'Stats par fournisseur : nb factures, montant total HT, taux moyen',
    input_schema: {
      type: 'object',
      properties: { fournisseur: { type: 'string' } },
      required: [],
    },
  },
  {
    name: 'get_activite_recente',
    description: 'Journal des dernières actions',
    input_schema: {
      type: 'object',
      properties: { limit: { type: 'number', description: '1-20, défaut 10' } },
      required: [],
    },
  },

  {
    name: 'get_tendances',
    description: 'Analyse les tendances sur N mois : évolution des prix par article/fournisseur, taux de rapprochement par mois, fréquence des anomalies par fournisseur, volumes de commandes.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'prix | rapprochements | anomalies | commandes' },
        fournisseur: { type: 'string' },
        reference_article: { type: 'string', description: 'Pour type=prix : filtrer sur une référence' },
        mois: { type: 'number', description: 'Période en mois (défaut 6, max 24)' },
      },
      required: ['type'],
    },
  },
  {
    name: 'recherche_avancee',
    description: 'Recherche multi-critères combinés : montant min/max, période, statut, fournisseur, texte — sur factures, commandes, BEs, exceptions ou rapprochements.',
    input_schema: {
      type: 'object',
      properties: {
        entite: { type: 'string', description: 'factures | commandes | be_receptions | exceptions | rapprochements' },
        fournisseur: { type: 'string' },
        statut: { type: 'string' },
        montant_min: { type: 'number' },
        montant_max: { type: 'number' },
        date_debut: { type: 'string', description: 'YYYY-MM-DD' },
        date_fin: { type: 'string', description: 'YYYY-MM-DD' },
        texte: { type: 'string', description: 'Recherche dans le numéro ou la désignation' },
        limit: { type: 'number', description: 'Max résultats, défaut 20' },
      },
      required: ['entite'],
    },
  },
  {
    name: 'traitement_conditionnel',
    description: 'Exécute une action en masse avec filtres composés : valider rapprochements par score + fournisseur + période, résoudre/ignorer anomalies avec écart sous un seuil, etc.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'valider_rapprochements | resoudre_exceptions | ignorer_exceptions' },
        filtres: {
          type: 'object',
          properties: {
            fournisseur: { type: 'string' },
            score_min: { type: 'number', description: 'Pour valider_rapprochements' },
            ecart_max_pct: { type: 'number', description: 'Pour exceptions : résoudre si |écart| ≤ X%' },
            type_exception: { type: 'string' },
            date_debut: { type: 'string' },
            date_fin: { type: 'string' },
          },
        },
        commentaire: { type: 'string' },
      },
      required: ['action'],
    },
  },
  {
    name: 'exporter_csv',
    description: 'Génère un fichier CSV téléchargeable directement dans le chat (compatible Excel, encodage UTF-8 BOM).',
    input_schema: {
      type: 'object',
      properties: {
        entite: { type: 'string', description: 'be_non_factures | factures | commandes | exceptions' },
        fournisseur: { type: 'string' },
        statut: { type: 'string' },
        date_debut: { type: 'string', description: 'YYYY-MM-DD' },
        date_fin: { type: 'string', description: 'YYYY-MM-DD' },
      },
      required: ['entite'],
    },
  },

  // ── Agent autonome ────────────────────────────────────────────────────────────
  {
    name: 'analyser_et_proposer',
    description: 'Lance l\'analyse autonome : Teddy inspecte les exceptions, rapprochements, prix manquants et BEs anciens, puis génère la liste des actions proposées. À utiliser quand l\'utilisateur demande à Teddy de préparer des actions ou de faire une analyse proactive.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'voir_actions_proposees',
    description: 'Affiche les actions proposées par Teddy en attente d\'approbation, avec leur description et risque.',
    input_schema: {
      type: 'object',
      properties: {
        statut: { type: 'string', enum: ['proposée', 'approuvée', 'rejetée'], description: 'Filtrer par statut' },
      },
      required: [],
    },
  },
  {
    name: 'approuver_actions_teddy',
    description: 'Approuve et exécute des actions proposées par Teddy. Peut approuver toutes les actions ou une liste d\'IDs.',
    input_schema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: 'IDs des actions à approuver. Vide + tous=true pour tout approuver.' },
        tous: { type: 'boolean', description: 'Approuver toutes les actions proposées' },
        type_action: { type: 'string', description: 'Approuver uniquement les actions de ce type (ex: resoudre_exception)' },
      },
      required: [],
    },
  },
  {
    name: 'rejeter_actions_teddy',
    description: 'Rejette des actions proposées sans les exécuter.',
    input_schema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' } },
        tous: { type: 'boolean' },
      },
      required: [],
    },
  },

  // ── Mémoire persistante ───────────────────────────────────────────────────────
  {
    name: 'lire_memoire_teddy',
    description: 'Lire un fait mémorisé ou toute la mémoire persistante (faits appris sur les fournisseurs, prix, préférences).',
    input_schema: {
      type: 'object',
      properties: {
        cle: { type: 'string', description: 'Clé spécifique à lire. Si vide, retourne toute la mémoire.' },
        categorie: { type: 'string', description: 'Filtrer par catégorie : prix, fournisseur, regle, preference, autre' },
      },
      required: [],
    },
  },
  {
    name: 'sauvegarder_memoire_teddy',
    description: 'Sauvegarder un fait important dans la mémoire persistante (survit aux conversations). Utiliser pour prix négociés, préférences, règles métier.',
    input_schema: {
      type: 'object',
      properties: {
        cle: { type: 'string', description: 'Identifiant court unique (ex: seuil_ecart_colombi, email_contact_sonepar)' },
        valeur: { type: 'string', description: 'Valeur ou description du fait à mémoriser' },
        categorie: { type: 'string', enum: ['prix', 'fournisseur', 'regle', 'preference', 'autre'], description: 'Catégorie' },
      },
      required: ['cle', 'valeur'],
    },
  },

  // ── Édition entités ──────────────────────────────────────────────────────────
  {
    name: 'modifier_commande',
    description: 'Modifie les champs d\'une commande : numéro, fournisseur, date, montant, statut. Utiliser l\'ID ou le numero_commande_interne pour identifier la commande.',
    input_schema: {
      type: 'object',
      properties: {
        commande_id: { type: 'string', description: 'ID UUID de la commande' },
        numero_commande_interne: { type: 'string', description: 'Numéro de commande pour recherche si ID inconnu' },
        champs: {
          type: 'object',
          description: 'Champs à modifier (seulement ceux à changer)',
          properties: {
            numero_commande_interne: { type: 'string' },
            fournisseur: { type: 'string' },
            date_commande: { type: 'string', description: 'Format YYYY-MM-DD' },
            montant_total_commande: { type: 'number' },
            statut_commande: { type: 'string', enum: ['ouverte', 'partiellement réceptionnée', 'soldée', 'en anomalie', 'annulée'] },
          },
        },
      },
      required: ['champs'],
    },
  },
  {
    name: 'modifier_ligne_commande',
    description: 'Modifie une ligne de commande : désignation, référence, quantité commandée, prix unitaire.',
    input_schema: {
      type: 'object',
      properties: {
        ligne_id: { type: 'string', description: 'ID UUID de la ligne' },
        commande_id: { type: 'string', description: 'ID de la commande pour lister ses lignes si ligne_id inconnu' },
        ligne_no: { type: 'number', description: 'Numéro de ligne si ligne_id inconnu' },
        champs: {
          type: 'object',
          properties: {
            designation: { type: 'string' },
            reference_article: { type: 'string' },
            quantite_commandee: { type: 'number' },
            pu_commande: { type: 'number' },
          },
        },
      },
      required: ['champs'],
    },
  },
  {
    name: 'modifier_facture',
    description: 'Modifie les champs d\'une facture : numéro, fournisseur, date, échéance, montant HT/TTC, statut, notes.',
    input_schema: {
      type: 'object',
      properties: {
        facture_id: { type: 'string', description: 'ID UUID de la facture' },
        numero_facture: { type: 'string', description: 'Numéro de facture pour recherche si ID inconnu' },
        champs: {
          type: 'object',
          properties: {
            numero_facture: { type: 'string' },
            fournisseur: { type: 'string' },
            date_facture: { type: 'string', description: 'Format YYYY-MM-DD' },
            date_echeance: { type: 'string', description: 'Format YYYY-MM-DD' },
            montant_ht: { type: 'number' },
            montant_ttc: { type: 'number' },
            statut_facture: { type: 'string', enum: ['en attente', 'rapprochée', 'validée', 'rejetée', 'annulée', 'avoir'] },
            notes: { type: 'string' },
          },
        },
      },
      required: ['champs'],
    },
  },
  {
    name: 'modifier_ligne_facture',
    description: 'Modifie une ligne de facture : désignation, référence, quantité, prix unitaire.',
    input_schema: {
      type: 'object',
      properties: {
        ligne_id: { type: 'string', description: 'ID UUID de la ligne' },
        facture_id: { type: 'string', description: 'ID de la facture pour lister ses lignes si ligne_id inconnu' },
        ligne_no: { type: 'number', description: 'Numéro de ligne si ligne_id inconnu' },
        champs: {
          type: 'object',
          properties: {
            designation: { type: 'string' },
            reference_article: { type: 'string' },
            quantite_facturee: { type: 'number' },
            pu_facture: { type: 'number' },
          },
        },
      },
      required: ['champs'],
    },
  },
  {
    name: 'modifier_be',
    description: 'Modifie les champs d\'un bon d\'entrée : numéro, fournisseur, date réception, statut, notes.',
    input_schema: {
      type: 'object',
      properties: {
        be_id: { type: 'string', description: 'ID UUID du BE' },
        numero_be: { type: 'string', description: 'Numéro BE pour recherche si ID inconnu' },
        champs: {
          type: 'object',
          properties: {
            numero_be: { type: 'string' },
            fournisseur: { type: 'string' },
            date_reception: { type: 'string', description: 'Format YYYY-MM-DD' },
            statut_be: { type: 'string', enum: ['reçu', 'partiellement facturé', 'facturé', 'soldé'] },
            notes: { type: 'string' },
          },
        },
      },
      required: ['champs'],
    },
  },

  // ── Actions ───────────────────────────────────────────────────────────────────
  {
    name: 'supprimer_factures',
    description: 'Supprime des factures et toutes leurs données liées (lignes, rapprochements, liaisons). TOUJOURS confirmer avant d\'appeler cet outil.',
    input_schema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: 'IDs spécifiques à supprimer' },
        statut: { type: 'string', description: 'Supprimer toutes les factures avec ce statut' },
        fournisseur: { type: 'string', description: 'Supprimer toutes les factures de ce fournisseur (partiel)' },
        tous: { type: 'boolean', description: 'Supprimer TOUTES les factures' },
      },
      required: [],
    },
  },
  {
    name: 'supprimer_bes',
    description: 'Supprime des BEs et leurs lignes/liaisons. TOUJOURS confirmer avant d\'appeler cet outil.',
    input_schema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' } },
        statut: { type: 'string' },
        fournisseur: { type: 'string' },
        tous: { type: 'boolean' },
      },
      required: [],
    },
  },
  {
    name: 'supprimer_commandes',
    description: 'Supprime des commandes et leurs lignes/liaisons. TOUJOURS confirmer avant d\'appeler cet outil.',
    input_schema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' } },
        statut: { type: 'string' },
        fournisseur: { type: 'string' },
        tous: { type: 'boolean' },
      },
      required: [],
    },
  },
  {
    name: 'supprimer_exceptions',
    description: 'Supprime des exceptions. TOUJOURS confirmer avant d\'appeler cet outil.',
    input_schema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' } },
        statut: { type: 'string' },
        tous: { type: 'boolean' },
      },
      required: [],
    },
  },
  {
    name: 'lancer_matching',
    description: 'Lance le matching automatique pour une ou plusieurs factures. Pas besoin de confirmation.',
    input_schema: {
      type: 'object',
      properties: {
        facture_id: { type: 'string', description: 'ID d\'une facture spécifique' },
        toutes_non_rapprochees: { type: 'boolean', description: 'Lancer sur toutes les factures importées ou partiellement rapprochées' },
      },
      required: [],
    },
  },
  {
    name: 'valider_rapprochements',
    description: 'Valide des rapprochements proposés. Pas besoin de confirmation.',
    input_schema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: 'IDs de rapprochements à valider' },
        facture_id: { type: 'string', description: 'Valider tous les rapprochements proposés d\'une facture' },
        score_min: { type: 'number', description: 'Valider tous les rapprochements avec score >= cette valeur (0-1)' },
      },
      required: [],
    },
  },
  {
    name: 'resoudre_exceptions',
    description: 'Résout ou ignore des exceptions. Pas besoin de confirmation.',
    input_schema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' } },
        nouveau_statut: { type: 'string', description: 'résolue | ignorée' },
        commentaire: { type: 'string' },
      },
      required: ['nouveau_statut'],
    },
  },
  {
    name: 'lancer_scan_gmail',
    description: 'Lance le scan Gmail pour importer les nouvelles commandes. Pas besoin de confirmation.',
    input_schema: {
      type: 'object',
      properties: {
        fournisseur: { type: 'string', description: 'Si fourni, importe uniquement les commandes de ce fournisseur (filtre partiel, insensible à la casse)' },
        force: { type: 'boolean', description: 'Si true, re-scanne même les messages déjà traités (utile si un email a été raté lors d\'un scan précédent)' },
      },
      required: [],
    },
  },
  {
    name: 'mettre_a_jour_prix',
    description: 'Met à jour le catalogue de prix (prix_reference) avec les prix extraits d\'une image ou fournis manuellement. Pas besoin de confirmation.',
    input_schema: {
      type: 'object',
      properties: {
        articles: {
          type: 'array',
          description: 'Liste des articles avec leur prix',
          items: {
            type: 'object',
            properties: {
              reference_article: { type: 'string', description: 'Référence article' },
              pu: { type: 'number', description: 'Prix unitaire HT' },
              designation: { type: 'string', description: 'Désignation (optionnel)' },
              fournisseur: { type: 'string', description: 'Fournisseur (optionnel)' },
            },
            required: ['reference_article', 'pu'],
          },
        },
      },
      required: ['articles'],
    },
  },
  {
    name: 'get_exception_detail',
    description: 'Retourne le contexte complet d\'une ou plusieurs exceptions : données exception + facture liée + ligne facture + BE + ligne BE + commande. Indispensable pour diagnostiquer et trouver les IDs nécessaires au rapprochement manuel.',
    input_schema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: 'IDs des exceptions à détailler' },
        statut: { type: 'string', description: 'Filtrer par statut si ids non fournis' },
        limit: { type: 'number', description: 'Max 20' },
      },
      required: [],
    },
  },
  {
    name: 'corriger_ecart_prix',
    description: 'Corrige le prix unitaire d\'une ligne de commande (pu_commande) et recalcule le montant total. Optionnellement met à jour le catalogue.',
    input_schema: {
      type: 'object',
      properties: {
        ligne_commande_id: { type: 'string', description: 'ID direct de la ligne commande (prioritaire)' },
        commande_id: { type: 'string', description: 'ID de la commande (si ligne_commande_id non connu)' },
        reference_article: { type: 'string', description: 'Référence article pour trouver la ligne dans la commande' },
        nouveau_pu: { type: 'number', description: 'Nouveau prix unitaire HT à appliquer' },
        mettre_a_jour_catalogue: { type: 'boolean', description: 'Si true, met aussi à jour prix_reference' },
      },
      required: ['nouveau_pu'],
    },
  },
  {
    name: 'forcer_rapprochement_manuel',
    description: 'Crée un rapprochement manuel entre une ligne de facture et une ligne de BE, en contournant le matching automatique. Nécessite les IDs exacts (obtenus via get_exception_detail ou rechercher_be_pour_facture).',
    input_schema: {
      type: 'object',
      properties: {
        facture_id: { type: 'string', description: 'ID de la facture' },
        ligne_facture_id: { type: 'string', description: 'ID de la ligne facture à rapprocher' },
        be_id: { type: 'string', description: 'ID du BE' },
        ligne_be_id: { type: 'string', description: 'ID de la ligne BE à rapprocher' },
        quantite_rapprochee: { type: 'number', description: 'Quantité à rapprocher' },
        montant_rapproche: { type: 'number', description: 'Montant HT à rapprocher (optionnel)' },
      },
      required: ['facture_id', 'ligne_facture_id', 'be_id', 'ligne_be_id', 'quantite_rapprochee'],
    },
  },
  {
    name: 'rechercher_be_pour_facture',
    description: 'Cherche les BEs et lignes BE qui pourraient correspondre à une facture non rapprochée ou dont le BE est introuvable. Retourne les lignes BE candidates avec leurs IDs.',
    input_schema: {
      type: 'object',
      properties: {
        facture_id: { type: 'string', description: 'ID de la facture à rapprocher' },
      },
      required: ['facture_id'],
    },
  },
  {
    name: 'annoter_exception',
    description: 'Enregistre dans la base l\'explication et la suggestion de résolution générées par l\'IA sur une exception.',
    input_schema: {
      type: 'object',
      properties: {
        exception_id: { type: 'string' },
        explication: { type: 'string', description: 'Explication de la cause de l\'anomalie' },
        suggestion: { type: 'string', description: 'Action recommandée pour résoudre l\'anomalie' },
      },
      required: ['exception_id'],
    },
  },
  {
    name: 'get_contacts_fournisseur',
    description: 'Retourne les contacts (emails) enregistrés pour un fournisseur donné.',
    input_schema: {
      type: 'object',
      properties: {
        fournisseur: { type: 'string', description: 'Nom partiel du fournisseur' },
      },
      required: ['fournisseur'],
    },
  },
  {
    name: 'envoyer_email',
    description: 'Envoie un email depuis le compte Gmail de l\'utilisateur. TOUJOURS montrer le contenu à l\'utilisateur et attendre confirmation avant d\'appeler cet outil.',
    input_schema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Adresse email du destinataire' },
        subject: { type: 'string', description: 'Sujet de l\'email' },
        body: { type: 'string', description: 'Corps de l\'email (texte brut, inclure la signature)' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'mettre_a_jour_lignes_commande',
    description: 'Met à jour les prix unitaires (pu_commande) des lignes d\'une commande existante. Cherche la commande par numéro, puis met à jour chaque ligne correspondant aux références. Met aussi à jour le catalogue prix_reference. Pas besoin de confirmation.',
    input_schema: {
      type: 'object',
      properties: {
        numero_commande: { type: 'string', description: 'Numéro de la commande (ex: CMD-2024-001)' },
        lignes: {
          type: 'array',
          description: 'Lignes à mettre à jour',
          items: {
            type: 'object',
            properties: {
              reference_article: { type: 'string', description: 'Référence article' },
              pu: { type: 'number', description: 'Prix unitaire HT' },
              designation: { type: 'string', description: 'Désignation (optionnel)' },
            },
            required: ['reference_article', 'pu'],
          },
        },
      },
      required: ['numero_commande', 'lignes'],
    },
  },
  {
    name: 'get_detail_commande',
    description: 'Retourne le détail complet d\'une commande : entête + toutes les lignes avec quantités commandées/reçues/facturées et prix.',
    input_schema: {
      type: 'object',
      properties: {
        commande_id: { type: 'string', description: 'ID de la commande' },
        numero_commande: { type: 'string', description: 'Numéro de commande (alternatif à commande_id)' },
      },
      required: [],
    },
  },
  {
    name: 'get_detail_be',
    description: 'Retourne le détail complet d\'un BE : entête + toutes les lignes avec quantités et statuts d\'attribution.',
    input_schema: {
      type: 'object',
      properties: {
        be_id: { type: 'string', description: 'ID du BE' },
        numero_be: { type: 'string', description: 'Numéro de BE (alternatif à be_id)' },
      },
      required: [],
    },
  },
  {
    name: 'lier_be_commande',
    description: 'Lie un BE à une commande. Distribue les lignes BE sur les lignes commande par référence article (FIFO). Pas besoin de confirmation.',
    input_schema: {
      type: 'object',
      properties: {
        be_id: { type: 'string', description: 'ID du BE à lier' },
        commande_id: { type: 'string', description: 'ID de la commande cible' },
      },
      required: ['be_id', 'commande_id'],
    },
  },
  {
    name: 'get_alertes',
    description: 'Retourne les alertes et notifications actives (non lues) : BEs non liés, commandes en anomalie, rapprochements en attente, etc.',
    input_schema: {
      type: 'object',
      properties: {
        lu: { type: 'boolean', description: 'Si false (défaut), retourne uniquement les non lues' },
      },
      required: [],
    },
  },
  {
    name: 'creer_commande',
    description: 'Crée une nouvelle commande avec ses lignes articles. Pas besoin de confirmation.',
    input_schema: {
      type: 'object',
      properties: {
        numero_commande_interne: { type: 'string', description: 'Numéro de commande (ex: BC-2025-042)' },
        fournisseur: { type: 'string', description: 'Nom du fournisseur' },
        date_commande: { type: 'string', description: 'Date YYYY-MM-DD' },
        lignes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              reference_article: { type: 'string' },
              designation: { type: 'string' },
              quantite_commandee: { type: 'number' },
              pu_commande: { type: 'number' },
            },
            required: ['reference_article', 'quantite_commandee'],
          },
        },
      },
      required: ['numero_commande_interne', 'fournisseur'],
    },
  },
  {
    name: 'analyser_patterns_fournisseur',
    description: 'Analyse les patterns historiques d\'un fournisseur : retards de livraison, taux d\'anomalies, variations de prix. Sauvegarde automatiquement les insights dans la mémoire. Utiliser quand l\'utilisateur demande d\'analyser un fournisseur ou de mémoriser ses habitudes.',
    input_schema: {
      type: 'object',
      properties: {
        fournisseur: { type: 'string', description: 'Nom du fournisseur (partiel accepté)' },
        sauvegarder: { type: 'boolean', description: 'Si true, sauvegarde les patterns en mémoire (défaut: true)' },
      },
      required: ['fournisseur'],
    },
  },
  {
    name: 'recherche_globale',
    description: 'Recherche dans toutes les tables simultanément (commandes, factures, BEs, exceptions) par mot-clé, fournisseur ou période. Utiliser quand l\'utilisateur cherche quelque chose sans préciser le type.',
    input_schema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Mot-clé : numéro, fournisseur, référence...' },
        fournisseur: { type: 'string', description: 'Filtre fournisseur (partiel)' },
        date_debut: { type: 'string', description: 'Date début YYYY-MM-DD' },
        date_fin: { type: 'string', description: 'Date fin YYYY-MM-DD' },
      },
      required: [],
    },
  },
  {
    name: 'get_echeances',
    description: 'Retourne les factures dont l\'échéance approche ou est dépassée. Utiliser pour "quelles factures arrivent à échéance ?", "factures en retard de paiement".',
    input_schema: {
      type: 'object',
      properties: {
        jours: { type: 'number', description: 'Horizon en jours (défaut: 30). Ex: 7 = échéances dans les 7 prochains jours.' },
        inclure_retard: { type: 'boolean', description: 'Si true, inclut aussi les factures déjà en retard (défaut: true)' },
      },
      required: [],
    },
  },
  {
    name: 'detecter_doublons',
    description: 'Détecte les factures potentiellement en double : même numéro, ou même fournisseur + même montant + dates proches. Utiliser quand l\'utilisateur demande "y a-t-il des doublons ?".',
    input_schema: {
      type: 'object',
      properties: {
        fournisseur: { type: 'string', description: 'Limiter la recherche à un fournisseur (optionnel)' },
      },
      required: [],
    },
  },
  {
    name: 'creer_facture',
    description: 'Crée une nouvelle facture manuellement. Pas besoin de confirmation.',
    input_schema: {
      type: 'object',
      properties: {
        numero_facture: { type: 'string', description: 'Numéro de facture' },
        fournisseur: { type: 'string', description: 'Nom du fournisseur' },
        date_facture: { type: 'string', description: 'Date YYYY-MM-DD' },
        date_echeance: { type: 'string', description: 'Date d\'échéance YYYY-MM-DD (optionnel)' },
        total_ht: { type: 'number', description: 'Montant HT' },
        montant_ttc: { type: 'number', description: 'Montant TTC (optionnel)' },
        notes: { type: 'string', description: 'Notes (optionnel)' },
      },
      required: ['numero_facture', 'fournisseur'],
    },
  },
  {
    name: 'creer_be',
    description: 'Crée un nouveau bordereau d\'entrée (BE/réception) manuellement. Pas besoin de confirmation.',
    input_schema: {
      type: 'object',
      properties: {
        numero_be: { type: 'string', description: 'Numéro du BE' },
        fournisseur: { type: 'string', description: 'Nom du fournisseur' },
        date_bl: { type: 'string', description: 'Date du BL YYYY-MM-DD' },
        date_reception: { type: 'string', description: 'Date de réception YYYY-MM-DD (défaut: aujourd\'hui)' },
        notes: { type: 'string', description: 'Notes (optionnel)' },
      },
      required: ['numero_be', 'fournisseur'],
    },
  },
  {
    name: 'audit_complet',
    description: 'Audit complet de la santé de la base : factures non rapprochées depuis >30j, BEs anciens, commandes en anomalie, exceptions non résolues, rapprochements à score faible. Retourne un score global /100 et la liste de tous les points d\'attention. Utiliser quand l\'utilisateur demande "fais un audit", "état de la base", "bilan complet".',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'generer_rapport',
    description: 'Génère un rapport de synthèse sur une période donnée : KPIs clés, activité, top fournisseurs, taux de rapprochement. Utiliser pour "rapport de la semaine/du mois", "bilan mensuel".',
    input_schema: {
      type: 'object',
      properties: {
        periode: { type: 'string', description: '"semaine" (7j) ou "mois" (30j) — défaut: mois' },
        fournisseur: { type: 'string', description: 'Limiter le rapport à un fournisseur (optionnel)' },
      },
      required: [],
    },
  },
  {
    name: 'comparer_fournisseurs',
    description: 'Compare 2 fournisseurs ou plus sur les 6 derniers mois : nombre de commandes, montants, taux d\'anomalies, délais, BEs anciens. Utiliser quand l\'utilisateur veut comparer des fournisseurs.',
    input_schema: {
      type: 'object',
      properties: {
        fournisseurs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Liste des fournisseurs à comparer (minimum 2)',
        },
      },
      required: ['fournisseurs'],
    },
  },
  {
    name: 'exporter_donnees',
    description: 'Exporte des données en CSV (commandes, factures, be_receptions, exceptions) avec filtres optionnels. Génère un fichier téléchargeable. Utiliser quand l\'utilisateur demande un export ou "donne-moi les données en CSV".',
    input_schema: {
      type: 'object',
      properties: {
        entite: { type: 'string', description: 'commandes | factures | be_receptions | exceptions' },
        fournisseur: { type: 'string', description: 'Filtre fournisseur (optionnel)' },
        statut: { type: 'string', description: 'Filtre statut (optionnel)' },
        date_debut: { type: 'string', description: 'Date début YYYY-MM-DD (optionnel)' },
        date_fin: { type: 'string', description: 'Date fin YYYY-MM-DD (optionnel)' },
      },
      required: ['entite'],
    },
  },
  {
    name: 'get_historique_prix',
    description: 'Retourne l\'historique complet des prix d\'une référence article : toutes les commandes qui l\'ont utilisée, prix min/max/moyen, évolution dans le temps. Utiliser pour "historique prix de REF", "évolution du prix de...".',
    input_schema: {
      type: 'object',
      properties: {
        reference_article: { type: 'string', description: 'Référence article exacte' },
        fournisseur: { type: 'string', description: 'Filtrer par fournisseur (optionnel)' },
      },
      required: ['reference_article'],
    },
  },
  {
    name: 'get_bes_sur_factures',
    description: 'Retourne la liste des numéros de BE présents sur les factures (détectés dans le PDF ou rapprochés). Pour chaque BE : quelles factures le mentionnent, si il est rapproché ou seulement détecté. Utiliser pour "quels BEs sont sur mes factures", "liste des BEs de ce mois", "BEs présents sur cette facture".',
    input_schema: {
      type: 'object',
      properties: {
        facture_id: { type: 'string', description: 'ID d\'une facture spécifique' },
        numero_facture: { type: 'string', description: 'Numéro de facture (recherche partielle)' },
        mois: { type: 'string', description: 'Mois au format YYYY-MM pour filtrer par mois de facturation' },
        fournisseur: { type: 'string', description: 'Filtrer par fournisseur' },
        date_debut: { type: 'string', description: 'YYYY-MM-DD' },
        date_fin: { type: 'string', description: 'YYYY-MM-DD' },
      },
      required: [],
    },
  },
  {
    name: 'analyser_ecarts_prix_fournisseur',
    description: 'Analyse les écarts de prix entre les factures reçues et le catalogue de référence pour un fournisseur. Identifie les articles surfacturés ou sous-facturés au-delà d\'un seuil. Utiliser pour "est-ce qu\'il y a des écarts de prix chez X ?", "vérifie les prix de ce fournisseur".',
    input_schema: {
      type: 'object',
      properties: {
        fournisseur: { type: 'string', description: 'Nom du fournisseur (partiel accepté)' },
        periode_mois: { type: 'number', description: 'Période d\'analyse en mois (défaut: 6)' },
        seuil_pct: { type: 'number', description: 'Seuil d\'écart en % pour signaler (défaut: 5)' },
      },
      required: ['fournisseur'],
    },
  },
  {
    name: 'get_flux_tresorerie',
    description: 'Vue flux de trésorerie : montants facturés vs rapprochés validés vs en attente vs non rapprochés, par mois. Utiliser pour "quel est mon flux de trésorerie ?", "combien est validé vs en attente ?", "bilan financier du mois".',
    input_schema: {
      type: 'object',
      properties: {
        periode_mois: { type: 'number', description: 'Période en mois (défaut: 3)' },
        fournisseur: { type: 'string', description: 'Filtrer par fournisseur (optionnel)' },
      },
      required: [],
    },
  },
  {
    name: 'detecter_surfacturations',
    description: 'Détecte les lignes de facture où le prix unitaire facturé dépasse le prix de commande. Donne la liste triée par écart décroissant. Utiliser pour "y a-t-il des surfacturations ?", "comparer prix facturés vs commandés".',
    input_schema: {
      type: 'object',
      properties: {
        fournisseur: { type: 'string', description: 'Filtrer par fournisseur (optionnel)' },
        seuil_pct: { type: 'number', description: 'Seuil d\'écart minimum en % (défaut: 3)' },
      },
      required: [],
    },
  },
  {
    name: 'planifier_rappel',
    description: 'Planifie un rappel pour une date future. Teddy mémorisera le rappel et le signalera au prochain brief du jour. Utiliser pour "rappelle-moi de...", "dans X jours vérifie...".',
    input_schema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Le message du rappel' },
        date_rappel: { type: 'string', description: 'Date YYYY-MM-DD' },
        heure: { type: 'string', description: 'Heure HH:MM (optionnel)' },
      },
      required: ['message', 'date_rappel'],
    },
  },
  {
    name: 'rapport_complet_fournisseur',
    description: 'Génère un rapport complet sur un fournisseur : factures des 3 derniers mois, BEs anciens, commandes ouvertes, exceptions actives, mémoire mémorisée. Plus détaillé que comparer_fournisseurs. Utiliser pour "rapport sur X", "bilan complet de X".',
    input_schema: {
      type: 'object',
      properties: {
        fournisseur: { type: 'string', description: 'Nom du fournisseur (partiel accepté)' },
      },
      required: ['fournisseur'],
    },
  },
  {
    name: 'synthese_mensuelle',
    description: 'Synthèse complète d\'un mois : factures, BEs, montants, taux rapprochement, top fournisseurs, exceptions, comparaison mois précédent. Utiliser pour "synthèse de janvier", "bilan du mois".',
    input_schema: {
      type: 'object',
      properties: {
        mois: { type: 'string', description: 'Mois YYYY-MM (défaut: mois en cours)' },
      },
      required: [],
    },
    cache_control: { type: 'ephemeral' },
  },
];

type ToolInput = Record<string, unknown>;

async function resolveIds(
  table: string,
  input: ToolInput,
  filters: { statut?: string; statut_col?: string; fournisseur?: string },
): Promise<string[]> {
  if (Array.isArray(input.ids) && input.ids.length > 0) return input.ids as string[];
  if (!input.tous && !input.statut && !input.fournisseur) return [];

  let q = supabase.from(table).select('id');
  if (input.statut && filters.statut_col) q = q.eq(filters.statut_col, input.statut);
  if (input.fournisseur) q = q.ilike('fournisseur', `%${input.fournisseur}%`);
  const { data } = await q;
  return (data ?? []).map((r: { id: string }) => r.id);
}

function deriveQuickActions(toolNames: string[]): { label: string; prompt: string; icon: string }[] {
  const actions: { label: string; prompt: string; icon: string }[] = [];
  const has = (t: string) => toolNames.includes(t);

  if (has('list_exceptions')) {
    actions.push({ label: 'Résoudre les anomalies auto', prompt: 'Résous automatiquement toutes les anomalies avec écart ≤ 5%.', icon: 'check' });
    actions.push({ label: 'Exporter les anomalies', prompt: 'Exporte toutes les anomalies ouvertes en CSV.', icon: 'download' });
  }
  if (has('list_rapprochements')) {
    actions.push({ label: 'Valider tout (score ≥ 0.85)', prompt: 'Valide tous les rapprochements proposés avec un score ≥ 0.85.', icon: 'check' });
  }
  if (has('list_factures')) {
    actions.push({ label: 'Exporter les factures en CSV', prompt: 'Exporte les factures affichées en CSV.', icon: 'download' });
    actions.push({ label: 'Lancer le matching', prompt: 'Lance le matching automatique sur toutes les factures non rapprochées.', icon: 'zap' });
  }
  if (has('list_be_receptions')) {
    actions.push({ label: 'Exporter les BEs en CSV', prompt: 'Exporte les BEs affichés en CSV.', icon: 'download' });
  }
  if (has('list_commandes')) {
    actions.push({ label: 'Exporter les commandes en CSV', prompt: 'Exporte les commandes affichées en CSV.', icon: 'download' });
  }
  if (has('get_morning_brief') || has('get_kpis')) {
    actions.push({ label: 'Traiter les anomalies', prompt: 'Gère toutes les anomalies ouvertes selon la procédure standard.', icon: 'wrench' });
    actions.push({ label: 'Valider les rapprochements', prompt: 'Valide tous les rapprochements proposés avec un score ≥ 0.85.', icon: 'check' });
  }
  if (has('lancer_scan_gmail')) {
    actions.push({ label: 'Lancer le matching', prompt: 'Lance le matching automatique sur toutes les factures non rapprochées.', icon: 'zap' });
  }
  if (has('get_fournisseur_stats') || has('get_tendances')) {
    actions.push({ label: 'Exporter cette analyse', prompt: 'Exporte cette analyse en CSV.', icon: 'download' });
  }

  // Dédupliquer sur label, max 3
  const seen = new Set<string>();
  return actions.filter(a => { if (seen.has(a.label)) return false; seen.add(a.label); return true; }).slice(0, 3);
}

async function executeToolWithRetry(name: string, input: ToolInput, maxAttempts = 2): Promise<string> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await executeTool(name, input);
    try {
      const parsed = JSON.parse(result) as Record<string, unknown>;
      if (!parsed.error || attempt === maxAttempts) return result;
    } catch { return result; }
    await new Promise(r => setTimeout(r, 300 * attempt));
  }
  return executeTool(name, input);
}

async function executeTool(name: string, input: ToolInput): Promise<string> {
  try {
    // ── Lecture ────────────────────────────────────────────────────────────────

    if (name === 'get_morning_brief') {
      const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
      const yesterday = new Date(Date.now() - 86400000).toISOString();

      const [resExc, resBesOld, resRapp, resActivite, resCmdAnomalie, resAFacturer, resCommandes] = await Promise.all([
        supabase.from('exceptions').select('niveau_priorite, type_exception, motif').in('statut_exception', ['ouverte', 'en cours']).limit(50),
        supabase.from('be_receptions').select('numero_be, fournisseur, created_at').in('statut_be', ['reçu', 'partiellement facturé']).lte('created_at', sevenDaysAgo).order('created_at').limit(10),
        supabase.from('rapprochements').select('id, score_match').eq('statut_validation', 'proposé').limit(100),
        supabase.from('journal_activite').select('type_action, details_action, created_at').gte('created_at', yesterday).order('created_at', { ascending: false }).limit(8),
        supabase.from('commandes').select('numero_commande_interne, fournisseur').eq('statut_commande', 'en anomalie').limit(10),
        supabase.from('be_receptions').select('id', { count: 'exact', head: true }).in('statut_be', ['reçu', 'partiellement facturé']),
        supabase.from('commandes').select('id', { count: 'exact', head: true }).in('statut_commande', ['ouverte', 'partiellement réceptionnée']),
      ]);

      const exByPriority: Record<string, number> = {};
      for (const ex of (resExc.data ?? [])) {
        const p = (ex as Record<string, string>).niveau_priorite ?? 'inconnue';
        exByPriority[p] = (exByPriority[p] ?? 0) + 1;
      }

      const rappScores = (resRapp.data ?? []).map((r: Record<string, unknown>) => Number(r.score_match ?? 0));
      const scoreMoyen = rappScores.length > 0 ? rappScores.reduce((a, b) => a + b, 0) / rappScores.length : 0;

      return JSON.stringify({
        date: new Date().toISOString().split('T')[0],
        exceptions: { total: resExc.data?.length ?? 0, par_priorite: exByPriority },
        bes_anciens_non_factures: { total: resBesOld.data?.length ?? 0, liste: resBesOld.data ?? [] },
        rapprochements_en_attente: { total: resRapp.data?.length ?? 0, score_moyen_pct: Math.round(scoreMoyen * 100) },
        a_facturer_total: resAFacturer.count ?? 0,
        commandes_ouvertes: resCommandes.count ?? 0,
        commandes_anomalie: resCmdAnomalie.data ?? [],
        activite_recente: resActivite.data ?? [],
      });
    }

    if (name === 'get_kpis') {
      const [
        resFactures,
        resParStatut,
        resExceptions,
        resBes,
        resTaux,
        resCommandes,
      ] = await Promise.all([
        supabase.from('factures').select('id', { count: 'exact', head: true }),
        supabase.from('factures').select('statut_facture'),
        supabase.from('exceptions').select('id', { count: 'exact', head: true }).in('statut_exception', ['ouverte', 'en cours']),
        supabase.from('be_receptions').select('id', { count: 'exact', head: true }).in('statut_be', ['reçu', 'partiellement facturé']),
        supabase.from('factures').select('taux_rapprochement'),
        supabase.from('commandes').select('id', { count: 'exact', head: true }),
      ]);

      // Surface Supabase errors explicitly so Claude doesn't confuse them with empty data
      const errors: string[] = [];
      if (resFactures.error) errors.push(`factures: ${resFactures.error.message}`);
      if (resParStatut.error) errors.push(`statuts: ${resParStatut.error.message}`);
      if (resExceptions.error) errors.push(`exceptions: ${resExceptions.error.message}`);
      if (resBes.error) errors.push(`bes: ${resBes.error.message}`);
      if (errors.length > 0) return JSON.stringify({ erreur_base_de_donnees: errors.join('; ') });

      const statutCounts: Record<string, number> = {};
      for (const f of (resParStatut.data ?? [])) {
        const s = (f as { statut_facture: string }).statut_facture;
        statutCounts[s] = (statutCounts[s] ?? 0) + 1;
      }
      const tauxData = resTaux.data ?? [];
      const tauxMoyen = tauxData.length > 0
        ? Math.round(tauxData.reduce((s, f) => s + ((f as { taux_rapprochement: number }).taux_rapprochement ?? 0), 0) / tauxData.length)
        : 0;
      return JSON.stringify({
        total_factures: resFactures.count ?? 0,
        total_commandes: resCommandes.count ?? 0,
        par_statut_facture: statutCounts,
        taux_rapprochement_moyen: `${tauxMoyen}%`,
        exceptions_actives: resExceptions.count ?? 0,
        bes_en_attente_facturation: resBes.count ?? 0,
      });
    }

    if (name === 'list_factures') {
      const limit = Math.min(Number(input.limit ?? 15), 200);
      let q = supabase.from('factures').select('id, numero_facture, fournisseur, date_facture, total_ht, statut_facture, taux_rapprochement').order('created_at', { ascending: false }).limit(limit);
      if (input.statut) q = q.eq('statut_facture', input.statut);
      if (input.fournisseur) q = q.ilike('fournisseur', `%${input.fournisseur}%`);
      if (input.date_debut) q = q.gte('date_facture', input.date_debut);
      if (input.date_fin) q = q.lte('date_facture', input.date_fin);
      const { data } = await q;
      return JSON.stringify(data ?? []);
    }

    if (name === 'list_be_receptions') {
      const limit = Math.min(Number(input.limit ?? 15), 200);
      let q = supabase.from('be_receptions').select('id, numero_be, fournisseur, date_bl, statut_be').order('created_at', { ascending: false }).limit(limit);
      if (input.statut) q = q.eq('statut_be', input.statut);
      if (input.fournisseur) q = q.ilike('fournisseur', `%${input.fournisseur}%`);
      if (input.date_debut) q = q.gte('date_bl', input.date_debut);
      if (input.date_fin) q = q.lte('date_bl', input.date_fin);
      const { data } = await q;
      return JSON.stringify(data ?? []);
    }

    if (name === 'list_commandes') {
      const limit = Math.min(Number(input.limit ?? 15), 200);
      let q = supabase.from('commandes').select('id, numero_commande_interne, fournisseur, date_commande, montant_total_commande, statut_commande').order('created_at', { ascending: false }).limit(limit);
      if (input.statut) q = q.eq('statut_commande', input.statut);
      if (input.fournisseur) q = q.ilike('fournisseur', `%${input.fournisseur}%`);
      const { data } = await q;
      return JSON.stringify(data ?? []);
    }

    if (name === 'list_exceptions') {
      const limit = Math.min(Number(input.limit ?? 15), 200);
      let q = supabase.from('exceptions').select('id, type_exception, niveau_priorite, statut_exception, motif, ecart, created_at').order('created_at', { ascending: false }).limit(limit);
      if (input.statut) q = q.eq('statut_exception', input.statut);
      if (input.type_exception) q = q.eq('type_exception', input.type_exception);
      if (input.niveau_priorite) q = q.eq('niveau_priorite', input.niveau_priorite);
      const { data } = await q;
      return JSON.stringify(data ?? []);
    }

    if (name === 'list_rapprochements') {
      const limit = Math.min(Number(input.limit ?? 15), 200);
      let q = supabase.from('rapprochements').select('id, facture_id, statut_validation, score_match, montant_rapproche, mode_match').order('created_at', { ascending: false }).limit(limit);
      if (input.statut_validation) q = q.eq('statut_validation', input.statut_validation);
      if (input.score_min) q = q.gte('score_match', input.score_min);
      const { data } = await q;
      return JSON.stringify(data ?? []);
    }

    if (name === 'get_fournisseur_stats') {
      let q = supabase.from('factures').select('fournisseur, total_ht, taux_rapprochement').limit(500);
      if (input.fournisseur) q = q.ilike('fournisseur', `%${input.fournisseur}%`);
      const { data } = await q;
      const stats: Record<string, { count: number; total_ht: number; taux_sum: number }> = {};
      for (const f of (data ?? [])) {
        const frow = f as { fournisseur: string | null; total_ht: number | null; taux_rapprochement: number };
        const key = frow.fournisseur ?? 'Inconnu';
        if (!stats[key]) stats[key] = { count: 0, total_ht: 0, taux_sum: 0 };
        stats[key].count++;
        stats[key].total_ht += frow.total_ht ?? 0;
        stats[key].taux_sum += frow.taux_rapprochement ?? 0;
      }
      return JSON.stringify(Object.entries(stats).map(([nom, s]) => ({ fournisseur: nom, factures: s.count, total_ht: Math.round(s.total_ht * 100) / 100, taux_moyen: Math.round(s.taux_sum / s.count) })).sort((a, b) => b.total_ht - a.total_ht).slice(0, 10));
    }

    if (name === 'get_activite_recente') {
      const limit = Math.min(Number(input.limit ?? 10), 20);
      const { data } = await supabase.from('journal_activite').select('type_action, entite_type, details_action, created_at').order('created_at', { ascending: false }).limit(limit);
      return JSON.stringify(data ?? []);
    }

    if (name === 'get_tendances') {
      const mois = Math.min(Number(input.mois ?? 6), 24);
      const dateFrom = new Date(Date.now() - mois * 30 * 86400000).toISOString();
      const type = String(input.type ?? '');
      const fourn = input.fournisseur ? String(input.fournisseur) : null;

      if (type === 'prix') {
        const ref = input.reference_article ? String(input.reference_article) : null;
        let q = supabase.from('prix_reference').select('reference_article, fournisseur, pu_last, updated_at').order('updated_at', { ascending: false });
        if (ref) q = q.ilike('reference_article', `%${ref}%`);
        if (fourn) q = q.ilike('fournisseur', `%${fourn}%`);
        const { data: catalogue } = await q.limit(30);
        let lq = supabase.from('lignes_commande').select('reference_article, pu_commande, created_at').gte('created_at', dateFrom).not('pu_commande', 'is', null).order('created_at');
        if (ref) lq = lq.ilike('reference_article', `%${ref}%`);
        const { data: historique } = await lq.limit(100);
        return JSON.stringify({ catalogue_actuel: catalogue ?? [], historique_commandes: historique ?? [] });
      }

      if (type === 'rapprochements') {
        let q = supabase.from('factures').select('date_facture, taux_rapprochement, fournisseur').gte('date_facture', dateFrom.split('T')[0]).not('taux_rapprochement', 'is', null).order('date_facture');
        if (fourn) q = q.ilike('fournisseur', `%${fourn}%`);
        const { data } = await q.limit(500);
        const byMonth: Record<string, { sum: number; count: number }> = {};
        for (const f of (data ?? [])) {
          const row = f as Record<string, unknown>;
          const month = String(row.date_facture ?? '').slice(0, 7) || 'inconnu';
          if (!byMonth[month]) byMonth[month] = { sum: 0, count: 0 };
          byMonth[month].sum += Number(row.taux_rapprochement ?? 0);
          byMonth[month].count++;
        }
        return JSON.stringify(Object.entries(byMonth).sort().map(([m, v]) => ({ mois: m, taux_moyen: Math.round(v.sum / v.count), nb_factures: v.count })));
      }

      if (type === 'anomalies') {
        let q = supabase.from('exceptions').select('fournisseur, type_exception, niveau_priorite, created_at').gte('created_at', dateFrom);
        if (fourn) q = q.ilike('fournisseur', `%${fourn}%`);
        const { data } = await q.limit(500);
        const byFourn: Record<string, { total: number; critiques: number; types: Record<string, number> }> = {};
        for (const e of (data ?? [])) {
          const row = e as Record<string, string>;
          const key = row.fournisseur ?? 'Inconnu';
          if (!byFourn[key]) byFourn[key] = { total: 0, critiques: 0, types: {} };
          byFourn[key].total++;
          if (row.niveau_priorite === 'critique') byFourn[key].critiques++;
          byFourn[key].types[row.type_exception] = (byFourn[key].types[row.type_exception] ?? 0) + 1;
        }
        return JSON.stringify(Object.entries(byFourn).sort((a, b) => b[1].total - a[1].total).slice(0, 15).map(([f, s]) => ({ fournisseur: f, ...s })));
      }

      if (type === 'commandes') {
        let q = supabase.from('commandes').select('fournisseur, date_commande, montant_total_commande').gte('date_commande', dateFrom.split('T')[0]).order('date_commande');
        if (fourn) q = q.ilike('fournisseur', `%${fourn}%`);
        const { data } = await q.limit(500);
        const byMonth: Record<string, { count: number; montant: number }> = {};
        for (const c of (data ?? [])) {
          const row = c as Record<string, unknown>;
          const month = String(row.date_commande ?? '').slice(0, 7) || 'inconnu';
          if (!byMonth[month]) byMonth[month] = { count: 0, montant: 0 };
          byMonth[month].count++;
          byMonth[month].montant += Number(row.montant_total_commande ?? 0);
        }
        return JSON.stringify(Object.entries(byMonth).sort().map(([m, v]) => ({ mois: m, commandes: v.count, montant_total: Math.round(v.montant) })));
      }

      return JSON.stringify({ error: `Type "${type}" non reconnu. Options: prix, rapprochements, anomalies, commandes` });
    }

    if (name === 'recherche_avancee') {
      const entite = String(input.entite ?? '');
      const limit = Math.min(Number(input.limit ?? 20), 100);
      type TableMeta = { table: string; statut_col?: string; montant_col?: string; date_col: string; has_fournisseur: boolean; text_col?: string };
      const tableMap: Record<string, TableMeta> = {
        factures: { table: 'factures', statut_col: 'statut_facture', montant_col: 'total_ht', date_col: 'date_facture', has_fournisseur: true, text_col: 'numero_facture' },
        commandes: { table: 'commandes', statut_col: 'statut_commande', montant_col: 'montant_total_commande', date_col: 'date_commande', has_fournisseur: true, text_col: 'numero_commande_interne' },
        be_receptions: { table: 'be_receptions', statut_col: 'statut_be', date_col: 'date_bl', has_fournisseur: true, text_col: 'numero_be' },
        exceptions: { table: 'exceptions', statut_col: 'statut_exception', date_col: 'created_at', has_fournisseur: false, text_col: 'motif' },
        rapprochements: { table: 'rapprochements', statut_col: 'statut_validation', montant_col: 'montant_rapproche', date_col: 'created_at', has_fournisseur: false },
      };
      const meta = tableMap[entite];
      if (!meta) return JSON.stringify({ error: `Entité non reconnue. Options: ${Object.keys(tableMap).join(', ')}` });

      let q = supabase.from(meta.table).select('*');
      if (input.statut && meta.statut_col) q = q.eq(meta.statut_col, String(input.statut));
      if (input.fournisseur && meta.has_fournisseur) q = q.ilike('fournisseur', `%${String(input.fournisseur)}%`);
      if (input.montant_min != null && meta.montant_col) q = q.gte(meta.montant_col, Number(input.montant_min));
      if (input.montant_max != null && meta.montant_col) q = q.lte(meta.montant_col, Number(input.montant_max));
      if (input.date_debut) q = q.gte(meta.date_col, String(input.date_debut));
      if (input.date_fin) q = q.lte(meta.date_col, String(input.date_fin));
      if (input.texte && meta.text_col) q = q.ilike(meta.text_col, `%${String(input.texte)}%`);
      q = q.order('created_at', { ascending: false }).limit(limit);
      const { data, error } = await q;
      if (error) return JSON.stringify({ error: error.message });
      return JSON.stringify({ entite, total: data?.length ?? 0, resultats: data ?? [] });
    }

    if (name === 'traitement_conditionnel') {
      const action = String(input.action ?? '');
      const filtres = ((input.filtres ?? {}) as Record<string, unknown>);
      const commentaire = input.commentaire ? String(input.commentaire) : undefined;

      if (action === 'valider_rapprochements') {
        let q = supabase.from('rapprochements').select('id, facture_id').eq('statut_validation', 'proposé');
        if (filtres.score_min) q = q.gte('score_match', Number(filtres.score_min));
        if (filtres.date_debut) q = q.gte('created_at', String(filtres.date_debut));
        if (filtres.date_fin) q = q.lte('created_at', String(filtres.date_fin));
        const { data: raps } = await q.limit(200);
        let filtered = (raps ?? []) as Array<Record<string, string>>;
        if (filtres.fournisseur) {
          const facIds = filtered.map(r => r.facture_id);
          const { data: facs } = await supabase.from('factures').select('id, fournisseur').in('id', facIds);
          const validIds = new Set((facs ?? []).filter((f: Record<string, string>) => f.fournisseur?.toLowerCase().includes(String(filtres.fournisseur).toLowerCase())).map((f: Record<string, string>) => f.id));
          filtered = filtered.filter(r => validIds.has(r.facture_id));
        }
        let valides = 0;
        for (const rap of filtered) {
          const res = await fetch(`${BASE_URL}/api/rapprochements`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rapId: rap.id, statut: 'validé', factureId: rap.facture_id }) });
          if (res.ok) valides++;
        }
        return JSON.stringify({ action, valides, candidats: filtered.length });
      }

      if (action === 'resoudre_exceptions' || action === 'ignorer_exceptions') {
        const nouveauStatut = action === 'resoudre_exceptions' ? 'résolue' : 'ignorée';
        let q = supabase.from('exceptions').select('id, ecart, fournisseur').in('statut_exception', ['ouverte', 'en cours']);
        if (filtres.type_exception) q = q.eq('type_exception', String(filtres.type_exception));
        if (filtres.date_debut) q = q.gte('created_at', String(filtres.date_debut));
        if (filtres.date_fin) q = q.lte('created_at', String(filtres.date_fin));
        const { data: excs } = await q.limit(200);
        let filtered = (excs ?? []) as Array<Record<string, unknown>>;
        if (filtres.ecart_max_pct != null) {
          const max = Number(filtres.ecart_max_pct);
          filtered = filtered.filter(e => Math.abs(Number(e.ecart ?? 999)) <= max);
        }
        if (filtres.fournisseur) filtered = filtered.filter(e => String(e.fournisseur ?? '').toLowerCase().includes(String(filtres.fournisseur).toLowerCase()));
        if (filtered.length === 0) return JSON.stringify({ resolues: 0, message: 'Aucune anomalie ne correspond aux critères' });
        const ids = filtered.map(e => String(e.id));
        const updates: Record<string, unknown> = { statut_exception: nouveauStatut };
        if (commentaire) updates.commentaire = commentaire;
        if (nouveauStatut === 'résolue') updates.date_resolution = new Date().toISOString();
        await supabase.from('exceptions').update(updates).in('id', ids);
        return JSON.stringify({ action, resolues: ids.length, candidats: excs?.length ?? 0 });
      }

      return JSON.stringify({ error: `Action "${action}" non reconnue. Options: valider_rapprochements, resoudre_exceptions, ignorer_exceptions` });
    }

    if (name === 'exporter_csv') {
      const entite = String(input.entite ?? '');
      const fourn = input.fournisseur ? String(input.fournisseur) : null;
      const statut = input.statut ? String(input.statut) : null;
      const dateDebut = input.date_debut ? String(input.date_debut) : null;
      const dateFin = input.date_fin ? String(input.date_fin) : null;

      type Row = Record<string, unknown>;
      let rows: Row[] = [];

      if (entite === 'be_non_factures') {
        let q = supabase.from('be_receptions').select('numero_be, fournisseur, date_bl, statut_be, created_at').in('statut_be', ['reçu', 'partiellement facturé']).order('created_at');
        if (fourn) q = q.ilike('fournisseur', `%${fourn}%`);
        const { data } = await q.limit(500);
        rows = (data ?? []) as Row[];
      } else if (entite === 'factures') {
        let q = supabase.from('factures').select('numero_facture, fournisseur, date_facture, total_ht, statut_facture, taux_rapprochement').order('date_facture');
        if (fourn) q = q.ilike('fournisseur', `%${fourn}%`);
        if (statut) q = q.eq('statut_facture', statut);
        if (dateDebut) q = q.gte('date_facture', dateDebut);
        if (dateFin) q = q.lte('date_facture', dateFin);
        const { data } = await q.limit(500);
        rows = (data ?? []) as Row[];
      } else if (entite === 'commandes') {
        let q = supabase.from('commandes').select('numero_commande_interne, fournisseur, date_commande, montant_total_commande, statut_commande').order('date_commande');
        if (fourn) q = q.ilike('fournisseur', `%${fourn}%`);
        if (statut) q = q.eq('statut_commande', statut);
        const { data } = await q.limit(500);
        rows = (data ?? []) as Row[];
      } else if (entite === 'exceptions') {
        let q = supabase.from('exceptions').select('type_exception, niveau_priorite, statut_exception, motif, ecart, fournisseur, created_at').order('created_at', { ascending: false });
        if (fourn) q = q.ilike('fournisseur', `%${fourn}%`);
        if (statut) q = q.eq('statut_exception', statut);
        const { data } = await q.limit(500);
        rows = (data ?? []) as Row[];
      } else {
        return JSON.stringify({ error: `Entité "${entite}" non reconnue. Options: be_non_factures, factures, commandes, exceptions` });
      }

      if (rows.length === 0) return JSON.stringify({ error: 'Aucune donnée à exporter pour ces critères' });

      const headers = Object.keys(rows[0]);
      const escape = (val: unknown) => { if (val == null) return ''; const s = String(val).replace(/"/g, '""'); return (s.includes(';') || s.includes('"') || s.includes('\n')) ? `"${s}"` : s; };
      const csv = [headers.join(';'), ...rows.map(r => headers.map(h => escape(r[h])).join(';'))].join('\n');
      const b64 = Buffer.from('﻿' + csv, 'utf-8').toString('base64');
      const filename = `${entite}_${fourn ?? 'tous'}_${new Date().toISOString().split('T')[0]}.csv`;

      return JSON.stringify({ __export__: true, filename, b64, rows_count: rows.length });
    }

    // ── Actions ────────────────────────────────────────────────────────────────

    if (name === 'supprimer_factures') {
      const ids = await resolveIds('factures', input, { statut_col: 'statut_facture', fournisseur: String(input.fournisseur ?? '') });
      if (ids.length === 0) return JSON.stringify({ supprimees: 0 });
      for (const id of ids) {
        await supabase.from('rapprochements').delete().eq('facture_id', id);
        await supabase.from('lignes_facture').delete().eq('facture_id', id);
        await supabase.from('liaison_facture_commande').delete().eq('facture_id', id);
        await supabase.from('factures').delete().eq('id', id);
      }
      return JSON.stringify({ supprimees: ids.length });
    }

    if (name === 'supprimer_bes') {
      const ids = await resolveIds('be_receptions', input, { statut_col: 'statut_be', fournisseur: String(input.fournisseur ?? '') });
      if (ids.length === 0) return JSON.stringify({ supprimes: 0 });
      for (const id of ids) {
        await supabase.from('lignes_be').delete().eq('be_id', id);
        await supabase.from('liaison_be_commande').delete().eq('be_id', id);
        await supabase.from('be_receptions').delete().eq('id', id);
      }
      return JSON.stringify({ supprimes: ids.length });
    }

    if (name === 'supprimer_commandes') {
      const ids = await resolveIds('commandes', input, { statut_col: 'statut_commande', fournisseur: String(input.fournisseur ?? '') });
      if (ids.length === 0) return JSON.stringify({ supprimees: 0 });
      for (const id of ids) {
        await supabase.from('lignes_commande').delete().eq('commande_id', id);
        await supabase.from('liaison_be_commande').delete().eq('commande_id', id);
        await supabase.from('liaison_facture_commande').delete().eq('commande_id', id);
        await supabase.from('commandes').delete().eq('id', id);
      }
      return JSON.stringify({ supprimees: ids.length });
    }

    if (name === 'supprimer_exceptions') {
      const ids = await resolveIds('exceptions', input, { statut_col: 'statut_exception' });
      if (ids.length === 0) return JSON.stringify({ supprimees: 0 });
      await supabase.from('exceptions').delete().in('id', ids);
      return JSON.stringify({ supprimees: ids.length });
    }

    if (name === 'lancer_matching') {
      if (input.facture_id) {
        const res = await fetch(`${BASE_URL}/api/matching`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ facture_id: input.facture_id }),
        });
        const json = await res.json() as { rapprochements_crees?: number; exceptions_creees?: number; message?: string };
        return JSON.stringify(json);
      }
      if (input.toutes_non_rapprochees) {
        const { data: factures } = await supabase.from('factures').select('id').in('statut_facture', ['importée', 'partiellement rapprochée', 'en cours de rapprochement']);
        let total = 0;
        for (const f of (factures ?? [])) {
          const res = await fetch(`${BASE_URL}/api/matching`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ facture_id: f.id }),
          });
          if (res.ok) {
            const json = await res.json() as { rapprochements_crees?: number };
            total += json.rapprochements_crees ?? 0;
          }
        }
        return JSON.stringify({ factures_traitees: factures?.length ?? 0, rapprochements_crees: total });
      }
      return JSON.stringify({ error: 'Précise facture_id ou toutes_non_rapprochees: true' });
    }

    if (name === 'valider_rapprochements') {
      let rapIds: string[] = Array.isArray(input.ids) ? input.ids as string[] : [];

      if (rapIds.length === 0 && input.facture_id) {
        const { data } = await supabase.from('rapprochements').select('id, facture_id').eq('facture_id', input.facture_id).eq('statut_validation', 'proposé');
        rapIds = (data ?? []).map((r: { id: string }) => r.id);
      }
      if (rapIds.length === 0 && input.score_min) {
        const { data } = await supabase.from('rapprochements').select('id, facture_id').eq('statut_validation', 'proposé').gte('score_match', input.score_min);
        rapIds = (data ?? []).map((r: { id: string }) => r.id);
      }

      let valides = 0;
      for (const rapId of rapIds) {
        const { data: rap } = await supabase.from('rapprochements').select('facture_id').eq('id', rapId).single();
        if (!rap) continue;
        const res = await fetch(`${BASE_URL}/api/rapprochements`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rapId, statut: 'validé', factureId: rap.facture_id }),
        });
        if (res.ok) valides++;
      }
      return JSON.stringify({ valides });
    }

    if (name === 'resoudre_exceptions') {
      const ids = Array.isArray(input.ids) ? input.ids as string[] : [];
      const statut = String(input.nouveau_statut ?? 'résolue');
      const commentaire = String(input.commentaire ?? '');
      if (ids.length === 0) return JSON.stringify({ resolues: 0 });
      const updates: Record<string, unknown> = { statut_exception: statut };
      if (commentaire) updates.commentaire = commentaire;
      if (statut === 'résolue') updates.date_resolution = new Date().toISOString();
      await supabase.from('exceptions').update(updates).in('id', ids);
      return JSON.stringify({ resolues: ids.length });
    }

    if (name === 'lancer_scan_gmail') {
      const body: Record<string, unknown> = {};
      if (input.fournisseur) body.fournisseur = input.fournisseur;
      if (input.force) body.force = true;
      const res = await fetch(`${BASE_URL}/api/gmail/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const preview = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
        return JSON.stringify({ error: `Scan Gmail échoué (HTTP ${res.status})`, detail: preview });
      }
      const json = await res.json() as { commandes_importees?: number; doublons_ignores?: number; filtres_ignores?: number; erreurs?: string[]; details?: string[]; error?: string };
      return JSON.stringify(json);
    }

    if (name === 'mettre_a_jour_prix') {
      type ArticleInput = { reference_article: string; pu: number; designation?: string; fournisseur?: string };
      const articles = Array.isArray(input.articles) ? input.articles as ArticleInput[] : [];
      if (articles.length === 0) return JSON.stringify({ mis_a_jour: 0 });
      let updated = 0;
      for (const art of articles) {
        if (!art.reference_article || art.pu == null) continue;
        const { error } = await supabase.from('prix_reference').upsert({
          reference_article: art.reference_article,
          fournisseur: art.fournisseur ?? '',
          pu_last: art.pu,
          designation: art.designation ?? null,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'reference_article,fournisseur' });
        if (!error) updated++;
      }
      return JSON.stringify({ mis_a_jour: updated, articles: articles.map(a => a.reference_article) });
    }

    if (name === 'mettre_a_jour_lignes_commande') {
      type LigneInput = { reference_article: string; pu: number; designation?: string };
      const numero = String(input.numero_commande ?? '');
      const lignes = Array.isArray(input.lignes) ? input.lignes as LigneInput[] : [];
      if (!numero || lignes.length === 0) return JSON.stringify({ erreur: 'numero_commande et lignes requis' });

      // Chercher la commande
      const { data: cmds } = await supabase.from('commandes')
        .select('id, numero_commande_interne, fournisseur')
        .ilike('numero_commande_interne', `%${numero}%`)
        .limit(1);
      const cmd = cmds?.[0] as { id: string; numero_commande_interne: string; fournisseur: string } | undefined;
      if (!cmd) return JSON.stringify({ erreur: `Commande "${numero}" introuvable` });

      // Récupérer toutes les lignes de cette commande
      const { data: lignesCmd } = await supabase.from('lignes_commande')
        .select('id, reference_article, quantite_commandee')
        .eq('commande_id', cmd.id);

      let lignes_mises_a_jour = 0;
      const non_trouvees: string[] = [];

      for (const l of lignes) {
        const match = (lignesCmd ?? []).find(
          (lc: { id: string; reference_article: string | null; quantite_commandee: number }) =>
            lc.reference_article?.toUpperCase().replace(/[^A-Z0-9]/g, '') === l.reference_article.toUpperCase().replace(/[^A-Z0-9]/g, '')
        ) as { id: string; reference_article: string | null; quantite_commandee: number } | undefined;

        if (!match) { non_trouvees.push(l.reference_article); continue; }

        await supabase.from('lignes_commande').update({
          pu_commande: l.pu,
          montant_ht_commande: match.quantite_commandee * l.pu,
        }).eq('id', match.id);

        // Mettre à jour le catalogue aussi
        await supabase.from('prix_reference').upsert({
          reference_article: l.reference_article,
          fournisseur: cmd.fournisseur ?? '',
          pu_last: l.pu,
          designation: l.designation ?? null,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'reference_article,fournisseur' });

        lignes_mises_a_jour++;
      }

      // Recalculer le montant total de la commande depuis les lignes
      const { data: toutesLignes } = await supabase.from('lignes_commande')
        .select('montant_ht_commande')
        .eq('commande_id', cmd.id);
      const total = (toutesLignes ?? []).reduce(
        (sum, l: { montant_ht_commande: number | null }) => sum + (l.montant_ht_commande ?? 0), 0
      );
      if (total > 0) {
        await supabase.from('commandes').update({ montant_total_commande: total }).eq('id', cmd.id);
      }

      return JSON.stringify({
        commande: cmd.numero_commande_interne,
        lignes_mises_a_jour,
        montant_total_recalcule: total > 0 ? total : undefined,
        non_trouvees: non_trouvees.length > 0 ? non_trouvees : undefined,
      });
    }

    if (name === 'get_exception_detail') {
      const ids = Array.isArray(input.ids) ? input.ids as string[] : [];
      const limit = Math.min(Number(input.limit ?? 20), 20);
      let q = supabase.from('exceptions').select('*');
      if (ids.length > 0) q = q.in('id', ids);
      else if (input.statut) q = q.eq('statut_exception', input.statut);
      q = q.order('niveau_priorite', { ascending: false }).limit(limit);
      const { data: exceptions } = await q;
      if (!exceptions || exceptions.length === 0) return JSON.stringify([]);

      type ExcRow = Record<string, unknown>;
      const result = await Promise.all((exceptions as ExcRow[]).map(async exc => {
        const ctx: ExcRow = { ...exc };
        if (exc.facture_id) {
          const { data } = await supabase.from('factures').select('id, numero_facture, fournisseur, date_facture, total_ht, statut_facture, taux_rapprochement').eq('id', exc.facture_id as string).single();
          ctx.facture = data;
        }
        if (exc.ligne_facture_id) {
          const { data } = await supabase.from('lignes_facture').select('id, reference_article, designation, quantite_facturee, pu_facture, montant_ht, numero_be_detecte').eq('id', exc.ligne_facture_id as string).single();
          ctx.ligne_facture = data;
        }
        if (exc.be_id) {
          const { data } = await supabase.from('be_receptions').select('id, numero_be, fournisseur, date_bl, statut_be').eq('id', exc.be_id as string).single();
          ctx.be = data;
        }
        if (exc.ligne_be_id) {
          const { data } = await supabase.from('lignes_be').select('id, reference_article, designation, quantite_receptionnee, quantite_facturee, quantite_restante_a_facturer').eq('id', exc.ligne_be_id as string).single();
          ctx.ligne_be = data;
        }
        if (exc.commande_id) {
          const { data } = await supabase.from('commandes').select('id, numero_commande_interne, fournisseur, montant_total_commande, statut_commande').eq('id', exc.commande_id as string).single();
          ctx.commande = data;
        }
        return ctx;
      }));
      return JSON.stringify(result);
    }

    if (name === 'corriger_ecart_prix') {
      let ligneId: string | null = null;
      let commandeId: string | null = null;
      let fournisseur: string | null = null;

      if (input.ligne_commande_id) {
        ligneId = String(input.ligne_commande_id);
        const { data: lc } = await supabase.from('lignes_commande').select('commande_id').eq('id', ligneId).single();
        commandeId = (lc as Record<string, string> | null)?.commande_id ?? null;
      } else if (input.commande_id && input.reference_article) {
        commandeId = String(input.commande_id);
        const ref = String(input.reference_article).toUpperCase().replace(/[^A-Z0-9]/g, '');
        const { data: lines } = await supabase.from('lignes_commande').select('id, reference_article').eq('commande_id', commandeId);
        const match = (lines ?? []).find((l: Record<string, unknown>) =>
          String(l.reference_article ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '') === ref
        ) as Record<string, string> | undefined;
        ligneId = match?.id ?? null;
      }
      if (!ligneId || !commandeId) return JSON.stringify({ error: 'Ligne commande introuvable — fournis ligne_commande_id ou commande_id+reference_article' });

      const { data: cmd } = await supabase.from('commandes').select('fournisseur').eq('id', commandeId).single();
      fournisseur = (cmd as Record<string, string> | null)?.fournisseur ?? null;

      const { data: ligne } = await supabase.from('lignes_commande').select('quantite_commandee, reference_article').eq('id', ligneId).single();
      if (!ligne) return JSON.stringify({ error: 'Ligne introuvable' });

      const nouveauPU = Number(input.nouveau_pu);
      const ligneRow = ligne as Record<string, unknown>;
      const nouveauMontant = (ligneRow.quantite_commandee as number) * nouveauPU;
      await supabase.from('lignes_commande').update({ pu_commande: nouveauPU, montant_ht_commande: nouveauMontant }).eq('id', ligneId);

      const { data: toutesLignes } = await supabase.from('lignes_commande').select('montant_ht_commande').eq('commande_id', commandeId);
      const total = (toutesLignes ?? []).reduce((s, l) => s + ((l as Record<string, number>).montant_ht_commande ?? 0), 0);
      await supabase.from('commandes').update({ montant_total_commande: total || null }).eq('id', commandeId);

      if (input.mettre_a_jour_catalogue && ligneRow.reference_article) {
        await supabase.from('prix_reference').upsert({
          reference_article: ligneRow.reference_article,
          fournisseur: fournisseur ?? '',
          pu_last: nouveauPU,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'reference_article,fournisseur' });
      }
      return JSON.stringify({ ok: true, nouveau_pu: nouveauPU, nouveau_montant_ligne: nouveauMontant, montant_total_commande: total });
    }

    if (name === 'forcer_rapprochement_manuel') {
      const res = await fetch(`${BASE_URL}/api/rapprochements`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          factureId: input.facture_id,
          ligneFacId: input.ligne_facture_id,
          beId: input.be_id,
          ligneBEId: input.ligne_be_id,
          quantiteRapprochee: input.quantite_rapprochee,
          montantRapproche: input.montant_rapproche ?? null,
        }),
      });
      const json = await res.json() as Record<string, unknown>;
      if (!res.ok) return JSON.stringify({ error: json.error ?? `HTTP ${res.status}` });
      return JSON.stringify(json);
    }

    if (name === 'rechercher_be_pour_facture') {
      const factureId = String(input.facture_id);
      const { data: facture } = await supabase.from('factures').select('fournisseur, date_facture').eq('id', factureId).single();
      const { data: lignesFac } = await supabase.from('lignes_facture').select('id, reference_article, designation, quantite_facturee, pu_facture, numero_be_detecte').eq('facture_id', factureId);

      const refs = [...new Set((lignesFac ?? []).map((l: Record<string, unknown>) => l.reference_article).filter(Boolean))] as string[];
      const beNums = [...new Set((lignesFac ?? []).map((l: Record<string, unknown>) => l.numero_be_detecte).filter(Boolean))] as string[];
      const facRow = facture as Record<string, string> | null;

      const [besByNum, besByFourn, lignesBE] = await Promise.all([
        beNums.length > 0
          ? supabase.from('be_receptions').select('id, numero_be, fournisseur, date_bl, statut_be').in('numero_be', beNums)
          : Promise.resolve({ data: [] }),
        facRow?.fournisseur
          ? supabase.from('be_receptions').select('id, numero_be, fournisseur, date_bl, statut_be').ilike('fournisseur', `%${facRow.fournisseur.slice(0, 6)}%`).in('statut_be', ['reçu', 'partiellement facturé']).limit(10)
          : Promise.resolve({ data: [] }),
        refs.length > 0
          ? supabase.from('lignes_be').select('id, be_id, reference_article, designation, quantite_receptionnee, quantite_restante_a_facturer').in('reference_article', refs).gt('quantite_restante_a_facturer', 0).limit(30)
          : Promise.resolve({ data: [] }),
      ]);

      return JSON.stringify({
        lignes_facture: lignesFac ?? [],
        bes_par_numero_detecte: besByNum.data ?? [],
        bes_fournisseur_disponibles: besByFourn.data ?? [],
        lignes_be_candidates_par_ref: lignesBE.data ?? [],
      });
    }

    if (name === 'annoter_exception') {
      const { error } = await supabase.from('exceptions').update({
        explication_ia: input.explication ?? null,
        suggestion_ia: input.suggestion ?? null,
      }).eq('id', String(input.exception_id));
      if (error) throw error;
      return JSON.stringify({ ok: true });
    }

    if (name === 'get_contacts_fournisseur') {
      const fournisseur = String(input.fournisseur ?? '');
      const { data: contacts } = await supabase
        .from('contacts_fournisseurs')
        .select('nom, email, telephone, poste')
        .ilike('fournisseur', `%${fournisseur}%`)
        .limit(10);
      const { data: fournData } = await supabase
        .from('fournisseurs')
        .select('nom, email_domaine')
        .ilike('nom', `%${fournisseur}%`)
        .limit(5);
      return JSON.stringify({ contacts: contacts ?? [], fournisseurs: fournData ?? [] });
    }

    if (name === 'envoyer_email') {
      const auth = await getValidToken();
      if (!auth) return JSON.stringify({ error: 'Gmail non connecté — connectez Gmail dans les Paramètres' });
      const to = String(input.to ?? '');
      const subject = String(input.subject ?? '');
      const body = String(input.body ?? '');
      if (!to || !subject || !body) return JSON.stringify({ error: 'to, subject et body sont requis' });
      await sendEmail(auth.token, { from: auth.config.email, to, subject, body });
      await supabase.from('journal_activite').insert({
        type_action: 'envoi_email',
        entite_type: 'email',
        details_action: JSON.stringify({ to, subject }),
      });
      return JSON.stringify({ envoye: true, to, subject });
    }

    if (name === 'get_detail_commande') {
      let cmdId = String(input.commande_id ?? '');
      if (!cmdId && input.numero_commande) {
        const { data } = await supabase.from('commandes').select('id').ilike('numero_commande_interne', `%${input.numero_commande}%`).limit(1);
        cmdId = (data?.[0] as { id: string } | undefined)?.id ?? '';
      }
      if (!cmdId) return JSON.stringify({ error: 'Commande introuvable' });
      const [{ data: cmd }, { data: lignes }] = await Promise.all([
        supabase.from('commandes').select('*').eq('id', cmdId).single(),
        supabase.from('lignes_commande').select('*').eq('commande_id', cmdId).order('ligne_no'),
      ]);
      return JSON.stringify({ commande: cmd, lignes: lignes ?? [] });
    }

    if (name === 'get_detail_be') {
      let beId = String(input.be_id ?? '');
      if (!beId && input.numero_be) {
        const { data } = await supabase.from('be_receptions').select('id').ilike('numero_be', `%${input.numero_be}%`).limit(1);
        beId = (data?.[0] as { id: string } | undefined)?.id ?? '';
      }
      if (!beId) return JSON.stringify({ error: 'BE introuvable' });
      const [{ data: be }, { data: lignes }] = await Promise.all([
        supabase.from('be_receptions').select('*').eq('id', beId).single(),
        supabase.from('lignes_be').select('*').eq('be_id', beId).order('ligne_no'),
      ]);
      return JSON.stringify({ be, lignes: lignes ?? [] });
    }

    if (name === 'lier_be_commande') {
      const res = await fetch(`${BASE_URL}/api/link-be-commande`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ beId: input.be_id, commandeId: input.commande_id }),
      });
      const json = await res.json() as Record<string, unknown>;
      if (!res.ok) return JSON.stringify({ error: json.error ?? `HTTP ${res.status}` });
      return JSON.stringify(json);
    }

    if (name === 'get_alertes') {
      const includeLu = input.lu === true;
      let q = supabase.from('notifications').select('*').order('created_at', { ascending: false }).limit(50);
      if (!includeLu) q = q.eq('lu', false);
      const { data } = await q;
      return JSON.stringify(data ?? []);
    }

    if (name === 'creer_commande') {
      type LigneInput = { reference_article: string; designation?: string; quantite_commandee: number; pu_commande?: number };
      const lignesInput = Array.isArray(input.lignes) ? input.lignes as LigneInput[] : [];
      const montant = lignesInput.reduce((s, l) => s + (l.quantite_commandee ?? 0) * (l.pu_commande ?? 0), 0);
      const { data: cmd, error } = await supabase.from('commandes').insert({
        numero_commande_interne: String(input.numero_commande_interne ?? ''),
        fournisseur: String(input.fournisseur ?? ''),
        date_commande: input.date_commande ? String(input.date_commande) : null,
        montant_total_commande: montant || null,
        type_source: 'manuel',
      }).select().single();
      if (error) return JSON.stringify({ error: error.message });
      if (lignesInput.length > 0 && cmd) {
        const cmdRow = cmd as { id: string };
        await supabase.from('lignes_commande').insert(
          lignesInput.map((l, i) => ({
            commande_id: cmdRow.id, ligne_no: i + 1,
            reference_article: l.reference_article,
            designation: l.designation ?? null,
            quantite_commandee: l.quantite_commandee,
            pu_commande: l.pu_commande ?? null,
            montant_ht_commande: (l.quantite_commandee ?? 0) * (l.pu_commande ?? 0),
            quantite_restante_a_recevoir: l.quantite_commandee,
          }))
        );
      }
      return JSON.stringify({ ok: true, commande: cmd, lignes_creees: lignesInput.length });
    }

    if (name === 'analyser_et_proposer') {
      const res = await fetch(`${BASE_URL}/api/teddy/analyse`, { method: 'POST' });
      const json = await res.json() as { total: number; nouvelles_creees: number; actions: unknown[] };
      return JSON.stringify({ total_en_attente: json.total, nouvelles_creees: json.nouvelles_creees, apercu: (json.actions ?? []).slice(0, 5) });
    }

    if (name === 'voir_actions_proposees') {
      const statut = String(input.statut ?? 'proposée');
      const { data } = await supabase.from('teddy_actions_proposees').select('*').eq('statut', statut).order('created_at', { ascending: false }).limit(50);
      return JSON.stringify(data ?? []);
    }

    if (name === 'approuver_actions_teddy') {
      let ids = Array.isArray(input.ids) ? input.ids as string[] : [];
      if (input.tous || input.type_action) {
        let q = supabase.from('teddy_actions_proposees').select('id').eq('statut', 'proposée');
        if (input.type_action) q = q.eq('type_action', String(input.type_action));
        const { data } = await q;
        ids = (data ?? []).map((r: Record<string, unknown>) => r.id as string);
      }
      const res = await fetch(`${BASE_URL}/api/teddy/actions`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, action: 'approuver' }),
      });
      const json = await res.json() as { resultats: { id: string; resultat: string; ok: boolean }[] };
      const ok = json.resultats?.filter(r => r.ok).length ?? 0;
      return JSON.stringify({ ok: true, approuvees: ok, total: ids.length });
    }

    if (name === 'rejeter_actions_teddy') {
      const ids = Array.isArray(input.ids) ? input.ids as string[] : [];
      const res = await fetch(`${BASE_URL}/api/teddy/actions`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, tous: input.tous === true, action: 'rejeter' }),
      });
      return res.ok ? JSON.stringify({ ok: true }) : JSON.stringify({ error: 'Erreur rejet' });
    }

    if (name === 'modifier_commande') {
      let cmdId = String(input.commande_id ?? '');
      if (!cmdId && input.numero_commande_interne) {
        const { data } = await supabase.from('commandes').select('id').ilike('numero_commande_interne', `%${input.numero_commande_interne}%`).limit(1);
        cmdId = (data?.[0] as { id: string } | undefined)?.id ?? '';
      }
      if (!cmdId) return JSON.stringify({ error: 'Commande introuvable' });
      const champs = input.champs as Record<string, unknown> ?? {};
      // Snapshot original fields for undo
      const { data: before } = await supabase.from('commandes').select(Object.keys(champs).join(',')).eq('id', cmdId).single();
      const { error } = await supabase.from('commandes').update(champs).eq('id', cmdId);
      if (error) return JSON.stringify({ error: error.message });
      const { data: updated } = await supabase.from('commandes').select('*').eq('id', cmdId).single();
      return JSON.stringify({ ok: true, commande: updated, __undo__: { table: 'commandes', id: cmdId, champs: before ?? {} } });
    }

    if (name === 'modifier_ligne_commande') {
      let ligneId = String(input.ligne_id ?? '');
      if (!ligneId && input.commande_id && input.ligne_no) {
        const { data } = await supabase.from('lignes_commande').select('id').eq('commande_id', input.commande_id).eq('ligne_no', input.ligne_no).limit(1);
        ligneId = (data?.[0] as { id: string } | undefined)?.id ?? '';
      }
      if (!ligneId) return JSON.stringify({ error: 'Ligne introuvable' });
      const champs = input.champs as Record<string, unknown> ?? {};
      // Recalcul montant_ht_commande si qte ou pu changent
      const { data: current } = await supabase.from('lignes_commande').select('quantite_commandee, pu_commande').eq('id', ligneId).single() as { data: { quantite_commandee: number; pu_commande: number } | null };
      const qte = Number((champs.quantite_commandee as number | undefined) ?? current?.quantite_commandee ?? 0);
      const pu = Number((champs.pu_commande as number | undefined) ?? current?.pu_commande ?? 0);
      const { error } = await supabase.from('lignes_commande').update({ ...champs, montant_ht_commande: qte * pu }).eq('id', ligneId);
      if (error) return JSON.stringify({ error: error.message });
      // Recalcul montant_total_commande sur la commande parente
      const { data: ligne } = await supabase.from('lignes_commande').select('commande_id').eq('id', ligneId).single() as { data: { commande_id: string } | null };
      if (ligne?.commande_id) {
        const { data: lignes } = await supabase.from('lignes_commande').select('montant_ht_commande').eq('commande_id', ligne.commande_id);
        const total = (lignes ?? []).reduce((s, l: Record<string, unknown>) => s + Number(l.montant_ht_commande ?? 0), 0);
        await supabase.from('commandes').update({ montant_total_commande: total }).eq('id', ligne.commande_id);
      }
      return JSON.stringify({ ok: true });
    }

    if (name === 'modifier_facture') {
      let factId = String(input.facture_id ?? '');
      if (!factId && input.numero_facture) {
        const { data } = await supabase.from('factures').select('id').ilike('numero_facture', `%${input.numero_facture}%`).limit(1);
        factId = (data?.[0] as { id: string } | undefined)?.id ?? '';
      }
      if (!factId) return JSON.stringify({ error: 'Facture introuvable' });
      const champs = input.champs as Record<string, unknown> ?? {};
      // Snapshot original fields for undo
      const { data: beforeFact } = await supabase.from('factures').select(Object.keys(champs).join(',')).eq('id', factId).single();
      const { error } = await supabase.from('factures').update(champs).eq('id', factId);
      if (error) return JSON.stringify({ error: error.message });
      const { data: updated } = await supabase.from('factures').select('*').eq('id', factId).single();
      return JSON.stringify({ ok: true, facture: updated, __undo__: { table: 'factures', id: factId, champs: beforeFact ?? {} } });
    }

    if (name === 'modifier_ligne_facture') {
      let ligneId = String(input.ligne_id ?? '');
      if (!ligneId && input.facture_id && input.ligne_no) {
        const { data } = await supabase.from('lignes_facture').select('id').eq('facture_id', input.facture_id).eq('ligne_no', input.ligne_no).limit(1);
        ligneId = (data?.[0] as { id: string } | undefined)?.id ?? '';
      }
      if (!ligneId) return JSON.stringify({ error: 'Ligne introuvable' });
      const champs = input.champs as Record<string, unknown> ?? {};
      const { data: current } = await supabase.from('lignes_facture').select('quantite_facturee, pu_facture').eq('id', ligneId).single() as { data: { quantite_facturee: number; pu_facture: number } | null };
      const qte = Number((champs.quantite_facturee as number | undefined) ?? current?.quantite_facturee ?? 0);
      const pu = Number((champs.pu_facture as number | undefined) ?? current?.pu_facture ?? 0);
      const { error } = await supabase.from('lignes_facture').update({ ...champs, montant_ht_ligne: qte * pu }).eq('id', ligneId);
      if (error) return JSON.stringify({ error: error.message });
      return JSON.stringify({ ok: true });
    }

    if (name === 'modifier_be') {
      let beId = String(input.be_id ?? '');
      if (!beId && input.numero_be) {
        const { data } = await supabase.from('be_receptions').select('id').ilike('numero_be', `%${input.numero_be}%`).limit(1);
        beId = (data?.[0] as { id: string } | undefined)?.id ?? '';
      }
      if (!beId) return JSON.stringify({ error: 'BE introuvable' });
      const champs = input.champs as Record<string, unknown> ?? {};
      // Snapshot original fields for undo
      const { data: beforeBe } = await supabase.from('be_receptions').select(Object.keys(champs).join(',')).eq('id', beId).single();
      const { error } = await supabase.from('be_receptions').update(champs).eq('id', beId);
      if (error) return JSON.stringify({ error: error.message });
      const { data: updated } = await supabase.from('be_receptions').select('*').eq('id', beId).single();
      return JSON.stringify({ ok: true, be: updated, __undo__: { table: 'be_receptions', id: beId, champs: beforeBe ?? {} } });
    }

    if (name === 'lire_memoire_teddy') {
      let q = supabase.from('teddy_memory').select('cle, valeur, categorie, updated_at').order('updated_at', { ascending: false });
      if (input.cle) q = q.eq('cle', String(input.cle));
      if (input.categorie) q = q.eq('categorie', String(input.categorie));
      const { data } = await q.limit(100);
      return JSON.stringify(data ?? []);
    }

    if (name === 'sauvegarder_memoire_teddy') {
      const { error } = await supabase.from('teddy_memory').upsert({
        cle: String(input.cle ?? ''),
        valeur: String(input.valeur ?? ''),
        categorie: String(input.categorie ?? 'autre'),
      }, { onConflict: 'cle' });
      if (error) return JSON.stringify({ error: error.message });
      return JSON.stringify({ ok: true, cle: input.cle });
    }

    if (name === 'analyser_patterns_fournisseur') {
      const fourn = String(input.fournisseur ?? '');
      const sauvegarder = input.sauvegarder !== false;
      const sixMonthsAgo = new Date(Date.now() - 6 * 30 * 86400000).toISOString();

      const [resCommandes, resExceptions, resBes, resPrix] = await Promise.all([
        supabase.from('commandes').select('id, date_commande, statut_commande').ilike('fournisseur', `%${fourn}%`).gte('created_at', sixMonthsAgo),
        supabase.from('exceptions').select('id, type_exception, niveau_priorite, created_at').ilike('fournisseur', `%${fourn}%`).gte('created_at', sixMonthsAgo),
        supabase.from('be_receptions').select('id, date_bl, statut_be, created_at').ilike('fournisseur', `%${fourn}%`).gte('created_at', sixMonthsAgo),
        supabase.from('lignes_commande').select('reference_article, pu_commande, created_at, commandes!inner(fournisseur)').ilike('commandes.fournisseur', `%${fourn}%`).gte('created_at', sixMonthsAgo).not('pu_commande', 'is', null).limit(200),
      ]);

      const nbCommandes = resCommandes.data?.length ?? 0;
      const nbExceptions = resExceptions.data?.length ?? 0;
      const tauxAnomalie = nbCommandes > 0 ? Math.round((nbExceptions / nbCommandes) * 100) : 0;

      // Analyse délais livraison : BEs en anomalie ou anciens
      const besAnciens = (resBes.data ?? []).filter(be => {
        const created = new Date((be as Record<string, string>).created_at).getTime();
        const age = (Date.now() - created) / 86400000;
        return age > 14 && (be as Record<string, string>).statut_be !== 'soldé';
      }).length;

      // Analyse variations prix
      const prixParRef: Record<string, number[]> = {};
      for (const l of (resPrix.data ?? [])) {
        const row = l as Record<string, unknown>;
        const ref = String(row.reference_article ?? '');
        if (!ref) continue;
        if (!prixParRef[ref]) prixParRef[ref] = [];
        prixParRef[ref].push(Number(row.pu_commande ?? 0));
      }
      const variationsMoyennes = Object.values(prixParRef)
        .filter(prices => prices.length >= 2)
        .map(prices => {
          const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
          const variance = prices.reduce((s, p) => s + Math.pow(p - avg, 2), 0) / prices.length;
          return Math.round((Math.sqrt(variance) / (avg || 1)) * 100);
        });
      const variationMoyennePct = variationsMoyennes.length > 0
        ? Math.round(variationsMoyennes.reduce((a, b) => a + b, 0) / variationsMoyennes.length)
        : 0;

      const insights: string[] = [];
      if (tauxAnomalie > 20) insights.push(`Taux d'anomalies élevé (${tauxAnomalie}% des commandes)`);
      if (besAnciens > 0) insights.push(`${besAnciens} BEs anciens non soldés (+14j)`);
      if (variationMoyennePct > 10) insights.push(`Variabilité des prix notable (±${variationMoyennePct}% en moyenne)`);
      if (insights.length === 0) insights.push('Fournisseur fiable sur les 6 derniers mois');

      const summary = {
        fournisseur: fourn,
        periode: '6 derniers mois',
        nb_commandes: nbCommandes,
        nb_exceptions: nbExceptions,
        taux_anomalie_pct: tauxAnomalie,
        bes_anciens_non_soldes: besAnciens,
        variation_prix_pct: variationMoyennePct,
        insights,
      };

      if (sauvegarder && (nbCommandes > 0 || nbExceptions > 0)) {
        const valeur = `Taux anomalies: ${tauxAnomalie}%, BEs anciens: ${besAnciens}, variation prix: ±${variationMoyennePct}%. Insights: ${insights.join('; ')}`;
        await supabase.from('teddy_memory').upsert({
          cle: `pattern_${fourn.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 30)}`,
          valeur,
          categorie: 'fournisseur',
        }, { onConflict: 'cle' });
      }

      return JSON.stringify(summary);
    }

    if (name === 'recherche_globale') {
      const q = String(input.q ?? '');
      const fournisseur = String(input.fournisseur ?? '');
      const dateDebut = String(input.date_debut ?? '');
      const dateFin = String(input.date_fin ?? '');

      type AnyQuery = Record<string, (col: string, val: string) => AnyQuery>;
      const applyFilters = (qb: unknown): AnyQuery => {
        let r = qb as AnyQuery;
        if (fournisseur) r = r.ilike('fournisseur', `%${fournisseur}%`);
        if (dateDebut) r = r.gte('created_at', dateDebut);
        if (dateFin) r = r.lte('created_at', dateFin);
        return r;
      };

      const orQ = q ? `fournisseur.ilike.%${q}%` : 'id.neq.00000000-0000-0000-0000-000000000000';

      const [resCmd, resFact, resBe, resExc] = await Promise.all([
        (applyFilters(supabase.from('commandes').select('id,numero_commande_interne,fournisseur,statut_commande,montant_total_commande,created_at')) as unknown as { or: (s: string) => { limit: (n: number) => Promise<{ data: unknown[] | null }> } }).or(q ? `numero_commande_interne.ilike.%${q}%,${orQ}` : orQ).limit(8),
        (applyFilters(supabase.from('factures').select('id,numero_facture,fournisseur,statut_facture,total_ht,created_at')) as unknown as { or: (s: string) => { limit: (n: number) => Promise<{ data: unknown[] | null }> } }).or(q ? `numero_facture.ilike.%${q}%,${orQ}` : orQ).limit(8),
        (applyFilters(supabase.from('be_receptions').select('id,numero_be,fournisseur,statut_be,created_at')) as unknown as { or: (s: string) => { limit: (n: number) => Promise<{ data: unknown[] | null }> } }).or(q ? `numero_be.ilike.%${q}%,${orQ}` : orQ).limit(8),
        supabase.from('exceptions').select('id,type_exception,fournisseur,niveau_priorite,statut_exception,created_at').or(q ? `fournisseur.ilike.%${q}%,type_exception.ilike.%${q}%` : orQ).limit(8),
      ]);

      return JSON.stringify({
        commandes: (resCmd as { data: unknown[] | null }).data ?? [],
        factures: (resFact as { data: unknown[] | null }).data ?? [],
        be_receptions: (resBe as { data: unknown[] | null }).data ?? [],
        exceptions: resExc.data ?? [],
      });
    }

    if (name === 'get_echeances') {
      const jours = Number(input.jours ?? 30);
      const dateLimite = new Date(Date.now() + jours * 86400000).toISOString().slice(0, 10);
      const { data } = await supabase
        .from('factures')
        .select('id,numero_facture,fournisseur,date_echeance,total_ht,statut_facture,taux_rapprochement')
        .not('date_echeance', 'is', null)
        .lte('date_echeance', dateLimite)
        .not('statut_facture', 'eq', 'rapprochée')
        .order('date_echeance');
      const today = Date.now();
      const result = (data ?? []).map(f => {
        const row = f as Record<string, unknown>;
        const joursRestants = Math.floor((new Date(String(row.date_echeance)).getTime() - today) / 86400000);
        return { ...row, jours_restants: joursRestants, en_retard: joursRestants < 0 };
      });
      return JSON.stringify({
        en_retard: result.filter(f => f.en_retard),
        a_venir: result.filter(f => !f.en_retard),
        total: result.length,
      });
    }

    if (name === 'detecter_doublons') {
      const fournisseur = String(input.fournisseur ?? '');
      let q = supabase.from('factures').select('id,numero_facture,fournisseur,total_ht,date_facture').order('fournisseur,total_ht');
      if (fournisseur) q = q.ilike('fournisseur', `%${fournisseur}%`);
      const { data: rows } = await q;
      const all = (rows ?? []) as Record<string, unknown>[];
      const doublons: Array<{ type: string; factures: unknown[] }> = [];
      const byNum: Record<string, unknown[]> = {};
      for (const f of all) { const k = String(f.numero_facture ?? '').toLowerCase().trim(); if (!byNum[k]) byNum[k] = []; byNum[k].push(f); }
      for (const g of Object.values(byNum)) { if (g.length > 1) doublons.push({ type: 'numéro identique', factures: g }); }
      for (let i = 0; i < all.length; i++) {
        for (let j = i + 1; j < all.length; j++) {
          const a = all[i], b = all[j];
          if (a.fournisseur !== b.fournisseur) continue;
          if (Math.abs(Number(a.total_ht ?? 0) - Number(b.total_ht ?? 0)) > 0.01) continue;
          if (String(a.numero_facture).toLowerCase() === String(b.numero_facture).toLowerCase()) continue;
          const diff = Math.abs(new Date(String(a.date_facture)).getTime() - new Date(String(b.date_facture)).getTime()) / 86400000;
          if (diff <= 30) doublons.push({ type: 'montant + fournisseur identiques (dates ≤30j)', factures: [a, b] });
        }
      }
      return JSON.stringify({ doublons_potentiels: doublons, nb: doublons.length });
    }

    if (name === 'creer_facture') {
      const { data: fact, error } = await supabase.from('factures').insert({
        numero_facture: String(input.numero_facture ?? ''),
        fournisseur: String(input.fournisseur ?? ''),
        date_facture: input.date_facture ? String(input.date_facture) : null,
        date_echeance: input.date_echeance ? String(input.date_echeance) : null,
        total_ht: input.total_ht != null ? Number(input.total_ht) : null,
        montant_ttc: input.montant_ttc != null ? Number(input.montant_ttc) : null,
        statut_facture: 'importée',
        notes: input.notes ? String(input.notes) : null,
      }).select().single();
      if (error) return JSON.stringify({ error: error.message });
      return JSON.stringify({ ok: true, id: (fact as Record<string, unknown>).id, numero_facture: input.numero_facture });
    }

    if (name === 'creer_be') {
      const { data: be, error } = await supabase.from('be_receptions').insert({
        numero_be: String(input.numero_be ?? ''),
        fournisseur: String(input.fournisseur ?? ''),
        date_bl: input.date_bl ? String(input.date_bl) : null,
        date_reception: input.date_reception ? String(input.date_reception) : new Date().toISOString().slice(0, 10),
        statut_be: 'reçu',
        notes: input.notes ? String(input.notes) : null,
      }).select().single();
      if (error) return JSON.stringify({ error: error.message });
      return JSON.stringify({ ok: true, id: (be as Record<string, unknown>).id, numero_be: input.numero_be });
    }

    if (name === 'audit_complet') {
      const d30 = new Date(Date.now() - 30 * 86400000).toISOString();
      const d14 = new Date(Date.now() - 14 * 86400000).toISOString();
      const d7 = new Date(Date.now() - 7 * 86400000).toISOString();
      const [a, b, c, d, e, f, g] = await Promise.all([
        supabase.from('factures').select('id,numero_facture,fournisseur,total_ht,created_at').in('statut_facture', ['importée', 'en cours de rapprochement']).lte('created_at', d30).limit(20),
        supabase.from('be_receptions').select('id,numero_be,fournisseur,statut_be,created_at').in('statut_be', ['reçu', 'partiellement facturé']).lte('created_at', d14).limit(20),
        supabase.from('commandes').select('id,numero_commande_interne,fournisseur,created_at').eq('statut_commande', 'en anomalie').limit(20),
        supabase.from('exceptions').select('id,type_exception,fournisseur,niveau_priorite,created_at').in('statut_exception', ['ouverte', 'en cours']).lte('created_at', d7).limit(20),
        supabase.from('rapprochements').select('id,score_match').eq('statut_validation', 'proposé').lt('score_match', 0.7).limit(10),
        supabase.from('exceptions').select('id', { count: 'exact', head: true }).in('statut_exception', ['ouverte', 'en cours']),
        supabase.from('rapprochements').select('id', { count: 'exact', head: true }).eq('statut_validation', 'proposé'),
      ]);
      const score = Math.max(0, 100 - (a.data?.length ?? 0) * 3 - (b.data?.length ?? 0) * 2 - (c.data?.length ?? 0) * 2 - (d.data?.length ?? 0) * 2 - (e.data?.length ?? 0) * 2);
      return JSON.stringify({
        score_global: score,
        kpis: { exceptions_actives: f.count ?? 0, rapprochements_en_attente: g.count ?? 0 },
        alertes: {
          factures_sans_rapprochement_30j: a.data ?? [],
          bes_anciens_non_soldes: b.data ?? [],
          commandes_en_anomalie: c.data ?? [],
          exceptions_non_resolues_7j: d.data ?? [],
          rapprochements_score_faible: e.data ?? [],
        },
      });
    }

    if (name === 'generer_rapport') {
      const fournisseur = String(input.fournisseur ?? '');
      // Pas de filtre sur created_at : cette colonne reflète la date d'import Supabase,
      // pas la date métier des documents. Le rapport est toujours un bilan global.
      const now = new Date();
      const periodeLabel = `Bilan global — au ${now.toLocaleDateString('fr-FR')}`;
      type RapportQuery = { ilike: (c: string, v: string) => RapportQuery; data?: Record<string, unknown>[] | null };
      const applyF = (q: RapportQuery) => fournisseur ? q.ilike('fournisseur', `%${fournisseur}%`) : q;
      const [rF, rB, rC, rE, rR] = await Promise.all([
        applyF(supabase.from('factures').select('fournisseur,total_ht,statut_facture,taux_rapprochement') as unknown as RapportQuery),
        applyF(supabase.from('be_receptions').select('fournisseur,statut_be') as unknown as RapportQuery),
        applyF(supabase.from('commandes').select('fournisseur,montant_total_commande,statut_commande') as unknown as RapportQuery),
        supabase.from('exceptions').select('statut_exception'),
        supabase.from('rapprochements').select('statut_validation,score_match'),
      ]);
      const facts = (rF as unknown as { data: Record<string, unknown>[] | null }).data ?? [];
      const cmds = (rC as unknown as { data: Record<string, unknown>[] | null }).data ?? [];
      const bes = (rB as unknown as { data: Record<string, unknown>[] | null }).data ?? [];
      const excs = rE.data ?? [];
      const raps = rR.data ?? [];
      const montantFact = facts.reduce((s, f) => s + Number(f.total_ht ?? 0), 0);
      const montantCmd = cmds.reduce((s, c) => s + Number(c.montant_total_commande ?? 0), 0);
      const tauxMoyen = facts.length ? Math.round(facts.reduce((s, f) => s + Number(f.taux_rapprochement ?? 0), 0) / facts.length) : 0;
      const parFourn: Record<string, number> = {};
      for (const f of facts) { const k = String(f.fournisseur ?? 'Inconnu'); parFourn[k] = (parFourn[k] ?? 0) + Number(f.total_ht ?? 0); }
      const topFourn = Object.entries(parFourn).sort(([, a], [, b]) => b - a).slice(0, 5).map(([nom, montant]) => ({ nom, montant: Math.round(montant) }));
      return JSON.stringify({
        periode: periodeLabel,
        note: 'Toutes les données sans filtre de date (created_at = date import, pas date document)',
        kpis: {
          factures: facts.length, montant_facture: Math.round(montantFact),
          commandes: cmds.length, montant_commandes: Math.round(montantCmd),
          bes: bes.length,
          exceptions_ouvertes: excs.filter(e => (e as Record<string, unknown>).statut_exception !== 'résolue').length,
          rapprochements_valides: raps.filter(r => (r as Record<string, unknown>).statut_validation === 'validé').length,
          taux_rapprochement_moyen: tauxMoyen,
        },
        top_fournisseurs: topFourn,
      });
    }

    if (name === 'comparer_fournisseurs') {
      const fournisseurs = (input.fournisseurs as string[]) ?? [];
      if (fournisseurs.length < 2) return JSON.stringify({ error: 'Fournir au moins 2 fournisseurs à comparer' });
      const since = new Date(Date.now() - 6 * 30 * 86400000).toISOString();
      const results = await Promise.all(fournisseurs.map(async (fourn: string) => {
        const [rc, re, rb, rf] = await Promise.all([
          supabase.from('commandes').select('id,montant_total_commande,statut_commande').ilike('fournisseur', `%${fourn}%`).gte('created_at', since),
          supabase.from('exceptions').select('id,niveau_priorite').ilike('fournisseur', `%${fourn}%`).gte('created_at', since),
          supabase.from('be_receptions').select('id,statut_be,created_at').ilike('fournisseur', `%${fourn}%`).gte('created_at', since),
          supabase.from('factures').select('id,total_ht,taux_rapprochement').ilike('fournisseur', `%${fourn}%`).gte('created_at', since),
        ]);
        const cmds = rc.data ?? [], excs = re.data ?? [], bes = rb.data ?? [], facts = rf.data ?? [];
        const montant = cmds.reduce((s, c) => s + Number((c as Record<string, unknown>).montant_total_commande ?? 0), 0);
        const besAnciens = bes.filter(be => {
          const age = (Date.now() - new Date(String((be as Record<string, unknown>).created_at)).getTime()) / 86400000;
          return age > 14 && !['soldé', 'facturé'].includes(String((be as Record<string, unknown>).statut_be));
        }).length;
        const tauxRap = facts.length ? Math.round(facts.reduce((s, f) => s + Number((f as Record<string, unknown>).taux_rapprochement ?? 0), 0) / facts.length) : 0;
        return { fournisseur: fourn, nb_commandes: cmds.length, montant_total: Math.round(montant), nb_anomalies: excs.length, taux_anomalie_pct: cmds.length ? Math.round(excs.length / cmds.length * 100) : 0, bes_anciens: besAnciens, taux_rapprochement_moyen: tauxRap, nb_factures: facts.length };
      }));
      return JSON.stringify({ comparaison: results, periode: '6 derniers mois' });
    }

    if (name === 'exporter_donnees') {
      const entite = String(input.entite ?? 'commandes');
      const fournisseur = String(input.fournisseur ?? '');
      const statut = String(input.statut ?? '');
      const dateDebut = String(input.date_debut ?? '');
      const dateFin = String(input.date_fin ?? '');
      let rows: Record<string, unknown>[] = [];
      let headers: string[] = [];
      let filename = '';
      type ExportQuery = Record<string, (c: string, v: string) => ExportQuery>;
      const af = (q: unknown) => {
        let r = q as ExportQuery;
        if (fournisseur) r = r.ilike('fournisseur', `%${fournisseur}%`);
        return r;
      };
      if (entite === 'commandes') {
        let q = af(supabase.from('commandes').select('numero_commande_interne,fournisseur,date_commande,statut_commande,montant_total_commande,created_at').order('created_at', { ascending: false }).limit(500));
        if (statut) q = (q as unknown as { eq: (c: string, v: string) => typeof q }).eq('statut_commande', statut);
        if (dateDebut) q = (q as unknown as { gte: (c: string, v: string) => typeof q }).gte('date_commande', dateDebut);
        if (dateFin) q = (q as unknown as { lte: (c: string, v: string) => typeof q }).lte('date_commande', dateFin);
        const { data } = await (q as unknown as Promise<{ data: Record<string, unknown>[] | null }>);
        rows = data ?? []; headers = ['numero_commande_interne','fournisseur','date_commande','statut_commande','montant_total_commande','created_at']; filename = `commandes_${new Date().toISOString().slice(0,10)}.csv`;
      } else if (entite === 'factures') {
        let q = af(supabase.from('factures').select('numero_facture,fournisseur,date_facture,date_echeance,total_ht,statut_facture,taux_rapprochement,created_at').order('created_at', { ascending: false }).limit(500));
        if (statut) q = (q as unknown as { eq: (c: string, v: string) => typeof q }).eq('statut_facture', statut);
        if (dateDebut) q = (q as unknown as { gte: (c: string, v: string) => typeof q }).gte('date_facture', dateDebut);
        if (dateFin) q = (q as unknown as { lte: (c: string, v: string) => typeof q }).lte('date_facture', dateFin);
        const { data } = await (q as unknown as Promise<{ data: Record<string, unknown>[] | null }>);
        rows = data ?? []; headers = ['numero_facture','fournisseur','date_facture','date_echeance','total_ht','statut_facture','taux_rapprochement']; filename = `factures_${new Date().toISOString().slice(0,10)}.csv`;
      } else if (entite === 'be_receptions') {
        let q = af(supabase.from('be_receptions').select('numero_be,fournisseur,date_bl,date_reception,statut_be,notes,created_at').order('created_at', { ascending: false }).limit(500));
        if (statut) q = (q as unknown as { eq: (c: string, v: string) => typeof q }).eq('statut_be', statut);
        if (dateDebut) q = (q as unknown as { gte: (c: string, v: string) => typeof q }).gte('date_bl', dateDebut);
        if (dateFin) q = (q as unknown as { lte: (c: string, v: string) => typeof q }).lte('date_bl', dateFin);
        const { data } = await (q as unknown as Promise<{ data: Record<string, unknown>[] | null }>);
        rows = data ?? []; headers = ['numero_be','fournisseur','date_bl','date_reception','statut_be','notes']; filename = `be_receptions_${new Date().toISOString().slice(0,10)}.csv`;
      } else if (entite === 'exceptions') {
        let q = af(supabase.from('exceptions').select('type_exception,fournisseur,niveau_priorite,statut_exception,motif,created_at').order('created_at', { ascending: false }).limit(500));
        if (statut) q = (q as unknown as { eq: (c: string, v: string) => typeof q }).eq('statut_exception', statut);
        const { data } = await (q as unknown as Promise<{ data: Record<string, unknown>[] | null }>);
        rows = data ?? []; headers = ['type_exception','fournisseur','niveau_priorite','statut_exception','motif','created_at']; filename = `exceptions_${new Date().toISOString().slice(0,10)}.csv`;
      }
      const esc = (v: unknown) => { const s = String(v ?? ''); return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      const csv = [headers.join(','), ...rows.map(r => headers.map(h => esc(r[h])).join(','))].join('\n');
      const b64 = Buffer.from('﻿' + csv, 'utf-8').toString('base64');
      return JSON.stringify({ __export__: true, filename, b64, rows_count: rows.length });
    }

    if (name === 'get_historique_prix') {
      const ref = String(input.reference_article ?? '');
      const fourn = String(input.fournisseur ?? '');
      let q = supabase.from('lignes_commande')
        .select('pu_commande,created_at,commandes!inner(fournisseur,date_commande,numero_commande_interne)')
        .eq('reference_article', ref)
        .not('pu_commande', 'is', null)
        .order('created_at', { ascending: false })
        .limit(50);
      if (fourn) q = q.ilike('commandes.fournisseur', `%${fourn}%`);
      const { data } = await q;
      const rows = (data ?? []) as Record<string, unknown>[];
      if (rows.length === 0) {
        const { data: cat } = await supabase.from('prix_reference').select('*').eq('reference_article', ref).limit(5);
        return JSON.stringify({ reference: ref, historique: [], catalogue: cat ?? [] });
      }
      const prix = rows.map(r => Number(r.pu_commande ?? 0));
      const min = Math.min(...prix), max = Math.max(...prix);
      const avg = prix.reduce((a, b) => a + b, 0) / prix.length;
      return JSON.stringify({
        reference: ref,
        stats: { min, max, moyenne: Math.round(avg * 100) / 100, dernier_prix: rows[0].pu_commande, nb_occurrences: rows.length },
        historique: rows.slice(0, 20),
      });
    }

    if (name === 'get_bes_sur_factures') {
      type FacRow = { id: string; numero_facture: string; date_facture: string; fournisseur: string };
      let factures: FacRow[] = [];

      if (input.facture_id) {
        const { data } = await supabase.from('factures').select('id, numero_facture, date_facture, fournisseur').eq('id', String(input.facture_id));
        factures = (data ?? []) as FacRow[];
      } else {
        let q = supabase.from('factures').select('id, numero_facture, date_facture, fournisseur').order('date_facture', { ascending: false }).limit(300);
        if (input.numero_facture) q = q.ilike('numero_facture', `%${String(input.numero_facture)}%`);
        if (input.fournisseur) q = q.ilike('fournisseur', `%${String(input.fournisseur)}%`);
        if (input.mois) {
          const [yr, mo] = String(input.mois).split('-');
          q = q.gte('date_facture', `${yr}-${mo}-01`).lte('date_facture', new Date(parseInt(yr), parseInt(mo), 0).toISOString().slice(0, 10));
        }
        if (input.date_debut) q = q.gte('date_facture', String(input.date_debut));
        if (input.date_fin) q = q.lte('date_facture', String(input.date_fin));
        const { data } = await q;
        factures = (data ?? []) as FacRow[];
      }

      if (factures.length === 0) return JSON.stringify({ bes: [], message: 'Aucune facture trouvée avec ces critères.' });

      const factureIds = factures.map(f => f.id);
      const factureMap = Object.fromEntries(factures.map(f => [f.id, f]));

      const [{ data: lignes }, { data: raps }] = await Promise.all([
        supabase.from('lignes_facture').select('facture_id, numero_be_detecte').in('facture_id', factureIds).not('numero_be_detecte', 'is', null),
        supabase.from('rapprochements').select('facture_id, be_id, statut_validation').in('facture_id', factureIds).not('be_id', 'is', null),
      ]);

      const rapBeIds = [...new Set((raps ?? []).map(r => r.be_id as string))];
      let beDetails: { id: string; numero_be: string }[] = [];
      if (rapBeIds.length > 0) {
        const { data } = await supabase.from('be_receptions').select('id, numero_be').in('id', rapBeIds);
        beDetails = (data ?? []) as { id: string; numero_be: string }[];
      }
      const beNumMap = Object.fromEntries(beDetails.map(b => [b.id, b.numero_be]));

      type BEEntry = { numero_be: string; source: string; factures: { numero_facture: string; date_facture: string }[]; statuts_rapprochement: string[] };
      const beMap = new Map<string, BEEntry>();

      for (const l of (lignes ?? [])) {
        const num = l.numero_be_detecte as string;
        if (!beMap.has(num)) beMap.set(num, { numero_be: num, source: 'détecté', factures: [], statuts_rapprochement: [] });
        const fac = factureMap[l.facture_id as string];
        const entry = beMap.get(num)!;
        if (fac && !entry.factures.find(f => f.numero_facture === fac.numero_facture))
          entry.factures.push({ numero_facture: fac.numero_facture, date_facture: fac.date_facture });
      }

      for (const r of (raps ?? [])) {
        const num = beNumMap[r.be_id as string];
        if (!num) continue;
        if (!beMap.has(num)) beMap.set(num, { numero_be: num, source: 'rapproché', factures: [], statuts_rapprochement: [] });
        const entry = beMap.get(num)!;
        entry.source = 'rapproché';
        const fac = factureMap[r.facture_id as string];
        if (fac && !entry.factures.find(f => f.numero_facture === fac.numero_facture))
          entry.factures.push({ numero_facture: fac.numero_facture, date_facture: fac.date_facture });
        const sv = r.statut_validation as string;
        if (sv && !entry.statuts_rapprochement.includes(sv)) entry.statuts_rapprochement.push(sv);
      }

      const results = Array.from(beMap.values()).sort((a, b) => a.numero_be.localeCompare(b.numero_be));
      return JSON.stringify({ nb_factures_analysees: factureIds.length, nb_bes: results.length, bes: results });
    }

    if (name === 'analyser_ecarts_prix_fournisseur') {
      const fournisseur = String(input.fournisseur ?? '');
      const periodeMois = Number(input.periode_mois ?? 6);
      const seuilPct = Number(input.seuil_pct ?? 5);
      const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - periodeMois);
      const { data: factures } = await supabase.from('factures').select('id, numero_facture').ilike('fournisseur', `%${fournisseur}%`).gte('date_facture', cutoff.toISOString().slice(0, 10));
      if (!factures || factures.length === 0) return JSON.stringify({ message: `Aucune facture trouvée pour "${fournisseur}" sur ${periodeMois} mois.` });
      const facIds = factures.map(f => f.id);
      const facNumMap = Object.fromEntries(factures.map(f => [f.id, f.numero_facture]));
      const { data: lignesF } = await supabase.from('lignes_facture').select('reference_article, pu_facture, facture_id').in('facture_id', facIds).not('reference_article', 'is', null).not('pu_facture', 'is', null);
      if (!lignesF || lignesF.length === 0) return JSON.stringify({ message: 'Aucune ligne de facture avec prix trouvée.' });
      const refs = [...new Set(lignesF.map(l => l.reference_article as string))];
      const { data: catalogue } = await supabase.from('prix_reference').select('reference_article, pu_reference').in('reference_article', refs);
      const catMap = new Map((catalogue ?? []).map(c => [c.reference_article, Number(c.pu_reference)]));
      const ecarts: { reference: string; pu_facture: number; pu_reference: number; ecart_pct: number; facture: string }[] = [];
      for (const l of lignesF) {
        const ref = l.reference_article as string;
        const puF = Number(l.pu_facture);
        const puRef = catMap.get(ref);
        if (!puRef || puRef === 0) continue;
        const ecartPct = Math.round(((puF - puRef) / puRef) * 10000) / 100;
        if (Math.abs(ecartPct) >= seuilPct) ecarts.push({ reference: ref, pu_facture: puF, pu_reference: puRef, ecart_pct: ecartPct, facture: facNumMap[l.facture_id as string] ?? '' });
      }
      ecarts.sort((a, b) => Math.abs(b.ecart_pct) - Math.abs(a.ecart_pct));
      const unique = [...new Map(ecarts.map(e => [e.reference, e])).values()];
      return JSON.stringify({ fournisseur, periode_mois: periodeMois, seuil_pct: seuilPct, nb_refs_analysees: refs.length, nb_refs_avec_catalogue: catMap.size, nb_ecarts: unique.length, ecarts: unique.slice(0, 30), note: unique.length === 0 ? `Aucun écart ≥ ${seuilPct}% détecté.` : `${unique.length} référence(s) avec écart ≥ ${seuilPct}%.` });
    }

    if (name === 'get_flux_tresorerie') {
      const periodeMois = Number(input.periode_mois ?? 3);
      const fournisseur = input.fournisseur ? String(input.fournisseur) : null;
      const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - periodeMois);
      let q = supabase.from('factures').select('id, fournisseur, date_facture, total_ht, statut_facture').gte('date_facture', cutoff.toISOString().slice(0, 10)).order('date_facture', { ascending: false }).limit(500);
      if (fournisseur) q = q.ilike('fournisseur', `%${fournisseur}%`);
      const { data: factures } = await q;
      if (!factures || factures.length === 0) return JSON.stringify({ message: 'Aucune facture sur cette période.' });
      const facIds = factures.map(f => f.id);
      const { data: raps } = await supabase.from('rapprochements').select('facture_id, montant_rapproche, statut_validation').in('facture_id', facIds);
      const rapsByFac = new Map<string, { valide: number; propose: number }>();
      for (const r of (raps ?? [])) {
        if (!rapsByFac.has(r.facture_id)) rapsByFac.set(r.facture_id, { valide: 0, propose: 0 });
        const m = Number(r.montant_rapproche ?? 0);
        if (r.statut_validation === 'validé') rapsByFac.get(r.facture_id)!.valide += m;
        else if (r.statut_validation === 'proposé') rapsByFac.get(r.facture_id)!.propose += m;
      }
      const byMonth = new Map<string, { mois: string; total_ht: number; valide: number; propose: number; non_rapproche: number; nb_factures: number }>();
      let tHt = 0, tVal = 0, tProp = 0, tNon = 0;
      for (const f of factures) {
        const mois = String(f.date_facture ?? '').slice(0, 7);
        if (!byMonth.has(mois)) byMonth.set(mois, { mois, total_ht: 0, valide: 0, propose: 0, non_rapproche: 0, nb_factures: 0 });
        const entry = byMonth.get(mois)!;
        const ht = Number(f.total_ht ?? 0);
        const rap = rapsByFac.get(f.id) ?? { valide: 0, propose: 0 };
        const nonRap = Math.max(0, ht - rap.valide - rap.propose);
        entry.total_ht += ht; entry.valide += rap.valide; entry.propose += rap.propose; entry.non_rapproche += nonRap; entry.nb_factures++;
        tHt += ht; tVal += rap.valide; tProp += rap.propose; tNon += nonRap;
      }
      const r2 = (n: number) => Math.round(n * 100) / 100;
      return JSON.stringify({ periode_mois: periodeMois, fournisseur: fournisseur ?? 'tous', synthese: { total_facture_ht: r2(tHt), montant_valide: r2(tVal), montant_en_attente: r2(tProp), montant_non_rapproche: r2(tNon), taux_couverture_pct: tHt > 0 ? Math.round((tVal / tHt) * 100) : 0 }, par_mois: Array.from(byMonth.values()).sort((a, b) => b.mois.localeCompare(a.mois)).map(m => ({ ...m, total_ht: r2(m.total_ht), valide: r2(m.valide), propose: r2(m.propose), non_rapproche: r2(m.non_rapproche) })) });
    }

    if (name === 'detecter_surfacturations') {
      const fournisseur = input.fournisseur ? String(input.fournisseur) : null;
      const seuilPct = Number(input.seuil_pct ?? 3);
      let facQ = supabase.from('factures').select('id, numero_facture, fournisseur').limit(500);
      if (fournisseur) facQ = facQ.ilike('fournisseur', `%${fournisseur}%`);
      const { data: factures } = await facQ;
      if (!factures || factures.length === 0) return JSON.stringify({ message: 'Aucune facture trouvée.' });
      const facIds = factures.map(f => f.id);
      const facMap = Object.fromEntries(factures.map(f => [f.id, f]));
      const { data: raps } = await supabase.from('rapprochements').select('facture_id, ligne_facture_id, ligne_be_id').in('facture_id', facIds).in('statut_validation', ['validé', 'proposé']).limit(1000);
      if (!raps || raps.length === 0) return JSON.stringify({ message: 'Aucun rapprochement trouvé.' });
      const lfIds = [...new Set(raps.map(r => r.ligne_facture_id as string).filter(Boolean))];
      const lbIds = [...new Set(raps.map(r => r.ligne_be_id as string).filter(Boolean))];
      const [{ data: lignesF }, { data: lignesB }] = await Promise.all([
        supabase.from('lignes_facture').select('id, reference_article, pu_facture, designation').in('id', lfIds),
        supabase.from('lignes_be').select('id, ligne_commande_id').in('id', lbIds).not('ligne_commande_id', 'is', null),
      ]);
      const lcIds = [...new Set((lignesB ?? []).map(lb => lb.ligne_commande_id as string).filter(Boolean))];
      const { data: lignesC } = lcIds.length > 0 ? await supabase.from('lignes_commande').select('id, pu_commande').in('id', lcIds) : { data: [] };
      const lfMap = Object.fromEntries((lignesF ?? []).map(l => [l.id, l]));
      const lbMap = Object.fromEntries((lignesB ?? []).map(l => [l.id, l]));
      const lcMap = Object.fromEntries((lignesC ?? []).map(l => [l.id, l]));
      const surfacts: { reference: string; designation: string; pu_facture: number; pu_commande: number; ecart_pct: number; ecart_eur: number; facture: string; fournisseur_nom: string }[] = [];
      for (const rap of raps) {
        const lf = lfMap[rap.ligne_facture_id as string];
        const lb = lbMap[rap.ligne_be_id as string];
        if (!lf || !lb || !lb.ligne_commande_id) continue;
        const lc = lcMap[lb.ligne_commande_id as string];
        if (!lc) continue;
        const puF = Number(lf.pu_facture ?? 0);
        const puC = Number(lc.pu_commande ?? 0);
        if (!puF || !puC) continue;
        const ecartPct = Math.round(((puF - puC) / puC) * 10000) / 100;
        if (ecartPct >= seuilPct) {
          const fac = facMap[rap.facture_id as string];
          surfacts.push({ reference: String(lf.reference_article ?? ''), designation: String(lf.designation ?? ''), pu_facture: puF, pu_commande: puC, ecart_pct: ecartPct, ecart_eur: Math.round((puF - puC) * 100) / 100, facture: fac?.numero_facture ?? '', fournisseur_nom: fac?.fournisseur ?? '' });
        }
      }
      surfacts.sort((a, b) => b.ecart_pct - a.ecart_pct);
      const totalEcartEur = Math.round(surfacts.reduce((s, l) => s + l.ecart_eur, 0) * 100) / 100;
      return JSON.stringify({ seuil_pct: seuilPct, fournisseur: fournisseur ?? 'tous', nb_surfacturations: surfacts.length, total_ecart_eur: totalEcartEur, surfacturations: surfacts.slice(0, 30), note: surfacts.length === 0 ? `Aucune surfacturation ≥ ${seuilPct}% détectée.` : `${surfacts.length} ligne(s) avec surfacturation ≥ ${seuilPct}% — écart total : ${totalEcartEur} €.` });
    }

    if (name === 'planifier_rappel') {
      const message = String(input.message ?? '');
      const date = String(input.date_rappel ?? '');
      if (!message || !date) return JSON.stringify({ error: 'message et date_rappel requis.' });
      const heure = input.heure ? String(input.heure) : null;
      const key = `rappel_${date}${heure ? `_${heure.replace(':', 'h')}` : ''}`;
      await supabase.from('teddy_memory').upsert({ cle: key, valeur: message, categorie: 'rappel', updated_at: new Date().toISOString() }, { onConflict: 'cle' });
      await supabase.from('notifications').insert({ type: 'rappel_planifie', severite: 'info', titre: `Rappel : ${date}`, message, lu: false });
      return JSON.stringify({ ok: true, message: `Rappel planifié pour le ${date}${heure ? ` à ${heure}` : ''} : "${message}"` });
    }

    if (name === 'rapport_complet_fournisseur') {
      const fournisseur = String(input.fournisseur ?? '');
      if (!fournisseur) return JSON.stringify({ error: 'fournisseur requis.' });
      const since3m = new Date(); since3m.setMonth(since3m.getMonth() - 3);
      const since6m = new Date(); since6m.setMonth(since6m.getMonth() - 6);
      const [{ data: factures }, { data: bes }, { data: commandes }, { data: exceptions }, { data: memo }] = await Promise.all([
        supabase.from('factures').select('id, numero_facture, date_facture, total_ht, statut_facture, taux_rapprochement').ilike('fournisseur', `%${fournisseur}%`).gte('date_facture', since3m.toISOString().slice(0, 10)).order('date_facture', { ascending: false }),
        supabase.from('be_receptions').select('id, numero_be, date_bl, statut_be').ilike('fournisseur', `%${fournisseur}%`).gte('created_at', since3m.toISOString()).order('created_at', { ascending: false }),
        supabase.from('commandes').select('numero_commande_interne, date_commande, montant_total_commande, statut_commande').ilike('fournisseur', `%${fournisseur}%`).gte('date_commande', since6m.toISOString().slice(0, 10)).order('date_commande', { ascending: false }),
        supabase.from('exceptions').select('type_exception, niveau_priorite, statut_exception, motif').ilike('fournisseur', `%${fournisseur}%`).in('statut_exception', ['ouverte', 'en cours']),
        supabase.from('teddy_memory').select('cle, valeur').or(`cle.ilike.%${fournisseur.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8)}%,categorie.eq.fournisseur`).limit(10),
      ]);
      const montantHT = (factures ?? []).reduce((s, f) => s + Number(f.total_ht ?? 0), 0);
      const tauxMoyen = (factures ?? []).length > 0 ? Math.round((factures ?? []).reduce((s, f) => s + Number(f.taux_rapprochement ?? 0), 0) / (factures ?? []).length) : 0;
      const besAnciens = (bes ?? []).filter(b => ['reçu', 'partiellement facturé'].includes(String(b.statut_be)));
      return JSON.stringify({ fournisseur, periode: '3-6 derniers mois', factures: { total: (factures ?? []).length, montant_ht: Math.round(montantHT * 100) / 100, taux_rapprochement_moyen: tauxMoyen, liste: (factures ?? []).slice(0, 10) }, be_receptions: { total: (bes ?? []).length, anciens_non_factures: besAnciens.length, liste_anciens: besAnciens.slice(0, 5) }, commandes: { total: (commandes ?? []).length, liste: (commandes ?? []).slice(0, 5) }, exceptions_actives: exceptions ?? [], memoire_fournisseur: (memo ?? []).map(m => `${m.cle}: ${m.valeur}`) });
    }

    if (name === 'synthese_mensuelle') {
      const mois = input.mois ? String(input.mois) : new Date().toISOString().slice(0, 7);
      const [yr, mo] = mois.split('-');
      const start = `${yr}-${mo}-01`;
      const end = new Date(parseInt(yr), parseInt(mo), 0).toISOString().slice(0, 10);
      const prevDate = new Date(parseInt(yr), parseInt(mo) - 2, 1);
      const prevStart = prevDate.toISOString().slice(0, 7) + '-01';
      const prevEnd = new Date(parseInt(yr), parseInt(mo) - 1, 0).toISOString().slice(0, 10);
      const [{ data: facs, count: nbFac }, { data: facsPrev }, { count: nbBes }, { count: nbBesPrev }, { data: exceptions }, { data: raps }] = await Promise.all([
        supabase.from('factures').select('fournisseur, total_ht, statut_facture, taux_rapprochement', { count: 'exact' }).gte('date_facture', start).lte('date_facture', end),
        supabase.from('factures').select('total_ht').gte('date_facture', prevStart).lte('date_facture', prevEnd),
        supabase.from('be_receptions').select('id', { count: 'exact', head: true }).gte('created_at', `${start}T00:00:00Z`).lte('created_at', `${end}T23:59:59Z`),
        supabase.from('be_receptions').select('id', { count: 'exact', head: true }).gte('created_at', `${prevStart}T00:00:00Z`).lte('created_at', `${prevEnd}T23:59:59Z`),
        supabase.from('exceptions').select('type_exception, niveau_priorite').in('statut_exception', ['ouverte', 'en cours']),
        supabase.from('rapprochements').select('montant_rapproche').eq('statut_validation', 'validé').gte('created_at', `${start}T00:00:00Z`).lte('created_at', `${end}T23:59:59Z`),
      ]);
      const montantHT = (facs ?? []).reduce((s, f) => s + Number(f.total_ht ?? 0), 0);
      const montantHTPrev = (facsPrev ?? []).reduce((s, f) => s + Number(f.total_ht ?? 0), 0);
      const montantValide = (raps ?? []).reduce((s, r) => s + Number(r.montant_rapproche ?? 0), 0);
      const tauxMoyen = (facs ?? []).length > 0 ? Math.round((facs ?? []).reduce((s, f) => s + Number(f.taux_rapprochement ?? 0), 0) / (facs ?? []).length) : 0;
      const byFourn = new Map<string, number>();
      for (const f of (facs ?? [])) byFourn.set(f.fournisseur ?? '?', (byFourn.get(f.fournisseur ?? '?') ?? 0) + Number(f.total_ht ?? 0));
      const topFournisseurs = [...byFourn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([nom, mt]) => ({ nom, montant_ht: Math.round(mt * 100) / 100 }));
      const r2 = (n: number) => Math.round(n * 100) / 100;
      return JSON.stringify({ mois, factures: { total: nbFac ?? 0, montant_ht: r2(montantHT), montant_precedent: r2(montantHTPrev), evolution_pct: montantHTPrev > 0 ? Math.round(((montantHT - montantHTPrev) / montantHTPrev) * 100) : null, taux_rapprochement_moyen: tauxMoyen, montant_valide: r2(montantValide) }, be_receptions: { total: nbBes ?? 0, precedent: nbBesPrev ?? 0 }, exceptions_ouvertes: (exceptions ?? []).length, top_fournisseurs: topFournisseurs });
    }

    return JSON.stringify({ error: `Outil inconnu: ${name}` });
  } catch (e) {
    return JSON.stringify({ error: String(e) });
  }
}

type ContentBlock = Record<string, unknown>;

export async function POST(req: NextRequest) {
  const { messages, currentPage, entityContext } = await req.json() as {
    messages: Array<{ role: 'user' | 'assistant'; content: unknown }>;
    currentPage?: string;
    entityContext?: { type: string; id: string };
  };

  const encoder = new TextEncoder();

  // Charger mémoire persistante + historique conversations en parallèle
  const [{ data: memoryRows }, { data: recentConvos }] = await Promise.all([
    supabase.from('teddy_memory').select('cle, valeur, categorie').order('updated_at', { ascending: false }).limit(60),
    supabase.from('teddy_conversations').select('resume, themes, created_at').order('created_at', { ascending: false }).limit(5),
  ]);
  const memorySection = (memoryRows ?? []).length > 0
    ? `\n\n════════════════════════════════════════\nMÉMOIRE PERSISTANTE (faits mémorisés)\n════════════════════════════════════════\n${(memoryRows ?? []).map((r: Record<string, string>) => `[${r.categorie}] ${r.cle}: ${r.valeur}`).join('\n')}`
    : '';
  const convosSection = (recentConvos ?? []).length > 0
    ? `\n\n════════════════════════════════════════\nCONVERSATIONS RÉCENTES\n════════════════════════════════════════\n${(recentConvos ?? []).map((c: Record<string, unknown>) => `[${new Date(String(c.created_at)).toLocaleDateString('fr-FR')}${(c.themes as string[] | null)?.length ? ' · ' + (c.themes as string[]).join(', ') : ''}] ${c.resume}`).join('\n')}`
    : '';

  let contextSection = '';
  if (currentPage) {
    contextSection = `\n\n════════════════════════════════════════\nCONTEXTE DE NAVIGATION\n════════════════════════════════════════\nPage actuelle : ${currentPage}`;
    if (entityContext) {
      contextSection += `\nEntité active : ${entityContext.type} (ID: ${entityContext.id})\nTu peux utiliser cet ID directement dans les outils sans demander à l'utilisateur.`;
    }
    contextSection += '\nAdapte tes suggestions à ce contexte.';
  }
  const systemArray = [
    { type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } },
    ...((memorySection || convosSection || contextSection) ? [{ type: 'text', text: `${memorySection}${convosSection}${contextSection}` }] : []),
  ];

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: object) => {
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); } catch {}
      };

      // Fenêtre glissante : 40 messages max, on ne coupe jamais au milieu d'un aller-retour tool_use/tool_result
      const MAX_HISTORY = 40;
      const allMsgs = messages
        .map(m => ({ role: m.role, content: m.content }))
        .filter(m => {
          if (typeof m.content === 'string') return m.content.trim().length > 0;
          if (Array.isArray(m.content)) return m.content.length > 0;
          return false;
        });
      let histStart = Math.max(0, allMsgs.length - MAX_HISTORY);
      while (histStart < allMsgs.length) {
        const m = allMsgs[histStart];
        const isOrphanResult = m.role === 'user' && Array.isArray(m.content) &&
          (m.content as ContentBlock[]).some(b => (b as Record<string, unknown>).type === 'tool_result');
        if (!isOrphanResult) break;
        histStart++;
      }
      const claudeMessages = allMsgs.slice(histStart);
      let iterations = 0;
      const usedToolNames = new Set<string>();

      try {
        while (iterations < 10) {
          iterations++;

          const res = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'x-api-key': process.env.ANTHROPIC_API_KEY!,
              'anthropic-version': '2023-06-01',
              'anthropic-beta': 'prompt-caching-2024-07-31',
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              model: 'claude-sonnet-4-6',
              max_tokens: 8000,
              stream: true,
              system: systemArray,
              tools,
              messages: claudeMessages,
            }),
          });

          if (!res.ok) {
            const errText = await res.text().catch(() => '');
            let detail = '';
            try { detail = (JSON.parse(errText) as { error?: { message?: string } }).error?.message ?? ''; } catch {}
            send({ type: 'error', message: `Erreur API (${res.status})${detail ? ` — ${detail}` : ''}` });
            console.error('[assistant stream]', res.status, errText.slice(0, 400));
            break;
          }

          const reader = res.body!.getReader();
          const decoder = new TextDecoder();
          let lineBuffer = '';
          let accText = '';
          const toolBlocks: { id: string; name: string; inputJson: string }[] = [];
          let currentTool: { id: string; name: string; inputJson: string } | null = null;
          let stopReason = '';

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            lineBuffer += decoder.decode(value, { stream: true });
            const lines = lineBuffer.split('\n');
            lineBuffer = lines.pop() ?? '';

            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const raw = line.slice(6).trim();
              if (!raw || raw === '[DONE]') continue;

              let ev: Record<string, unknown>;
              try { ev = JSON.parse(raw); } catch { continue; }

              if (ev.type === 'content_block_start') {
                const cb = ev.content_block as Record<string, unknown>;
                if (cb.type === 'tool_use') {
                  currentTool = { id: String(cb.id), name: String(cb.name), inputJson: '' };
                  send({ type: 'tool_start', name: cb.name });
                }
              } else if (ev.type === 'content_block_delta') {
                const delta = ev.delta as Record<string, unknown>;
                if (delta.type === 'text_delta') {
                  const chunk = String(delta.text ?? '');
                  accText += chunk;
                  send({ type: 'text_chunk', text: chunk });
                } else if (delta.type === 'input_json_delta' && currentTool) {
                  currentTool.inputJson += String(delta.partial_json ?? '');
                }
              } else if (ev.type === 'content_block_stop') {
                if (currentTool) {
                  toolBlocks.push({ ...currentTool });
                  currentTool = null;
                }
              } else if (ev.type === 'message_delta') {
                const delta = ev.delta as Record<string, unknown>;
                stopReason = String(delta.stop_reason ?? '');
              }
            }
          }

          if (stopReason === 'end_turn') {
            const qas = deriveQuickActions(Array.from(usedToolNames));
            if (qas.length > 0) send({ type: 'quick_actions', actions: qas });
            if (usedToolNames.size > 0) send({ type: 'refresh' });
            send({ type: 'done' });
            break;
          }

          if (stopReason === 'tool_use' && toolBlocks.length > 0) {
            const assistantContent: ContentBlock[] = [];
            if (accText) assistantContent.push({ type: 'text', text: accText });
            for (const tb of toolBlocks) {
              let parsedInput: ToolInput = {};
              try { parsedInput = JSON.parse(tb.inputJson || '{}'); } catch {}
              assistantContent.push({ type: 'tool_use', id: tb.id, name: tb.name, input: parsedInput });
            }
            claudeMessages.push({ role: 'assistant', content: assistantContent });

            const toolResultEntries = await Promise.all(toolBlocks.map(async (tb) => {
              usedToolNames.add(tb.name);
              let parsedInput: ToolInput = {};
              try { parsedInput = JSON.parse(tb.inputJson || '{}'); } catch {}
              const result = await executeToolWithRetry(tb.name, parsedInput);
              send({ type: 'tool_end', name: tb.name });
              // Tronquer les résultats trop longs pour préserver la fenêtre de contexte
              let toolContent = result.length > 6000
                ? result.slice(0, 6000) + '…[résultat tronqué — utilise des filtres plus précis si nécessaire]'
                : result;
              try {
                const parsed = JSON.parse(result) as Record<string, unknown>;
                if (parsed.__export__ === true) {
                  send({ type: 'export', filename: String(parsed.filename ?? ''), b64: String(parsed.b64 ?? '') });
                  toolContent = JSON.stringify({ ok: true, fichier: String(parsed.filename ?? ''), lignes: parsed.rows_count });
                }
                if (parsed.__undo__) {
                  const undo = parsed.__undo__ as { table: string; id: string; champs: Record<string, unknown> };
                  send({ type: 'undo', table: undo.table, id: undo.id, champs: undo.champs });
                  const clean = { ...parsed };
                  delete (clean as Record<string, unknown>).__undo__;
                  toolContent = JSON.stringify(clean);
                }
              } catch { /* not JSON or no export flag */ }
              return { tool_use_id: tb.id, content: toolContent };
            }));
            const toolResults: ContentBlock[] = toolResultEntries.map(e => ({
              type: 'tool_result', tool_use_id: e.tool_use_id, content: e.content,
            }));
            claudeMessages.push({ role: 'user', content: toolResults });
          } else {
            const qas = deriveQuickActions(Array.from(usedToolNames));
            if (qas.length > 0) send({ type: 'quick_actions', actions: qas });
            if (usedToolNames.size > 0) send({ type: 'refresh' });
            send({ type: 'done' });
            break;
          }
        }
      } catch (e) {
        console.error('[assistant stream error]', e);
        send({ type: 'error', message: 'Erreur interne. Réessaie dans un moment.' });
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
