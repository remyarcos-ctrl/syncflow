// ============================================================
// Rapprochement ② BL papier (lignes_be) ↔ ③ saisie log (saisies_cl)
// Logique partagée : carte BE + vue globale.
// Principe : ③ fait foi par défaut, un écart est remonté pour décision.
// ============================================================
import type { LigneBE, SaisieCL } from '@/types';
import { facteurConditionnement } from './conditionnement';
import { REF_ALIAS_CL_TO_COLOMBI } from './ref-alias';

export const normalizeRef = (s: string | null | undefined) =>
  String(s ?? '').toUpperCase().replace(/O/g, '0').replace(/[^A-Z0-9]/g, '');

// Alias CL → Colombi : la saisie Centralink utilise parfois un autre code que le BL papier
// (ex. LTLPK03 saisi ↔ LTL014 au papier)… et l'INVERSE aussi (les codes se mélangent sur
// les papiers : LTLPK03 imprimé sur certains BL, 490041 au papier vs 490042 commandé).
// L'alias s'applique donc aux DEUX côtés (papier ET saisie), sinon la même marchandise
// devient deux fantômes symétriques : « hors commande ②500/③— » + « dispatch ②—/③492 »
// (vu au balayage réel sur LTLPK03 et 490041×5 bons).
const aliasNorm = new Map(
  Object.entries(REF_ALIAS_CL_TO_COLOMBI).map(([cl, col]) => [normalizeRef(cl), normalizeRef(col)]),
);
export const aliasRef = (raw: string | null | undefined): string => {
  // Réf préfixée du n° de commande (coquille fournisseur : « 1404/16928A » = 16928A) —
  // on coupe le préfixe numérique avant de normaliser, sinon deux réfs distinctes.
  const brut = String(raw ?? '');
  const m = brut.match(/^\s*\d{3,5}\s*\/\s*(.+)$/);
  const k = normalizeRef(m ? m[1] : brut);
  return aliasNorm.get(k) ?? k;
};

export type StatutResolution = 'à analyser' | 'vérifié' | 'corrigé' | 'accepté' | 'ignoré';

export interface ResolutionRow {
  reference_article: string;
  statut: string;
  note: string | null;
}

export interface EcartPointage {
  ref: string;
  papier: number | null;       // ② somme lignes_be (hors retour / hors_systeme)
  cl: number | null;           // ③ somme saisies_cl
  ecart: number;               // papier - cl  (>0 = ② a plus que ③, <0 = ③ a plus que ②)
  recuTotal: number | null;    // « Livré » total Centralink pour cette réf (toutes livraisons/commandes)
  facteur: number;             // facteur de conditionnement utilisé pour réconcilier (1 si aucun)
  saisiAilleurs: boolean;      // absent de la saisie de CE BE, mais reçu ailleurs dans Centralink
  commandeEnAttente: boolean;  // existe-t-il une commande avec du reliquat à recevoir pour cette réf ?
  doublonStrict: boolean;      // ③ contient N lignes STRICTEMENT identiques (réf+qté+commande) → vraie double saisie (cf 17655)
  surRecue: boolean | null;    // vraie sur-réception au niveau commande (reçu > commandé) — null = info non fournie (rester prudent)
  barcode: boolean;            // réf gérée au code-barres → un ③>② peut être une entrée scan, pas un doublon
  nonDetaille: number;         // part du Livré absente du détail par bon (order/view perd des lignes) — couvre un ②>③ sans que ce soit un oubli
  statut: StatutResolution;
  note: string | null;
}

type LigneBeLite = Pick<LigneBE, 'reference_article' | 'quantite_receptionnee'> &
  Partial<Pick<LigneBE, 'statut_retour' | 'hors_systeme' | 'designation'>>;
type SaisieLite = Pick<SaisieCL, 'reference_article' | 'quantite_recue'> &
  Partial<Pick<SaisieCL, 'commande_ref'>>;

export const aEcart = (e: { ecart: number }) => Math.abs(e.ecart) > 0.001;

// Options de contexte (tous par réf NORMALISÉE-ALIASÉE) — chaque écran passe ce qu'il a ;
// sans l'info, le verdict reste conservateur (on n'invente ni n'efface d'accusation).
export interface PointageOpts {
  refsReliquat?: Set<string>;            // réfs avec commande en reliquat à recevoir
  refsRecues?: Set<string>;              // réfs reçues quelque part dans Centralink (reçu > 0)
  recuTotalByRef?: Map<string, number>;  // réf → « Livré » total Centralink
  refsSurRecues?: Set<string>;           // réfs avec VRAIE sur-réception (reçu > commandé sur une commande)
  refsBarcode?: Set<string>;             // réfs gérées au code-barres (stocks_cl.has_barcode)
  nonDetailleByRef?: Map<string, number>; // réf → Livré − Σ saisies détaillées (part non détaillée par bon)
}

