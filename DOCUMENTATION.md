# SyncFlow — Documentation Technique

## Table des matières

1. [Vue d'ensemble & stack technique](#1-vue-densemble--stack-technique)
2. [Modèle de données](#2-modèle-de-données)
   - [Entités principales](#entités-principales)
   - [Champs critiques](#champs-critiques)
   - [Relations](#relations)
3. [Logique métier critique](#3-logique-métier-critique)
   - [Liaison BE ↔ Commande (`link-be-commande`)](#liaison-be--commande-link-be-commande)
   - [recalculateBalances](#recalculatebalances)
   - [Matching des références articles](#matching-des-références-articles)
   - [Détection de reliquats (checkReliquats)](#détection-de-reliquats)
   - [Gestion des écarts (`quantite_document_be`)](#gestion-des-écarts-quantite_document_be)
   - [Workflow Retours / Surplus (`statut_retour`)](#workflow-retours--surplus)
4. [API Routes](#4-api-routes)
5. [Pages UI principales](#5-pages-ui-principales)
6. [Flux utilisateur typiques](#6-flux-utilisateur-typiques)
7. [Import des documents](#7-import-des-documents)
8. [Intégration Gmail OAuth](#8-intégration-gmail-oauth)
9. [Points d'attention techniques](#9-points-dattention-techniques)
10. [Migrations SQL nécessaires](#10-migrations-sql-nécessaires)
11. [Variables d'environnement](#11-variables-denvironnement)
12. [État actuel](#12-état-actuel)

---

## 1. Vue d'ensemble & stack technique

SyncFlow est une application de **rapprochement 3 voies** pour SD Équipements / Orchidée Innovation. Elle réconcilie automatiquement :

**Commandes** ↔ **BEs (Bons d'Entrée / Bons de Livraison)** ↔ **Factures fournisseurs**

### Stack

| Couche | Technologie | Version |
|--------|------------|---------|
| Framework | Next.js App Router | 16.2.4 |
| Runtime | React | 19.2.4 |
| Base de données | Supabase (PostgreSQL) | @supabase/supabase-js ^2.104 |
| Data fetching | TanStack React Query | ^5.99 |
| UI components | Radix UI + TailwindCSS | Tailwind v4 |
| Icônes | lucide-react | ^1.8 |
| Toasts | sonner | ^2.0 |
| Typage | TypeScript | ^5 |

> **Important** : Next.js 16 + React 19 ont des breaking changes par rapport aux versions antérieures. Lire `node_modules/next/dist/docs/` avant toute modification d'infrastructure.

### Contexte entreprise

- **Société** : SD Équipements / Orchidée Innovation
- **RAF** : Rémy Arcos — `remy.arcos@orchidee-innovation.fr`
- **Secteur** : Armes de loisir, matériel de défense
- **Fournisseur principal** : Colombi-sports via plateforme Centralink
- **Autres fournisseurs** : Humbert, SN Europarm, Umarex, Nobel, Browning, Rivolier
- **Emails commandes** : `no-reply@centralink.fr` → `remy.arcos@orchidee-innovation.fr`

---

## 2. Modèle de données

### Entités principales

#### `commandes`

```
id                        uuid PK
numero_commande_interne   text  ex: "#4721"
fournisseur               text
date_commande             date
statut_commande           text  voir valeurs ci-dessous
type_source               text  'email' | 'pdf' | 'csv' | 'manuel'
montant_total_commande    numeric
fichier_pdf               text  (URL)
commentaire               text
```

Statuts : `ouverte` | `partiellement réceptionnée` | `réceptionnée` | `partiellement facturée` | `soldée` | `en anomalie`

#### `lignes_commande`

```
id                           uuid PK
commande_id                  uuid FK → commandes
ligne_no                     integer
reference_article            text
designation                  text
quantite_commandee           numeric
pu_commande                  numeric
montant_ht_commande          numeric
quantite_receptionnee_reelle numeric  ← CALCULÉ par recalculateBalances
quantite_facturee            numeric  ← CALCULÉ par recalculateBalances
quantite_restante_a_recevoir numeric
quantite_restante_a_facturer numeric
statut_ligne                 text
```

Statuts ligne : `non reçue` | `partiellement reçue` | `reçue` | `partiellement facturée` | `soldée` | `sur-réceptionné` | `sur-facturée`

#### `be_receptions`

```
id             uuid PK
numero_be      text  ex: "BE26031735"
fournisseur    text
date_bl        date
commande_id    uuid FK → commandes  (première liaison uniquement)
statut_be      text
pdf_url        text  (URL vers le PDF source en Supabase Storage)
fichier_nom    text
email_source_id text
commentaire    text
```

Statuts : `reçu` | `partiellement facturé` | `facturé` | `soldé` | `en anomalie`

#### `lignes_be`

```
id                          uuid PK
be_id                       uuid FK → be_receptions
ligne_no                    integer
reference_article           text
designation                 text
quantite_receptionnee       numeric  ← peut être corrigée manuellement
quantite_document_be        numeric  ← NULL ou qté originale du document BE avant correction
quantite_facturee           numeric
quantite_restante_a_facturer numeric
ligne_commande_id           uuid FK → lignes_commande  NULL = ligne libre
statut_ligne_be             text
statut_retour               text  NULL | 'a_retourner' | 'retourne' | 'avoir_demande' | 'avoir_recu'
motif_retour                text  raison du retour
date_retour_effectif        date
date_avoir_demande          date
commentaire                 text
```

#### `factures`

```
id                  uuid PK
numero_facture      text
fournisseur         text
date_facture        date
statut_facture      text
total_ht            numeric
total_tva           numeric
total_ttc           numeric
taux_rapprochement  numeric  (0–100)
pdf_url             text
commentaire         text
```

Statuts : `importée` | `en cours de rapprochement` | `partiellement rapprochée` | `rapprochée` | `en anomalie`

#### `lignes_facture`

```
id                   uuid PK
facture_id           uuid FK
ligne_no             integer
reference_article    text
designation          text
quantite_facturee    numeric
pu_facture           numeric  ← PRIX NET après remise (= montant_ht / qte)
montant_ht           numeric
numero_be_detecte    text  numéro BE extrait du PDF
```

#### Tables de liaison et autres

```
liaison_be_commande      be_id + commande_id  (many-to-many)
liaison_facture_commande facture_id + commande_id  (many-to-many)
rapprochements           lien facture ↔ be ↔ commande par ligne, avec score et statut
contacts_fournisseurs    fournisseur + nom + email + role
gmail_config             access_token + refresh_token + token_expiry
journal_activite         log de toutes les actions
```

### Champs critiques

| Champ | Table | Rôle |
|-------|-------|------|
| `ligne_commande_id` | `lignes_be` | NULL = ligne libre/surplus, non-NULL = attribuée à une commande |
| `quantite_document_be` | `lignes_be` | Quantité originale du BE avant correction manuelle. NULL = pas de correction. Présent = écart à réclamer |
| `quantite_receptionnee_reelle` | `lignes_commande` | Calculé uniquement par `recalculateBalances`, jamais écrit manuellement |
| `statut_retour` | `lignes_be` | Cycle de vie du retour fournisseur |
| `pu_facture` | `lignes_facture` | Prix NET (HT/qte), pas prix brut |

---

## 3. Logique métier critique

### Liaison BE ↔ Commande (`link-be-commande`)

**Fichier** : `src/app/api/link-be-commande/route.ts`

#### Règle fondamentale : UN BE PEUT COUVRIR PLUSIEURS COMMANDES

```
BE : 22 × ref LTLPK03
Commande A : besoin de 10 → reçoit 10
Commande B : besoin de 8  → reçoit 8
Reste libre : 4 unités (surplus confirmé)
```

#### Algorithme POST (lier)

1. Insérer dans `liaison_be_commande` (idempotent)
2. Récupérer toutes les `lignes_be` avec `ligne_commande_id IS NULL` (libres)
3. **Agréger par référence** : si plusieurs lignes libres avec la même ref → fusionner en une seule avec `qteTotale = somme`
   - Conserver la première ligne, supprimer les doublons
   - `quantite_document_be` = somme des docs si hasEcart, sinon NULL
4. Pour chaque groupe de référence :
   - Trouver les lignes commande correspondantes (via `refsMatch`)
   - Trier par capacité restante décroissante
   - Calculer `totalCapacite` ; si ≤ 0 → laisser libre (ne pas forcer sur-réception)
   - Distribuer en cascade sur toutes les lignes cmd qui matchent
   - Si `qteDispo > 0` après distribution → créer une ligne libre résiduelle
5. Appeler `recalculateBalances` sur la commande

#### Compteur anti-double-comptage `dejaPourCmd`

```typescript
const dejaPourCmd = new Map<string, number>();
// Avant chaque attribution :
const qteReste = Math.max(0,
  ligneCmd.quantite_commandee - ligneCmd.quantite_receptionnee_reelle - (dejaPourCmd.get(ligneCmd.id) ?? 0)
);
// Après attribution :
dejaPourCmd.set(ligneCmd.id, (dejaPourCmd.get(ligneCmd.id) ?? 0) + qteAttribuer);
```

**Critique** : ce compteur empêche le double-comptage quand plusieurs lignes BE du même BE ont la même référence dans la même session.

#### Algorithme DELETE (délier)

Remettre `ligne_commande_id = NULL` **uniquement** sur les lignes_be attribuées à CETTE commande. Les lignes attribuées aux autres commandes sont **intouchables**.

```typescript
const lignesCmdIds = lignesCmd.map(l => l.id);
await sb.from('lignes_be')
  .update({ ligne_commande_id: null })
  .eq('be_id', beId)
  .in('ligne_commande_id', lignesCmdIds);  // filtre sur cette commande uniquement
```

---

### recalculateBalances

**Règle d'or** : `quantite_receptionnee_reelle` d'une ligne commande = **SUM des `lignes_be.quantite_receptionnee` WHERE `ligne_commande_id = lc.id`**

```typescript
// CORRECT — lien strict par FK
const linkedBELines = lignesBE.filter(lb => lb.ligne_commande_id === lc.id);

// INTERDIT — causait des doubles comptes sur scissions
// const linkedBELines = lignesBE.filter(lb => normalizeRef(lb.ref) === normalizeRef(lc.ref));
```

Le fallback par référence était dangereux : une ligne scindée (portion liée + portion libre avec la même ref) était comptée deux fois.

---

### Matching des références articles

```typescript
const normalizeRef = (s: string | null | undefined) =>
  String(s ?? '').toUpperCase().replace(/O/g, '0').replace(/[^A-Z0-9]/g, '');

function refsMatch(a, b): boolean {
  if (!a || !b) return false;
  if (a.toLowerCase().trim() === b.toLowerCase().trim()) return true;
  if (normalizeRef(a) === normalizeRef(b)) return true;
  // Cas "1404/16928A" vs "16928A"
  const ap = a.split('/'); const bp = b.split('/');
  if (ap.length > 1 && normalizeRef(ap[ap.length - 1]) === normalizeRef(b)) return true;
  if (bp.length > 1 && normalizeRef(bp[bp.length - 1]) === normalizeRef(a)) return true;
  return false;
}
```

Règles :
- O → 0 (lettre O = chiffre zéro)
- Caractères non alphanumériques supprimés
- Comparaison sur la partie après `/` (codes Colombi-sports du type `1404/STARRD44`)

---

### Détection de reliquats

Géré via `recalculateBalances` qui met à jour `quantite_restante_a_recevoir` et `statut_ligne` sur chaque ligne commande. La page "Anomalies" (`/exceptions`) présente les lignes en statut anormal.

---

### Gestion des écarts (`quantite_document_be`)

**Fichier** : `src/app/api/update-ligne-be/route.ts`

Quand la quantité réellement reçue diffère de celle marquée sur le BE :

1. L'utilisateur corrige `quantite_receptionnee` via l'édition inline (page BE detail)
2. L'API PATCH enregistre :
   - `quantite_receptionnee` = nouvelle valeur
   - `quantite_document_be` = ancienne valeur (seulement à la première correction, jamais écrasé ensuite)
   - `quantite_restante_a_facturer` = max(0, newQte - qteFact)
3. Si la ligne est liée à une commande → `recalculateBalances` est appelé
4. Le frontend affiche un toast d'alerte + un badge orange sur la ligne
5. Une bannière orange s'affiche sur le BE detail avec le bouton "Demander l'avoir par email"

**Calcul de l'écart groupé par référence** (page BE detail) :
```typescript
// Grouper par référence pour avoir la vraie qté totale (attribuée + libre)
const groupes = new Map();
for (const l of lignes) {
  const key = l.reference_article ?? `__${l.id}`;
  const g = groupes.get(key);
  if (g) {
    g.qteTotale += l.quantite_receptionnee ?? 0;
    if (l.quantite_document_be != null) g.qteDoc = (g.qteDoc ?? 0) + l.quantite_document_be;
  } else {
    groupes.set(key, { qteTotale: l.quantite_receptionnee ?? 0, qteDoc: l.quantite_document_be ?? null });
  }
}
return Array.from(groupes.values()).filter(g => g.qteDoc != null && g.qteDoc !== g.qteTotale);
```

> **Piège** : ne pas calculer l'écart ligne par ligne — après scission, la ligne principale a `quantite_receptionnee=15` et `quantite_document_be=500`, mais la vraie qté totale est la somme de toutes les lignes de la même réf.

---

### Workflow Retours / Surplus

**Fichier** : `src/app/api/retour-fournisseur/route.ts`

#### Cycle de vie `statut_retour`

```
NULL (ligne libre) → a_retourner → retourne → avoir_demande → avoir_recu
```

| Statut | Badge | Signification |
|--------|-------|--------------|
| `a_retourner` | Orange | Retour décidé, email envoyé au fournisseur |
| `retourne` | Bleu | Marchandise physiquement retournée |
| `avoir_demande` | Violet | Avoir réclamé formellement |
| `avoir_recu` | Vert | Avoir reçu, retour soldé |

#### Règle : surplus confirmé vs BE non traité

La page Surplus ne montre comme **surplus confirmé** que les lignes libres de BEs ayant **au moins une `liaison_be_commande`**. Un BE sans aucune liaison commande apparaît dans une **bannière d'avertissement** distincte ("commande manquante ou à importer ?").

```typescript
// BE ids avec au moins une liaison
const besLiesIds = await supabase
  .from('liaison_be_commande')
  .select('be_id')
  .in('be_id', beIds);

// Surplus confirmé = ligne libre ET be_id IN besLies
const lignesConfirmees = lignesLibres.filter(l => besLiesSet.has(l.be_id));
// À vérifier = be_id NOT IN besLies
const besNonLies = bes.filter(be => !besLiesSet.has(be.id));
```

#### POST (initier retour)
- Marque `statut_retour = 'a_retourner'`, `motif_retour = motif`
- Si `sendEmailFlag` : envoie l'email via Gmail API avec le template pré-rempli
- Log dans `journal_activite`

#### PATCH (progresser)
- Met à jour `statut_retour` vers l'étape suivante
- Enregistre `date_retour_effectif` ou `date_avoir_demande` selon l'étape

---

## 4. API Routes

| Route | Méthode(s) | Description |
|-------|-----------|-------------|
| `/api/link-be-commande` | POST, DELETE | Lier/délier un BE à une commande avec attribution des lignes |
| `/api/update-ligne-be` | PATCH | Corriger `quantite_receptionnee` + enregistrer `quantite_document_be` |
| `/api/retour-fournisseur` | POST, PATCH | Initier un retour ou progresser son statut |
| `/api/contacts-fournisseurs` | GET, POST, DELETE | CRUD contacts par fournisseur |
| `/api/send-email` | POST | Envoyer un email via Gmail OAuth (avoir, relance…) |
| `/api/import-pdf` | POST | OCR + parsing PDF (BE ou facture) via Claude API |
| `/api/matching` | POST | Rapprochement automatique facture ↔ BE ↔ commande |
| `/api/init-reception` | POST | Initialiser les quantités reçues |
| `/api/gmail/auth` | GET | Lancer le flux OAuth Gmail |
| `/api/gmail/callback` | GET | Callback OAuth, enregistre les tokens |
| `/api/gmail/sync` | POST | Scanner les nouveaux emails Gmail |
| `/api/gmail/status` | GET | Statut de la connexion Gmail |
| `/api/gmail/disconnect` | POST | Déconnecter Gmail |

---

## 5. Pages UI principales

| Route | Fichier | Description |
|-------|---------|-------------|
| `/dashboard` | `app/(app)/dashboard/page.tsx` | KPIs globaux |
| `/emails` | `app/(app)/emails/page.tsx` | Emails Gmail reçus |
| `/commandes` | `app/(app)/commandes/page.tsx` | Liste des commandes |
| `/commandes/[id]` | `app/(app)/commandes/[id]/page.tsx` | Détail commande |
| `/be-receptions` | `app/(app)/be-receptions/page.tsx` | Liste BEs avec badge écart |
| `/be-receptions/[id]` | `app/(app)/be-receptions/[id]/page.tsx` | Détail BE — édition inline qté, écart, retour, contacts, email |
| `/surplus` | `app/(app)/surplus/page.tsx` | Surplus confirmé + retours en cours + BEs non liés |
| `/factures` | `app/(app)/factures/page.tsx` | Liste factures |
| `/factures/[id]` | `app/(app)/factures/[id]/page.tsx` | Détail facture — matching, alerte retour |
| `/rapprochements` | `app/(app)/rapprochements/page.tsx` | Vue globale rapprochements |
| `/rapprochements/par-fournisseur` | — | Synthèse par fournisseur |
| `/rapprochements/3-voies` | — | Rapprochement 3 voies |
| `/exceptions` | `app/(app)/exceptions/page.tsx` | Anomalies et alertes |
| `/fournisseurs` | `app/(app)/fournisseurs/page.tsx` | Référentiel fournisseurs |
| `/settings` | `app/(app)/settings/page.tsx` | Paramètres, connexion Gmail |

### Composants partagés

| Composant | Description |
|-----------|-------------|
| `PDFViewerPanel` | Panneau slide-over (min(52vw, 900px)) avec iframe PDF. Props : `url`, `open`, `onClose`, `title` |
| `StatusBadge` | Badge coloré selon le statut |
| `PageHeader` | En-tête de page avec titre et sous-titre |

---

## 6. Flux utilisateur typiques

### Flux A — Nouvelle facture → rapprochement → validation

1. Gmail sync détecte un nouvel email avec PDF en PJ
2. PDF importé via `/api/import-pdf` (Claude OCR)
3. Facture créée dans `factures` + `lignes_facture`
4. Page `/factures/[id]` : cliquer "Lancer matching"
5. L'algo match les lignes facture avec lignes BE/commande par ref + prix + qté
6. Rapprochements proposés affichés — valider unitairement ou "Valider tout"
7. `taux_rapprochement` mis à jour → statut facture → `rapprochée`

> **Alerte retour** : si le fournisseur a des `statut_retour` en cours (hors `avoir_recu`), une bannière rouge s'affiche sur la page facture : "ne pas valider avant réception de l'avoir".

### Flux B — BE importé → liaison commande → réception

1. Email avec PDF BE reçu → import automatique ou manuel
2. Page `/be-receptions/[id]` :
   - Vérifier les lignes : quantités, références
   - Corriger `quantite_receptionnee` si écart avec le document (édition inline)
   - Si correction → badge orange + toast + `quantite_document_be` enregistré
3. Cliquer "Ajouter" commande liée → sélectionner la commande (triée par nb de refs en commun)
4. L'algo `link-be-commande` distribue les lignes :
   - Lignes qui matchent → `ligne_commande_id` renseigné
   - Lignes sans match ou en excès → libres (surplus)
5. `recalculateBalances` met à jour les statuts commande

### Flux C — Retour / Surplus

**Pré-requis** : le BE doit être lié à au moins une commande pour que ses lignes libres soient considérées comme du surplus confirmé.

1. Page `/surplus` onglet "Libres sans action" : lignes libres de BEs liés
2. Cliquer "Retourner" sur une ligne → modal :
   - Motif (liste déroulante)
   - Email au fournisseur pré-rempli (contacts depuis `contacts_fournisseurs`)
3. Ligne passe en `statut_retour = 'a_retourner'`
4. Onglet "Retours en cours" : progression par bouton :
   - "Marquer retourné" → `retourne`
   - "Demander l'avoir" → `avoir_demande` + date
   - "Avoir reçu" → `avoir_recu`
5. Quand la facture du fournisseur arrive : bannière rouge si avoir toujours en attente

**Cas "BE sans commande"** : si le BE n'est lié à aucune commande, ses lignes libres apparaissent dans la bannière amber "À vérifier" et non dans le surplus confirmé. Deux options :
- Importer la commande correspondante et lier le BE (Flux B)
- Aller sur le BE et initier un retour directement depuis la page BE detail

---

## 7. Import des documents

### BEs (PDF Colombi-sports)

**Fichier** : `src/app/api/import-pdf/route.ts`

Règles d'extraction :
- Numéro BE : prendre la partie avant "/" — `BE26031735/1` → `BE26031735`
- Chaque ligne produit a deux codes : code article réel (ex: `STARRD44`) + code de position (4 lettres majuscules, ex: `AAFB`) — ignorer le code de position
- Agréger les lignes avec la même référence
- Ignorer les EAN (numériques longs ≥ 8 chiffres)
- Ne **pas** tronquer les refs commençant par 4 lettres — seulement ignorer les refs qui **sont entièrement** 4 lettres majuscules

**Conditionnement cartouches** (uniquement si désignation contient "CARTOUCHE") :
```javascript
const isMunition = /CARTOUCHE/.test(desig) && !/BOITE\s+DE|BOÎTE\s+DE/.test(desig);
if (isMunition) {
  const condMatch = desig.match(/[X×*]\s*(\d{2,})|PAR\s+(\d+)|LOT\s+DE\s+(\d+)/);
  if (condMatch) {
    const factor = parseInt(condMatch[1] || condMatch[2] || condMatch[3]);
    if (factor > 1 && factor <= 10000 && qte < factor) qte = qte * factor;
  }
}
```

### Factures (PDF)

- `pu_facture` = `montant_ht / quantite_facturee` — prix **NET** après remise, jamais le prix brut
- Clé d'agrégation : `beNum|ref` (un article par BE)
- `numero_be_detecte` : numéro BE extrait du corps du PDF, normalisé sans `/`

### Commandes (Email Centralink)

- Sujet : `"COMMANDE POUR COLOMBI - SD Centralink"`
- Fournisseur extrait du sujet : regex `/COMMANDE\s+POUR\s+([^\-]+)/i`
- Numéro commande dans le corps : `"Numéro de bon de commande interne : #4721"`
- Gmail regroupe tous les emails Centralink en un thread → utiliser l'API `threads` (pas `messages`)
- Tronquer le contenu à **12 000 caractères** (grandes commandes 40+ lignes)

---

## 8. Intégration Gmail OAuth

**Fichier** : `src/lib/gmail-api.ts`

### Scopes requis

```
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/gmail.send
```

> `gmail.send` a été ajouté après la mise en place initiale. Si la connexion existante ne permet pas l'envoi, **reconnecter Gmail** via `/settings` → "Reconnecter Gmail".

### Fonctions principales

| Fonction | Description |
|----------|-------------|
| `getValidToken()` | Retourne le token valide (refresh auto si expiré dans < 2 min) |
| `sendEmail(token, {from, to, subject, body})` | Envoie un email RFC 2822 encodé base64url |
| `listThreads(token, query)` | Liste les threads selon une query Gmail |
| `getThread(token, threadId)` | Récupère un thread avec tous ses messages |
| `getAttachment(token, messageId, attachmentId)` | Télécharge une PJ base64url |

### Stockage des tokens

Table `gmail_config` (une seule ligne) :
- `access_token` / `refresh_token` / `token_expiry`
- `processed_thread_ids` : array de thread IDs déjà traités (évite les doublons)

---

## 9. Points d'attention techniques

### Pièges de la fusion de lignes (scissions)

Après un `link-be-commande`, des lignes peuvent être scindées ou fusionnées. Si on délie puis relie, d'anciens artefacts peuvent subsister en base (lignes scindées avec l'ancienne ref). Avant de relier un BE qui a déjà été lié/délié plusieurs fois, vérifier l'état en base :

```sql
SELECT id, ligne_no, reference_article, quantite_receptionnee,
       quantite_document_be, ligne_commande_id, statut_retour
FROM lignes_be
WHERE be_id = '<be_id>'
ORDER BY ligne_no;
```

Nettoyer les artefacts si nécessaire avant de relier.

### Stale values dans `link-be-commande`

**Bug corrigé** : après fusion (agrégation de doublons), la variable `lb` en mémoire contient l'ancienne `quantite_receptionnee` (stale). Toujours utiliser `groupe.qteTotale` (valeur réelle après fusion) dans les comparaisons, jamais `lb.quantite_receptionnee`.

```typescript
// CORRECT
if (qteAttribuer < groupe.qteTotale) { ... }

// FAUX — lb.quantite_receptionnee est stale après fusion
if (qteAttribuer < lb.quantite_receptionnee) { ... }
```

### React Query — invalidations

Après chaque mutation (liaison, correction qté, retour) :
- Invalider `['lignes_be', id]`, `['be', id]`
- Si commande impactée : invalider aussi `['commandes_be', id]`
- Pour le surplus : invalider `['lignes_libres']` et `['bes_lies_ids', ...]`

### Sur-réception — politique

Si la commande est déjà à capacité maximale quand on lie un nouveau BE, les lignes libres **restent libres** (surplus). Elles ne sont **jamais forcées** en sur-réception. La sur-réception réelle n'arrive que si la quantité reçue dépasse explicitement la commande lors d'une attribution partielle.

### Détection de doublons BE

Seuil : **100% de similarité uniquement** (égalité stricte sur le numéro normalisé). Un seuil plus bas créait des faux positifs sur des numéros séquentiels (ex: BE26030578 vs BE26030579).

---

## 10. Migrations SQL nécessaires

À exécuter dans Supabase SQL Editor si pas encore fait :

```sql
-- 1. Tracking des écarts BE document
ALTER TABLE lignes_be
  ADD COLUMN IF NOT EXISTS quantite_document_be numeric DEFAULT NULL;

-- 2. Contacts fournisseurs
CREATE TABLE IF NOT EXISTS contacts_fournisseurs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fournisseur text NOT NULL,
  nom        text,
  email      text NOT NULL,
  role       text,
  created_at timestamptz DEFAULT now()
);

-- 3. Workflow retour fournisseur
ALTER TABLE lignes_be
  ADD COLUMN IF NOT EXISTS statut_retour text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS motif_retour text DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS date_retour_effectif date DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS date_avoir_demande date DEFAULT NULL;

ALTER TABLE lignes_be DROP CONSTRAINT IF EXISTS lignes_be_statut_retour_check;
ALTER TABLE lignes_be ADD CONSTRAINT lignes_be_statut_retour_check
  CHECK (statut_retour IN ('a_retourner', 'retourne', 'avoir_demande', 'avoir_recu'));
```

---

## 11. Variables d'environnement

```env
# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon_key>
SUPABASE_SERVICE_ROLE_KEY=<service_role_key>

# Claude API (OCR / parsing PDF)
ANTHROPIC_API_KEY=<key>

# Gmail OAuth
GOOGLE_CLIENT_ID=<client_id>
GOOGLE_CLIENT_SECRET=<client_secret>
GOOGLE_REDIRECT_URI=http://localhost:3000/api/gmail/callback

# Next.js
NEXTAUTH_SECRET=<secret>
NEXTAUTH_URL=http://localhost:3000
```

---

## 12. État actuel

### Ce qui fonctionne

- Import et parsing de BEs PDF (Colombi-sports)
- Import et parsing de factures PDF
- Import de commandes depuis emails Centralink (Gmail OAuth)
- Liaison BE ↔ Commande avec attribution intelligente des lignes (cascade multi-commandes)
- Correction manuelle de `quantite_receptionnee` avec tracking `quantite_document_be`
- Bannière écart + workflow email avoir
- Contacts fournisseurs par fournisseur
- Rapprochement automatique facture ↔ BE ↔ commande
- Surplus confirmé vs BEs non liés (distinction fiable)
- Workflow retour fournisseur complet (4 statuts + email)
- Alerte facture si retour en attente chez ce fournisseur
- Visualisation PDF inline (BE detail + facture detail)
- Journal d'activité

### Bugs connus et corrigés

| Bug | Cause | Correction |
|-----|-------|-----------|
| Double-comptage lors de la liaison | `quantite_receptionnee_reelle` lu sans `dejaPourCmd` | Compteur `dejaPourCmd` en mémoire |
| Fallback ref dans `recalculateBalances` | Ligne libre + ligne liée même ref = double compte | Suppression du fallback, FK stricte |
| Stale value après fusion | `lb.quantite_receptionnee` stale après agrégation | Utiliser `groupe.qteTotale` |
| Délier cassait les autres commandes | `ligne_commande_id = null` sur toutes les lignes du BE | Filtre sur `lignesCmdIds` de CETTE commande |
| Écart banner magnitude erronée | Calcul par ligne isolée au lieu de groupe par ref | Groupement par `reference_article` avec somme |
| Sur-réception forcée | Lignes excédentaires créées en sur-réceptionné | Laisser libre quand `totalCapacite <= 0` |
| Refs tronquées | Regex `[A-Z]{4}` supprimait le début des refs | N'ignorer que les refs **entièrement** 4 lettres |
| `contacts.map is not a function` | Table `contacts_fournisseurs` inexistante | Migration SQL + `Array.isArray(json) ? json : []` |
| `quantite_document_be` inconnue | Colonne non encore migrée | Migration SQL `ADD COLUMN IF NOT EXISTS` |

### TODOs / Améliorations envisagées

- [ ] Génération PDF de bon de retour (pour accompagner le colis physique)
- [ ] Relance automatique si avoir non reçu après N jours
- [ ] Lien entre `avoir_recu` et la facture d'avoir correspondante dans Supabase
- [ ] Dashboard : widget "retours en attente" avec montant estimé
- [ ] Import commandes en PDF (pas uniquement email Centralink)
- [ ] Reconnexion Gmail si scope `gmail.send` manquant (bouton dans `/settings`)
