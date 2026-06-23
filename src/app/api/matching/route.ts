import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// Supabase admin client (service role) pour bypasser RLS
export const maxDuration = 60;
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

interface MatchCandidate {
  ligne_facture_id: string;
  ligne_be_id: string;
  ligne_commande_id: string | null;
  be_id: string;
  commande_id: string | null;
  score: number;
  mode_match: string;
  quantite_rapprochee: number;
  montant_rapproche: number | null;
}

// Score de confiance : comparaison référence article + désignation + quantité
function scoreMatch(
  refFact: string | null,
  desFact: string | null,
  refBE: string | null,
  desBE: string | null,
  qFact: number,
  qBE: number,
): { score: number; mode: string } {
  const norm = (s: string | null) => (s ?? '').toLowerCase().trim().replace(/\s+/g, ' ');

  const refF = norm(refFact);
  const refB = norm(refBE);
  const desF = norm(desFact);
  const desB = norm(desBE);

  // Correspondance exacte référence
  if (refF && refB && refF === refB) {
    const qScore = qFact === qBE ? 1 : Math.max(0, 1 - Math.abs(qFact - qBE) / Math.max(qFact, qBE));
    return { score: 0.7 + 0.3 * qScore, mode: 'automatique_be_article' };
  }

  // Correspondance partielle référence (l'une contient l'autre)
  if (refF && refB && (refF.includes(refB) || refB.includes(refF))) {
    return { score: 0.55, mode: 'automatique_be_article' };
  }

  // Correspondance désignation
  if (desF && desB) {
    const wordsF = desF.split(' ').filter((w) => w.length > 3);
    const wordsB = desB.split(' ').filter((w) => w.length > 3);
    if (wordsF.length > 0) {
      const overlap = wordsF.filter((w) => desB.includes(w)).length / wordsF.length;
      if (overlap >= 0.6) {
        return { score: 0.4 + 0.3 * overlap, mode: 'automatique_be_designation' };
      }
    }
  }

  return { score: 0, mode: 'manuel' };
}

