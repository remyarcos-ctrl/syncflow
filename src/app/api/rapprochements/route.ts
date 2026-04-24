import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import type { StatutFacture, StatutValidation } from '@/types';

// Supabase admin client (service role) pour bypasser RLS
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

/** Recalcule le taux de rapprochement (lignes validées uniquement) et le statut_facture.
 *  Retourne { taux, statut_facture } */
async function recalculerTaux(factureId: string): Promise<{ taux: number; statut_facture: StatutFacture }> {
  // Total lignes facture
  const { count: totalCount } = await supabase
    .from('lignes_facture')
    .select('id', { count: 'exact', head: true })
    .eq('facture_id', factureId);

  const total = totalCount ?? 0;
  if (total === 0) {
    return { taux: 0, statut_facture: 'importée' };
  }

  // Lignes distinctes ayant au moins 1 rapprochement validé
  const { data: rapValidees } = await supabase
    .from('rapprochements')
    .select('ligne_facture_id')
    .eq('facture_id', factureId)
    .eq('statut_validation', 'validé')
    .not('ligne_facture_id', 'is', null);

  const distinctLignes = new Set(
    (rapValidees ?? []).map((r: { ligne_facture_id: string | null }) => r.ligne_facture_id)
  ).size;

  const taux = Math.round((distinctLignes / total) * 100);
  const statut_facture: StatutFacture =
    taux === 100 ? 'rapprochée' : taux > 0 ? 'partiellement rapprochée' : 'importée';

  return { taux, statut_facture };
}

// ── PATCH — Valider / Rejeter / Mettre à revoir un rapprochement ──────────────

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json() as {
      rapId?: string;
      statut?: StatutValidation;
      factureId?: string;
    };

    const { rapId, statut, factureId } = body;

    if (!rapId || !statut || !factureId) {
      return NextResponse.json(
        { error: 'rapId, statut et factureId sont requis' },
        { status: 400 },
      );
    }

    const statutsValides: StatutValidation[] = ['validé', 'rejeté', 'à revoir'];
    if (!statutsValides.includes(statut)) {
      return NextResponse.json({ error: 'statut invalide' }, { status: 400 });
    }

    // Récupérer le rapprochement actuel pour connaître son statut et la ligne BE
    const { data: currentRap } = await supabase
      .from('rapprochements')
      .select('statut_validation, ligne_be_id, quantite_rapprochee')
      .eq('id', rapId)
      .single();

    // 1. Mettre à jour le statut du rapprochement
    const updatePayload: Record<string, unknown> = { statut_validation: statut };
    if (statut === 'validé') {
      updatePayload.date_validation = new Date().toISOString();
    }

    const { error: updateError } = await supabase
      .from('rapprochements')
      .update(updatePayload)
      .eq('id', rapId);

    if (updateError) throw updateError;

    // Mettre à jour quantite_restante_a_facturer et quantite_facturee sur lignes_be
    if (currentRap?.ligne_be_id && (currentRap.quantite_rapprochee ?? 0) > 0) {
      const qty = currentRap.quantite_rapprochee as number;
      const ligneBEId = currentRap.ligne_be_id as string;
      const wasValid = currentRap.statut_validation === 'validé';
      const becomesValid = statut === 'validé';

      if (!wasValid && becomesValid) {
        // Validation : diminuer restante, augmenter facturée
        const { data: lb } = await supabase.from('lignes_be')
          .select('quantite_restante_a_facturer, quantite_facturee').eq('id', ligneBEId).single();
        if (lb) {
          await supabase.from('lignes_be').update({
            quantite_restante_a_facturer: Math.max(0, (lb.quantite_restante_a_facturer ?? 0) - qty),
            quantite_facturee: (lb.quantite_facturee ?? 0) + qty,
          }).eq('id', ligneBEId);
        }
      } else if (wasValid && !becomesValid) {
        // Rejet/révision : restaurer restante, diminuer facturée
        const { data: lb } = await supabase.from('lignes_be')
          .select('quantite_restante_a_facturer, quantite_facturee').eq('id', ligneBEId).single();
        if (lb) {
          await supabase.from('lignes_be').update({
            quantite_restante_a_facturer: (lb.quantite_restante_a_facturer ?? 0) + qty,
            quantite_facturee: Math.max(0, (lb.quantite_facturee ?? 0) - qty),
          }).eq('id', ligneBEId);
        }
      }
    }

    // 2. Recalculer taux et statut facture
    const { taux, statut_facture } = await recalculerTaux(factureId);

    // 3. Mettre à jour la facture
    const { error: factureError } = await supabase
      .from('factures')
      .update({ taux_rapprochement: taux, statut_facture })
      .eq('id', factureId);

    if (factureError) throw factureError;

    // Si la facture est soldée à 100%, vérifier si les commandes liées le sont aussi
    if (taux === 100) {
      try {
        const { data: liaisons } = await supabase
          .from('liaison_facture_commande').select('commande_id').eq('facture_id', factureId);
        const cmdIds = (liaisons ?? []).map((l: { commande_id: string }) => l.commande_id).filter(Boolean);

        for (const cmdId of cmdIds) {
          // Toutes les factures liées à cette commande
          const { data: factLiaisons } = await supabase
            .from('liaison_facture_commande').select('facture_id').eq('commande_id', cmdId);
          const factIds = (factLiaisons ?? []).map((l: { facture_id: string }) => l.facture_id).filter(Boolean);
          if (!factIds.length) continue;

          const { data: facts } = await supabase
            .from('factures').select('taux_rapprochement').in('id', factIds);
          const toutesRapprochees = (facts ?? []).every(
            (f: { taux_rapprochement: number | null }) => (f.taux_rapprochement ?? 0) === 100
          );

          if (toutesRapprochees) {
            await supabase.from('commandes').update({ statut_commande: 'soldée' }).eq('id', cmdId);
          }
        }
      } catch (e) {
        console.error('[rapprochements] statut_commande update error:', e);
        // Ne bloque pas la réponse
      }
    }

    // 4. Journal
    await supabase.from('journal_activite').insert({
      type_action: 'validation_rapprochement',
      entite_type: 'facture',
      entite_id: factureId,
      details_action: JSON.stringify({ statut, taux_resultant: taux }),
    });

    return NextResponse.json({ ok: true, taux_rapprochement: taux, statut_facture });
  } catch (err) {
    console.error('[rapprochements PATCH]', err);
    return NextResponse.json({ error: 'Erreur interne' }, { status: 500 });
  }
}

