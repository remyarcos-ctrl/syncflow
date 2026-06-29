import { NextResponse } from 'next/server';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { normalizeRef, aliasKey } from '@/lib/reception';

// Détection des candidats alias (réf renommée / double codification).
//
// Signal : sur UN MÊME bon, un code n'a que du papier ② (0 saisie) pendant qu'un
// AUTRE code n'a que de la saisie ③ (0 papier), avec la MÊME quantité → c'est très
// probablement le même article sous deux codes. La quantité-égale seule produit des
// faux (deux articles à qté 10 sur un bon chargé) : on tranche avec la DÉSIGNATION
// (lignes_be.designation côté papier vs stocks_cl.titre côté saisie). Si les deux
// désignations partagent un mot distinctif (marque/modèle) → confirmé. Si le titre CL
// est inconnu → « à vérifier » (l'humain tranche). Sinon (désignations sans rapport)
// → écarté comme coïncidence.

function adminSb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

// PostgREST plafonne à 1000 lignes : on pagine.
async function fetchAll<T>(sb: SupabaseClient, table: string, columns: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select(columns).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

// Mots de catégorie / outils : trop communs pour prouver à eux seuls une identité
// (deux pistolets différents partagent « pistolet »). Un alias doit partager au moins
// un mot HORS de cette liste (marque, modèle…).
const GENERIQUES = new Set([
  'packitem', 'generique', 'pack', 'item', 'pistolet', 'revolver', 'carabine', 'fusil',
  'arme', 'munition', 'munitions', 'balle', 'balles', 'cartouche', 'cartouches', 'co2',
  'pour', 'avec', 'sans', 'les', 'des', 'une', 'noir', 'noire', 'blanc', 'chrome', 'mm',
  'joule', 'joules', 'cal', 'calibre', 'pak', 'blank', 'defense', 'alarme', 'plombs',
  'billes', 'cuir', 'plastique', 'abs', 'eco', 'set', 'kit', 'lot', 'modele', 'type',
]);

function tokens(s: string | null | undefined): Set<string> {
  const t = String(s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // sans accents
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/);
  const out = new Set<string>();
  for (let w of t) {
    if (w.length > 3 && w.endsWith('s')) w = w.slice(0, -1);  // pluriel léger
    if (w.length < 3) continue;                                // trop court / unités
    if (/^\d+$/.test(w)) continue;                             // nombre pur (qté/calibre)
    out.add(w);
  }
  return out;
}

// Mots distinctifs partagés (hors génériques) = preuve d'identité.
function motsDistinctifsCommuns(a: string | null | undefined, b: string | null | undefined): string[] {
  const ta = tokens(a), tb = tokens(b);
  const shared: string[] = [];
  for (const w of ta) if (tb.has(w) && !GENERIQUES.has(w)) shared.push(w);
  return shared;
}

type BeRow = { be_id: string; reference_article: string; designation: string | null; quantite_receptionnee: number | null; hors_systeme: boolean | null };
type SaRow = { numero_be: string | null; reference_article: string; quantite_recue: number | null };
type StRow = { reference_article: string; titre: string | null };
type BrRow = { id: string; numero_be: string | null };

type Cand = {
  saisieCode: string; papierCode: string;
  occurrences: number; qteTotale: number;
  bons: { be: string; qte: number }[];
  papierDesignation: string | null; saisieTitre: string | null;
  motsCommuns: string[];
  mappingLine: string;
};

export async function GET() {
  const sb = adminSb();
  try {
    const [be, sa, st, br] = await Promise.all([
      fetchAll<BeRow>(sb, 'lignes_be', 'be_id, reference_article, designation, quantite_receptionnee, hors_systeme'),
      fetchAll<SaRow>(sb, 'saisies_cl', 'numero_be, reference_article, quantite_recue'),
      fetchAll<StRow>(sb, 'stocks_cl', 'reference_article, titre'),
      fetchAll<BrRow>(sb, 'be_receptions', 'id, numero_be'),
    ]);

    const beNumById = new Map(br.map((r) => [r.id, r.numero_be ?? '']));
    const titreByRef = new Map<string, string>();
    for (const s of st) if (s.titre) titreByRef.set(normalizeRef(s.reference_article), s.titre);

    // Par bon : pour chaque code normalisé, papier ② et saisie ③ + un libellé/code brut.
    type Cell = { papier: number; saisi: number; raw: string; design: string | null };
    const parBon = new Map<string, Map<string, Cell>>();   // be -> ref -> cell
    const cell = (be: string, ref: string): Cell => {
      let m = parBon.get(be); if (!m) { m = new Map(); parBon.set(be, m); }
      let c = m.get(ref); if (!c) { c = { papier: 0, saisi: 0, raw: '', design: null }; m.set(ref, c); }
      return c;
    };
    for (const l of be) {
      if (l.hors_systeme) continue;
      const beNum = beNumById.get(l.be_id); if (!beNum) continue;
      const ref = normalizeRef(l.reference_article); if (!ref) continue;
      const c = cell(beNum, ref);
      c.papier += Number(l.quantite_receptionnee) || 0;
      if (!c.raw) c.raw = l.reference_article;
      if (!c.design && l.designation) c.design = l.designation;
    }
    for (const s of sa) {
      const beNum = s.numero_be ?? ''; if (!beNum) continue;
      const ref = normalizeRef(s.reference_article); if (!ref) continue;
      const c = cell(beNum, ref);
      c.saisi += Number(s.quantite_recue) || 0;
      if (!c.raw) c.raw = s.reference_article;
    }

    // Appariement orphelin-papier ↔ orphelin-saisie, même qté, sur le même bon.
    const confMap = new Map<string, Cand>();      // clé saisieNorm→papierNorm
    const verifMap = new Map<string, Cand>();
    for (const [beNum, m] of parBon) {
      const orphPap = [...m.entries()].filter(([, c]) => c.papier > 0 && c.saisi === 0);
      const orphSai = [...m.entries()].filter(([, c]) => c.saisi > 0 && c.papier === 0);
      for (const [pRef, pc] of orphPap) {
        for (const [sRef, sc] of orphSai) {
          if (pRef === sRef) continue;
          if (pc.papier !== sc.saisi) continue;                       // même quantité exacte
          if (aliasKey(sc.raw) === aliasKey(pc.raw)) continue;         // alias déjà connu
          const titre = titreByRef.get(sRef) ?? null;
          const communs = motsDistinctifsCommuns(pc.design, titre);
          const confirme = communs.length >= 1;
          // titre inconnu → on ne peut pas juger : « à vérifier ». Désignations
          // présentes mais sans mot commun → coïncidence, on écarte.
          if (!confirme && titre) continue;
          const key = `${sRef}>${pRef}`;
          const target = confirme ? confMap : verifMap;
          let cand = target.get(key);
          if (!cand) {
            cand = {
              saisieCode: sc.raw, papierCode: pc.raw, occurrences: 0, qteTotale: 0,
              bons: [], papierDesignation: pc.design, saisieTitre: titre, motsCommuns: communs,
              mappingLine: `  '${sc.raw}': '${pc.raw}',`,
            };
            target.set(key, cand);
          }
          cand.occurrences += 1;
          cand.qteTotale += pc.papier;
          cand.bons.push({ be: beNum, qte: pc.papier });
        }
      }
    }

    const tri = (a: Cand, b: Cand) => b.occurrences - a.occurrences || b.qteTotale - a.qteTotale;
    return NextResponse.json({
      confirmes: [...confMap.values()].sort(tri),
      aVerifier: [...verifMap.values()].sort(tri),
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