export async function POST(req: NextRequest) {
  try {
    const { facture_id } = await req.json() as { facture_id?: string };
    if (!facture_id) {
      return NextResponse.json({ error: 'facture_id requis' }, { status: 400 });
    }

    // 1. Charger la facture et ses lignes
    const [{ data: facture }, { data: lignesFacture }] = await Promise.all([
      supabase.from('factures').select('*').eq('id', facture_id).single(),
      supabase.from('lignes_facture').select('*').eq('facture_id', facture_id),
    ]);

    if (!facture) return NextResponse.json({ error: 'Facture introuvable' }, { status: 404 });
    if (!lignesFacture || lignesFacture.length === 0) {
      return NextResponse.json({ message: 'Aucune ligne facture', created: 0 });
    }

    // 2. Trouver les liaisons commandes pour cette facture
    const { data: liaisons } = await supabase
      .from('liaison_facture_commande')
      .select('commande_id')
      .eq('facture_id', facture_id);

    const commandeIds = (liaisons ?? []).map((l: { commande_id: string }) => l.commande_id);

    // 3. Charger les BEs liés aux commandes (ou par fournisseur si pas de liaison)
    let beIds: string[] = [];
    if (commandeIds.length > 0) {
      const { data: liaisonsBC } = await supabase
        .from('liaison_be_commande')
        .select('be_id')
        .in('commande_id', commandeIds);
      beIds = (liaisonsBC ?? []).map((l: { be_id: string }) => l.be_id);
    }

    // Fallback: chercher par fournisseur (6 premiers caractères)
    if (beIds.length === 0 && facture.fournisseur) {
      const prefix = facture.fournisseur.slice(0, 6).toLowerCase();
      const { data: besByFourni } = await supabase
        .from('be_receptions')
        .select('id')
        .ilike('fournisseur', `${prefix}%`);
      beIds = (besByFourni ?? []).map((b: { id: string }) => b.id);
    }

    if (beIds.length === 0) {
      return NextResponse.json({ message: 'Aucun BE trouvé pour le matching', created: 0 });
    }

    // 4. Charger lignes BE et lignes commande
    const [{ data: lignesBE }, { data: lignesCmd }] = await Promise.all([
      supabase.from('lignes_be').select('*').in('be_id', beIds),
      commandeIds.length > 0
        ? supabase.from('lignes_commande').select('*').in('commande_id', commandeIds)
        : Promise.resolve({ data: [] }),
    ]);

    const { data: besList } = await supabase.from('be_receptions').select('id,commande_id').in('id', beIds);
    const beCommandeMap = Object.fromEntries(
      (besList ?? []).map((b: { id: string; commande_id: string | null }) => [b.id, b.commande_id]),
    );

    // 5. Rapprochements existants (pour ne pas dupliquer)
    const { data: existingRaps } = await supabase
      .from('rapprochements')
      .select('ligne_facture_id,ligne_be_id')
      .eq('facture_id', facture_id);

    const existingPairs = new Set(
      (existingRaps ?? []).map((r: { ligne_facture_id: string; ligne_be_id: string }) =>
        `${r.ligne_facture_id}:${r.ligne_be_id}`
      ),
    );

    // 6. Algorithme de matching
    const candidates: MatchCandidate[] = [];

    for (const lf of lignesFacture ?? []) {
      let bestScore = 0.3; // seuil minimum
      let best: MatchCandidate | null = null;

      for (const lb of lignesBE ?? []) {
        const pair = `${lf.id}:${lb.id}`;
        if (existingPairs.has(pair)) continue;

        const { score, mode } = scoreMatch(
          lf.reference_article,
          lf.designation,
          lb.reference_article,
          lb.designation,
          lf.quantite_facturee,
          lb.quantite_receptionnee,
        );

        if (score > bestScore) {
          bestScore = score;
          const cmdId = beCommandeMap[lb.be_id] ?? null;
          const ligneCmd = (lignesCmd ?? []).find(
            (lc: { commande_id: string; reference_article: string | null }) =>
              lc.commande_id === cmdId &&
              lc.reference_article === lf.reference_article,
          ) ?? null;

          best = {
            ligne_facture_id: lf.id,
            ligne_be_id: lb.id,
            ligne_commande_id: ligneCmd?.id ?? null,
            be_id: lb.be_id,
            commande_id: cmdId,
            score: bestScore,
            mode_match: mode,
            quantite_rapprochee: Math.min(lf.quantite_facturee, lb.quantite_receptionnee),
            montant_rapproche:
              lf.pu_facture != null
                ? Math.min(lf.quantite_facturee, lb.quantite_receptionnee) * lf.pu_facture
                : null,
          };
        }
      }

      if (best) candidates.push(best);
    }

    if (candidates.length === 0) {
      return NextResponse.json({ message: 'Aucun rapprochement automatique possible', created: 0 });
    }

    // 7. Insérer les rapprochements
    const { data: inserted, error } = await supabase
      .from('rapprochements')
      .insert(
        candidates.map((c) => ({
          facture_id,
          ligne_facture_id: c.ligne_facture_id,
          be_id: c.be_id,
          ligne_be_id: c.ligne_be_id,
          commande_id: c.commande_id,
          ligne_commande_id: c.ligne_commande_id,
          quantite_rapprochee: c.quantite_rapprochee,
          montant_rapproche: c.montant_rapproche,
          mode_match: c.mode_match,
          score_match: c.score,
          statut_validation: 'proposé',
        })),
      )
      .select('id');

    if (error) throw error;

    // 7b. Détection des écarts de prix
    interface ExceptionRow {
      facture_id: string;
      be_id: string;
      commande_id: string | null;
      ligne_facture_id: string;
      type_exception: string;
      niveau_priorite: string;
      statut_exception: string;
      motif: string;
      valeur_attendue: number;
      valeur_obtenue: number;
      ecart: number;
    }

    const exceptions: ExceptionRow[] = [];

    for (const c of candidates) {
      if (!c.ligne_commande_id) continue;

      const lc = (lignesCmd ?? []).find(
        (row: { id: string }) => row.id === c.ligne_commande_id,
      ) as { id: string; pu_commande: number | null } | undefined;

      const lf = (lignesFacture ?? []).find(
        (row: { id: string }) => row.id === c.ligne_facture_id,
      ) as { id: string; pu_facture: number | null } | undefined;

      if (!lc || !lf) continue;

      const puCmd = lc.pu_commande;
      const puFact = lf.pu_facture;

      if (puCmd == null || puCmd === 0 || puFact == null) continue;

      const ecartPct = ((puFact - puCmd) / puCmd) * 100;
      if (Math.abs(ecartPct) <= 5) continue;

      exceptions.push({
        facture_id,
        be_id: c.be_id,
        commande_id: c.commande_id,
        ligne_facture_id: c.ligne_facture_id,
        type_exception: 'écart_prix',
        niveau_priorite: Math.abs(ecartPct) > 15 ? 'haute' : 'moyenne',
        statut_exception: 'ouverte',
        motif: `Écart prix ${ecartPct >= 0 ? '+' : ''}${ecartPct.toFixed(1)}% : facturé ${puFact.toFixed(2)} € vs commandé ${puCmd.toFixed(2)} €`,
        valeur_attendue: puCmd,
        valeur_obtenue: puFact,
        ecart: Math.abs(ecartPct),
      });
    }

    let exceptionsCreees = 0;
    if (exceptions.length > 0) {
      try {
        const { data: insertedExc, error: excError } = await supabase
          .from('exceptions')
          .insert(exceptions)
          .select('id');
        if (excError) {
          console.error('[matching] Erreur insertion exceptions:', excError);
        } else {
          exceptionsCreees = insertedExc?.length ?? 0;

          // Générer explications IA pour les nouvelles exceptions (fire and forget)
          if (insertedExc && insertedExc.length > 0) {
            void Promise.all(
              (insertedExc as { id: string }[]).map((exc) =>
                fetch(`${process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'}/api/exception-ia`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ exceptionId: exc.id }),
                }).catch(() => null) // Never block matching on AI failure
              )
            );
          }
        }
      } catch (excErr) {
        console.error('[matching] Erreur insertion exceptions:', excErr);
      }
    }

    // 8. Mettre à jour le taux de rapprochement sur la facture
    const { data: totalLignes } = await supabase
      .from('lignes_facture')
      .select('id', { count: 'exact' })
      .eq('facture_id', facture_id);

    const { data: rapprochees } = await supabase
      .from('rapprochements')
      .select('ligne_facture_id')
      .eq('facture_id', facture_id)
      .not('ligne_facture_id', 'is', null);

    const uniqueRapprochees = new Set((rapprochees ?? []).map((r: { ligne_facture_id: string }) => r.ligne_facture_id)).size;
    const total = (totalLignes as unknown as { count?: number } | null)?.count ?? 1;
    const taux = Math.round((uniqueRapprochees / total) * 100);

    await supabase
      .from('factures')
      .update({
        taux_rapprochement: taux,
        statut_facture: taux === 100 ? 'rapprochée' : taux > 0 ? 'partiellement rapprochée' : 'en cours de rapprochement',
      })
      .eq('id', facture_id);

    // 9. Journal
    await supabase.from('journal_activite').insert({
      type_action: 'matching_automatique',
      entite_type: 'facture',
      entite_id: facture_id,
      details_action: JSON.stringify({
        rapprochements_crees: inserted?.length ?? 0,
        taux_resultant: taux,
      }),
    });

    return NextResponse.json({
      created: inserted?.length ?? 0,
      taux_rapprochement: taux,
      exceptions_creees: exceptionsCreees,
    });
  } catch (err) {
    console.error('[matching]', err);
    return NextResponse.json({ error: 'Erreur interne' }, { status: 500 });
  }
}
