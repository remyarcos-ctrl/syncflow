// Croisement des réfs d'un document importé avec le CATALOGUE connu (toutes les réfs
// déjà vues : commandes ∪ stock CL ∪ saisies CL). Objectif : attraper les réfs mal lues
// (scan flou) DÈS L'IMPORT, au lieu de laisser un fantôme filer jusqu'à la détection.
// On ne corrige RIEN en silence : on FAIT REMONTER « réf inconnue + réf proche probable »,
// Rémy tranche (philosophie syncflow : remonter, pas gommer).
import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeRef } from '@/lib/document-parser';
import { aliasRef } from '@/lib/pointage';

// Levenshtein ≤ 1 (substitution, insertion ou suppression d'un caractère) sur réfs
// normalisées — même logique que la fusion réf-mismatch de la détection.
export function distance1(a: string, b: string): boolean {
  const x = normalizeRef(a), y = normalizeRef(b);
  if (x === y) return false;
  if (Math.abs(x.length - y.length) > 1) return false;
  if (x.length === y.length) {
    let diff = 0;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) diff++;
    return diff === 1;
  }
  const [court, long] = x.length < y.length ? [x, y] : [y, x];
  for (let i = 0, j = 0, sauts = 0; j < long.length; ) {
    if (court[i] === long[j]) { i++; j++; }
    else { if (++sauts > 1) return false; j++; }
  }
  return true;
}

// Charge toutes les réfs connues (normalisées + aliasées). Paginé : lignes_commande et
// saisies_cl dépassent 1000 lignes (piège PostgREST — un select non paginé tronque).
export async function chargerCatalogue(sb: SupabaseClient): Promise<Set<string>> {
  const catalogue = new Set<string>();
  for (const table of ['lignes_commande', 'stocks_cl', 'saisies_cl']) {
    for (let from = 0; ; from += 1000) {
      const { data } = await sb.from(table).select('reference_article').range(from, from + 999);
      const rows = data ?? [];
      for (const r of rows) {
        const k = aliasRef(String((r as { reference_article: string | null }).reference_article ?? ''));
        if (k) catalogue.add(k);
      }
      if (rows.length < 1000) break;
    }
  }
  return catalogue;
}

// Contrôle les réfs d'un BE contre le catalogue. Retourne un avertissement par réf
// inconnue, avec la réf connue la plus proche (distance 1) quand il y en a une.
export function controlerRefsCatalogue(
  refs: { reference_article: string; quantite: number }[],
  catalogue: Set<string>,
): string[] {
  if (!catalogue.size) return []; // catalogue indisponible → pas de faux « inconnue »
  const avert: string[] = [];
  for (const { reference_article: ref, quantite } of refs) {
    const k = aliasRef(ref);
    if (!k || catalogue.has(k)) continue;
    const proches = [...catalogue].filter((c) => distance1(k, c)).slice(0, 3);
    avert.push(
      proches.length
        ? `réf « ${ref} » (qté ${quantite}) inconnue du catalogue — probable coquille de scan, réf proche connue : ${proches.map((p) => `« ${p} »`).join(', ')} → vérifier sur le PDF`
        : `réf « ${ref} » (qté ${quantite}) inconnue du catalogue (jamais commandée, ni en stock, ni saisie) — vérifier sur le PDF (réf mal lue ? nouveau produit ?)`,
    );
  }
  return avert;
}