export function comparerPointage(
  lignesBe: LigneBeLite[],
  saisies: SaisieLite[],
  resolutions: ResolutionRow[] = [],
  opts: PointageOpts = {},
): EcartPointage[] {
  const { refsReliquat, refsRecues, recuTotalByRef, refsSurRecues, refsBarcode, nonDetailleByRef } = opts;
  const papier = new Map<string, number>();
  const label = new Map<string, string>();
  const desig = new Map<string, string>();
  for (const l of lignesBe) {
    // Pointage = comparer le BL papier (②) à ce que la log a saisi (③).
    // Les lignes SAV (hors_systeme) sont EXCLUES : le SAV ne doit JAMAIS être saisi sous
    // une commande (règle métier — si la log le saisit quand même, le Centre le remonte
    // en « SAV saisi sous commande », priorité haute). Les compter au papier créait de
    // faux « oublis » (SN0004 : 1000 livrés + 3 SAV → faux oubli de 3) et de faux « hors
    // commande » (réf 70 « SAV SOUS GARANTIE »). Les retours restent comptés (reçus puis
    // retournés : la saisie log initiale les inclut).
    if (l.hors_systeme) continue;
    const k = aliasRef(l.reference_article); // alias appliqué au papier AUSSI (codes mélangés)
    if (!k) continue;
    papier.set(k, (papier.get(k) ?? 0) + (l.quantite_receptionnee ?? 0));
    if (!label.has(k)) label.set(k, l.reference_article ?? k);
    if (!desig.has(k) && l.designation) desig.set(k, l.designation);
  }
  const cl = new Map<string, number>();
  // Doublon STRICT = N lignes de saisie identiques (réf + qté + commande) sur ce bon
  // → signature d'une double saisie de réception (cf 17655 : 2×10 sur #4721), le seul
  // signal fiable indépendamment du niveau commande.
  const dupCount = new Map<string, number>();
  const doublons = new Set<string>();
  for (const s of saisies) {
    const k = aliasRef(s.reference_article); // traduire le code CL vers le code du BL papier
    if (!k) continue;
    cl.set(k, (cl.get(k) ?? 0) + (s.quantite_recue ?? 0));
    if (!label.has(k)) label.set(k, s.reference_article ?? k);
    if ((s.quantite_recue ?? 0) > 0) {
      const dk = `${k}|${s.quantite_recue}|${s.commande_ref ?? ''}`;
      const n = (dupCount.get(dk) ?? 0) + 1;
      dupCount.set(dk, n);
      if (n >= 2) doublons.add(k);
    }
  }
  const res = new Map<string, { statut: string; note: string | null }>();
  for (const r of resolutions) res.set(aliasRef(r.reference_article), { statut: r.statut, note: r.note });

  const keys = new Set<string>([...papier.keys(), ...cl.keys()]);
  return [...keys]
    .map(k => {
      const p = papier.has(k) ? papier.get(k)! : null;
      const c = cl.has(k) ? cl.get(k)! : null;
      const r = res.get(k);
      // Réconciliation conditionnement : si ② et ③ concordent via le facteur
      // (ex. 45 cartons × 500 = 22 500 pièces), pas d'écart.
      const concordDirect = p != null && c != null && Math.abs(p - c) <= 0.001;
      const n = facteurConditionnement(desig.get(k));
      const concordFacteur = p != null && c != null && n > 1 && (Math.abs(p * n - c) <= 0.001 || Math.abs(c * n - p) <= 0.001);
      // Présent au BL mais pas saisi sous CE BE, pourtant reçu ailleurs dans Centralink → saisi sous un autre BE (pas un oubli).
      const saisiAilleurs = p != null && c == null && !!refsRecues?.has(k);
      const concord = concordDirect || concordFacteur || saisiAilleurs;
      return {
        ref: label.get(k) ?? k,
        papier: p,
        cl: c,
        recuTotal: recuTotalByRef?.has(k) ? recuTotalByRef.get(k)! : null,
        ecart: concord ? 0 : (p ?? 0) - (c ?? 0),
        facteur: concordFacteur ? n : 1,
        saisiAilleurs,
        commandeEnAttente: refsReliquat ? refsReliquat.has(k) : false,
        doublonStrict: doublons.has(k),
        surRecue: refsSurRecues ? refsSurRecues.has(k) : null,
        barcode: refsBarcode?.has(k) ?? false,
        nonDetaille: nonDetailleByRef?.get(k) ?? 0,
        statut: (r?.statut as StatutResolution) ?? 'à analyser',
        note: r?.note ?? null,
      };
    })
    .sort((a, b) => Math.abs(b.ecart) - Math.abs(a.ecart) || a.ref.localeCompare(b.ref));
}

