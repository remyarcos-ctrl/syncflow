import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const maxDuration = 60;
function adminSb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

async function executeAction(sb: ReturnType<typeof adminSb>, action: Record<string, unknown>): Promise<string> {
  const payload = (action.payload ?? {}) as Record<string, unknown>;

  switch (action.type_action) {
    case 'resoudre_exception':
      await sb.from('exceptions').update({
        statut_exception: 'résolue',
        resolution: 'Résolu automatiquement par Teddy (écart dans la tolérance)',
      }).eq('id', payload.exception_id as string);
      return 'Exception résolue';

    case 'valider_rapprochement': {
      await sb.from('rapprochements').update({ statut_validation: 'validé' }).eq('id', payload.rapprochement_id as string);
      // Mettre à jour statut facture liée
      const { data: rapp } = await sb.from('rapprochements').select('facture_id').eq('id', payload.rapprochement_id as string).single() as { data: { facture_id: string } | null };
      if (rapp?.facture_id) {
        await sb.from('factures').update({ statut_facture: 'rapprochée' }).eq('id', rapp.facture_id);
      }
      return 'Rapprochement validé';
    }

    case 'corriger_prix': {
      const qte = Number(payload.quantite ?? 0);
      const pu = Number(payload.pu_catalogue ?? 0);
      await sb.from('lignes_commande').update({
        pu_commande: pu,
        montant_ht_commande: qte * pu,
      }).eq('id', payload.ligne_id as string);
      // Recalcul total commande
      if (payload.commande_id) {
        const { data: lignes } = await sb.from('lignes_commande').select('montant_ht_commande').eq('commande_id', payload.commande_id as string);
        const total = (lignes ?? []).reduce((s: number, l: Record<string, unknown>) => s + Number(l.montant_ht_commande ?? 0), 0);
        await sb.from('commandes').update({ montant_total_commande: total }).eq('id', payload.commande_id as string);
      }
      return `Prix mis à jour : ${pu} €`;
    }

    case 'relance_be':
      // Relance = action manuelle, on marque juste comme "approuvée" pour que l'utilisateur sache qu'il faut agir
      return `Relance à effectuer pour ${payload.fournisseur} — BE ${payload.numero_be}`;

    default:
      return 'Action exécutée';
  }
}

// GET — liste des actions
export async function GET(req: NextRequest) {
  const sb = adminSb();
  const statut = new URL(req.url).searchParams.get('statut') ?? 'proposée';
  const { data, count } = await sb
    .from('teddy_actions_proposees')
    .select('*', { count: 'exact' })
    .eq('statut', statut)
    .order('created_at', { ascending: false })
    .limit(100);
  return NextResponse.json({ actions: data ?? [], total: count ?? 0 });
}

// PATCH — approuver ou rejeter (une ou plusieurs)
export async function PATCH(req: NextRequest) {
  const sb = adminSb();
  const body = await req.json() as { ids?: string[]; tous?: boolean; action: 'approuver' | 'rejeter' };

  let ids: string[] = body.ids ?? [];
  if (body.tous) {
    const { data } = await sb.from('teddy_actions_proposees').select('id').eq('statut', 'proposée');
    ids = (data ?? []).map((r: Record<string, unknown>) => r.id as string);
  }

  const resultats: { id: string; resultat: string; ok: boolean }[] = [];

  for (const id of ids) {
    if (body.action === 'approuver') {
      const { data: action } = await sb.from('teddy_actions_proposees').select('*').eq('id', id).single() as { data: Record<string, unknown> | null };
      if (!action) { resultats.push({ id, resultat: 'introuvable', ok: false }); continue; }
      try {
        const resultat = await executeAction(sb, action);
        await sb.from('teddy_actions_proposees').update({
          statut: 'approuvée',
          resultat,
          executed_at: new Date().toISOString(),
        }).eq('id', id);
        resultats.push({ id, resultat, ok: true });
      } catch (e) {
        resultats.push({ id, resultat: String(e), ok: false });
      }
    } else {
      await sb.from('teddy_actions_proposees').update({ statut: 'rejetée' }).eq('id', id);
      resultats.push({ id, resultat: 'rejetée', ok: true });
    }
  }

  return NextResponse.json({ ok: true, resultats });
}

// DELETE — nettoyer les actions traitées
export async function DELETE() {
  const sb = adminSb();
  await sb.from('teddy_actions_proposees').delete().in('statut', ['approuvée', 'rejetée']);
  return NextResponse.json({ ok: true });
}
