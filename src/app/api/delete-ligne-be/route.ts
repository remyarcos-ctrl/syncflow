import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

function adminSb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(),
  );
}

function computeStatutCommande(statuts: string[]): string {
  if (!statuts.length) return 'ouverte';
  if (statuts.every(s => s === 'soldée')) return 'soldée';
  if (statuts.every(s => s === 'non reçue')) return 'ouverte';
  if (statuts.some(s => s === 'sur-facturée' || s === 'sur-réceptionné')) return 'en anomalie';
  if (statuts.every(s => ['soldée', 'partiellement facturée', 'reçue'].includes(s))) return 'réceptionnée';
  if (statuts.some(s => ['reçue', 'partiellement reçue', 'partiellement facturée', 'soldée'].includes(s))) return 'partiellement réceptionnée';
  return 'ouverte';
}

async function recalculateBalances(sb: ReturnType<typeof adminSb>, commandeId: string) {
  const { data: lignesCmd } = await sb.from('lignes_commande').select('*').eq('commande_id', commandeId);
  if (!lignesCmd?.length) return;

  const lignesCmdIds = lignesCmd.map(l => l.id);
  const { data: lignesBe } = await sb
    .from('lignes_be')
    .select('ligne_commande_id, quantite_receptionnee, quantite_facturee')
    .in('ligne_commande_id', lignesCmdIds);

  const beByCmd = new Map<string, { qteRecu: number; qteFact: number }>();
  for (const lb of lignesBe ?? []) {
    if (!lb.ligne_commande_id) continue;
    const cur = beByCmd.get(lb.ligne_commande_id) ?? { qteRecu: 0, qteFact: 0 };
    cur.qteRecu += lb.quantite_receptionnee ?? 0;
    cur.qteFact += lb.quantite_facturee ?? 0;
    beByCmd.set(lb.ligne_commande_id, cur);
  }

  const statutsLignes: string[] = [];

  for (const lc of lignesCmd) {
    const { qteRecu, qteFact } = beByCmd.get(lc.id) ?? { qteRecu: 0, qteFact: 0 };
    const qteCmd = lc.quantite_commandee ?? 0;
    const qteResteRecv = Math.max(0, qteCmd - qteRecu);
    const qteResteFact = Math.max(0, qteRecu - qteFact);

    let statut: string;
    if (qteRecu === 0) statut = 'non reçue';
    else if (qteRecu > qteCmd) statut = 'sur-réceptionné';
    else if (qteFact > qteCmd) statut = 'sur-facturée';
    else if (qteFact >= qteCmd) statut = 'soldée';
    else if (qteFact > 0 && qteRecu >= qteCmd) statut = 'partiellement facturée';
    else if (qteRecu >= qteCmd) statut = 'reçue';
    else statut = 'partiellement reçue';

    statutsLignes.push(statut);

    await sb.from('lignes_commande').update({
      quantite_receptionnee_reelle: qteRecu,
      quantite_facturee: qteFact,
      quantite_restante_a_recevoir: qteResteRecv,
      quantite_restante_a_facturer: qteResteFact,
      statut_ligne: statut,
    }).eq('id', lc.id);
  }

  const statutCommande = computeStatutCommande(statutsLignes);
  await sb.from('commandes').update({ statut_commande: statutCommande }).eq('id', commandeId);
}

// Supprime une ligne_be et recalcule les balances de la commande liée si applicable.
// Utile pour nettoyer les lignes fantômes créées par un parse erroné.
export async function POST(req: NextRequest) {
  const { ligneBeId } = await req.json() as { ligneBeId: string };
  if (!ligneBeId) return NextResponse.json({ error: 'ligneBeId requis' }, { status: 400 });

  const sb = adminSb();

  // Récupérer la ligne pour connaître la commande potentiellement liée et tracer dans le journal
  const { data: ligne, error: errRead } = await sb
    .from('lignes_be')
    .select('id, be_id, reference_article, designation, quantite_receptionnee, ligne_commande_id, quantite_facturee')
    .eq('id', ligneBeId)
    .single();
  if (errRead || !ligne) {
    return NextResponse.json({ error: errRead?.message ?? 'Ligne BE introuvable' }, { status: 404 });
  }

  // Garde-fou : si la ligne a déjà été facturée, on refuse — il faut d'abord annuler le rapprochement.
  if ((ligne.quantite_facturee ?? 0) > 0) {
    return NextResponse.json({
      error: 'Cette ligne est déjà facturée. Annule d\'abord le rapprochement de la facture avant de la supprimer.',
    }, { status: 400 });
  }

  let commandeId: string | null = null;
  if (ligne.ligne_commande_id) {
    const { data: lc } = await sb.from('lignes_commande').select('commande_id').eq('id', ligne.ligne_commande_id).single();
    commandeId = lc?.commande_id ?? null;
  }

  const { error: errDel } = await sb.from('lignes_be').delete().eq('id', ligneBeId);
  if (errDel) {
    return NextResponse.json({ error: errDel.message }, { status: 500 });
  }

  if (commandeId) {
    await recalculateBalances(sb, commandeId);
  }

  await sb.from('journal_activite').insert({
    type_action: 'suppression_ligne_be',
    entite_type: 'be_reception',
    entite_id: ligne.be_id,
    details_action: JSON.stringify({
      reference: ligne.reference_article,
      designation: ligne.designation,
      quantite: ligne.quantite_receptionnee,
      etait_attribuee: !!ligne.ligne_commande_id,
    }),
  });

  return NextResponse.json({ ok: true });
}
