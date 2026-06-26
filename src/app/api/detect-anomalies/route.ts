import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { controlerReceptions, normalizeRef, type LigneBeInput, type LigneCmdInput } from '@/lib/reception';
import {
  controlerLignesFacture,
  type LigneFactureInput, type LigneCommandeInput, type CommandeInput, type SaisieInput,
} from '@/lib/facturation';
import { quantitesConcordent, facteurConditionnement } from '@/lib/conditionnement';
import { REF_ALIAS_CL_TO_COLOMBI } from '@/lib/ref-alias';

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

  const [lbeR, lcR, saisR, beR, lfR, factR, cmdR, exR, savR, resR] = await Promise.all([
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
    selectAll(() => sb.from('reception_resolution').select('be_id, reference_article, classement')),
  ]);

  // Réfs de pièces détachées SAV (livrées hors commande, hors Centralink).
  const refsSav = new Set((savR.data ?? []).map((r) => normalizeRef(r.reference_article)));
  // Classements de la fiche Contrôle réception qui valent SAV pour CETTE ligne (be|réf) :
  // permet de traiter une livraison comme SAV/échange SANS mettre un produit vendable
  // dans refs_sav (qui masquerait toute future erreur Colombi sur ce produit).
  const SAV_CLASSEMENTS = new Set(['pièce détachée', 'SAV / échange']);
  const savClasse = new Set(
    (resR.data ?? [])
      .filter((r) => SAV_CLASSEMENTS.has(String(r.classement)))
      .map((r) => `${r.be_id}|${normalizeRef(r.reference_article)}`),
  );

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
  // Total reçu sur les BE papier () par référence — sert à confirmer ou non une sur-livraison
  // (le papier est le contrôle physique indépendant de la saisie Centralink).
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
    // Pièce détachée SAV connue (refs_sav) OU ligne classée SAV/échange sur la fiche →
    // destinataire SAV (info, pas Colombi).
    const estSav = c.verdict === 'hors_commande'
      && (refsSav.has(normalizeRef(c.ref)) || savClasse.has(`${c.be_id}|${normalizeRef(c.ref)}`));
    // Sur-livraison : reçu (saisie Centralink) > commandé. Deux causes possibles,
    // INDISCERNABLES côté Centralink (« Attendu négatif » identique). Seul le BE papier ()
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

  // ── (Pointage↔retiré du centre : un BE couvre plusieurs commandes, donc
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

  // ── 3c) POINTAGE↔: la log a-t-elle saisi conformément au BL papier ? ──────
  // Compare, PAR BE, le scan papier () à la saisie log (, section Bon de Livraison).
  // Sur-saisie (> papier, hors conditionnement) = doublon / erreur de saisie → log.
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
  // Alias de réf CL → réf Colombi (codes vrac : billes/plombs saisis sous un code
  // générique dans Centralink). On traduit la saisie vers le code du BL papier
  // avant de comparer ; l'écart d'unité (boîte/pièce) est ensuite géré par le
  // conditionnement (quantitesConcordent). Voir src/lib/ref-alias.ts.
  const aliasNorm = new Map(
    Object.entries(REF_ALIAS_CL_TO_COLOMBI).map(([cl, col]) => [normalizeRef(cl), normalizeRef(col)]),
  );
  const aliasRef = (raw: string | null | undefined) => {
    const k = normalizeRef(raw);
    return aliasNorm.get(k) ?? k;
  };
  const saisieByBeRef = new Map<string, number>();
  for (const s of saisies) {
    const beId = beIdByNum.get(nbe(s.numero_be));
    if (!beId) continue;
    const kk = beId + '|' + aliasRef(s.reference_article);
    saisieByBeRef.set(kk, (saisieByBeRef.get(kk) ?? 0) + (Number(s.quantite_recue) || 0));
  }
  // Saisies sous un n° de BE INVALIDE (mois > 12, ex. BE-25-13-… au lieu de -12-) :
  // erreur de saisie du n° de BE par la log. La marchandise est bien saisie, juste mal
  // numérotée → ça crée un manque "fantôme" sur le vrai BE. Quand une réf en manque est
  // saisie ainsi, ce n'est PAS un surplus mais une erreur log à recoller (cas 1/2).
  const beInvalide = (n: string | null | undefined): boolean => {
    const m = String(n ?? '').toUpperCase().match(/BE-?\d{2}-?(\d{2})-?\d+/);
    if (!m) return false;
    const mois = Number(m[1]);
    return mois > 12 || mois === 0;
  };
  const saisieSousBeInvalide = new Map<string, { numBe: string; qte: number }[]>();
  for (const s of saisies) {
    if (!beInvalide(s.numero_be)) continue;
    const k = aliasRef(s.reference_article);
    const arr = saisieSousBeInvalide.get(k) ?? [];
    arr.push({ numBe: s.numero_be, qte: Number(s.quantite_recue) || 0 });
    saisieSousBeInvalide.set(k, arr);
  }
  // Quantité saisie HORS PAPIER par réf (orpheline : saisie sous un BE connu où la réf
  // n'est même pas au papier = mauvais n° de BE). Si cette quantité couvre le manque d'un
  // BE, c'est une PURE mauvaise répartition (la marchandise est saisie ailleurs), pas un
  // surplus. C'est local (la qté orpheline explique le manque), pas faussé par le total global.
  const qteSaisieHorsPapierParRef = new Map<string, number>();
  for (const [kk, sv] of saisieByBeRef) {
    if (sv <= 0.001) continue;
    const beId = kk.slice(0, kk.indexOf('|'));
    const k = kk.slice(kk.indexOf('|') + 1);
    // Orpheline = saisie sous un BE dont on A LE PAPIER (lignes_be) mais où la réf n'y figure
    // pas. Si on n'a pas scanné le papier de ce BE, on ne peut RIEN conclure → on n'en tient pas
    // compte (sinon toutes les saisies des vieux BE non scannés passeraient pour des erreurs).
    if (lbByBe.has(beId) && !lbByBe.get(beId)!.has(k)) {
      qteSaisieHorsPapierParRef.set(k, (qteSaisieHorsPapierParRef.get(k) ?? 0) + sv);
    }
  }
  // Réfs réellement commandées (un oubli de saisie n'a de sens que là-dessus : les pièces SAV
  // et le hors-commande sont hors-Centralink, donc = 0 est NORMAL, pas un oubli).
  const refsCommandees = new Set<string>();
  for (const l of lignesCmd) {
    if ((Number(l.quantite_commandee) || 0) > 0) refsCommandees.add(aliasRef(l.reference_article));
  }
  // (Les cartes papier/commandé/reçu par réf de l'ancien §3e ont été retirées avec lui :
  //  le surplus se mesure désormais vs en §1, pas vs commandé.)
  // ── 3c) CONTRÔLE BE PAPIER vs SAISIE LOG, PAR BE ─────────────────────────
  // Le 1er contrôle : pour chaque BE qu'on a scanné, la log a-t-elle saisi dans
  // Centralink la même chose que notre BL papier ? CL reste la référence ; notre
  // papier est le contrôle indépendant. Un écart = erreur de saisie de la log
  // (oubli, doublon, mauvais n° de BE) → à corriger dans Centralink.
  for (const [beId, refs] of lbByBe) {
    const numBe = beNumById.get(beId) ?? '';
    for (const [k, info] of refs) {
      const papier = info.qte;
      if (papier <= 0) continue;
      const saisie = saisieByBeRef.get(beId + '|' + k) ?? 0;             // saisi sous CE BE
      if (quantitesConcordent(papier, saisie, info.desig)) continue;     // OK : égal ou conditionnement
      // Réf au conditionnement (X500, boîte de N…) : et peuvent être en unités
      // différentes (pièces vs boîtes) → écart à vérifier, pas un manque ferme.
      const conditionne = facteurConditionnement(info.desig) > 1;
      const condMotif = `À vérifier (conditionnement « ${info.desig} ») ${k} sur ${numBe} : BL papier ${papier} / saisi ${saisie} — écart probablement dû aux unités (pièces/boîtes)`;
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
            : `Sur-saisie ${k} sur ${numBe} : BL papier ${papier} / saisi ${saisie}${mult ? ` (×${mult})` : ''} → ${surplus.toFixed(0)} de trop`,
          valeur_attendue: papier, valeur_obtenue: saisie, ecart: surplus,
          statut_exception: 'ouverte', niveau_priorite: conditionne ? 'faible' : mult && mult >= 2 ? 'haute' : 'moyenne',
          suggestion_action_ia: conditionne ? condAction
            : `Corriger dans Centralink : sur ${numBe}, la log a saisi ${saisie} ${k} alors que le BL papier en montre ${papier} → réduire de ${surplus.toFixed(0)}${mult ? ` (doublon ×${mult})` : ''}.`,
        });
      } else {
        // Le BL papier montre PLUS que la saisie sous ce BE = SURPLUS COLOMBI.
        // Colombi sur-livre en routine ; la log ne saisit que ce qui a une commande ouverte,
        // l'excédent reste non saisi sous ce BE → il remonte ici. Ce n'est PAS un oubli log :
        // c'est à arbitrer côté achat (garder → commande de régule AVEC le n° de BE dans la
        // colonne Bon de Livraison → la saisie se rangera sous ce BE et le manque se fermera
        // tout seul au prochain sync ; retour → avoir ; ou ajout au stock). Le rare vrai oubli =
        // le cas où il n'y a PAS de surplus (à la revue), donc on reste prudent : destinataire Colombi.
        const manque = papier - saisie;
        // CAS LOG (cas 1/2) : réf en manque MAIS saisie sous un n° de BE INVALIDE (mois > 12)
        // → erreur de n° de BE de la log (la marchandise est saisie, juste mal numérotée),
        // PAS un surplus → à recoller sur le bon BE.
        const sousInvalide = saisieSousBeInvalide.get(k);
        if (sousInvalide && sousInvalide.length) {
          if (seen.has(key('pointage', beId, k, 'sur-saisie log'))) continue;
          const besInv = [...new Set(sousInvalide.map((x) => x.numBe))].slice(0, 3).join(', ');
          nouvelles.push({
            origine: 'pointage', destinataire: 'log', type_exception: 'sur-saisie log',
            be_id: beId, reference_article: k,
            motif: `${k} manque sur ${numBe} (${papier} / ${saisie}) mais saisi sous un n° de BE INVALIDE (${besInv}, mois > 12) → erreur de n° de BE`,
            valeur_attendue: papier, valeur_obtenue: saisie, ecart: -manque,
            statut_exception: 'ouverte', niveau_priorite: 'haute',
            suggestion_action_ia: `Corriger dans Centralink : ${k} a été saisi sous un n° de BE invalide (${besInv}) → recoller sur le bon n° de BE ${numBe}. Le manque se fermera ensuite.`,
          });
          continue;
        }
        // CAS LOG (mauvais n° de BE / lumping, BE valide) : si la réf est saisie HORS PAPIER sur
        // un autre BE (orpheline) pour une quantité qui COUVRE ce manque → PURE mauvaise
        // répartition (la marchandise est saisie ailleurs, juste mal numérotée), pas un surplus.
        // Déjà signalé côté « saisi hors papier » (§3d, avec la piste) → on ne le re-marque pas.
        // Si l'orpheline NE couvre PAS tout le manque (cas mixte type KI0001), le reste tombe en
        // surplus ci-dessous → on a bien les deux : recoller (log) + surplus net (Colombi).
        if ((qteSaisieHorsPapierParRef.get(k) ?? 0) >= manque - 0.001) continue;
        if (!refsCommandees.has(k)) continue; // SAV / hors-commande → = 0 normal, traité ailleurs
        // Réf conditionnée (boîte/lot) : l'écart papier/saisi vient probablement des unités
        // (pièces vs boîtes) → on le signale PAR BE, à vérifier (pas un vrai manque).
        if (conditionne) {
          if (seen.has(key('pointage', beId, k, 'sur-livraison'))) continue;
          nouvelles.push({
            origine: 'pointage', destinataire: 'à vérifier', type_exception: 'sur-livraison',
            be_id: beId, reference_article: k,
            motif: condMotif, valeur_attendue: papier, valeur_obtenue: saisie, ecart: -manque,
            statut_exception: 'ouverte', niveau_priorite: 'faible', suggestion_action_ia: condAction,
          });
          continue;
        }
        // Sinon : l'écart papier > saisie PAR BE est trop bruité — la marchandise peut
        // être saisie sous un AUTRE n° de BL (mauvais n° de BE). On ne tranche donc PAS par
        // BE : le vrai écart déclaration/comptage est jugé PAR RÉFÉRENCE (total vs total)
        // en §3c-bis, où la saisie sous d'autres BL est prise en compte.
      }
    }
  }

  // ── 3c-bis) SURPLUS COLOMBI EXACT, PAR RÉFÉRENCE ──────────────────────────────
  // Surplus = ce que Colombi a livré sur NOS bons scannés (papier) mais qui n'est ni saisi
  // sur ces bons, ni refusé (avoir), ni gardé via régule. On compare le papier aux SAISIES
  // SUR LES BONS QU'ON A SCANNÉS (fiable, même période) — pas au reçu commande toutes périodes,
  // qui mélange l'historique d'avant nos scans et fausse le calcul.
  //   surplus = papier − saisi(sur nos bons) − avoir − régule
  // Ex. 19803 : 29 − 14 − 8 − 3 = 4.
  const papierTotParRef = new Map<string, { qte: number; desig: string | null; beId: string }>();
  for (const [beId, refs] of lbByBe) {
    for (const [k, info] of refs) {
      const cur = papierTotParRef.get(k) ?? { qte: 0, desig: info.desig, beId };
      cur.qte += info.qte;
      if (!cur.desig && info.desig) cur.desig = info.desig;
      papierTotParRef.set(k, cur);
    }
  }
  // Saisi sur les bons SCANNÉS, par réf (saisieByBeRef est déjà restreint à nos BE).
  const saisieScanParRef = new Map<string, number>();
  for (const [kk, v] of saisieByBeRef) {
    const k = kk.slice(kk.indexOf('|') + 1);
    saisieScanParRef.set(k, (saisieScanParRef.get(k) ?? 0) + v);
  }
  // Commandes de RÉGULE (note « Surplus … » dans bls_centralink) = surplus gardé régularisé.
  const reguleCmdIds = new Set(
    (cmdR.data ?? []).filter((c) => /surplus/i.test(c.bls_centralink || '')).map((c) => c.id),
  );
  const avoirParRef = new Map<string, number>();
  const reguleParRef = new Map<string, number>();
  const resteParRef = new Map<string, number>();
  for (const l of lignesCmd) {
    const k = aliasRef(l.reference_article);
    const r = Number(l.quantite_receptionnee_reelle) || 0;
    if (r < 0) avoirParRef.set(k, (avoirParRef.get(k) ?? 0) + (-r));                          // refusé/rendu
    if (reguleCmdIds.has(l.commande_id)) reguleParRef.set(k, (reguleParRef.get(k) ?? 0) + Math.max(0, r)); // gardé
    resteParRef.set(k, (resteParRef.get(k) ?? 0) + Math.max(0, Number(l.quantite_restante_a_recevoir) || 0));
  }
  for (const [k, info] of papierTotParRef) {
    if (!refsCommandees.has(k)) continue;                  // hors-commande/SAV → traité ailleurs
    if (facteurConditionnement(info.desig) > 1) continue;  // conditionnement → géré par BE (unités)
    const pap = info.qte;
    const saisi = saisieScanParRef.get(k) ?? 0;            // saisi sur NOS bons
    const avoir = avoirParRef.get(k) ?? 0;                 // refusé/rendu
    const regule = reguleParRef.get(k) ?? 0;               // gardé via régule
    const surplus = pap - saisi - avoir - regule;
    if (surplus < 0.5) continue;                           // tout saisi / rendu / régularisé → rien
    if (seen.has(key('pointage', info.beId, k, 'sur-livraison'))) continue;
    const reste = resteParRef.get(k) ?? 0;                 // commande encore ouverte ?
    const detail = `papier ${pap}, saisi ${saisi}${avoir > 0 ? `, avoir ${avoir}` : ''}${regule > 0 ? `, régule ${regule}` : ''}`;
    if (reste < 0.001) {
      nouvelles.push({
        origine: 'pointage', destinataire: 'Colombi', type_exception: 'sur-livraison',
        be_id: info.beId, reference_article: k,
        motif: `Surplus Colombi ${k} : ${surplus.toFixed(0)} livré(s) en plus, ni saisi(s) ni rendu(s) ni régularisé(s) (${detail}, commandes soldées) → à régulariser`,
        valeur_attendue: pap, valeur_obtenue: saisi, ecart: -surplus,
        statut_exception: 'ouverte', niveau_priorite: 'moyenne',
        suggestion_action_ia: `Surplus Colombi à régulariser : ${k} → ${surplus.toFixed(0)} en trop (${detail}), commandes déjà soldées. Action : commande de régule (avec le n° de BL) pour les encaisser, ou réclamer/retourner à Colombi.`,
      });
    } else {
      nouvelles.push({
        origine: 'pointage', destinataire: 'à vérifier', type_exception: 'sur-livraison',
        be_id: info.beId, reference_article: k,
        motif: `Écart papier vs saisi ${k} : ${surplus.toFixed(0)} d'écart (${detail}), commande encore ouverte → à vérifier (saisie en cours, bon non scanné, ou sur-déclaration)`,
        valeur_attendue: pap, valeur_obtenue: saisi, ecart: -surplus,
        statut_exception: 'ouverte', niveau_priorite: 'moyenne',
        suggestion_action_ia: `À vérifier ${k} : ${detail}, commande encore ouverte. Soit la log n'a pas fini de saisir, soit la marchandise est saisie sous un bon qu'on n'a pas scanné, soit Colombi a sur-déclaré → vérifier.`,
      });
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
    cmdRefByBeRef.set(beId + '|' + aliasRef(s.reference_article), s.commande_ref);
  }

  // ── 3d) SAISI HORS PAPIER (erreur de n° de BE) → log ─────────────────────────
  // saisi sous un BE scanné mais réf ABSENTE de son BL papier → la log a collé la
  // saisie au mauvais numéro de BE. Souvent la marchandise est bien reçue (juste mal
  // numérotée), donc pas un risque financier — mais une saisie SALE à nettoyer pour
  // garder CL propre. Piste (#12) : les BE où cette réf est sur papier avec un déficit.
  //
  // ⚠ On ne lève l'anomalie QUE si la réf a un déficit papier ailleurs (= une vraie
  // cible de re-dispatch). Sans déficit nulle part, l'« orphelin » est un faux signal :
  // c'est typiquement un article à FORT DÉBIT (pistolets/revolvers en gros lots) que la
  // log booke sous plein de n° de BE — dont on ne scanne qu'une fraction des BL. Rien à
  // recoller → pas une erreur récupérable, on n'invente pas l'anomalie.
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
    if (!pistes.length) continue;                       // orphelin sans déficit ailleurs → faux signal (fort débit), on n'invente pas
    const pistesStr = pistes.slice(0, 3).map((p) => `${p.numBe} (manque ${p.manque.toFixed(0)})`).join(', ');
    nouvelles.push({
      origine: 'pointage', destinataire: 'log', type_exception: 'sur-saisie log',
      be_id: beId, reference_article: k,
      motif: `Saisi hors papier : ${sv.toFixed(0)} ${k} saisis sous ${numBe}, mais la réf est ABSENTE de son BL papier → probable erreur de n° de BE (manque ailleurs : ${pistesStr})`,
      valeur_attendue: 0, valeur_obtenue: sv, ecart: sv,
      statut_exception: 'ouverte', niveau_priorite: 'moyenne',
      suggestion_action_ia: `Corriger dans Centralink : ${sv.toFixed(0)} ${k} saisis sous ${numBe} alors qu'absents de son BL papier (mauvais n° de BE). Cette réf manque sur : ${pistesStr} → re-saisir sous le bon n° de BE.`,
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

  // ── 3e) RETIRÉ ────────────────────────────────────────────────────────────────
  // L'ancien §3e comparait le PAPIER au COMMANDÉ et déclarait « Sur-livraison
  // Colombi ». C'était FAUX par construction : est la DÉCLARATION de Colombi, pas
  // le reçu ; et le commandé traîne régules/avoirs sur un périmètre différent → faux
  // surplus (cf. 19803 : 29 vs commandé 28 = faux +1, alors que reçu net 20 =
  // commandé net 20). Le VRAI surplus se mesure RÉCEPTION > COMMANDÉ, déjà fait
  // par §1 (controlerReceptions, surLivraisonNette nette des avoirs). L'écart papier vs saisi
  // (déclaration vs comptage) est traité en §3c, sans présumer le coupable.

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

  // ── CROISEMENT STOCK (bar-code) sur les SUR-LIVRAISONS Colombi ───────────────
  // Une « sur-livraison Colombi » suppose que Colombi a livré en trop → réclamation.
  // MAIS la log rentre souvent la marchandise en stock au BAR-CODE (scan direct, sans
  // réception de commande) : le surplus est alors un FAUX surplus déjà absorbé en
  // stock, PAS une réclamation. Le stock CL temps réel (fiche produit) fait foi.
  //
  // GARDE-FOU (réponse à « et s'il y a quand même une erreur malgré le bar-code ? ») :
  // le bar-code n'est PAS un blanc-seing. On vérifie que le surplus est réellement
  // absorbé : stock CL réel + ventes 90j doivent COUVRIR le surplus.
  //   • couvre   → faux surplus probable → priorité faible, destinataire « à vérifier »,
  //                 sort de la file de réclamation Colombi (mais reste VISIBLE, jamais supprimé).
  //   • NE COUVRE PAS → le bar-code n'explique pas tout → on GARDE l'anomalie « à vérifier »
  //                 (vraie sur-livraison Colombi ou erreur de saisie) → elle reste remontée.
  // Rien n'est gommé en silence : on requalifie + on justifie. (cf écran Stock Centralink)
  const stkR = await selectAll(() =>
    sb.from('stocks_cl').select('reference_article, stock_cl, floating, has_barcode, ventes, stock_source'));
  const stockByRef = new Map<string, { stock_cl: number | null; floating: number | null; has_barcode: boolean | null; ventes: number | null; stock_source: string | null }>();
  for (const s of (stkR.data ?? [])) {
    const k = normalizeRef(s.reference_article as string);
    if (k && !stockByRef.has(k)) stockByRef.set(k, s as never);
  }
  for (const n of nouvelles) {
    if (n.type_exception !== 'sur-livraison' || n.destinataire !== 'Colombi') continue;
    const st = stockByRef.get(normalizeRef(n.reference_article));
    if (!st || st.has_barcode !== true) continue;            // pas de bar-code connu → inchangé
    const S = Math.abs(Number(n.ecart) || 0);                // ampleur du surplus
    const stock = Number(st.stock_cl) || 0;
    const ventes = Number(st.ventes) || 0;
    const src = st.stock_source === 'fiche' ? 'temps réel' : 'snapshot minuit';
    const couvre = stock + ventes >= S - 0.001;
    if (couvre) {
      n.destinataire = 'à vérifier';
      n.niveau_priorite = 'faible';
      n.motif += ` · 🏷 BAR-CODE : stock CL ${src} ${stock} + ventes 90j ${ventes} couvrent le surplus ${S.toFixed(0)} → faux surplus probable (déjà en stock), PAS une réclamation Colombi`;
      n.suggestion_action_ia = `Faux surplus probable : ${n.reference_article} est géré au bar-code (rentré en stock sans réception) et le stock CL ${src} (${stock}) + ventes 90j (${ventes}) couvrent les ${S.toFixed(0)} en trop → NE PAS réclamer à Colombi ; vérifier au stock (écran Stock Centralink).`;
    } else {
      n.destinataire = 'à vérifier';
      n.niveau_priorite = 'moyenne';
      n.motif += ` · ⚠ BAR-CODE mais stock CL ${src} (${stock}) + ventes 90j (${ventes}) NE couvrent PAS le surplus ${S.toFixed(0)} → à vérifier : vraie sur-livraison Colombi ou erreur de saisie`;
      n.suggestion_action_ia = `À vérifier ${n.reference_article} : géré au bar-code, mais le stock CL ${src} (${stock}) + ventes 90j (${ventes}) n'expliquent pas les ${S.toFixed(0)} en trop → contrôler physiquement (vraie sur-livraison Colombi à réclamer, ou erreur de saisie à corriger).`;
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
