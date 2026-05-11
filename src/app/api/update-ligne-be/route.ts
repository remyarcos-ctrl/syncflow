import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

function adminSb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
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
  const montantTotal = lignesCmd.reduce(
    (sum, lc) => sum + (lc.quantite_commandee ?? 0) * (lc.pu_commande ?? 0),
    0,
  );
  await sb.from('commandes').update({
    statut_commande: statutCommande,
    montant_total_commande: montantTotal || null,
  }).eq('id', commandeId);
}

// PATCH : corriger la quantité réellement reçue sur une ligne BE
export async function PATCH(req: NextRequest) {
  const { ligneBeId, quantiteReceptionnee } = await req.json() as {
    ligneBeId: string;
    quantiteReceptionnee: number;
  };

  if (!ligneBeId || isNaN(quantiteReceptionnee) || quantiteReceptionnee < 0) {
    return NextResponse.json({ error: 'ligneBeId et quantiteReceptionnee (≥0) requis' }, { status: 400 });
  }

  const sb = adminSb();

  // Lire la ligne pour connaître quantite_facturee, ligne_commande_id et la valeur d'origine
  const { data: ligne, error: errRead } = await sb
    .from('lignes_be')
    .select('quantite_receptionnee, quantite_facturee, quantite_document_be, ligne_commande_id')
    .eq('id', ligneBeId)
    .single();

  if (errRead || !ligne) {
    return NextResponse.json({ error: errRead?.message ?? 'Ligne BE introuvable' }, { status: 404 });
  }

  const qteFact = ligne.quantite_facturee ?? 0;
  const qteResteFacturer = Math.max(0, quantiteReceptionnee - qteFact);

  // quantite_document_be est posée à l'import (valeur extraite par Claude) et reste immuable.
  // Les éditions utilisateur ne touchent que quantite_receptionnee — sinon une saisie erronée
  // figerait la "vérité document" sur une fausse valeur et générerait des écarts fantômes.
  const quantiteDocumentBe = ligne.quantite_document_be ?? ligne.quantite_receptionnee;

  const { error: errUpd } = await sb.from('lignes_be').update({
    quantite_receptionnee: quantiteReceptionnee,
    quantite_restante_a_facturer: qteResteFacturer,
  }).eq('id', ligneBeId);

  if (errUpd) {
    return NextResponse.json({ error: errUpd.message }, { status: 500 });
  }

  await sb.from('journal_activite').insert({
    type_action: 'correction_quantite',
    entite_type: 'ligne_be',
    entite_id: ligneBeId,
    details_action: JSON.stringify({
      ancienne_qte: ligne.quantite_receptionnee,
      nouvelle_qte: quantiteReceptionnee,
      ecart: quantiteDocumentBe - quantiteReceptionnee,
    }),
  });

  // Recalculer les balances de la commande liée si applicable
  if (ligne.ligne_commande_id) {
    const { data: ligneCmd } = await sb
      .from('lignes_commande')
      .select('commande_id')
      .eq('id', ligne.ligne_commande_id)
      .single();

    if (ligneCmd?.commande_id) {
      await recalculateBalances(sb, ligneCmd.commande_id);
    }
  }

  const ecart = quantiteDocumentBe - quantiteReceptionnee;
  return NextResponse.json({ ok: true, ecart, quantiteDocument: quantiteDocumentBe });
}
