import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

function adminSb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

// ── Normalisation refs (CONTEXT.md) ──────────────────────────────────────────

const normalizeRef = (s: string | null | undefined) =>
  String(s ?? '').toUpperCase().replace(/O/g, '0').replace(/[^A-Z0-9]/g, '');

function refsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  if (a.toLowerCase().trim() === b.toLowerCase().trim()) return true;
  if (normalizeRef(a) === normalizeRef(b)) return true;
  const ap = a.split('/'); const bp = b.split('/');
  if (ap.length > 1 && normalizeRef(ap[ap.length - 1]) === normalizeRef(b)) return true;
  if (bp.length > 1 && normalizeRef(bp[bp.length - 1]) === normalizeRef(a)) return true;
  return false;
}

// ── recalculateBalances (CONTEXT.md) ─────────────────────────────────────────
// quantite_receptionnee_reelle = SUM(lignes_be.quantite_receptionnee WHERE ligne_commande_id = lc.id)
// Pas de fallback par référence — causerait des doubles comptes.

async function recalculateBalances(sb: ReturnType<typeof adminSb>, commandeId: string) {
  const { data: lignesCmd } = await sb
    .from('lignes_commande')
    .select('*')
    .eq('commande_id', commandeId);
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

function computeStatutCommande(statuts: string[]): string {
  if (!statuts.length) return 'ouverte';
  if (statuts.every(s => s === 'soldée')) return 'soldée';
  if (statuts.every(s => s === 'non reçue')) return 'ouverte';
  if (statuts.some(s => s === 'sur-facturée' || s === 'sur-réceptionné')) return 'en anomalie';
  if (statuts.every(s => ['soldée', 'partiellement facturée', 'reçue'].includes(s))) return 'réceptionnée';
  if (statuts.some(s => ['reçue', 'partiellement reçue', 'partiellement facturée', 'soldée'].includes(s))) return 'partiellement réceptionnée';
  return 'ouverte';
}

// ── POST : lier un BE à une commande ─────────────────────────────────────────

export async function POST(req: NextRequest) {
  const { beId, commandeId } = await req.json() as { beId: string; commandeId: string };
  if (!beId || !commandeId) {
    return NextResponse.json({ error: 'beId et commandeId requis' }, { status: 400 });
  }

  const sb = adminSb();

  // 1. Liaison many-to-many (idempotente)
  const { error: liaisonErr } = await sb
    .from('liaison_be_commande')
    .insert({ be_id: beId, commande_id: commandeId });
  if (liaisonErr && !liaisonErr.message.includes('unique') && !liaisonErr.message.includes('duplicate')) {
    return NextResponse.json({ error: liaisonErr.message }, { status: 500 });
  }

  // 2. Mettre à jour commande_id sur be_receptions si c'est la première liaison
  const { data: toutesLiaisons } = await sb
    .from('liaison_be_commande')
    .select('id')
    .eq('be_id', beId);
  if ((toutesLiaisons?.length ?? 0) === 1) {
    await sb.from('be_receptions').update({ commande_id: commandeId }).eq('id', beId);
  }

  // 3. Lignes BE libres (non encore attribuées à une commande)
  const { data: lignesBeLibres, error: errLignesBe } = await sb
    .from('lignes_be')
    .select('*')
    .eq('be_id', beId)
    .is('ligne_commande_id', null)
    .eq('hors_systeme', false);

  if (errLignesBe) {
    return NextResponse.json({ error: errLignesBe.message }, { status: 500 });
  }

  // 4. Lignes commande de la commande cible
  const { data: lignesCmd, error: errLignesCmd } = await sb
    .from('lignes_commande')
    .select('*')
    .eq('commande_id', commandeId);

  if (errLignesCmd) {
    return NextResponse.json({ error: errLignesCmd.message }, { status: 500 });
  }

  let lignesAttribuees = 0;
  const diag: { ref_be: string | null; raison: string; qte?: number }[] = [];

  console.log(`\n[link-be-commande] POST beId=${beId} commandeId=${commandeId}`);
  console.log(`  → lignes BE libres trouvées : ${lignesBeLibres?.length ?? 0}`);
  for (const l of lignesBeLibres ?? []) {
    console.log(`      BE ligne  ref="${l.reference_article}"  qte_recue=${l.quantite_receptionnee}  ligne_commande_id=${l.ligne_commande_id}`);
  }
  console.log(`  → lignes commande trouvées : ${lignesCmd?.length ?? 0}`);
  for (const l of lignesCmd ?? []) {
    console.log(`      CMD ligne ref="${l.reference_article}"  qte_cmd=${l.quantite_commandee}  qte_recu_reelle=${l.quantite_receptionnee_reelle}`);
  }

  if (lignesBeLibres?.length && lignesCmd?.length) {
    const dejaPourCmd = new Map<string, number>();

    const { data: maxRow } = await sb
      .from('lignes_be')
      .select('ligne_no')
      .eq('be_id', beId)
      .order('ligne_no', { ascending: false })
      .limit(1);
    let nextLigneNo = (maxRow?.[0]?.ligne_no ?? 0) + 1;

    // Agréger les lignes BE libres par référence article (plusieurs lignes même réf → une seule)
    const groupesBeLibres: {
      refBe: string | null;
      designation: string | null;
      qteTotale: number;
      qteTotaleDocument: number; // somme des quantités documentées (doc_be ?? qty)
      ligneIds: string[];
    }[] = [];
    for (const lb of lignesBeLibres ?? []) {
      const existing = groupesBeLibres.find(g =>
        g.refBe != null && lb.reference_article != null &&
        refsMatch(g.refBe, lb.reference_article)
      );
      if (existing) {
        existing.qteTotale += lb.quantite_receptionnee ?? 0;
        existing.qteTotaleDocument += lb.quantite_document_be ?? lb.quantite_receptionnee ?? 0;
        existing.ligneIds.push(lb.id);
      } else {
        groupesBeLibres.push({
          refBe: lb.reference_article,
          designation: lb.designation,
          qteTotale: lb.quantite_receptionnee ?? 0,
          qteTotaleDocument: lb.quantite_document_be ?? lb.quantite_receptionnee ?? 0,
          ligneIds: [lb.id],
        });
      }
    }
    console.log(`  → ${groupesBeLibres.length} groupe(s) après agrégation par référence`);

    for (const groupe of groupesBeLibres) {
      // Représentant : on garde la première ligne BE, on supprime les doublons
      const [premiereLigneId, ...doublonIds] = groupe.ligneIds;
      const lb = lignesBeLibres!.find(l => l.id === premiereLigneId)!;
      // Supprimer les lignes doublons agrégées et mettre à jour la quantité sur la ligne conservée
      if (doublonIds.length) {
        await sb.from('lignes_be').delete().in('id', doublonIds);
        const hasEcart = groupe.qteTotaleDocument !== groupe.qteTotale;
        await sb.from('lignes_be').update({
          quantite_receptionnee: groupe.qteTotale,
          quantite_restante_a_facturer: groupe.qteTotale,
          quantite_document_be: hasEcart ? groupe.qteTotaleDocument : null,
        }).eq('id', premiereLigneId);
        console.log(`  🔀 ref_be="${groupe.refBe}" fusion de ${doublonIds.length + 1} lignes → qte_totale=${groupe.qteTotale}`);
      }

      const lignesCmdMatch = lignesCmd.filter(lc => refsMatch(lb.reference_article, lc.reference_article));
      if (!lignesCmdMatch.length) {
        console.log(`  ✗ ref_be="${lb.reference_article}" → aucun match`);
        diag.push({ ref_be: lb.reference_article, raison: 'aucune_ref_cmd_correspondante' });
        continue;
      }

      let qteDispo = groupe.qteTotale;
      if (qteDispo <= 0) {
        diag.push({ ref_be: lb.reference_article, raison: 'qte_be_zero' });
        continue;
      }

      // Trier les lignes cmd par capacité restante décroissante (on remplit d'abord celles qui ont le plus de place)
      const lignesCmdSorted = [...lignesCmdMatch].sort((a, b) => {
        const ra = Math.max(0, (a.quantite_commandee ?? 0) - (a.quantite_receptionnee_reelle ?? 0) - (dejaPourCmd.get(a.id) ?? 0));
        const rb = Math.max(0, (b.quantite_commandee ?? 0) - (b.quantite_receptionnee_reelle ?? 0) - (dejaPourCmd.get(b.id) ?? 0));
        return rb - ra;
      });

      const totalCapacite = lignesCmdSorted.reduce((s, lc) =>
        s + Math.max(0, (lc.quantite_commandee ?? 0) - (lc.quantite_receptionnee_reelle ?? 0) - (dejaPourCmd.get(lc.id) ?? 0)), 0);

      // Si toutes les lignes cmd sont déjà pleines → laisser libre, ne pas forcer de sur-réception
      if (totalCapacite <= 0) {
        console.log(`  ⚠ ref_be="${groupe.refBe}" commande déjà complète → ligne laissée libre`);
        diag.push({ ref_be: groupe.refBe, raison: 'capacite_atteinte_ligne_libre', qte: qteDispo });
        continue;
      }

      // Distribuer la quantité BE sur les lignes cmd en cascade
      let originalLineUpdated = false;

      for (const ligneCmd of lignesCmdSorted) {
        if (qteDispo <= 0) break;
        const qteReste = Math.max(0, (ligneCmd.quantite_commandee ?? 0) - (ligneCmd.quantite_receptionnee_reelle ?? 0) - (dejaPourCmd.get(ligneCmd.id) ?? 0));
        if (qteReste <= 0) continue;

        const qteAttribuer = Math.min(qteDispo, qteReste);

        if (!originalLineUpdated) {
          // Première attribution : mettre à jour la ligne BE d'origine
          // Utiliser groupe.qteTotale (valeur réelle en base après fusion) et non lb.quantite_receptionnee (stale)
          const updates: Record<string, unknown> = { ligne_commande_id: ligneCmd.id };
          if (qteAttribuer < groupe.qteTotale) {
            updates.quantite_receptionnee = qteAttribuer;
            updates.quantite_restante_a_facturer = qteAttribuer;
          }
          const { error } = await sb.from('lignes_be').update(updates).eq('id', lb.id);
          if (error) { diag.push({ ref_be: lb.reference_article, raison: `erreur_update: ${error.message}` }); break; }
          originalLineUpdated = true;
          console.log(`  ✓ ref_be="${lb.reference_article}" → cmd ligne ${ligneCmd.id} qte=${qteAttribuer}`);
        } else {
          // Attributions suivantes : créer de nouvelles lignes BE
          const { error } = await sb.from('lignes_be').insert({
            be_id: beId,
            ligne_no: nextLigneNo++,
            reference_article: lb.reference_article,
            designation: lb.designation,
            quantite_receptionnee: qteAttribuer,
            quantite_facturee: 0,
            quantite_restante_a_facturer: qteAttribuer,
            ligne_commande_id: ligneCmd.id,
          });
          if (error) { diag.push({ ref_be: lb.reference_article, raison: `erreur_insert: ${error.message}` }); break; }
          console.log(`  ✓ ref_be="${lb.reference_article}" → cmd ligne ${ligneCmd.id} qte=${qteAttribuer} (nouvelle ligne BE)`);
        }

        dejaPourCmd.set(ligneCmd.id, (dejaPourCmd.get(ligneCmd.id) ?? 0) + qteAttribuer);
        qteDispo -= qteAttribuer;
        lignesAttribuees++;
        diag.push({ ref_be: lb.reference_article, raison: 'attribue', qte: qteAttribuer });
      }

      // S'il reste de la quantité après avoir rempli toutes les lignes cmd → ligne libre
      if (qteDispo > 0 && originalLineUpdated) {
        await sb.from('lignes_be').insert({
          be_id: beId,
          ligne_no: nextLigneNo++,
          reference_article: lb.reference_article,
          designation: lb.designation,
          quantite_receptionnee: qteDispo,
          quantite_facturee: 0,
          quantite_restante_a_facturer: qteDispo,
          ligne_commande_id: null,
        });
        diag.push({ ref_be: lb.reference_article, raison: `reste_libre: ${qteDispo}`, qte: qteDispo });
        console.log(`  ✓ ref_be="${lb.reference_article}" reste libre qte=${qteDispo}`);
      }
    }
  } else {
    if (!lignesBeLibres?.length) {
      console.log(`  ⚠ aucune ligne BE libre trouvée (toutes déjà attribuées ou BE sans lignes)`);
      diag.push({ ref_be: null, raison: 'aucune_ligne_be_libre' });
    }
    if (!lignesCmd?.length) {
      console.log(`  ⚠ aucune ligne commande trouvée pour commandeId=${commandeId}`);
      diag.push({ ref_be: null, raison: 'aucune_ligne_commande_trouvee' });
    }
  }
  console.log(`  → TOTAL lignes attribuées : ${lignesAttribuees}\n`);

  // 5. Recalcul des balances commande (quantite_receptionnee_reelle, statuts…)
  await recalculateBalances(sb, commandeId);

  await sb.from('journal_activite').insert({
    type_action: 'liaison_be_commande',
    entite_type: 'be_reception',
    entite_id: beId,
    details_action: JSON.stringify({ commande_id: commandeId, lignes_attribuees: lignesAttribuees }),
  });

  return NextResponse.json({ ok: true, lignes_attribuees: lignesAttribuees, diag });
}

// ── DELETE : délier un BE d'une commande ─────────────────────────────────────

export async function DELETE(req: NextRequest) {
  const { liaisonId, beId, commandeId } = await req.json() as {
    liaisonId: string;
    beId: string;
    commandeId: string;
  };
  if (!liaisonId || !beId || !commandeId) {
    return NextResponse.json({ error: 'liaisonId, beId et commandeId requis' }, { status: 400 });
  }

  const sb = adminSb();

  // Récupérer les IDs des lignes commande de cette commande
  const { data: lignesCmd } = await sb
    .from('lignes_commande')
    .select('id')
    .eq('commande_id', commandeId);
  const lignesCmdIds = (lignesCmd ?? []).map(l => l.id);

  // Libérer UNIQUEMENT les lignes_be de CE be attribuées à CETTE commande (CONTEXT.md §Délier)
  // Les lignes attribuées aux autres commandes sont intouchables.
  if (lignesCmdIds.length) {
    await sb.from('lignes_be')
      .update({ ligne_commande_id: null })
      .eq('be_id', beId)
      .in('ligne_commande_id', lignesCmdIds);
  }

  // Supprimer la liaison
  await sb.from('liaison_be_commande').delete().eq('id', liaisonId);

  // Recalculer les balances
  await recalculateBalances(sb, commandeId);

  return NextResponse.json({ ok: true });
}