// ── POST — Créer un rapprochement manuel ──────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      factureId?: string;
      ligneFacId?: string;
      beId?: string;
      ligneBEId?: string;
      quantiteRapprochee?: number;
      montantRapproche?: number | null;
    };

    const { factureId, ligneFacId, beId, ligneBEId, quantiteRapprochee, montantRapproche } = body;

    if (!factureId || !ligneFacId || !beId || !ligneBEId || quantiteRapprochee == null) {
      return NextResponse.json(
        { error: 'factureId, ligneFacId, beId, ligneBEId et quantiteRapprochee sont requis' },
        { status: 400 },
      );
    }

    // 1. Insérer le rapprochement manuel
    const { error: insertError } = await supabase.from('rapprochements').insert({
      facture_id: factureId,
      ligne_facture_id: ligneFacId,
      be_id: beId,
      ligne_be_id: ligneBEId,
      quantite_rapprochee: quantiteRapprochee,
      montant_rapproche: montantRapproche ?? null,
      mode_match: 'manuel',
      score_match: 100,
      statut_validation: 'proposé',
    });

    if (insertError) throw insertError;

    // 2. Recalculer taux et statut facture
    const { taux, statut_facture } = await recalculerTaux(factureId);

    // 3. Mettre à jour la facture
    const { error: factureError } = await supabase
      .from('factures')
      .update({ taux_rapprochement: taux, statut_facture })
      .eq('id', factureId);

    if (factureError) throw factureError;

    // 4. Journal
    await supabase.from('journal_activite').insert({
      type_action: 'rapprochement_manuel',
      entite_type: 'facture',
      entite_id: factureId,
      details_action: JSON.stringify({ ligne_facture_id: ligneFacId, be_id: beId, taux_resultant: taux }),
    });

    return NextResponse.json({ ok: true, taux_rapprochement: taux });
  } catch (err) {
    console.error('[rapprochements POST]', err);
    return NextResponse.json({ error: 'Erreur interne' }, { status: 500 });
  }
}
