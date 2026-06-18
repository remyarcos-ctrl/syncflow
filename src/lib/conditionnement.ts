// Réconciliation des unités de conditionnement (cartons / boîtes vs pièces).
// Le BL papier peut être en cartons (ex. 45) alors que Centralink compte en
// pièces (45 × 500 = 22 500). Le facteur est lu dans la désignation (« X 500 »).

export function facteurConditionnement(designation: string | null | undefined): number {
  const d = String(designation ?? '').toUpperCase();
  const m = d.match(/[X×*]\s*(\d{2,})|PAR\s+(\d+)|LOT\s+DE\s+(\d+)|BO[IÎ]TE\s+DE\s+(\d+)/);
  if (!m) return 1;
  const n = parseInt(m[1] ?? m[2] ?? m[3] ?? m[4] ?? '1', 10);
  return n > 1 && n <= 100000 ? n : 1;
}

// Deux quantités concordent si elles sont égales OU égales via le facteur
// de conditionnement (a×N == b ou b×N == a).
export function quantitesConcordent(
  a: number, b: number, designation: string | null | undefined, tol = 0.001,
): boolean {
  if (Math.abs(a - b) <= tol) return true;
  const n = facteurConditionnement(designation);
  if (n > 1) {
    if (Math.abs(a * n - b) <= tol) return true;
    if (Math.abs(b * n - a) <= tol) return true;
  }
  return false;
}
