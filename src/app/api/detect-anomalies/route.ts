import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { controlerReceptions, normalizeRef, type LigneBeInput, type LigneCmdInput } from '@/lib/reception';
import {
  controlerLignesFacture,
  type LigneFactureInput, type LigneCommandeInput, type CommandeInput, type SaisieInput,
} from '@/lib/facturation';
import { quantitesConcordent, facteurConditionnement } from '@/lib/conditionnement';

export const maxDuration = 60; // détection lourde (beaucoup de données) → éviter le timeout serverless
export const dynamic = 'force-dynamic';

const nbe = (s: string | null | undefined) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function adminSb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(),
  );
}

// PostgREST plafonne chaque requête à 1000 lignes. Plusieurs tables (saisies_cl,
// lignes_commande…) dépassent ce seuil → sans pagination, la détection ne voit
// qu'une partie des données et croit à des oublis/écarts qui n'existent pas.
// selectAll boucle sur .range() jusqu'à tout récupérer. Retourne { data } pour
// rester compatible avec le code aval qui lit `.data`.
async function selectAll<T = Record<string, unknown>>(
  build: () => { range: (a: number, b: number) => PromiseLike<{ data: T[] | null; error: unknown }> },
): Promise<{ data: T[]; error?: unknown }> {
  const pageSize = 1000;
  let from = 0;
  const data: T[] = [];
  for (;;) {
    const { data: rows, error } = await build().range(from, from + pageSize - 1);
    if (error) return { data, error };
    const r = rows ?? [];
    data.push(...r);
    if (r.length < pageSize) break;
    from += pageSize;
  }
  return { data };
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
    selectAll(() => sb.from('lignes_be').select('be_id, reference_article, designation, quantite_receptionnee, hors_systeme, statut_retour')),
    selectAll(() => sb.from('lignes_commande').select('commande_id, reference_article, quantite_commandee, pu_commande, quantite_receptionnee_reelle, quantite_restante_a_recevoir')),
    selectAll(() => sb.from('saisies_cl').select('numero_be, reference_article, quantite_recue, commande_ref')),
    selectAll(() => sb.from('be_receptions').select('id, numero_be')),
    selectAll(() => sb.from('lignes_facture').select('id, facture_id, ligne_no, reference_article, designation, quantite_facturee, pu_facture, montant_ht, numero_be_detecte')),
    selectAll(() => sb.from('factures').select('id')),
    selectAll(() => sb.from('commandes').select('id, numero_commande_interne, bls_centralink')),
    selectAll(() => sb.from('exceptions').select('be_id, facture_id, commande_id, reference_article, type_exception, origine')
      .in('origine', ['réception', 'pointage', 'facturation'])),
    selectAll(() => sb.from('refs_sav').select('reference_article')),
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
  // Cartes NIVEAU COMMANDE (par réf) : papier ② total, commandé ① total, reçu ③ total.
  // Sert à distinguer une SUR-LIVRAISON Colombi (② > commandé) d'un oubli log.
  const papierTotalParRef = new Map<string, number>();
  const desigParRef = new Map<string, string | null>();
  for (const [, refs] of lbByBe) {
    for (const [k, info] of refs) {
      papierTotalParRef.set(k, (papierTotalParRef.get(k) ?? 0) + info.qte);
      if (info.desig && !desigParRef.get(k)) desigParRef.set(k, info.desig);
    }
  }
  const cmdParRef = new Map<string, number>();
  const recuTotParRef = new Map<string, number>();
  for (const l of lignesCmd) {
    const k = normalizeRef(l.reference_article);
    cmdParRef.set(k, (cmdParRef.get(k) ?? 0) + Math.max(0, Number(l.quantite_commandee) || 0));
    recuTotParRef.set(k, (recuTotParRef.get(k) ?? 0) + (Number(l.quantite_receptionnee_reelle) || 0));
  }
  // Réf sur-livrée par Colombi (le papier total dépasse le commandé) → le « manque » côté
  // saisie n'est PAS un oubli log mais un surplus Colombi (traité en §3e, destinataire Colombi).
  const surLivreeParColombi = (k: string) =>
    facteurConditionnement(desigParRef.get(k) ?? null) <= 1 && (papierTotalParRef.get(k) ?? 0) > (cmdParRef.get(k) ?? 0) + 0.001;
  // ── 3c) CONTRÔLE BE PAPIER ② vs SAISIE LOG ③, PAR BE ─────────────────────────
  // Le 1er contrôle : pour chaque BE qu'on a scanné, la log a-t-elle saisi dans
  // Centralink la même chose que notre BL papier ? CL reste la référence ; notre
  // papier est le contrôle indépendant. Un écart = erreur de saisie de la log
  // (oubli, doublon, mauvais n° de BE) → à corriger dans Centralink.
  for (const [beId, refs] of lbByBe) {
    const numBe = beNumById.get(beId) ?? '';
    for (const [k, info] of refs) {
      const papier = info.qte;
      if (papier <= 0) continue;
      const saisie = saisieByBeRef.get(beId + '|' + k) ?? 0;             // ③ saisi sous CE BE
      if (quantitesConcordent(papier, saisie, info.desig)) continue;     // OK : égal ou conditionnement
      // Réf au conditionnement (X500, boîte de N…) : ② et ③ peuvent être en unités
      // différentes (pièces vs boîtes) → écart à vérifier, pas un manque ferme.
      const conditionne = facteurConditionnement(info.desig) > 1;
      const condMotif = `À vérifier (conditionnement « ${info.desig} ») ${k} sur ${numBe} : BL papier ② ${papier} / saisi ③ ${saisie} — écart probablement dû aux unités (pièces/boîtes)`;
      const condAction = `⚠ Conditionnement (« ${info.desig} ») : vérifier les unités (pièces vs boîtes) — ${numBe} : papier ${papier} / saisi ${saisie}.`;
      if (saisie > papier + 0.001) {
        // La log a saisi PLUS que le BL papier → sur-saisie / doublon.
        if (seen.has(key('pointage', beId, k, 'sur-saisie log'))) continue;
        const surplus = saisie - papier;
        const mult = papier > 0 && Number.isInteger(saisie / papier) ? saisie / papier : null;
        nouvelles.push({
          origine: 'pointage', destinataire: 'log', type_exception: 'sur-saisie log',
          be_id: beId, reference_article: k,
          motif: conditionne ? condMotif
            : `Sur-saisie ${k} sur ${numBe} : BL papier ② ${papier} / saisi ③ ${saisie}${mult ? ` (×${mult})` : ''} → ${surplus.toFixed(0)} de trop`,
          valeur_attendue: papier, valeur_obtenue: saisie, ecart: surplus,
          statut_exception: 'ouverte', niveau_priorite: conditionne ? 'faible' : mult && mult >= 2 ? 'haute' : 'moyenne',
          suggestion_action_ia: conditionne ? condAction
            : `Corriger dans Centralink : sur ${numBe}, la log a saisi ${saisie} ${k} alors que le BL papier en montre ${papier} → réduire de ${surplus.toFixed(0)}${mult ? ` (doublon ×${mult})` : ''}.`,
        });
      } else {
        // La log a saisi MOINS que le BL papier → oubli / mal saisi (sous un autre n° de BE).
        if (!refsCommandees.has(k)) continue; // SAV / hors-commande → ③ = 0 normal, pas un oubli
        if (surLivreeParColombi(k)) continue; // sur-livraison Colombi (② > commandé) → §3e, pas un oubli log
        if (seen.has(key('pointage', beId, k, 'oubli log'))) continue;
        const manque = papier - saisie;
        nouvelles.push({
          origine: 'pointage', destinataire: 'log', type_exception: 'oubli log',
          be_id: beId, reference_article: k,
          motif: conditionne ? condMotif
            : `Oubli ${k} sur ${numBe} : BL papier ② ${papier} / saisi ③ ${saisie} → ${manque.toFixed(0)} non saisi(s)`,
          valeur_attendue: papier, valeur_obtenue: saisie, ecart: -manque,
          statut_exception: 'ouverte', niveau_priorite: conditionne ? 'faible' : manque >= 10 ? 'haute' : 'moyenne',
          suggestion_action_ia: conditionne ? condAction
            : `Corriger dans Centralink : sur ${numBe}, la log a saisi ${saisie} ${k} alors que le BL papier en montre ${papier} → saisir les ${manque.toFixed(0)} manquants (oubli, ou saisis sous un mauvais n° de BE).`,
        });
      }
    }
  }

  // Lignes marquées SAV au papier (hors_systeme) + la commande sous laquelle CL les a saisies.
  // Une réf n'est « SAV pure » sur un BE que si TOUTES ses lignes y sont SAV. Si la même réf
  // a aussi une ligne normale sur ce BE (ex. SN0004 = 1000 livrés + 3 en échange SAV), la part
  // SAV est noyée dans la livraison normale → on ne marque PAS la réf SAV, sinon le garde-fou
  // §3f croit que toute la saisie est du SAV.
  const normalBeRef = new Set<string>();
  for (const l of lignesBe) {
    if (!l.hors_systeme) normalBeRef.add(l.be_id + '|' + normalizeRef(l.reference_article));
  }
  const horsSysByBeRef = new Set<string>();
  for (const l of lignesBe) {
    if (!l.hors_systeme) continue;
    const kk = l.be_id + '|' + normalizeRef(l.reference_article);
    if (normalBeRef.has(kk)) continue; // réf aussi livrée normalement sur ce BE → pas une ligne SAV pure
    horsSysByBeRef.add(kk);
  }
  const cmdRefByBeRef = new Map<string, string>();
  for (const s of saisies) {
    const beId = beIdByNum.get(nbe(s.numero_be));
    if (!beId || !s.commande_ref) continue;
    cmdRefByBeRef.set(beId + '|' + normalizeRef(s.reference_article), s.commande_ref);
  }

  // ── 3d) SAISI HORS PAPIER (erreur de n° de BE) → log ─────────────────────────
  // ③ saisi sous un BE scanné mais réf ABSENTE de son BL papier → la log a collé la
  // saisie au mauvais numéro de BE. Souvent la marchandise est bien reçue (juste mal
  // numérotée), donc pas un risque financier — mais une saisie SALE à nettoyer pour
  // garder CL propre. Piste (#12) : les BE où cette réf est sur papier avec un déficit.
  const deficitParRef = new Map<string, { numBe: string; manque: number }[]>();
  for (const [beId, refs] of lbByBe) {
    for (const [k, info] of refs) {
      const sv = saisieByBeRef.get(beId + '|' + k) ?? 0;
      if (info.qte > sv + 0.001) {
        const arr = deficitParRef.get(k) ?? [];
        arr.push({ numBe: beNumById.get(beId) ?? '', manque: info.qte - sv });
        deficitParRef.set(k, arr);
      }
    }
  }
  for (const [kk, sv] of saisieByBeRef) {
    if (sv <= 0.001) continue;
    const sep = kk.indexOf('|');
    const beId = kk.slice(0, sep);
    const k = kk.slice(sep + 1);
    if (lbByBe.get(beId)?.has(k)) continue;             // réf sur le papier → c'est §3c, pas ici
    if (horsSysByBeRef.has(kk)) continue;               // ligne SAV (hors_systeme) → c'est §3f, pas une erreur de n° de BE
    const numBe = beNumById.get(beId);
    if (!numBe) continue;
    if (seen.has(key('pointage', beId, k, 'sur-saisie log'))) continue;
    const pistes = (deficitParRef.get(k) ?? []).filter((p) => p.numBe !== numBe);
    const pistesStr = pistes.length ? pistes.slice(0, 3).map((p) => `${p.numBe} (manque ${p.manque.toFixed(0)})`).join(', ') : null;
    nouvelles.push({
      origine: 'pointage', destinataire: 'log', type_exception: 'sur-saisie log',
      be_id: beId, reference_article: k,
      motif: `Saisi hors papier : ${sv.toFixed(0)} ${k} saisis sous ${numBe}, mais la réf est ABSENTE de son BL papier → probable erreur de n° de BE`,
      valeur_attendue: 0, valeur_obtenue: sv, ecart: sv,
      statut_exception: 'ouverte', niveau_priorite: 'moyenne',
      suggestion_action_ia: `Corriger dans Centralink : ${sv.toFixed(0)} ${k} saisis sous ${numBe} alors qu'absents de son BL papier (mauvais n° de BE).${pistesStr ? ` Cette réf manque sur : ${pistesStr} → re-saisir sous le bon n° de BE.` : ` Vérifier sous quel BL elle a réellement été livrée.`}`,
    });
  }

  // ── 3f) GARDE-FOU SAV : ligne marquée SAV au papier MAIS saisie sous une commande ──
  // Le BL dit SAV (hors_systeme) mais la log l'a quand même saisi sous une commande dans
  // CL → le SAV gonfle le reçu de la commande → risque de payer du SAV. À retirer côté CL.
  for (const [kk, sv] of saisieByBeRef) {
    if (sv <= 0.001) continue;
    if (!horsSysByBeRef.has(kk)) continue;              // pas une ligne SAV → rien
    const sep = kk.indexOf('|');
    const beId = kk.slice(0, sep);
    const k = kk.slice(sep + 1);
    const numBe = beNumById.get(beId);
    if (!numBe) continue;
    if (seen.has(key('pointage', beId, k, 'sur-saisie log'))) continue;
    const cr = cmdRefByBeRef.get(kk) ?? '';
    nouvelles.push({
      origine: 'pointage', destinataire: 'log', type_exception: 'sur-saisie log',
      be_id: beId, reference_article: k,
      motif: `SAV saisi sous commande : ${k} (${sv.toFixed(0)}) sur ${numBe} est marqué SAV au BL papier, mais saisi dans CL sous ${cr || 'une commande'} → gonfle le reçu`,
      valeur_attendue: 0, valeur_obtenue: sv, ecart: sv,
      statut_exception: 'ouverte', niveau_priorite: 'haute',
      suggestion_action_ia: `Corriger dans Centralink : ${k} (${sv.toFixed(0)}) sur ${numBe} est du SAV (BL papier) mais saisi sous ${cr || 'une commande'} → le retirer de la commande (le SAV ne doit pas compter dans le reçu, sinon risque de payer du SAV à Colombi).`,
    });
  }

  // ── 3e) SUR-LIVRAISON COLOMBI VISIBLE AU PAPIER (② total > commandé) → Colombi ──
  // Colombi a livré plus que commandé, mais la log n'a saisi que le commandé (reçu ③ ≤
  // commandé) → le surplus n'apparaît QUE sur notre BL papier → réclamation Colombi (pas
  // un oubli log). Le cas reçu ③ > commandé est déjà capté en §1.
  const beForRef = new Map<string, string>();
  for (const [beId, refs] of lbByBe) for (const k of refs.keys()) if (!beForRef.has(k)) beForRef.set(k, beId);
  for (const [k, P] of papierTotalParRef) {
    const C = cmdParRef.get(k) ?? 0;
    const R = recuTotParRef.get(k) ?? 0;
    if (C <= 0) continue;                          // jamais commandé → hors-commande (§1)
    if (!surLivreeParColombi(k)) continue;         // ② ≤ commandé ou conditionné → pas ici
    if (R > C + 0.001) continue;                   // déjà capté par §1 (reçu > commandé)
    const beId = beForRef.get(k);
    if (!beId) continue;
    if (seen.has(key('réception', beId, k, 'sur-livraison'))) continue;
    const surplus = P - C;
    const manqueSaisie = C - R; // commande non encore saisie par la log (alors que livrée au papier)
    nouvelles.push({
      origine: 'réception', destinataire: 'Colombi', type_exception: 'sur-livraison',
      be_id: beId, reference_article: k,
      motif: `Sur-livraison Colombi ${k} : BL papier ② ${P} > commandé ${C} (reçu CL ③ ${R}) → Colombi a livré ${surplus.toFixed(0)} de plus que commandé`,
      valeur_attendue: C, valeur_obtenue: P, ecart: surplus,
      statut_exception: 'ouverte', niveau_priorite: 'moyenne',
      suggestion_action_ia: `Réclamation Colombi : ${surplus.toFixed(0)} ${k} livrés en plus du commandé (papier ② ${P} / commandé ${C}) → avoir, reprise, ou régularisation par commande acheteuse.`
        + (manqueSaisie > 0.001 ? ` NB côté log : reçu CL ③ ${R} < commandé ${C} → la log doit aussi compléter la saisie du commandé (${manqueSaisie.toFixed(0)} non saisi).` : ''),
    });
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
