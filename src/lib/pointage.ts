// ============================================================
// Rapprochement ② BL papier (lignes_be) ↔ ③ saisie log (saisies_cl)
// Logique partagée : carte BE + vue globale.
// Principe : ③ fait foi par défaut, un écart est remonté pour décision.
// ============================================================
import type { LigneBE, SaisieCL } from '@/types';
import { quantitesConcordent, facteurConditionnement } from './conditionnement';

export const normalizeRef = (s: string | null | undefined) =>
  String(s ?? '').toUpperCase().replace(/O/g, '0').replace(/[^A-Z0-9]/g, '');

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
  facteur: number;             // facteur de conditionnement utilisé pour réconcilier (1 si aucun)
  commandeEnAttente: boolean;  // existe-t-il une commande avec du reliquat à recevoir pour cette réf ?
  statut: StatutResolution;
  note: string | null;
}

type LigneBeLite = Pick<LigneBE, 'reference_article' | 'quantite_receptionnee'> &
  Partial<Pick<LigneBE, 'statut_retour' | 'hors_systeme' | 'designation'>>;
type SaisieLite = Pick<SaisieCL, 'reference_article' | 'quantite_recue'>;

export const aEcart = (e: { ecart: number }) => Math.abs(e.ecart) > 0.001;

export function comparerPointage(
  lignesBe: LigneBeLite[],
  saisies: SaisieLite[],
  resolutions: ResolutionRow[] = [],
  refsReliquat?: Set<string>, // réfs normalisées ayant une commande avec reliquat à recevoir
): EcartPointage[] {
  const papier = new Map<string, number>();
  const label = new Map<string, string>();
  const desig = new Map<string, string>();
  for (const l of lignesBe) {
    // Pointage = comparer le BL papier (②) à ce que la log a saisi (③).
    // On compte TOUTES les lignes du BL — y compris hors_systeme et retours —
    // car la saisie log les inclut aussi (elles ont bien été reçues sur ce BL).
    const k = normalizeRef(l.reference_article);
    if (!k) continue;
    papier.set(k, (papier.get(k) ?? 0) + (l.quantite_receptionnee ?? 0));
    if (!label.has(k)) label.set(k, l.reference_article ?? k);
    if (!desig.has(k) && l.designation) desig.set(k, l.designation);
  }
  const cl = new Map<string, number>();
  for (const s of saisies) {
    const k = normalizeRef(s.reference_article);
    if (!k) continue;
    cl.set(k, (cl.get(k) ?? 0) + (s.quantite_recue ?? 0));
    if (!label.has(k)) label.set(k, s.reference_article ?? k);
  }
  const res = new Map<string, { statut: string; note: string | null }>();
  for (const r of resolutions) res.set(normalizeRef(r.reference_article), { statut: r.statut, note: r.note });

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
      const concord = concordDirect || concordFacteur;
      return {
        ref: label.get(k) ?? k,
        papier: p,
        cl: c,
        ecart: concord ? 0 : (p ?? 0) - (c ?? 0),
        facteur: concordFacteur ? n : 1,
        commandeEnAttente: refsReliquat ? refsReliquat.has(k) : false,
        statut: (r?.statut as StatutResolution) ?? 'à analyser',
        note: r?.note ?? null,
      };
    })
    .sort((a, b) => Math.abs(b.ecart) - Math.abs(a.ecart) || a.ref.localeCompare(b.ref));
}

export type CauseCode = 'conforme' | 'oubli_log' | 'sur_saisie' | 'hors_commande';

// Cause structurée d'un écart (modèle directionnel).
// Centralink (③) ne booke que le commandé ; le BL papier (②) contient tout le reçu.
//  - ③ > ②            → la log a saisi plus que le papier → sur-saisie (erreur log)
//  - ② > ③ + reliquat → du commandé attendu n'a pas été saisi → oubli log (erreur log)
//  - ② > ③ sans reliquat → reçu hors-commande / sur-livraison → à investiguer (Colombi)
export function causeEcart(e: EcartPointage): { code: CauseCode; label: string } {
  if (!aEcart(e)) return { code: 'conforme', label: 'Conforme' };
  if (e.ecart < 0) return { code: 'sur_saisie', label: 'Sur-saisie log (③ > ②)' };
  return e.commandeEnAttente
    ? { code: 'oubli_log', label: 'Oubli log (commande en attente)' }
    : { code: 'hors_commande', label: 'Hors commande — à investiguer' };
}

// Verdict lisible (réutilise la cause).
export function verdictPointage(e: EcartPointage): { label: string; ok: boolean } {
  const c = causeEcart(e);
  return { label: c.label, ok: c.code === 'conforme' };
}
