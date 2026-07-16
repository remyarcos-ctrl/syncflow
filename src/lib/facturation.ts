// Contrôle 3-voies de facturation : facture ④ vs commande ① (prix + qté) vs reçu ③ (qté).
// Principe : on DÉTECTE et on SIGNALE les écarts, jamais de correction automatique.
// Rattachement facture→commande : via numero_be_detecte → saisies_cl.commande_ref,
// sinon repli sur la référence article dans les commandes.
// Clé de réf = aliasRef (lib/pointage) : normalisation + alias CL↔Colombi + préfixe
// commande coupé — la facture Colombi imprime les mêmes codes que le BL papier,
// donc sans alias une réf facturée sous son code Colombi (ex. LTL014) passerait
// « hors commande » alors qu'elle est commandée sous son code CL (LTLPK03).
import { aliasRef } from './pointage';
import { facteurConditionnement } from './conditionnement';

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

// Contexte optionnel — sans l'info, le verdict reste celui des 3 voies (on n'invente rien).
export interface FacturationOpts {
  // Réfs (clé aliasRef) dont le reçu ③ est CONTESTÉ par une anomalie de pointage OUVERTE
  // (sur-saisie log, réception non détaillée…) : le reçu peut être gonflé par une double
  // saisie non apurée → une ligne « conforme » peut quand même payer du non-livré
  // (ex. 17655 : papier 10, Livré 30 → une facture de 30 passerait conforme).
  refsRecuConteste?: Set<string>;
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
  puCommande: number | null;        // ① prix unitaire commandé (retenu : celui qui colle le mieux)
  qteCommandee: number | null;      // ① quantité commandée
  qteRecue: number | null;          // ③ quantité reçue (Centralink)
  ecartPrixPct: number | null;      // (PU fact - PU cmd) / PU cmd × 100
  ecartQteRecu: number | null;      // qté facturée - qté reçue (>0 = sur-facturé)
  facteur: number;                  // facteur de conditionnement ayant réconcilié qté/prix (1 si aucun)
  recuConteste: boolean;            // reçu ③ contesté par une anomalie de pointage ouverte
  verdict: VerdictFact;
  problemes: string[];              // libellés courts des écarts détectés
}

