# SyncFlow — Contexte Métier & Règles Techniques

## Vue d'ensemble

SyncFlow est une application de **rapprochement 3 voies** pour SD Equipements / Orchidée Innovation (RAF : Rémy Arcos). Elle réconcilie automatiquement :

**Commandes** ↔ **BEs (Bordereaux d'Expédition)** ↔ **Factures fournisseurs**

Le fournisseur principal est **Colombi-sports** (via Centralink). D'autres fournisseurs : Humbert, SN Europarm, Umarex, Nobel, Browning, Rivolier.

---

## Modèle de données

### Entités principales

```
Commandes
  - numero_commande_interne (ex: #4721)
  - fournisseur
  - date_commande
  - statut_commande: 'ouverte' | 'partiellement réceptionnée' | 'réceptionnée' | 'partiellement facturée' | 'soldée' | 'en anomalie'
  - type_source: 'Email' | 'Manuel'
  - montant_total_commande

LignesCommande
  - commande_id (FK)
  - ligne_no
  - reference_article
  - designation
  - quantite_commandee
  - quantite_recue_indiquee
  - quantite_receptionnee_reelle  ← calculé par recalculateBalances
  - quantite_facturee             ← calculé par recalculateBalances
  - quantite_restante_a_recevoir
  - quantite_restante_a_facturer
  - pu_commande
  - statut_ligne_commande: 'non reçue' | 'partiellement reçue' | 'reçue' | 'partiellement facturée' | 'soldée' | 'sur-facturée'

BEReceptions
  - numero_be (ex: BE26031735)
  - fournisseur
  - date_bl
  - date_livraison
  - statut_be: 'importé' | 'partiellement facturé' | 'soldé' | 'en anomalie'
  - file_url (PDF source)

LignesBE
  - be_id (FK)
  - reference_article
  - designation
  - quantite_receptionnee
  - quantite_facturee
  - ligne_commande_id (FK → LignesCommande) ← NULL = ligne libre, non attribuée
  - statut_ligne_be: 'non facturée' | 'partiellement facturée' | 'soldée' | 'sur-facturée'

LiaisonBECommande  ← table many-to-many BE ↔ Commande
  - be_id (FK)
  - commande_id (FK)

Factures
  - numero_facture
  - fournisseur
  - date_facture
  - total_ht
  - total_ttc
  - statut_facture: 'importée' | 'en cours de rapprochement' | 'partiellement rapprochée' | 'rapprochée' | 'en anomalie'
  - taux_rapprochement (0-100)
  - file_url (PDF source)

LignesFacture
  - facture_id (FK)
  - reference_article
  - designation
  - quantite_facturee
  - prix_unitaire  ← PRIX NET après remise (= montant_ht / quantite), PAS le prix brut
  - montant_ht
  - numero_be_detecte  ← numéro BE extrait du PDF de la facture

LiaisonFactureCommande  ← table many-to-many Facture ↔ Commande
  - facture_id (FK)
  - commande_id (FK)

Rapprochements
  - facture_id, be_id, commande_id
  - ligne_facture_id, ligne_be_id, ligne_commande_id
  - quantite_rapprochee
  - score_match (0-100)
  - statut_validation: 'proposé' | 'validé' | 'rejeté'

Exceptions
  - type_exception: 'livraison incomplète' | 'surplus livraison' | 'article non commandé' | 'reliquat à recevoir' | 'reliquat à facturer'
  - niveau_priorite: 'haute' | 'moyenne' | 'faible'
  - commande_id
  - motif
  - statut_exception: 'ouverte' | 'en cours' | 'résolue' | 'ignorée'
```

---

## Règle fondamentale : UN BE PEUT COUVRIR PLUSIEURS COMMANDES

C'est la règle la plus importante de tout le système.

**Exemple concret :**
```
BE contient : 22 × ref 17302
Commande A veut 10 × 17302 → attribuer 10, reste 12 libres
Commande B veut 8 × 17302  → attribuer 8 des 12 libres, reste 4 libres
Commande C veut 4 × 17302  → attribuer les 4 restants, reste 0
```

### Mécanisme de scission (CRITIQUE)

Quand on lie un BE à une commande (`linkBEToCommand`) :

1. Ne prendre QUE les lignes BE avec `ligne_commande_id = NULL` (libres)
2. Pour chaque ligne libre, chercher la ligne commande correspondante par référence
3. Calculer `qte_reste = quantite_commandee - quantite_receptionnee_reelle - deja_attribue_cette_session`
4. `qte_pour_cmd = min(qte_reste, qte_be_dispo)`
5. Si `qte_restante_be > 0` → **scission** : mettre à jour la ligne existante à `qte_pour_cmd` et créer une nouvelle ligne avec `qte_restante_be` et `ligne_commande_id = NULL`
6. Sinon → lier directement toute la ligne

**IMPORTANT :** Utiliser un compteur `dejaPourCmd` en mémoire dans la boucle pour éviter le double-comptage quand le BE a plusieurs lignes libres avec la même référence dans la même session.

```javascript
const dejaPourCmd = {}; // { ligne_commande_id: qte_deja_attribuee }

for (const lbe of lignes_be_libres) {
  const qte_deja_recue = (cmd_line.quantite_receptionnee_reelle || 0) + (dejaPourCmd[cmd_line.id] || 0);
  const qte_reste_cmd = Math.max(0, qte_cmd_totale - qte_deja_recue);
  // ... scission ...
  dejaPourCmd[cmd_line.id] = (dejaPourCmd[cmd_line.id] || 0) + qte_pour_cmd;
}
```

### Délier un BE d'une commande (CRITIQUE)

Quand on délie un BE d'une commande, on doit remettre `ligne_commande_id = NULL` **UNIQUEMENT** sur les lignes attribuées à CETTE commande. Les lignes attribuées aux autres commandes sont intouchables.

```javascript
const lignesCmdIds = new Set(lignesCommande.map(l => l.id));
for (const lbe of lignesBE) {
  if (lbe.ligne_commande_id && lignesCmdIds.has(lbe.ligne_commande_id)) {
    await LignesBE.update(lbe.id, { ligne_commande_id: null });
  }
}
```

---

## recalculateBalances — Règle d'or

`quantite_receptionnee_reelle` d'une ligne commande = somme des `quantite_receptionnee` des LignesBE dont `ligne_commande_id === lc.id`.

**PAS de fallback par référence article.** Le fallback causait des doubles comptes quand une ligne BE était scindée (la ligne liée + la ligne libre avec la même ref étaient toutes les deux comptées).

```javascript
// CORRECT
const linkedBELines = allBeLinesForCmd.filter(bl => bl.ligne_commande_id === lc.id);

// INTERDIT - causait des doubles comptes
// if (linkedBELines.length === 0) {
//   linkedBELines = allBeLinesForCmd.filter(bl => normalizeRef(bl.reference_article) === normalizedLcRef);
// }
```

---

## Matching des références articles

```javascript
const normalizeRef = (s) =>
  String(s || '').toUpperCase().replace(/O/g, '0').replace(/[^A-Z0-9]/g, '');

const refsMatch = (a, b) => {
  if (!a || !b) return false;
  if (a.toLowerCase().trim() === b.toLowerCase().trim()) return true;
  if (normalizeRef(a) === normalizeRef(b)) return true;
  // Cas "1404/16928A" vs "16928A" — matcher sur la partie après le "/"
  const aParts = a.split('/');
  const bParts = b.split('/');
  if (aParts.length > 1 && normalizeRef(aParts[aParts.length - 1]) === normalizeRef(b)) return true;
  if (bParts.length > 1 && normalizeRef(bParts[bParts.length - 1]) === normalizeRef(a)) return true;
  return false;
};
```

---

## Import des BEs (PDF)

### Format Colombi-sports
Chaque ligne produit a deux codes :
1. **Code article réel** (ex: STARRD44, CR00031, 490122) — à extraire
2. **Code de position** (ex: AAAA, AAFB) — toujours 4 lettres majuscules — à ignorer

### Règles d'extraction BE
- Numéro BE : prendre uniquement la partie avant "/" (ex: BE26031735/1 → BE26031735)
- Agréger les lignes avec la même référence (même article livré en plusieurs positions)
- Ignorer les codes EAN/barcodes (numériques longs 8+ chiffres)
- Ne pas supprimer les 4 premières lettres d'une ref — seulement ignorer les refs qui SONT ENTIÈREMENT 4 lettres majuscules

### Conditionnement cartouches (UNIQUEMENT pour les articles dont la désignation contient "CARTOUCHE")
Si la désignation contient "CARTOUCHE" ET "X 500" (ou "X 50", "PAR 100", etc.) → multiplier la quantité.
**Exception :** Si la désignation contient "BOITE DE" → ne pas multiplier (la qté est déjà en boîtes).

```javascript
const isMunition = /CARTOUCHE/.test(desig) && !/BOITE\s+DE|BOÎTE\s+DE/.test(desig);
if (isMunition) {
  const condMatch = desig.match(/[X×*]\s*(\d{2,})|PAR\s+(\d+)|LOT\s+DE\s+(\d+)/);
  if (condMatch) {
    const factor = parseInt(condMatch[1] || condMatch[2] || condMatch[3]);
    if (factor > 1 && factor <= 10000 && qte < factor) {
      qte = qte * factor;
    }
  }
}
```

---

## Import des Factures (PDF)

### Règle clé : prix UNITAIRE NET
`prix_unitaire` = Total HT / Quantité = prix NET après remise. **Jamais le prix brut avant remise.**

C'est ce prix net qui permet de distinguer des lignes du même article provenant de BEs différents (ex: M25000208 à 96€ ≠ M25000208 à 128€).

### Clé d'agrégation facture
`beNum|ref` — une ligne par combinaison BE + article. Si le même article apparaît dans 2 BEs différents = 2 lignes séparées.

```javascript
const beNum = l.numero_be ? String(l.numero_be).split('/')[0].replace(/[^a-zA-Z0-9]/g, '').toUpperCase() : '';
const key = beNum + '|' + ref;
```

---

## Import des Commandes (Email Centralink)

### Format email Centralink
- Sujet : `"COMMANDE POUR COLOMBI - SD Centralink"`
- Le fournisseur est dans le sujet, pas dans le corps
- Regex pour extraire le fournisseur : `/COMMANDE\s+POUR\s+([^\-]+)/i`
- Le numéro de commande est dans le corps : `"Numéro de bon de commande interne : #4721"`
- Les quantités sont parfois en cartouches (unités), les BEs en paquets

### Problème Gmail : emails groupés en threads
Gmail regroupe tous les emails Centralink en un seul thread. Il faut utiliser l'API threads (pas messages) pour récupérer tous les emails individuels.

### Limite de contenu
Tronquer à 12000 caractères (pas 3000) pour capturer les grandes commandes avec 40+ lignes.

---

## Détection des doublons

Seuil de détection : **100% de similarité uniquement** (égalité stricte sur le numéro normalisé). Un seuil plus bas créait des faux positifs sur des numéros séquentiels (ex: BE26030578 / BE26030579).

---

## Bugs connus et corrigés

1. **Double-comptage lors de la liaison** — résolu par le compteur `dejaPourCmd` en mémoire
2. **Fallback par ref dans recalculateBalances** — supprimé, causait des additions erronées
3. **Scission incomplète** — `quantite_receptionnee_reelle` lu une seule fois, pas mis à jour dans la boucle → corrigé par `dejaPourCmd`
4. **Délier cassait les autres commandes** — `ligne_commande_id = null` appliqué à TOUTES les lignes du BE au lieu de seulement celles de la commande déliée
5. **Refs tronquées** — regex `[A-Z]{4}` supprimait les 4 premières lettres de refs comme STARRD44 → corrigé pour n'ignorer que les refs entièrement composées de 4 lettres
6. **Fournisseur mal extrait** — le LLM prenait "Centralink" (l'expéditeur) au lieu du fournisseur destinataire → corrigé par extraction depuis le sujet de l'email
7. **Prix brut vs prix net** — le matching utilisait le prix brut au lieu du prix net après remise → corrigé
8. **Rate limit Base44** — problème spécifique à Base44, ne s'applique pas à Next.js/Supabase

---

## Architecture des API routes (Next.js)

```
/api/commandes          GET, POST
/api/commandes/[id]     GET, PUT, DELETE
/api/lignes-commande    GET, POST
/api/be-receptions      GET, POST
/api/lignes-be          GET, POST, PUT
/api/factures           GET, POST
/api/lignes-facture     GET, POST
/api/liaison-be-commande    POST, DELETE
/api/liaison-facture-commande  POST
/api/rapprochements     GET, POST, PUT
/api/exceptions         GET, POST, PUT
/api/link-be-to-command     POST  ← logique de scission
/api/unlink-be-from-command POST  ← délier proprement
/api/recalculate-balances   POST  ← recalcul cascadé
/api/run-matching           POST  ← rapprochement automatique
/api/extract-document       POST  ← OCR PDF via Claude API
/api/gmail/sync             POST  ← scan Gmail OAuth
/api/gmail/callback         GET   ← OAuth callback
```

---

## Variables d'environnement requises

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
ANTHROPIC_API_KEY=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:3000/api/gmail/callback
NEXTAUTH_SECRET=
NEXTAUTH_URL=http://localhost:3000
```

---

## Contexte entreprise

- **Société** : SD Equipements / Orchidée Innovation
- **RAF** : Rémy Arcos
- **Secteur** : Vente d'armes de loisir, matériel de défense
- **Fournisseur principal** : Colombi-sports (via plateforme Centralink)
- **Emails commandes** : no-reply@centralink.fr → remy.arcos@orchidee-innovation.fr
- **Emails BEs** : PDF en pièce jointe depuis Colombi-sports
- **Emails factures** : PDF en pièce jointe depuis les fournisseurs
