// PostgREST plafonne chaque requête à 1000 lignes (max-rows serveur) — même `.limit(9999)`
// est écrêté. Sur les tables qui dépassent (lignes_commande ~2000, saisies_cl ~1800), une
// lecture à plat renvoie des données TRONQUÉES sans aucune erreur → écrans faux en silence
// (cf. piège documenté : faux « hors commande », faux manques au pointage).
// selectAll boucle sur .range() jusqu'à tout récupérer. À utiliser pour TOUTE lecture non
// scopée (sans .eq()/.in() restrictif) de ces tables.
export async function selectAll<T = Record<string, unknown>>(
  build: () => { range: (a: number, b: number) => PromiseLike<{ data: T[] | null; error: unknown }> },
): Promise<T[]> {
  const pageSize = 1000;
  let from = 0;
  const out: T[] = [];
  for (;;) {
    const { data, error } = await build().range(from, from + pageSize - 1);
    if (error) throw error; // remonte à React Query → état d'erreur visible, pas de données partielles
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return out;
}
