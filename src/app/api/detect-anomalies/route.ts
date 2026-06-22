import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { controlerReceptions, normalizeRef, type LigneBeInput, type LigneCmdInput } from '@/lib/reception';
import {
  controlerLignesFacture,
  type LigneFactureInput, type LigneCommandeInput, type CommandeInput, type SaisieInput,
} from '@/lib/facturation';
import { quantitesConcordent, facteurConditionnement } from '@/lib/conditionnement';

const nbe = (s: string | null | undefined) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function adminSb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(),
  );
}

interface NewExc {
  origine: string; destinataire: string; type_exception: string;
  be_id?: string | null; facture_id?: string | null; commande_id?: string | null; reference_article: string;
  motif: string; valeur_attendue: number | null; valeur_obtenue: number | null; ecart: number | null;
  statut_exception: string; niveau_priorite: string;
  suggestion_action_ia?: string | null;
}

// POST : détecte les anomalies des 3 contrôles et les déverse dans `exceptions`
// (idempotent : clé = origine | ancre (be/facture) | réf | type).
export async function POST() {
  const sb = adminSb();

  const [lbeR, lcR, saisR, beR, lfR, factR, cmdR, exR, savR] = await Promise.all([
    sb.from('lignes_be').select('be_id, reference_article, designation, quantite_receptionnee, hors_systeme, statut_retour'),
    sb.from('lignes_commande').select('commande_id, reference_article, quantite_commandee, pu_commande, quantite_receptionnee_reelle, quantite_restante_a_recevoir'),
    sb.from('saisies_cl').select('numero_be, reference_article, quantite_recue, commande_ref'),
    sb.from('be_receptions').select('id, numero_be'),
    sb.from('lignes_facture').select('id, facture_id, ligne_no, reference_article, designation, quantite_facturee, pu_facture, montant_ht, numero_be_detecte'),
    sb.from('factures').select('id'),
    sb.from('commandes').select('id, numero_commande_interne, bls_centralink'),
    sb.from('exceptions').select('be_id, facture_id, commande_id, reference_article, type_exception, origine')
      .in('origine', ['réception', 'pointage', 'facturation']),
    sb.from('refs_sav').select('reference_article'),
  ]);

  // Réfs de pièces détachées SAV (livrées hors commande, hors Centralink).
  const refsSav = new Set((savR.data ?? []).map((r) => normalizeRef(r.reference_article)));

  const lignesBe = lbeR.data ?? [];
  const lignesCmd = (lcR.data ?? []);
  const saisies = saisR.data ?? [];
  const lignesFact = (lfR.data ?? []) as LigneFactureInput[];
  const commandes = (cmdR.data ?? []) as CommandeInput[];

  // clés déjà présentes
  const seen = new Set(
    (exR.data ?? []).map((e) => `${e.origine}|${e.be_id ?? e.facture_id ?? e.commande_id ?? ''}|${normalizeRef(e.reference_article)}|${e.type_exception}`),
  );
  const key = (o: string, ancre: string, ref: string, type: string) => `${o}|${ancre}|${normalizeRef(ref)}|${type}`;
  const nouvelles: NewExc[] = [];

  // ── 1) RÉCEPTION → Colombi ──────────────────────────────────────────────────
  const beForRecep = lignesBe.filter((l) => !l.hors_systeme && (l.quantite_receptionnee ?? 0) > 0) as LigneBeInput[];
  const recep = controlerReceptions(beForRecep, lignesCmd as LigneCmdInput[]);
  // Total reçu sur les BE papier (②) par référence — sert à confirmer ou non une sur-livraison
  // (le papier est le contrôle physique indépendant de la saisie ③ Centralink).
  const totalBeParRef = new Map<string, number>();
  for (const l of beForRecep) {
    const k = normalizeRef(l.reference_article);
    if (!k) continue;
    totalBeParRef.set(k, (totalBeParRef.get(k) ?? 0) + (Number(l.quantite_receptionnee) || 0));
  }
  const TYPE_R: Record<string, string> = { sur_livraison: 'sur-livraison', hors_commande: 'hors-commande' };
  const recepVus = new Set<string>(); // dédoublonnage : 1 anomalie par référence (pas par BE)
  for (const c of recep) {
    if (c.verdict !== 'sur_livraison' && c.verdict !== 'hors_commande') continue;
    const type = TYPE_R[c.verdict];
    const dk = `${type}|${normalizeRef(c.ref)}`;
    if (recepVus.has(dk)) continue;
    recepVus.add(dk);
    if (seen.has(key('réception', c.be_id, c.ref, type))) continue;
    const ecart = c.verdict === 'sur_livraison' ? c.surLivraisonNette : c.qteBe;
    // Pièce détachée SAV connue, livrée hors commande → destinataire SAV (info, pas Colombi).
    const estSav = c.verdict === 'hors_commande' && refsSav.has(normalizeRef(c.ref));
    // Sur-livraison : reçu (③ saisie Centralink) > commandé. Deux causes possibles,
    // INDISCERNABLES côté Centralink (« Attendu négatif » identique). Seul le BE papier (②)
    // tranche : si le papier confirme le surplus → Colombi a vraiment sur-livré ; si le
    // papier ne le montre pas → l'acheteuse a sur-saisi → log. Sans papier importé pour
    // la réf, on ne peut pas conclure → on reste prudent (Colombi) et on signale à vérifier.
    const bePapierRef = c.verdict === 'sur_livraison' ? (totalBeParRef.get(normalizeRef(c.ref)) ?? 0) : 0;
    const papierConfirme = bePapierRef > (c.totalCommande ?? 0) + 0.001;
    const papierContredit = c.verdict === 'sur_livraison' && bePapierRef > 0.001 && !papierConfirme;
    const versLog = papierContredit;
    const destinataire = c.verdict === 'sur_livraison'
      ? (versLog ? 'log' : 'Colombi')
      : (estSav ? 'SAV' : 'Colombi');
    nouvelles.push({
      origine: 'réception', destinataire, type_exception: type, be_id: c.be_id, reference_article: c.ref,
      motif: c.verdict === 'sur_livraison'
        ? versLog
          ? `Sur-saisie probable ${c.ref} : reçu ${c.totalRecu} > commandé ${c.totalCommande} (Attendu négatif) mais le BE papier (${bePapierRef}) ne montre pas ce surplus — à corriger dans Centralink`
          : bePapierRef > 0.001
            ? `Sur-livraison ${c.ref} : commandé ${c.totalCommande} / reçu ${c.totalRecu} → +${ecart}, confirmée par le BE papier (${bePapierRef})`
            : `Sur-livraison ${c.ref} : commandé ${c.totalCommande} / reçu ${c.totalRecu} → +${ecart} — à vérifier (BE papier non importé pour cette réf)`
        : estSav
          ? `Pièce détachée SAV ${c.ref} : reçu ${c.qteBe}, livrée hors commande (hors Centralink)`
          : `Hors commande ${c.ref} : reçu ${c.qteBe}, jamais commandé`,
      valeur_attendue: c.verdict === 'sur_livraison' ? c.totalCommande : null,
      valeur_obtenue: c.verdict === 'sur_livraison' ? c.totalRecu : c.qteBe,
      ecart, statut_exception: 'ouverte', niveau_priorite: estSav ? 'faible' : 'moyenne',
      suggestion_action_ia: c.verdict === 'sur_livraison'
        ? versLog
          ? `Corriger dans Centralink : la saisie ${c.ref} (${c.totalRecu}) dépasse le commandé (${c.totalCommande}) sans que le BE papier (${bePapierRef}) le confirme → ramener le reçu au réel (${bePapierRef || c.totalCommande}).`
          : `Réclamation Colombi : sur-livraison ${c.ref} de +${ecart} (commandé ${c.totalCommande} / reçu ${c.totalRecu})${bePapierRef > 0.001 ? `, confirmée par le BE papier (${bePapierRef})` : ' — vérifier le BL papier'} → réclamer avoir ou passer commande de régularisation.`
        : estSav
          ? `Info SAV : pièce détachée ${c.ref} (${c.qteBe}) livrée hors commande — aucune action Centralink, rattacher au dossier SAV.`
          : `Réclamation Colombi : ${c.ref} (${c.qteBe}) jamais commandé → vérifier le BL et réclamer (livraison non commandée).`,
    });
  }

  // ── (Pointage ②↔③ retiré du centre : un BE couvre plusieurs commandes, donc
  //     la comparaison par n° de BE est structurellement bruitée. Il reste
  //     consultable dans l'écran « Rappro. pointage ».) ──────────────────────────

  // ── 3) FACTURATION → Colombi ────────────────────────────────────────────────
  const factControles = controlerLignesFacture(
    lignesFact, lignesCmd as LigneCommandeInput[], commandes, saisies as SaisieInput[],
  );
  const TYPE_F: Record<string, string> = { sur_facturation: 'surfacturation quantité', ecart_prix: 'écart prix' };
  for (const c of factControles) {
    if (c.verdict !== 'sur_facturation' && c.verdict !== 'ecart_prix') continue;
    const type = TYPE_F[c.verdict];
    const ref = c.lf.reference_article ?? '';
    if (seen.has(key('facturation', c.lf.facture_id, ref, type))) continue;
    nouvelles.push({
      origine: 'facturation', destinataire: 'Colombi', type_exception: type, facture_id: c.lf.facture_id, reference_article: ref,
      motif: `${ref} : ${c.problemes.join(' · ')}`,
      valeur_attendue: c.verdict === 'ecart_prix' ? c.puCommande : c.qteRecue,
      valeur_obtenue: c.verdict === 'ecart_prix' ? c.lf.pu_facture : c.lf.quantite_facturee,
      ecart: c.verdict === 'ecart_prix' ? c.ecartPrixPct : c.ecartQteRecu,
      statut_exception: 'ouverte', niveau_priorite: c.verdict === 'sur_facturation' ? 'haute' : 'moyenne',
      suggestion_action_ia: c.verdict === 'ecart_prix'
        ? `Réclamation Colombi : ${ref} facturé ${c.lf.pu_facture} € au lieu de ${c.puCommande} € commandé (écart ${c.ecartPrixPct}%) → demander avoir / facture rectificative au prix commande.`
        : `Réclamation Colombi : ${ref} facturé ${c.lf.quantite_facturee} pour ${c.qteRecue} reçu (écart ${c.ecartQteRecu}) → demander avoir sur le surplus facturé.`,
    });
  }

  // ── 3b) DOUBLE SAISIE (reçu = multiple exact du commandé) → log ──────────────
  const cmdNum = new Map((cmdR.data ?? []).map((c) => [c.id, c.numero_commande_interne]));
  const dblVus = new Set<string>();
  for (const l of lignesCmd) {
    const q = Number(l.quantite_commandee) || 0;
    const r = Number(l.quantite_receptionnee_reelle) || 0;
    if (q <= 0 || r <= q || !Number.isInteger(r / q) || r / q < 2) continue;
    const ref = l.reference_article ?? '';
    const dk = `${l.commande_id}|${normalizeRef(ref)}`;
    if (dblVus.has(dk)) continue;
    dblVus.add(dk);
    if (seen.has(key('réception', l.commande_id, ref, 'sur-saisie log'))) continue;
    nouvelles.push({
      origine: 'réception', destinataire: 'log', type_exception: 'sur-saisie log',
      commande_id: l.commande_id, reference_article: ref,
      motif: `Double saisie probable ${ref} sur ${cmdNum.get(l.commande_id) ?? ''} : reçu ${r} = ${r / q}× commandé ${q} — à corriger dans Centralink`,
      valeur_attendue: q, valeur_obtenue: r, ecart: r - q,
      statut_exception: 'ouverte', niveau_priorite: 'moyenne',
      suggestion_action_ia: `Corriger dans Centralink : sur ${cmdNum.get(l.commande_id) ?? ''}, la saisie ${ref} (${r}) = ${r / q}× le commandé ${q} → ramener le reçu à ${q} (supprimer la/les saisie(s) en double).`,
    });
  }

  // ── 3c) POINTAGE ②↔③ : la log a-t-elle saisi conformément au BL papier ? ──────
  // Compare, PAR BE, le scan papier (②) à la saisie log (③, section Bon de Livraison).
  // Sur-saisie (③ > ② papier, hors conditionnement) = doublon / erreur de saisie → log.
  const lbByBe = new Map<string, Map<string, { qte: number; desig: string | null }>>();
  for (const l of lignesBe) {
    if (l.hors_systeme) continue;
    const m = lbByBe.get(l.be_id) ?? new Map<string, { qte: number; desig: string | null }>();
    const k = normalizeRef(l.reference_article);
    const cur = m.get(k) ?? { qte: 0, desig: l.designation ?? null };
    cur.qte += Number(l.quantite_receptionnee) || 0;
    if (!cur.desig && l.designation) cur.desig = l.designation;
    m.set(k, cur); lbByBe.set(l.be_id, m);
  }
  const beNumById = new Map((beR.data ?? []).map((b) => [b.id, b.numero_be]));
  const beIdByNum = new Map((beR.data ?? []).map((b) => [nbe(b.numero_be), b.id]));
  const saisieByBeRef = new Map<string, number>();
  for (const s of saisies) {
    const beId = beIdByNum.get(nbe(s.numero_be));
    if (!beId) continue;
    const kk = beId + '|' + normalizeRef(s.reference_article);
    saisieByBeRef.set(kk, (saisieByBeRef.get(kk) ?? 0) + (Number(s.quantite_recue) || 0));
  }
  // Réfs réellement commandées (un oubli de saisie n'a de sens que là-dessus : les pièces SAV
  // et le hors-commande sont hors-Centralink, donc ③ = 0 est NORMAL, pas un oubli).
  const refsCommandees = new Set<string>();
  for (const l of lignesCmd) {
    if ((Number(l.quantite_commandee) || 0) > 0) refsCommandees.add(normalizeRef(l.reference_article));
  }
  // Carte par-référence : pour chaque réf, la liste {BE, papier ②, saisie ③} sur les BE
  // qui ont un scan papier. Désignation par réf (pour le conditionnement).
  const beParRef = new Map<string, Array<{ beId: string; numBe: string; papier: number; saisie: number }>>();
  const desigByRef = new Map<string, string | null>();
  for (const [beId, refs] of lbByBe) {
    for (const [k, info] of refs) {
      if (info.qte <= 0) continue;
      const arr = beParRef.get(k) ?? [];
      arr.push({ beId, numBe: beNumById.get(beId) ?? '', papier: info.qte, saisie: saisieByBeRef.get(beId + '|' + k) ?? 0 });
      beParRef.set(k, arr);
      if (info.desig && !desigByRef.get(k)) desigByRef.set(k, info.desig);
    }
  }

  // ── 3c) BILAN NET PAR RÉFÉRENCE : papier ② vs saisie ③ sur les BE scannés ───────
  // La comparaison par BE seule MASQUE le vrai manque : un oubli sur un BE peut être
  // « compensé » par une sur-saisie sur un autre (mauvais dispatching de la log). On
  // somme donc, PAR RÉFÉRENCE, le papier et la saisie SUR LES SEULS BE qui ont un scan
  // papier : le dispatching s'annule dans la somme, et le NET = vrai manque (oubli) ou
  // vrai surplus (sur-saisie). On nomme en plus le dispatching dans l'action.
  // ⚠ Limite : ne couvre que les BE scannés (les réceptions sans BL importé restent hors champ).
  for (const [k, arr] of beParRef) {
    if (!arr.length) continue;
    const sorted = [...arr].sort((a, b) => (a.numBe < b.numBe ? -1 : a.numBe > b.numBe ? 1 : 0));
    const totalPapier = sorted.reduce((s, x) => s + x.papier, 0);
    const totalSaisie = sorted.reduce((s, x) => s + x.saisie, 0);
    const desig = desigByRef.get(k) ?? null;
    const surplusBEs = sorted.filter((x) => x.saisie > x.papier + 0.001);   // ③ > ② : saisi sous le mauvais BE
    const deficitBEs = sorted.filter((x) => x.papier > x.saisie + 0.001);   // ② > ③ : manque ici
    const dispatch = Math.min(
      surplusBEs.reduce((s, x) => s + (x.saisie - x.papier), 0),
      deficitBEs.reduce((s, x) => s + (x.papier - x.saisie), 0),
    ); // quantité saisie sous un mauvais BE (réutilisable par re-dispatching)

    if (quantitesConcordent(totalPapier, totalSaisie, desig)) {
      // Net OK globalement : pas de manque ni de surplus réel. Mais si un BE est en
      // surplus ET un autre en déficit → mauvais dispatching pur (à re-dispatcher).
      if (!surplusBEs.length || !deficitBEs.length || dispatch <= 0.001) continue;
      const anchor = surplusBEs[0];
      if (seen.has(key('pointage', anchor.beId, k, 'sur-saisie log'))) continue;
      nouvelles.push({
        origine: 'pointage', destinataire: 'log', type_exception: 'sur-saisie log',
        be_id: anchor.beId, reference_article: k,
        motif: `Mauvais dispatching ${k} : total papier ② ${totalPapier} = saisi ③ ${totalSaisie}, mais réparti sous les mauvais BE (${surplusBEs.map((x) => `${x.numBe} +${(x.saisie - x.papier).toFixed(0)}`).join(', ')})`,
        valeur_attendue: totalPapier, valeur_obtenue: totalSaisie, ecart: 0,
        statut_exception: 'ouverte', niveau_priorite: 'moyenne',
        suggestion_action_ia: `Re-dispatcher dans Centralink : ${dispatch.toFixed(0)} ${k} saisis sous le mauvais BE → basculer de ${surplusBEs.map((x) => x.numBe).join(', ')} vers ${deficitBEs.map((x) => `${x.numBe} (manque ${(x.papier - x.saisie).toFixed(0)})`).join(', ')}.`,
      });
      continue;
    }

    // Réf vendue au conditionnement (X500, boîte de N…) : ② et ③ peuvent être dans des
    // unités différentes (pièces vs boîtes) → un écart n'est PAS un manque fiable, juste à vérifier.
    const conditionne = facteurConditionnement(desig) > 1;
    const net = totalPapier - totalSaisie; // > 0 : manque (papier > saisie) ; < 0 : surplus
    if (net > 0.001) {
      // OUBLI NET : sur les BE scannés, le papier dépasse la saisie de `net` (dispatching
      // interne neutralisé). Ces `net` sont reçus selon les BL mais non saisis SUR CES BE
      // dans Centralink (soit pas saisis du tout, soit saisis sous un autre n° de BE).
      if (!refsCommandees.has(k)) continue; // SAV / hors-commande → ③ = 0 normal, pas un oubli
      const anchor = deficitBEs[0] ?? sorted[0];
      if (seen.has(key('pointage', anchor.beId, k, 'oubli log'))) continue;
      const concernes = deficitBEs.map((x) => `${x.numBe} (manque ${(x.papier - x.saisie).toFixed(0)})`).join(', ');
      const action = conditionne
        ? `⚠ Conditionnement (« ${desig} ») : vérifier les unités (pièces vs boîtes) avant de conclure — papier ② ${totalPapier} / saisi ③ ${totalSaisie} sur ${concernes || 'ces BE'}.`
        : dispatch > 0.001
          ? `Re-dispatcher d'abord les ${dispatch.toFixed(0)} ${k} saisis à tort sur ${surplusBEs.map((x) => x.numBe).join(', ')} vers ${deficitBEs.map((x) => x.numBe).join(', ')} ; PUIS il reste ${net.toFixed(0)} ${k} reçus au papier mais non saisis sur ces BE → à saisir (ou vérifier sous quel autre n° de BE ils ont été saisis).`
          : `Saisir dans Centralink les ${net.toFixed(0)} ${k} reçus selon les BL papier mais non saisis sur ces BE${concernes ? ` — ${concernes}` : ''} (ou vérifier sous quel autre n° de BE ils ont été saisis).`;
      nouvelles.push({
        origine: 'pointage', destinataire: 'log', type_exception: 'oubli log',
        be_id: anchor.beId, reference_article: k,
        motif: conditionne
          ? `À vérifier (conditionnement « ${desig} ») ${k} : papier ② ${totalPapier} / saisi ③ ${totalSaisie} sur ${sorted.length} BE scannés — écart probablement dû aux unités (pièces/boîtes)`
          : `Manque ${k} : papier ② ${totalPapier} / saisi ③ ${totalSaisie} sur ${sorted.length} BE scannés → ${net.toFixed(0)} reçu(s) au papier non saisi(s) sur ces BE`,
        valeur_attendue: totalPapier, valeur_obtenue: totalSaisie, ecart: -net,
        statut_exception: 'ouverte', niveau_priorite: conditionne ? 'faible' : net >= 10 ? 'haute' : 'moyenne',
        suggestion_action_ia: action,
      });
    } else {
      // SUR-SAISIE NETTE : `-net` de trop saisis vs le papier (doublon réel, pas dispatching).
      const surplus = -net;
      const anchor = surplusBEs[0] ?? sorted[0];
      if (seen.has(key('pointage', anchor.beId, k, 'sur-saisie log'))) continue;
      const ouTrop = surplusBEs.map((x) => `${x.numBe} (+${(x.saisie - x.papier).toFixed(0)})`).join(', ');
      nouvelles.push({
        origine: 'pointage', destinataire: 'log', type_exception: 'sur-saisie log',
        be_id: anchor.beId, reference_article: k,
        motif: conditionne
          ? `À vérifier (conditionnement « ${desig} ») ${k} : papier ② ${totalPapier} / saisi ③ ${totalSaisie} sur ${sorted.length} BE scannés — écart probablement dû aux unités (pièces/boîtes)`
          : `Sur-saisie nette ${k} : papier ② ${totalPapier} / saisi ③ ${totalSaisie} sur ${sorted.length} BE scannés → ${surplus.toFixed(0)} de trop`,
        valeur_attendue: totalPapier, valeur_obtenue: totalSaisie, ecart: surplus,
        statut_exception: 'ouverte', niveau_priorite: conditionne ? 'faible' : surplus >= 10 ? 'haute' : 'moyenne',
        suggestion_action_ia: conditionne
          ? `⚠ Conditionnement (« ${desig} ») : vérifier les unités (pièces vs boîtes) avant de conclure — papier ② ${totalPapier} / saisi ③ ${totalSaisie}${ouTrop ? ` (${ouTrop})` : ''}.`
          : `Corriger dans Centralink : ${surplus.toFixed(0)} ${k} saisis en trop vs les BL papier${ouTrop ? ` (${ouTrop})` : ''} → réduire la saisie.`,
      });
    }
  }

  // ── 4) NUMÉROS DE BE IMPOSSIBLES (faute de frappe log : mois > 12) → log ─────
  const beVus = new Set<string>();
  for (const c of (cmdR.data ?? [])) {
    let bls: { type?: string; ref?: string }[] = [];
    try { bls = JSON.parse(c.bls_centralink || '[]'); } catch { bls = []; }
    for (const b of bls) {
      if (b.type !== 'be' || !b.ref) continue;
      const m = b.ref.match(/^BE-(\d{2})-(\d{2})-/i);
      if (!m) continue;
      const mois = parseInt(m[2], 10);
      if (mois >= 1 && mois <= 12) continue; // mois valide
      const badN = b.ref.toUpperCase();
      if (beVus.has(badN)) continue;
      beVus.add(badN);
      if (seen.has(key('pointage', c.id, badN, 'numéro BE invalide'))) continue;
      nouvelles.push({
        origine: 'pointage', destinataire: 'log', type_exception: 'numéro BE invalide',
        commande_id: c.id, reference_article: badN,
        motif: `N° de BE impossible « ${badN} » (mois ${m[2]}) — probable faute de frappe à corriger dans Centralink`,
        valeur_attendue: null, valeur_obtenue: null, ecart: null,
        statut_exception: 'ouverte', niveau_priorite: 'faible',
        suggestion_action_ia: `Corriger dans Centralink : le n° de BE « ${badN} » a un mois impossible (${m[2]}) → corriger la saisie du numéro de BE (faute de frappe).`,
      });
    }
  }

  let inserted = 0;
  if (nouvelles.length > 0) {
    const { error, count } = await sb.from('exceptions').insert(nouvelles, { count: 'exact' });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    inserted = count ?? nouvelles.length;
  }

  const parOrigine = (o: string) => nouvelles.filter((n) => n.origine === o).length;
  return NextResponse.json({
    inserees: inserted,
    detail: { réception: parOrigine('réception'), pointage: parOrigine('pointage'), facturation: parOrigine('facturation') },
    deja_presentes: seen.size,
  });
}
