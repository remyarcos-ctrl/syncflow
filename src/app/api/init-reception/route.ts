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

// ── POST : saisir une quantité initiale (historique pré-SyncFlow) ─────────────
// Crée ou réutilise un BE fictif "INIT-[numero_commande]", y insère/met à jour
// une ligne_be liée à la ligne_commande, puis recalcule les balances.

export async function POST(req: NextRequest) {
  const body = await req.json() as { commandeId: string; ligneCommandeId: string; quantite: number };
  const { commandeId, ligneCommandeId } = body;
  const quantite = Number(body.quantite);

  if (!commandeId || !ligneCommandeId || isNaN(quantite) || quantite < 0) {
    return NextResponse.json({ error: 'commandeId, ligneCommandeId et quantite (≥0) requis' }, { status: 400 });
  }

  const sb = adminSb();

  // 1. Commande → numéro pour construire le nom du BE INIT
  const { data: commande } = await sb
    .from('commandes')
    .select('numero_commande_interne, fournisseur')
    .eq('id', commandeId)
    .single();
  if (!commande) return NextResponse.json({ error: 'Commande introuvable' }, { status: 404 });

  const initBeNum = `INIT-${commande.numero_commande_interne}`;

  // 2. Trouver ou créer le BE fictif INIT
  let { data: initBE } = await sb
    .from('be_receptions')
    .select('id')
    .eq('numero_be', initBeNum)
    .maybeSingle();

  if (!initBE) {
    const { data: newBE, error } = await sb.from('be_receptions').insert({
      numero_be: initBeNum,
      fournisseur: commande.fournisseur ?? null,
      date_bl: new Date().toISOString().split('T')[0],
      statut_be: 'reçu',
      commande_id: commandeId,
    }).select('id').single();
    if (error || !newBE) {
      return NextResponse.json({ error: error?.message ?? 'Erreur création BE INIT' }, { status: 500 });
    }
    initBE = newBE;
  }

  // 3. Liaison be_commande (idempotente)
  const { error: liaisonErr } = await sb
    .from('liaison_be_commande')
    .insert({ be_id: initBE.id, commande_id: commandeId });
  if (liaisonErr && !liaisonErr.message.includes('unique') && !liaisonErr.message.includes('duplicate')) {
    return NextResponse.json({ error: liaisonErr.message }, { status: 500 });
  }

  // 4. Ligne BE existante pour cette ligne_commande dans le BE INIT
  const { data: existingLigne } = await sb
    .from('lignes_be')
    .select('id')
    .eq('be_id', initBE.id)
    .eq('ligne_commande_id', ligneCommandeId)
    .maybeSingle();

  if (quantite === 0) {
    // Saisie à 0 → supprimer la ligne init si elle existait
    if (existingLigne) {
      await sb.from('lignes_be').delete().eq('id', existingLigne.id);
    }
  } else if (existingLigne) {
    await sb.from('lignes_be').update({
      quantite_receptionnee: quantite,
      quantite_restante_a_facturer: quantite,
    }).eq('id', existingLigne.id);
  } else {
    const { data: ligneCmd } = await sb
      .from('lignes_commande')
      .select('reference_article, designation')
      .eq('id', ligneCommandeId)
      .single();

    const { data: maxRow } = await sb
      .from('lignes_be')
      .select('ligne_no')
      .eq('be_id', initBE.id)
      .order('ligne_no', { ascending: false })
      .limit(1);
    const nextLigneNo = (maxRow?.[0]?.ligne_no ?? 0) + 1;

    const { error: insErr } = await sb.from('lignes_be').insert({
      be_id: initBE.id,
      ligne_no: nextLigneNo,
      reference_article: ligneCmd?.reference_article ?? null,
      designation: ligneCmd?.designation ?? null,
      quantite_receptionnee: quantite,
      quantite_facturee: 0,
      quantite_restante_a_facturer: quantite,
      ligne_commande_id: ligneCommandeId,
    });
    if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });
  }

  // 5. Recalcul des balances
  await recalculateBalances(sb, commandeId);

  return NextResponse.json({ ok: true });
}