// Contrôle d'une liste de lignes de facture contre commandes + reçu.
export function controlerLignesFacture(
  lignesFact: LigneFactureInput[],
  lignesCmd: LigneCommandeInput[],
  commandes: CommandeInput[],
  saisies: SaisieInput[],
  opts: FacturationOpts = {},
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

  // Lignes commande groupées par commande_id, et index global par référence ALIASÉE
  const lignesByCmd = new Map<string, LigneCommandeInput[]>();
  const cmdIdsByRef = new Map<string, Set<string>>();
  for (const l of lignesCmd) {
    const arr = lignesByCmd.get(l.commande_id) ?? [];
    arr.push(l);
    lignesByCmd.set(l.commande_id, arr);
    const k = aliasRef(l.reference_article);
    if (k) {
      if (!cmdIdsByRef.has(k)) cmdIdsByRef.set(k, new Set());
      cmdIdsByRef.get(k)!.add(l.commande_id);
    }
  }

  const contestees = opts.refsRecuConteste ?? new Set<string>();

  return lignesFact.map((lf) => {
    const refN = aliasRef(lf.reference_article);
    const recuConteste = !!refN && contestees.has(refN);

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
      for (const cid of cmdIdsByRef.get(refN) ?? []) cmdIds.add(cid);
    }

    // 2) Agréger les lignes commande correspondant à la référence.
    // ⚠ Le rattachement par BE peut être TROP ÉTROIT : le BE ne couvre qu'une partie
    // des commandes de la réf → si la réf n'apparaît dans AUCUNE commande du BE,
    // on retombe sur le repli par réf plutôt que de déclarer « hors commande » à tort.
    let matched: LigneCommandeInput[] = [];
    const collecter = (ids: Iterable<string>) => {
      const out: LigneCommandeInput[] = [];
      for (const cid of ids) {
        for (const l of lignesByCmd.get(cid) ?? []) {
          if (aliasRef(l.reference_article) === refN) out.push(l);
        }
      }
      return out;
    };
    matched = collecter(cmdIds);
    if (matched.length === 0 && refN && cmdIdsByRef.has(refN)) {
      for (const cid of cmdIdsByRef.get(refN)!) cmdIds.add(cid);
      matched = collecter(cmdIds);
    }

    const commandesRattachees = [...cmdIds]
      .filter((id) => matched.some((m) => m.commande_id === id))
      .map((id) => cmdById.get(id)?.numero_commande_interne)
      .filter(Boolean) as string[];

    if (matched.length === 0) {
      return {
        lf, commandesRattachees,
        puCommande: null, qteCommandee: null, qteRecue: null,
        ecartPrixPct: null, ecartQteRecu: null,
        facteur: 1, recuConteste,
        verdict: 'hors_commande' as const,
        problemes: ['référence absente des commandes'],
      };
    }

    const qteCommandee = matched.reduce((s, m) => s + (Number(m.quantite_commandee) || 0), 0);
    const qteRecue = matched.reduce((s, m) => s + (Number(m.quantite_receptionnee_reelle) || 0), 0);

    // ── Conditionnement : la facture peut être en PIÈCES quand Centralink compte en
    // BOÎTES (« PLOMBS X500 » : facturé 5000, reçu 10 boîtes → 10×500 = 5000, conforme).
    // On réconcilie les QUANTITÉS et le PRIX avec le même facteur, dans le même sens.
    const n = facteurConditionnement(lf.designation);
    let facteur = 1;
    let qteFactEnUniteCmd = lf.quantite_facturee; // qté facturée ramenée à l'unité de la commande
    if (n > 1 && Math.abs(lf.quantite_facturee - qteRecue) > TOL_QTE) {
      if (Math.abs(lf.quantite_facturee - qteRecue * n) <= TOL_QTE) {
        // facture en pièces, CL en boîtes
        facteur = n; qteFactEnUniteCmd = lf.quantite_facturee / n;
      } else if (Math.abs(lf.quantite_facturee * n - qteRecue) <= TOL_QTE) {
        // facture en boîtes, CL en pièces
        facteur = n; qteFactEnUniteCmd = lf.quantite_facturee * n;
      }
    }

    // ── Prix : plusieurs commandes rattachées = plusieurs PU possibles → on retient
    // celui qui MINIMISE l'écart (on n'accuse que si AUCUN prix commandé ne colle).
    // Si les quantités ont été réconciliées ×N, le PU l'est aussi (PU boîte = PU pièce × N).
    const pusCandidats = [...new Set(matched.map((m) => m.pu_commande).filter((p): p is number => p != null && p !== 0))];
    let puCommande: number | null = null;
    let ecartPrixPct: number | null = null;
    if (lf.pu_facture != null && pusCandidats.length > 0) {
      const puFactAjuste = facteur > 1 && qteFactEnUniteCmd < lf.quantite_facturee
        ? lf.pu_facture * facteur              // facture en pièces → PU ramené à la boîte
        : facteur > 1
          ? lf.pu_facture / facteur            // facture en boîtes → PU ramené à la pièce
          : lf.pu_facture;
      for (const pu of pusCandidats) {
        const e = ((puFactAjuste - pu) / pu) * 100;
        if (ecartPrixPct == null || Math.abs(e) < Math.abs(ecartPrixPct)) {
          ecartPrixPct = e; puCommande = pu;
        }
      }
    } else {
      puCommande = pusCandidats[0] ?? null;
    }

    const ecartQteRecu = qteFactEnUniteCmd - qteRecue;

    const problemes: string[] = [];
    const surFacture = ecartQteRecu > TOL_QTE;          // facturé > reçu
    const sousFacture = ecartQteRecu < -TOL_QTE;        // facturé < reçu (partiel)
    const ecartPrix = ecartPrixPct != null && Math.abs(ecartPrixPct) > TOL_PRIX_PCT;

    if (facteur > 1) problemes.push(`unités réconciliées ×${n} (conditionnement)`);
    if (surFacture) {
      problemes.push(`facturé ${fmt(qteFactEnUniteCmd)} > reçu ${fmt(qteRecue)}`);
      // Facteur présent mais qui ne réconcilie PAS exactement : l'écart peut venir des
      // unités → on le dit, la réclamation doit vérifier avant d'accuser Colombi.
      if (n > 1 && facteur === 1) problemes.push(`⚠ conditionnement ×${n} possible — vérifier les unités avant réclamation`);
    }
    if (ecartPrix) problemes.push(`prix ${ecartPrixPct! > 0 ? '+' : ''}${ecartPrixPct!.toFixed(1)}% vs commande`);
    if (sousFacture && !surFacture) problemes.push(`facturé ${fmt(qteFactEnUniteCmd)} < reçu ${fmt(qteRecue)} (partiel)`);
    if (recuConteste) problemes.push('reçu ③ contesté par le pointage (anomalie ouverte) — apurer avant paiement');

    // Verdict : priorité au plus grave
    let verdict: VerdictFact = 'conforme';
    if (surFacture) verdict = 'sur_facturation';
    else if (ecartPrix) verdict = 'ecart_prix';
    else if (sousFacture) verdict = 'partiel';

    return {
      lf, commandesRattachees,
      puCommande, qteCommandee, qteRecue,
      ecartPrixPct, ecartQteRecu,
      facteur, recuConteste,
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