export type CauseCode =
  | 'conforme'
  | 'oubli_log'
  | 'sur_saisie'
  | 'hors_commande'
  | 'dispatch'          // ③ > ② mais reçu = commandé partout → réf répartie multi-commandes, papier incomplet — pas d'erreur log probable
  | 'detail_incomplet'; // ② > ③ mais le Livré non détaillé couvre le manque → order/view perd des lignes, pas un oubli

// Cause structurée d'un écart — mêmes garde-fous que la détection du Centre (§3c/§3g) :
//  ③ > ② :
//   1. lignes de saisie STRICTEMENT identiques répétées → vraie double saisie (17655) — accusation ferme
//   2. sinon, vraie sur-réception au niveau commande (reçu > commandé) → sur-saisie log
//   3. sinon (reçu = commandé partout) → « dispatch » : réf servie pour plusieurs commandes,
//      notre scan papier incomplet — PAS une erreur log (cf faux positifs SN0006/PR004/REM007)
//   NB : sans l'info surRecue (écran qui ne la charge pas), on reste sur l'accusation prudente (2).
//  ② > ③ :
//   4. la part du Livré non détaillée par bon couvre le manque → « détail incomplet » (order/view
//      perd des lignes — prouvé sur 17655 : 2 visibles / 3 réelles) — pas un oubli
//   5. sinon reliquat commande → oubli log ; sinon → hors commande (Colombi)
//  Bar-code : un ③>② sur réf scannée peut être une entrée scan → mention, on ne conclut pas seul.
export function causeEcart(e: EcartPointage): { code: CauseCode; label: string } {
  if (!aEcart(e)) return { code: 'conforme', label: 'Conforme' };
  const bc = e.barcode ? ' · 🏷 bar-code : peut être une entrée scan, vérifier le canal' : '';
  if (e.ecart < 0) {
    if (e.doublonStrict) return { code: 'sur_saisie', label: `Double saisie (ligne répétée à l'identique)${bc}` };
    // dispatch UNIQUEMENT si on SAIT qu'aucune commande n'est sur-reçue (surRecue === false) ;
    // info absente (null) → on garde l'accusation prudente, on ne blanchit pas à l'aveugle.
    // NB : « dispatch » couvre aussi le n° de bon erroné (marchandise d'un autre bon saisie
    // ici, cf KI0001 : manque sur 1094, excédent sur 1125) → recouper avec les manques.
    if (e.surRecue === false) return { code: 'dispatch', label: 'Saisi sous ce bon sans papier correspondant (reçu = commandé partout) — bon partagé au papier incomplet, ou n° de bon erroné : recouper avec les manques des autres bons' };
    return { code: 'sur_saisie', label: `Sur-saisie log (③ > ②)${bc}` };
  }
  // ⚠ formulation prudente : le Livré GLOBAL de la réf dépasse le détail de TOUS les bons
  // (part bookée sans bon détaillé — réception directe, bon non capté, ou ligne perdue par
  // order/view). Le manque de CE bon s'y explique probablement, mais on ne prétend PAS que
  // la compta de ce bon montre plus (vérifié sur BE-26-04-1130 : compta = saisies, la part
  // non détaillée était ailleurs).
  if (e.nonDetaille >= e.ecart - 0.001 && e.nonDetaille > 0)
    return { code: 'detail_incomplet', label: `Couvert par le Livré global (${e.nonDetaille.toFixed(0)} bookés sans bon détaillé quelque part) — pas un oubli ferme, vérifier en comptabilité` };
  if (e.commandeEnAttente) return { code: 'oubli_log', label: 'Oubli log (commande en attente)' };
  // Réf reçue/commandée quelque part (commandes soldées) → pas « hors commande » : c'est un
  // écart papier > saisie sur du soldé = surplus à investiguer (le contrôle réception le route).
  if ((e.recuTotal ?? 0) > 0)
    return { code: 'hors_commande', label: 'Surplus vs saisie (commandes soldées) — à investiguer côté Colombi (voir Contrôle réception)' };
  return { code: 'hors_commande', label: 'Hors commande (réf jamais commandée) — à investiguer' };
}

// Verdict lisible (réutilise la cause).
export function verdictPointage(e: EcartPointage): { label: string; ok: boolean } {
  const c = causeEcart(e);
  return { label: c.label, ok: c.code === 'conforme' };
}
