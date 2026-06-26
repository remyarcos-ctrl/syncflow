// Correspondance de références entre Centralink (saisie ③) et le BL Colombi (papier ②).
//
// Pourquoi : pour certains articles « en vrac » (billes, plombs…), Centralink
// enregistre la réception sous un CODE GÉNÉRIQUE maison alors que le bon de
// livraison Colombi utilise le code article. Sans correspondance, le contrôle
// croit à la fois à un oubli (le code Colombi absent de la saisie) ET à une
// sur-saisie (le code CL absent du papier) → deux fausses anomalies pour une
// livraison parfaite.
//
// On aliase uniquement le CODE : une fois le code CL traduit en code Colombi,
// l'écart d'unité (boîte vs pièce, ex. 960 boîtes ×50 = 48 000 billes) est géré
// automatiquement par la logique de conditionnement (quantitesConcordent lit
// « X50 / X500 » dans la désignation). Donc PAS de facteur à maintenir ici.
//
// Format : { 'CODE CENTRALINK': 'CODE COLOMBI' }. Ajouter une ligne quand un
// nouveau code générique CL apparaît (cf. anomalies « saisi hors papier » sur
// des réfs type GNQ-*).

export const REF_ALIAS_CL_TO_COLOMBI: Record<string, string> = {
  'GNQ-RUBBER50': 'PR020',          // billes caoutchouc C50 (x50)
  'GNQ-PLOMBS-PLATS-45': 'PO0003',  // plombs plats C4.5 (x500)
  'GNQ-PLOMBS-PLATS-55': 'PO0005',  // plombs plats C5.5 (x250)
  'GNQ-VERROU-PONTET': '2001',      // verrou de pontet à clé
  'LTLPK03': 'LTL014',              // pistolet LTL Bravo 1.50 : code CL ≠ code BL Colombi
  '490041': '490042',               // revolver Crosman Vigilante : code CL 490041 ≠ code BL 490042
};
