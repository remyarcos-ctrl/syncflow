// ============================================================
// Rapprochement ② BL papier (lignes_be) ↔ ③ saisie log (saisies_cl)
// Logique partagée : carte BE + vue globale.
// Principe : ③ fait foi par défaut, un écart est remonté pour décision.
// ============================================================
import type { LigneBE, SaisieCL } from '@/types';

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
  papier: number | null; // ② somme lignes_be (hors retour / hors_systeme)
  cl: number | null;     // ③ somme saisies_cl
  ecart: number;         // papier - cl  (>0 = log a sous-saisi, <0 = log a sur-saisi)
  dansCommande: boolean; // la référence existe-t-elle dans au moins une commande ?
  statut: StatutResolution;
  note: string | null;
}

type LigneBeLite = Pick<LigneBE, 'reference_article' | 'quantite_receptionnee'> &
  Partial<Pick<LigneBE, 'statut_retour' | 'hors_systeme'>>;
type SaisieLite = Pick<SaisieCL, 'reference_article' | 'quantite_recue'>;

export const aEcart = (e: { ecart: number }) => Math.abs(e.ecart) > 0.001;

export function comparerPointage(
  lignesBe: LigneBeLite[],
  saisies: SaisieLite[],
  resolutions: ResolutionRow[] = [],
  refsCommandees?: Set<string>, // réfs normalisées présentes dans au moins une commande
): EcartPointage[] {
  const papier = new Map<string, number>();
  const label = new Map<string, string>();
  for (const l of lignesBe) {
    // Pointage = comparer le BL papier (②) à ce que la log a saisi (③).
    // On compte TOUTES les lignes du BL — y compris hors_systeme et retours —
    // car la saisie log les inclut aussi (elles ont bien été reçues sur ce BL).
    const k = normalizeRef(l.reference_article);
    if (!k) continue;
    papier.set(k, (papier.get(k) ?? 0) + (l.quantite_receptionnee ?? 0));
    if (!label.has(k)) label.set(k, l.reference_article ?? k);
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
      return {
        ref: label.get(k) ?? k,
        papier: p,
        cl: c,
        ecart: (p ?? 0) - (c ?? 0),
        dansCommande: refsCommandees ? refsCommandees.has(k) : true,
        statut: (r?.statut as StatutResolution) ?? 'à analyser',
        note: r?.note ?? null,
      };
    })
    .sort((a, b) => Math.abs(b.ecart) - Math.abs(a.ecart) || a.ref.localeCompare(b.ref));
}

// Verdict lisible d'un écart (côté pointage log)
export function verdictPointage(e: EcartPointage): { label: string; ok: boolean } {
  if (!aEcart(e)) return { label: 'conforme', ok: true };
  if (e.papier == null) return { label: 'en plus dans CL (absent du BL papier)', ok: false };
  if (e.cl == null) return e.dansCommande
    ? { label: 'non saisi par la log', ok: false }
    : { label: 'hors commande (envoi Colombi non commandé)', ok: false };
  return { label: e.ecart > 0 ? `log a sous-saisi de ${e.ecart}` : `log a sur-saisi de ${-e.ecart}`, ok: false };
}

export type CauseCode = 'conforme' | 'ecart_qte' | 'hors_commande' | 'non_saisi' | 'en_plus_cl';

// Cause structurée d'un écart, pour classer/filtrer/exporter.
export function causeEcart(e: EcartPointage): { code: CauseCode; label: string } {
  if (!aEcart(e)) return { code: 'conforme', label: 'Conforme' };
  if (e.papier == null) return { code: 'en_plus_cl', label: 'En plus dans CL' };
  if (e.cl == null) return e.dansCommande
    ? { code: 'non_saisi', label: 'Non saisi (oubli log)' }
    : { code: 'hors_commande', label: 'Hors commande' };
  return { code: 'ecart_qte', label: 'Écart quantité' };
}
