// Contrôle 3-voies de facturation : facture ④ vs commande ① (prix + qté) vs reçu ③ (qté).
// Principe : on DÉTECTE et on SIGNALE les écarts, jamais de correction automatique.
// Rattachement facture→commande : via numero_be_detecte → saisies_cl.commande_ref,
// sinon repli sur la référence article dans les commandes.

export const normalizeRef = (s: string | null | undefined): string =>
  String(s ?? '').toUpperCase().replace(/O/g, '0').replace(/[^A-Z0-9]/g, '');

const normNum = (s: string | null | undefined): string =>
  String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// Seuils (écart au-delà duquel on signale)
export const TOL_PRIX_PCT = 1;    // 1 % d'écart de prix unitaire
export const TOL_QTE = 0.01;      // tolérance quantité

export interface LigneFactureInput {
  id: string;
  facture_id: string;
  ligne_no: number;
  reference_article: string | null;
  designation: string | null;
  quantite_facturee: number;
  pu_facture: number | null;
  montant_ht: number | null;
  numero_be_detecte: string | null;
}
export interface LigneCommandeInput {
  commande_id: string;
  reference_article: string | null;
  quantite_commandee: number;
  pu_commande: number | null;
  quantite_receptionnee_reelle: number;
}
export interface CommandeInput {
  id: string;
  numero_commande_interne: string;
}
export interface SaisieInput {
  numero_be: string;
  commande_ref: string | null;
}

export type VerdictFact =
  | 'conforme'
  | 'ecart_prix'
  | 'sur_facturation'
  | 'partiel'
  | 'hors_commande';

export interface ControleLigne {
  lf: LigneFactureInput;
  commandesRattachees: string[];   // numéros de commande (#NNNN)
  puCommande: number | null;        // ① prix unitaire commandé
  qteCommandee: number | null;      // ① quantité commandée
  qteRecue: number | null;          // ③ quantité reçue (Centralink)
  ecartPrixPct: number | null;      // (PU fact - PU cmd) / PU cmd × 100
  ecartQteRecu: number | null;      // qté facturée - qté reçue (>0 = sur-facturé)
  verdict: VerdictFact;
  problemes: string[];              // libellés courts des écarts détectés
}

// Contrôle d'une liste de lignes de facture contre commandes + reçu.
export function controlerLignesFacture(
  lignesFact: LigneFactureInput[],
  lignesCmd: LigneCommandeInput[],
  commandes: CommandeInput[],
  saisies: SaisieInput[],
): ControleLigne[] {
  // Index commande par numéro normalisé
  const cmdById = new Map(commandes.map((c) => [c.id, c]));
  const cmdByNum = new Map<string, CommandeInput>();
  for (const c of commandes) cmdByNum.set(normNum(c.numero_commande_interne), c);

  // BE (saisie) → ensemble de numéros de commande
  const cmdRefsByBe = new Map<string, Set<string>>();
  for (const s of saisies) {
    if (!s.commande_ref) continue;
    const k = normNum(s.numero_be);
    if (!cmdRefsByBe.has(k)) cmdRefsByBe.set(k, new Set());
    cmdRefsByBe.get(k)!.add(normNum(s.commande_ref));
  }

  // Lignes commande groupées par commande_id, et index global par référence
  const lignesByCmd = new Map<string, LigneCommandeInput[]>();
  for (const l of lignesCmd) {
    const arr = lignesByCmd.get(l.commande_id) ?? [];
    arr.push(l);
    lignesByCmd.set(l.commande_id, arr);
  }

  return lignesFact.map((lf) => {
    const refN = normalizeRef(lf.reference_article);

    // 1) Déterminer les commandes candidates
    const cmdIds = new Set<string>();
    const beN = normNum(lf.numero_be_detecte);
    if (beN && cmdRefsByBe.has(beN)) {
      for (const num of cmdRefsByBe.get(beN)!) {
        const c = cmdByNum.get(num);
        if (c) cmdIds.add(c.id);
      }
    }
    // Repli : aucune commande via BE → toutes les commandes contenant la référence
    if (cmdIds.size === 0 && refN) {
      for (const l of lignesCmd) {
        if (normalizeRef(l.reference_article) === refN) cmdIds.add(l.commande_id);
      }
    }

    // 2) Agréger les lignes commande correspondant à la référence
    const matched: LigneCommandeInput[] = [];
    for (const cid of cmdIds) {
      for (const l of lignesByCmd.get(cid) ?? []) {
        if (normalizeRef(l.reference_article) === refN) matched.push(l);
      }
    }

    const commandesRattachees = [...cmdIds]
      .map((id) => cmdById.get(id)?.numero_commande_interne)
      .filter(Boolean) as string[];

    if (matched.length === 0) {
      return {
        lf, commandesRattachees,
        puCommande: null, qteCommandee: null, qteRecue: null,
        ecartPrixPct: null, ecartQteRecu: null,
        verdict: 'hors_commande',
        problemes: ['référence absente des commandes'],
      };
    }

    const puCommande = matched.find((m) => m.pu_commande != null)?.pu_commande ?? null;
    const qteCommandee = matched.reduce((s, m) => s + (Number(m.quantite_commandee) || 0), 0);
    const qteRecue = matched.reduce((s, m) => s + (Number(m.quantite_receptionnee_reelle) || 0), 0);

    const ecartPrixPct =
      puCommande && lf.pu_facture != null && puCommande !== 0
        ? ((lf.pu_facture - puCommande) / puCommande) * 100
        : null;
    const ecartQteRecu = lf.quantite_facturee - qteRecue;

    const problemes: string[] = [];
    const surFacture = ecartQteRecu > TOL_QTE;          // facturé > reçu
    const sousFacture = ecartQteRecu < -TOL_QTE;        // facturé < reçu (partiel)
    const ecartPrix = ecartPrixPct != null && Math.abs(ecartPrixPct) > TOL_PRIX_PCT;

    if (surFacture) problemes.push(`facturé ${fmt(lf.quantite_facturee)} > reçu ${fmt(qteRecue)}`);
    if (ecartPrix) problemes.push(`prix ${ecartPrixPct! > 0 ? '+' : ''}${ecartPrixPct!.toFixed(1)}% vs commande`);
    if (sousFacture && !surFacture) problemes.push(`facturé ${fmt(lf.quantite_facturee)} < reçu ${fmt(qteRecue)} (partiel)`);

    // Verdict : priorité au plus grave
    let verdict: VerdictFact = 'conforme';
    if (surFacture) verdict = 'sur_facturation';
    else if (ecartPrix) verdict = 'ecart_prix';
    else if (sousFacture) verdict = 'partiel';

    return {
      lf, commandesRattachees,
      puCommande, qteCommandee, qteRecue,
      ecartPrixPct, ecartQteRecu,
      verdict, problemes,
    };
  });
}

const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2));

export const estEcart = (v: VerdictFact): boolean =>
  v === 'sur_facturation' || v === 'ecart_prix' || v === 'hors_commande';

export const verdictLabel: Record<VerdictFact, string> = {
  conforme: 'Conforme',
  ecart_prix: 'Écart prix',
  sur_facturation: 'Sur-facturation',
  partiel: 'Partiel',
  hors_commande: 'Hors commande',
};
