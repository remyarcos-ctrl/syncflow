// Contrôle réception : BE papier ② vs COMMANDES ① — indépendant de la saisie log ③.
// Répond à : « Colombi a-t-il livré ce qu'on a commandé, en quantité ? »
// Utilisable dès l'import du BE, avant que la log saisisse.

export const normalizeRef = (s: string | null | undefined): string =>
  String(s ?? '').toUpperCase().replace(/O/g, '0').replace(/[^A-Z0-9]/g, '');

export type VerdictReception = 'conforme' | 'sur_livraison' | 'hors_commande';

export interface LigneBeInput {
  be_id: string;
  reference_article: string | null;
  designation: string | null;
  quantite_receptionnee: number;
  hors_systeme?: boolean | null;
}
export interface LigneCmdInput {
  reference_article: string | null;
  quantite_commandee: number;
  quantite_receptionnee_reelle: number;
}

export interface ControleReception {
  be_id: string;
  ref: string;
  designation: string | null;
  qteBe: number;            // ② reçu sur ce BE
  totalCommande: number | null;  // ① total commandé (lignes positives)
  totalRecu: number | null;      // ③ total reçu Centralink (lignes positives)
  totalRetour: number;           // total retourné (lignes négatives = retours acheteuse)
  surLivraisonNette: number;     // reçu − commandé − retours (>0 = sur-livraison à traiter)
  doubleSaisie: boolean;         // reçu = multiple exact du commandé → double saisie log probable
  verdict: VerdictReception;
}

export const verdictReceptionLabel: Record<VerdictReception, string> = {
  conforme: 'Conforme',
  sur_livraison: 'Sur-livraison Colombi',
  hors_commande: 'Hors commande Colombi',
};

// Agrège les commandes par référence, puis qualifie chaque ligne de BE.
export function controlerReceptions(
  lignesBe: LigneBeInput[],
  lignesCmd: LigneCmdInput[],
): ControleReception[] {
  // Par référence : total commandé + total reçu (Centralink, autoritaire)
  // Par référence : commandé (lignes +), reçu (lignes +), retours (lignes − = retours acheteuse).
  // Détection double saisie : sur une ligne, reçu = multiple exact (≥2) du commandé
  // → la log a saisi la réception plusieurs fois. On retient le « vrai » reçu (= commandé).
  const parRef = new Map<string, { cmd: number; recu: number; retour: number; dbl: boolean }>();
  for (const l of lignesCmd) {
    const k = normalizeRef(l.reference_article);
    if (!k) continue;
    const cur = parRef.get(k) ?? { cmd: 0, recu: 0, retour: 0, dbl: false };
    const q = Number(l.quantite_commandee) || 0;
    const r = Math.max(0, Number(l.quantite_receptionnee_reelle) || 0);
    if (q >= 0) {
      cur.cmd += q;
      if (q > 0 && r > q && Number.isInteger(r / q) && r / q >= 2) {
        cur.recu += q;       // double saisie : on corrige (vrai reçu = commandé)
        cur.dbl = true;
      } else {
        cur.recu += r;
      }
    } else {
      cur.retour += -q;       // commande négative = retour vers Colombi
      cur.recu += r;
    }
    parRef.set(k, cur);
  }

  return lignesBe.map((l) => {
    const k = normalizeRef(l.reference_article);
    const agg = parRef.get(k);
    // Sur-livraison NETTE : reçu (corrigé des doubles) − commandé − retours.
    const surLiv = agg ? agg.recu - agg.cmd - agg.retour : 0;
    let verdict: VerdictReception = 'conforme';
    if (!agg) verdict = 'hors_commande';
    else if (surLiv > 0.001) verdict = 'sur_livraison';
    return {
      be_id: l.be_id,
      ref: l.reference_article ?? k,
      designation: l.designation ?? null,
      qteBe: Number(l.quantite_receptionnee) || 0,
      totalCommande: agg ? agg.cmd : null,
      totalRecu: agg ? agg.recu : null,
      totalRetour: agg ? agg.retour : 0,
      surLivraisonNette: surLiv,
      doubleSaisie: agg ? agg.dbl : false,
      verdict,
    };
  });
}

export const estAnomalieReception = (v: VerdictReception): boolean =>
  v === 'sur_livraison' || v === 'hors_commande';
