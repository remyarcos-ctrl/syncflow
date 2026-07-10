import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { controlerReceptions, normalizeRef, type LigneBeInput, type LigneCmdInput } from '@/lib/reception';
import {
  controlerLignesFacture,
  type LigneFactureInput, type LigneCommandeInput, type CommandeInput, type SaisieInput,
} from '@/lib/facturation';
import { quantitesConcordent, facteurConditionnement } from '@/lib/conditionnement';
import { aliasRef } from '@/lib/pointage';

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
  numero_be_libre?: string | null;   // n° de BE en texte (bon importé OU bon CL jamais importé) → affichage + tri
  motif: string; valeur_attendue: number | null; valeur_obtenue: number | null; ecart: number | null;
  statut_exception: string; niveau_priorite: string;
  suggestion_action_ia?: string | null;
  commentaire?: string | null;
}

// POST : détecte les anomalies des 3 contrôles et les déverse dans `exceptions`
// (idempotent : clé = origine | ancre (be/facture) | réf | type).
export async function POST(req: Request) {
  const sb = adminSb();

  // Mode « rafraîchir » (?refresh=1) : avant de re-détecter, on purge les anomalies
  // VIERGES (ouvertes, sans aucun travail humain : ni commentaire, ni assignation, ni
  // résolution). Effet : une anomalie corrigée à la source (la log corrige Centralink,
  // Colombi fait un avoir…) ne se reproduit pas à la détection → elle disparaît toute
  // seule. SÛR : les vierges encore valides sont immédiatement recréées par la détection
  // ci-dessous ; les anomalies travaillées ne sont JAMAIS touchées.
  let purgees = 0;
  if (new URL(req.url).searchParams.get('refresh')) {
    const { data: del } = await sb.from('exceptions').delete()
      .eq('statut_exception', 'ouverte')
      .is('commentaire', null).is('resolu_par', null).is('assigne_a', null)
      .is('echeance', null).is('date_resolution', null)
      .select('id');
    purgees = del?.length ?? 0;
  }

  const [lbeR, lcR, saisR, beR, lfR, factR, cmdR, exR, savR, resR] = await Promise.all([
    selectAll(() => sb.from('lignes_be').select('be_id, reference_article, designation, quantite_receptionnee, hors_systeme, statut_retour, ref_cde_client')),
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
  // Classements « disposés » sur la fiche Contrôle réception = la ligne a été TRAITÉE par
  // l'humain → l'anomalie de réception correspondante naît directement « résolue » (elle
  // quitte la liste active du Centre). Connecte les 2 écrans : classer = résoudre.
  // (Les classements « … Colombi » restent OUVERTS : ce sont des actions confirmées à mener.)
  const DISPOSE_CLASSEMENTS = new Set(['pièce détachée', 'SAV / échange', 'surplus vu DH (gardé)', 'commandé autrement', 'résolu']);
  const disposeClasse = new Map<string, string>(
    (resR.data ?? [])
      .filter((r) => DISPOSE_CLASSEMENTS.has(String(r.classement)))
      .map((r) => [`${r.be_id}|${normalizeRef(r.reference_article)}`, String(r.classement)]),
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

  // Alias de réf CL ↔ Colombi + préfixe n° de commande (« 1404/16928A » = 16928A) :
  // DÉFINITION UNIQUE partagée avec le moteur écran (lib/pointage.aliasRef) pour que le
  // Centre et les écrans jugent avec la même clé. S'applique aux saisies ET au papier
  // (les codes se mélangent sur les BL : LTLPK03/490041 imprimés côté papier aussi).
  // Couples « commande|réf » déjà signalés comme sur-réception (§3b/§3c/§3g) → évite que
  // l'angle mort « réception non détaillée » (§3h) ne fasse doublon sur le même écart.
  const cmdRefSurSaisie = new Set<string>();

  // ── 1) RÉCEPTION → Colombi ──────────────────────────────────────────────────
  const beForRecep = lignesBe.filter((l) => !l.hors_systeme && (l.quantite_receptionnee ?? 0) > 0) as LigneBeInput[];
  const recep = controlerReceptions(beForRecep, lignesCmd as LigneCmdInput[]);
  // Total reçu sur les BE papier () par référence — sert à confirmer ou non une sur-livraison
  // (le papier est le contrôle physique indépendant de la saisie Centralink).
  const totalBeParRef = new Map<string, number>();
  for (const l of beForRecep) {
    const k = aliasRef(l.reference_article); // papier aliasé aussi (codes mélangés sur les BL)
    if (!k) continue;
    totalBeParRef.set(k, (totalBeParRef.get(k) ?? 0) + (Number(l.quantite_receptionnee) || 0));
  }
  // M2M + outil lancé en cours de route : une réf peut avoir des saisies sur des bons
  // JAMAIS scannés (historiques). Son papier ② est alors STRUCTURELLEMENT incomplet →
  // « le papier ne montre pas ce surplus » ne prouve plus une sur-saisie de la log.
  const scannedBeNums = new Set((beR.data ?? []).map((b) => nbe(b.numero_be)));
  const refsPapierPartiel = new Set<string>();
  for (const s of saisies) {
    if (!scannedBeNums.has(nbe(s.numero_be))) refsPapierPartiel.add(aliasRef(s.reference_article));
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
    const bePapierRef = c.verdict === 'sur_livraison' ? (totalBeParRef.get(aliasRef(c.ref)) ?? 0) : 0;
    const papierConfirme = bePapierRef > (c.totalCommande ?? 0) + 0.001;
    const papierContredit = c.verdict === 'sur_livraison' && bePapierRef > 0.001 && !papierConfirme;
    // Papier incomplet (saisies sur des bons non scannés) → le silence du papier ne prouve
    // RIEN : on n'accuse pas la log, on reste « Colombi / à vérifier » avec mention.
    const papierPartiel = refsPapierPartiel.has(aliasRef(c.ref));
    const versLog = papierContredit && !papierPartiel;
    const destinataire = c.verdict === 'sur_livraison'
      ? (versLog ? 'log' : 'Colombi')
      : (estSav ? 'SAV' : 'Colombi');
    // Ligne déjà DISPOSÉE sur la fiche Contrôle réception (SAV/échange, gardé, commandé
    // autrement, résolu…) → l'anomalie naît « résolue » (classer = résoudre, les 2 écrans
    // sont connectés). Ne s'applique pas aux classements « … Colombi » (actions à mener).
    const dispose = disposeClasse.get(`${c.be_id}|${normalizeRef(c.ref)}`);
    nouvelles.push({
      origine: 'réception', destinataire, type_exception: type, be_id: c.be_id, reference_article: c.ref,
      motif: c.verdict === 'sur_livraison'
        ? versLog
          ? `Sur-saisie probable ${c.ref} : reçu ${c.totalRecu} > commandé ${c.totalCommande} (Attendu négatif) mais le BE papier (${bePapierRef}) ne montre pas ce surplus — à corriger dans Centralink`
          : bePapierRef > 0.001
            ? papierContredit && papierPartiel
              ? `Sur-livraison ${c.ref} : commandé ${c.totalCommande} / reçu ${c.totalRecu} → +${ecart} — à vérifier : le papier scanné (${bePapierRef}) ne le confirme pas, MAIS la réf a des réceptions sur des bons non scannés (papier incomplet, outil lancé en cours de route) → impossible de trancher par le BL`
              : `Sur-livraison ${c.ref} : commandé ${c.totalCommande} / reçu ${c.totalRecu} → +${ecart}, confirmée par le BE papier (${bePapierRef})`
            : `Sur-livraison ${c.ref} : commandé ${c.totalCommande} / reçu ${c.totalRecu} → +${ecart} — à vérifier (BE papier non importé pour cette réf)`
        : estSav
          ? `Pièce détachée SAV ${c.ref} : reçu ${c.qteBe}, livrée hors commande (hors Centralink)`
          : `Hors commande ${c.ref} : reçu ${c.qteBe}, jamais commandé`,
      valeur_attendue: c.verdict === 'sur_livraison' ? c.totalCommande : null,
      valeur_obtenue: c.verdict === 'sur_livraison' ? c.totalRecu : c.qteBe,
      ecart, statut_exception: dispose ? 'résolue' : 'ouverte', niveau_priorite: estSav ? 'faible' : 'moyenne',
      commentaire: dispose ? `Classé « ${dispose} » sur la fiche Contrôle réception` : undefined,
      suggestion_action_ia: c.verdict === 'sur_livraison'
        ? versLog
          ? `Corriger dans Centralink : la saisie ${c.ref} (${c.totalRecu}) dépasse le commandé (${c.totalCommande}) sans que le BE papier (${bePapierRef}) le confirme → ramener le reçu au réel (${bePapierRef || c.totalCommande}).`
          : papierContredit && papierPartiel
            ? `À vérifier ${c.ref} : reçu ${c.totalRecu} > commandé ${c.totalCommande}, papier scanné (${bePapierRef}) insuffisant pour trancher (réceptions sur bons non scannés) → contrôler physiquement, ou scanner les bons manquants de la réf, AVANT de réclamer ou de corriger la saisie.`
            : `Réclamation Colombi : sur-livraison ${c.ref} de +${ecart} (commandé ${c.totalCommande} / reçu ${c.totalRecu})${papierConfirme ? `, confirmée par le BE papier (${bePapierRef})` : ' — vérifier le BL papier'} → réclamer avoir ou passer commande de régularisation.`
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
    cmdRefSurSaisie.add(`${cmdNum.get(l.commande_id) ?? ''}|${aliasRef(ref)}`);   // §3h ne re-signale pas le même écart
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
    const k = aliasRef(l.reference_article); // même clé que les saisies (alias + préfixe coupé)
    const cur = m.get(k) ?? { qte: 0, desig: l.designation ?? null };
    cur.qte += Number(l.quantite_receptionnee) || 0;
    if (!cur.desig && l.designation) cur.desig = l.designation;
    m.set(k, cur); lbByBe.set(l.be_id, m);
  }
  const beNumById = new Map((beR.data ?? []).map((b) => [b.id, b.numero_be]));
  const beIdByNum = new Map((beR.data ?? []).map((b) => [nbe(b.numero_be), b.id]));
  // (aliasNorm / aliasRef sont définis plus haut, juste après `nouvelles`.)
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
  // Signature d'un BE = année + séquence (on IGNORE le mois) : un BE invalide (mois > 12)
  // est le typo de son jumeau de même signature. Ex. BE-25-13-0787 ≡ BE-25-12-0787 (250787).
  // Sert à ne recoller le BE invalide qu'à son vrai BE, pas à tous les manques de la réf.
  const beSignature = (n: string | null | undefined): string | null => {
    const m = String(n ?? '').toUpperCase().match(/BE-?(\d{2})-?\d{2}-?(\d+)/);
    return m ? m[1] + m[2] : null;
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

  // ── Reçu réel (colonne Livré, AUTORITAIRE) vs détail saisi par bon ───────────
  // Le reçu réel (quantite_receptionnee_reelle = colonne Livré de Centralink) est ce qui
  // sera facturé. Le détail par bon (saisies_cl, section « Bon de Livraison » d'order/view)
  // SOUS-COMPTE parfois : order/view perd une ligne de réception que la vue comptable
  // (delivery_note) montre. On garde order/view comme source (delivery_note, lui, DUPLIQUE
  // les commandes multi-bons → inexploitable), mais on s'appuie sur le reçu réel pour
  // mesurer le vrai écart (§3g) et faire remonter l'angle mort (§3h).
  const recuReelByCmdRef = new Map<string, number>();
  const surReceptionByCmdRef = new Set<string>();   // (commande|réf) où reçu réel > commandé = VRAIE sur-réception
  // Reçu réel + reliquat par (n° commande NORMALISÉ | réf) : sert au SCOPE par commande via la
  // colonne « Référence cde client » du BE (ex. « 5567 » ↔ commande #5567) → on compare le papier
  // au reçu/reliquat de LA commande que sert le bon, jamais au total (fin du piège M2M).
  const nnum = (s: string | null | undefined) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const livreByNormCmdRef = new Map<string, number>();
  const resteByNormCmdRef = new Map<string, number>();
  for (const l of lignesCmd) {
    const num = cmdNum.get(l.commande_id);
    if (!num) continue;
    const kk = `${num}|${aliasRef(l.reference_article)}`;
    recuReelByCmdRef.set(kk, (recuReelByCmdRef.get(kk) ?? 0) + (Number(l.quantite_receptionnee_reelle) || 0));
    if ((Number(l.quantite_receptionnee_reelle) || 0) > (Number(l.quantite_commandee) || 0) + 0.001) surReceptionByCmdRef.add(kk);
    const nk = `${nnum(num)}|${aliasRef(l.reference_article)}`;
    livreByNormCmdRef.set(nk, (livreByNormCmdRef.get(nk) ?? 0) + (Number(l.quantite_receptionnee_reelle) || 0));
    resteByNormCmdRef.set(nk, (resteByNormCmdRef.get(nk) ?? 0) + Math.max(0, Number(l.quantite_restante_a_recevoir) || 0));
  }
  // Commandes que sert chaque réf de NOS bons scannés, d'après la colonne « Référence cde client »
  // du papier (ref_cde_client, ex. « 5567 » ou « 5567,5570 »). Clé = réf aliasée → set de n° normalisés.
  const cdeClientsByRef = new Map<string, Set<string>>();
  for (const l of lignesBe) {
    const cdes = String(l.ref_cde_client ?? '').split(',').map((x) => nnum(x)).filter((x) => x.length >= 3);
    if (!cdes.length) continue;
    const k = aliasRef(l.reference_article);
    const set = cdeClientsByRef.get(k) ?? new Set<string>();
    for (const c of cdes) set.add(c);
    cdeClientsByRef.set(k, set);
  }
  const detailByCmdRef = new Map<string, number>();
  const cmdRefsByBeRef = new Map<string, Set<string>>();
  for (const s of saisies) {
    if (!s.commande_ref) continue;
    const kk = `${s.commande_ref}|${aliasRef(s.reference_article)}`;
    detailByCmdRef.set(kk, (detailByCmdRef.get(kk) ?? 0) + (Number(s.quantite_recue) || 0));
    const beId = beIdByNum.get(nbe(s.numero_be));
    if (beId) {
      const bk = beId + '|' + aliasRef(s.reference_article);
      const set = cmdRefsByBeRef.get(bk) ?? new Set<string>();
      set.add(s.commande_ref); cmdRefsByBeRef.set(bk, set);
    }
  }

  // ── Contexte par réf pour §3c — MÊMES garde-fous que le moteur écran (lib/pointage) ──
  // reste à recevoir (commande en attente = corrobore un oubli de saisie), reçu total
  // (saisi sous un autre bon) et part du Livré non détaillée par bon (détail incomplet, §3h).
  const resteParRef = new Map<string, number>();
  const recuTotalParRef = new Map<string, number>();
  for (const l of lignesCmd) {
    const k = aliasRef(l.reference_article);
    resteParRef.set(k, (resteParRef.get(k) ?? 0) + Math.max(0, Number(l.quantite_restante_a_recevoir) || 0));
    recuTotalParRef.set(k, (recuTotalParRef.get(k) ?? 0) + (Number(l.quantite_receptionnee_reelle) || 0));
  }
  const saisiTotalParRef = new Map<string, number>();
  for (const s of saisies) {
    const k = aliasRef(s.reference_article);
    saisiTotalParRef.set(k, (saisiTotalParRef.get(k) ?? 0) + (Number(s.quantite_recue) || 0));
  }
  const nonDetailleParRef = new Map<string, number>();
  for (const [k, recu] of recuTotalParRef) {
    const nd = recu - (saisiTotalParRef.get(k) ?? 0);
    if (nd > 0.001) nonDetailleParRef.set(k, nd);
  }
  const oubliLogRefs = new Set<string>();   // réfs portées en « oubli log » par BE → §3c-bis ne double pas

  // Stock CL (bar-code) — chargé tôt : mention canal scan sur les oublis (§3c), filtre §3h,
  // post-pass bar-code. Clé ALIASÉE : le stock CL porte le code CL (ex. LTLPK03) alors que
  // les anomalies portent le code Colombi (LTL014) — sans alias, le croisement est aveugle.
  const stkR = await selectAll(() =>
    sb.from('stocks_cl').select('reference_article, stock_cl, floating, has_barcode, ventes, stock_source, entrees_barcode, mvts_barcode, mvts_reception'));
  const stockByRef = new Map<string, { stock_cl: number | null; floating: number | null; has_barcode: boolean | null; ventes: number | null; stock_source: string | null; entrees_barcode: number | null; mvts_barcode: { date: string; delta: number }[] | null; mvts_reception: { date: string; delta: number }[] | null }>();
  for (const s of (stkR.data ?? [])) {
    const k = aliasRef(s.reference_article as string);
    if (k && !stockByRef.has(k)) stockByRef.set(k, s as never);
  }
  // Mois (YYMM) d'un n° de bon « BE-26-01-0712 » → 2601. Défini tôt : utilisé dès §3c et par bcHint.
  const beYYMM = (n: string | null | undefined): number => { const m = String(n ?? '').match(/BE-?(\d{2})-?(\d{2})/i); return m ? (+m[1]) * 100 + (+m[2]) : 0; };
  // Mois (YYMM) d'une date de mouvement fiche « 19/01/26 à 14:56 » → 2601.
  const moveYM = (dstr: string): number => { const m = String(dstr).match(/(\d{2})\/(\d{2})\/(\d{2})/); return m ? (+m[3]) * 100 + (+m[2]) : 0; };
  // Indice BAR-CODE. `has_barcode` (présence) = FIABLE. Le TOTAL `entrees_barcode` = BRUIT (Σ de
  // corrections d'inventaire taguées par outil, jamais rattachées à un bon, reconstitue_ok souvent
  // faux) → on ne le chiffre JAMAIS (fausse réassurance). MAIS un mouvement Barcode DATÉ
  // (`mvts_barcode`, lu sur la fiche) tombant dans le MÊME MOIS que le bon est une donnée réelle et
  // vérifiable → on la remonte comme PISTE concrète (à confirmer, jamais un « bien reçu » auto).
  const bcHint = (k: string, moisBon: number[], manque: number): string => {
    const st = stockByRef.get(k);
    if (!st) return '';
    const mois = new Set((moisBon ?? []).filter(Boolean));
    // GARDE-FOU magnitude : un mouvement qui « explique le manque » est du MÊME ORDRE que le
    // manque, pas 1000× (cf PR004 : delta 306954 = correction d'inventaire aberrante).
    const plafond = Math.max(manque * 3 + 5, 0);
    const pick = (moves: { date: string; delta: number }[] | null | undefined) => (mois.size && Array.isArray(moves)
      ? moves.filter((mv) => Number(mv.delta) > 0 && Number(mv.delta) <= plafond && mois.has(moveYM(mv.date))).sort((a, b) => Number(b.delta) - Number(a.delta)).slice(0, 3)
      : []);
    // 1) Mouvement RÉCEPTION daté du même mois que le bon = probable « reçu sans n° de bon »
    //    (cas REM005 : Réception +2 le 06/05 = pile les 2 du bon de mai, invisibles au pointage
    //    par bon). Prioritaire sur la piste bar-code : c'est une réception, pas un scan.
    const rec = pick(st.mvts_reception);
    if (rec.length) {
      const parts = rec.map((mv) => `+${Number(mv.delta).toFixed(0)} le ${mv.date}`).join(', ');
      return ` 🧾 PISTE RÉCEPTION : la fiche ${k} porte un mouvement « Réception » (${parts}) dans le MÊME MOIS que le bon. ⚠ ATTENTION, deux lectures possibles : soit reçu-compté SANS n° de bon rattaché (rien à réclamer), soit la SAISIE TARDIVE d'un bon ANTÉRIEUR (une date de mouvement = date de saisie, pas date du bon — cas REM005 : le +2 de mai était le bon d'avril). Trancher via delivery_note?q=<n° du bon> (qui montre ce que CL a rattaché à QUEL bon), pas au mois seul.`;
    }
    const bc = st.has_barcode ? pick(st.mvts_barcode) : [];
    if (bc.length) {
      const parts = bc.map((mv) => `+${Number(mv.delta).toFixed(0)} le ${mv.date}`).join(', ');
      return ` 🏷 PISTE BAR-CODE : la fiche ${k} porte un mouvement douchette (${parts}) dans le MÊME MOIS que le bon → probablement entré au scan au lieu d'être saisi sous le bon. ⚠ Indice, PAS une preuve : RECOMPTAGE PHYSIQUE conseillé avant de solder — si le compte colle → rien à réclamer, sinon → manquant Colombi à réclamer.`;
    }
    if (st.has_barcode) return ` 🏷 Réf gérée au code-barres : la fiche porte des mouvements « Barcode » (entrées au scan / corrections de stock, NON rattachées à un bon) mais aucun ne colle nettement au manque ce mois-là. Une entrée au scan reste possible — regarder les mouvements « Barcode » de la fiche ${k} ; en cas de doute, RECOMPTAGE PHYSIQUE conseillé (seul juge). ⚠ Rappel : rayon = stock CL ne prouve rien si un inventaire est passé depuis — les mouvements DATÉS de la fiche font foi.`;
    return '';
  };

  // ── 3g) DOUBLE SAISIE DE RÉCEPTION (lignes saisie STRICTEMENT identiques) ──────
  // Quand la log saisit la réception d'un même bon plusieurs fois dans Centralink, la même
  // ligne (n° BE + réf + qté + commande) revient à l'identique N fois → le « reçu » est gonflé.
  // On l'attrape DIRECTEMENT, AVANT les garde-fous code-barres/conditionnement — sinon le couac
  // est masqué (ex. PO0005 lu comme « conditionnement », 17655 adouci par le bar-code). C'est du
  // pointage en trop côté log (le STOCK réel n'est pas touché, cf. 2 couches Centralink distinctes).
  const cmdIdByNum = new Map((cmdR.data ?? []).map((c) => [c.numero_commande_interne, c.id])); // aussi utilisé en §3h
  const dupCount = new Map<string, { numBe: string; ref: string; qte: number; cmd: string; n: number }>();
  for (const s of saisies) {
    const ref = String(s.reference_article ?? '').trim();
    if (!ref || /^EXTRA$/i.test(ref)) continue;            // ligne de frais, pas un article
    const numBe = String(s.numero_be ?? '').trim();
    const qte = Number(s.quantite_recue) || 0;
    if (!numBe || qte <= 0) continue;
    const kk = `${numBe}|${ref}|${qte}|${s.commande_ref ?? ''}`;
    const cur = dupCount.get(kk) ?? { numBe, ref, qte, cmd: s.commande_ref ?? '', n: 0 };
    cur.n++; dupCount.set(kk, cur);
  }
  const dupBeRef = new Set<string>();   // beId|réf que §3g possède (flag réel) → §3c ne re-traite pas
  for (const d of dupCount.values()) {
    if (d.n < 2) continue;
    const beId = beIdByNum.get(nbe(d.numBe));
    if (!beId) {
      // Bon NON IMPORTÉ : pas de papier pour trancher → on ne gomme plus (audit 10/07 :
      // P00022 ×2 sur BE25030767 invisible). Ancre = la commande (comme §3h). Un doublon
      // strictement identique est suspect en soi ; seul le papier tranche → « importer le bon ».
      const cmdId = d.cmd ? cmdIdByNum.get(d.cmd) : undefined;
      if (!cmdId) continue;                            // ni bon importé ni commande → pas d'ancre
      const kd = aliasRef(d.ref);
      if (seen.has(key('réception', cmdId, kd, 'sur-saisie log'))) continue;
      const recent = beYYMM(d.numBe) >= 2512;          // flux (≥ déc 2025) → moyenne ; historique → faible
      nouvelles.push({
        origine: 'réception', destinataire: 'à vérifier', type_exception: 'sur-saisie log',
        commande_id: cmdId, reference_article: kd, numero_be_libre: d.numBe,
        motif: `Saisie ×${d.n} STRICTEMENT identique de ${kd} sous ${d.numBe} (qté ${d.qte} chacune, ${d.cmd}) — bon NON importé dans syncflow : impossible de vérifier contre le papier. Si c'est un doublon, le reçu est gonflé de ${(d.qte * (d.n - 1)).toFixed(0)} (risque facturation).`,
        valeur_attendue: d.qte, valeur_obtenue: d.qte * d.n, ecart: d.qte * (d.n - 1),
        statut_exception: 'ouverte', niveau_priorite: recent ? 'moyenne' : 'faible',
        suggestion_action_ia: `Scanner/importer le bon ${d.numBe} pour trancher (papier = juge), ou vérifier la réception de ${kd} sur ${d.cmd} dans Centralink : ${d.n} lignes identiques (qté ${d.qte}) — si le physique ne justifie qu'une, supprimer le(s) doublon(s).`,
      });
      continue;
    }
    const k = aliasRef(d.ref);
    // GARDE-FOU anti-faux-positif : un doublon n'est une SUR-réception que s'il fait dépasser
    // le PAPIER de ce bon. Sinon = ligne légitime / conditionnement (PO0005, papier 400) / simple
    // déficit → ce n'est pas « en trop », on laisse §3c/§3d/conditionnement gérer.
    const info = lbByBe.get(beId)?.get(k);
    const papierBeRef = info?.qte ?? 0;
    const totalSaisi = saisieByBeRef.get(beId + '|' + k) ?? 0;
    if (papierBeRef <= 0) continue;                                          // réf pas sur ce bon → §3d
    if (quantitesConcordent(papierBeRef, totalSaisi, info?.desig)) continue; // concorde (dont conditionnement)
    if (totalSaisi <= papierBeRef + 0.001) continue;                         // déficit, pas une sur-saisie
    dupBeRef.add(beId + '|' + k);   // §3g prend la main UNIQUEMENT sur ce vrai cas de sur-réception
    if (d.cmd) cmdRefSurSaisie.add(`${d.cmd}|${k}`);                          // §3h ne re-signale pas le même écart
    if (seen.has(key('pointage', beId, k, 'sur-saisie log'))) continue;      // idempotent (même type stocké que §3c)
    // Le reçu réel (colonne Livré) est autoritaire : s'il DÉPASSE le détail saisi, c'est
    // qu'order/view a perdu des lignes → le vrai surplus vs le BL papier se mesure sur le
    // Livré (ex. 17655 : papier 10, détail 20, mais Livré 30 → +20, pas +10).
    const recuReel = d.cmd ? (recuReelByCmdRef.get(`${d.cmd}|${k}`) ?? 0) : 0;
    const sousCompte = recuReel > totalSaisi + 0.001;
    const reference = Math.max(totalSaisi, recuReel);
    const enTrop = reference - papierBeRef;
    nouvelles.push({
      origine: 'pointage', destinataire: 'log', type_exception: 'sur-saisie log',
      be_id: beId, reference_article: k,
      motif: sousCompte
        ? `Sur-saisie ${k} sur ${d.numBe} : BL papier ${papierBeRef}, mais Centralink compte ${reference} reçus sur ${d.cmd} (colonne Livré) → +${enTrop} en trop. Le détail par bon n'en montre que ${totalSaisi} (order/view en perd une partie, visible en comptabilité) → gonfle le reçu (risque facturation).`
        : `Réception saisie en double : ${k} sur ${d.numBe} (papier ${papierBeRef} / saisi ${totalSaisi}, ligne ${d.qte} répétée ${d.n}×) → ${enTrop} en trop. Pointage seulement (le stock réel n'est pas touché).`,
      valeur_attendue: papierBeRef, valeur_obtenue: reference, ecart: enTrop,
      statut_exception: 'ouverte', niveau_priorite: 'haute',
      suggestion_action_ia: sousCompte
        ? `Corriger dans Centralink : réconcilier la réception de ${k} sur ${d.cmd} au BL papier (${papierBeRef}) — le Livré (${reference}) dépasse le papier de ${enTrop} → supprimer les saisies en trop (le détail visible n'en montre que ${totalSaisi}, mais le Livré fait foi).`
        : `Corriger dans Centralink : ${k} a sa réception saisie en double sur ${d.numBe} (papier ${papierBeRef}, saisi ${totalSaisi}) → supprimer la/les saisie(s) en trop. N'affecte pas le stock physique, mais gonfle le reçu (risque facturation).`,
    });
  }

  // ── 3c) CONTRÔLE BE PAPIER vs SAISIE LOG, PAR BE ─────────────────────────
  // Le 1er contrôle : pour chaque BE qu'on a scanné, la log a-t-elle saisi dans
  // Centralink la même chose que notre BL papier ? CL reste la référence ; notre
  // papier est le contrôle indépendant. Un écart = erreur de saisie de la log
  // (oubli, doublon, mauvais n° de BE) → à corriger dans Centralink.
  // Écarts EXPLIQUÉS par un total (reçue ailleurs / Livré non ventilé) : avant, deux
  // `continue` silencieux les gommaient — l'audit de couverture (10/07) a montré 7 écarts
  // réels invisibles au Centre (VES002 60/30, 491038, LTLPK03…). Même piège que RGA4412 :
  // le TOTAL n'a jamais prouvé le détail par bon. On COLLECTE et on ÉMET après la boucle
  // (par réf, ou agrégé « bon jamais saisi » quand tout le bon est vide).
  const exoSilencieuses = new Map<string, { k: string; numBe: string; papier: number; saisie: number; manque: number; via: 'ailleurs' | 'non ventilé'; nd: number }[]>();
  const bonsAvecSaisie = new Set<string>();
  for (const [kk, v] of saisieByBeRef) if (v > 0) bonsAvecSaisie.add(kk.slice(0, kk.indexOf('|')));
  for (const [beId, refs] of lbByBe) {
    const numBe = beNumById.get(beId) ?? '';
    for (const [k, info] of refs) {
      const papier = info.qte;
      if (papier <= 0) continue;
      if (dupBeRef.has(beId + '|' + k)) continue;   // double saisie identique → déjà traité en §3g (clair), pas de doublon/mauvais label
      const saisie = saisieByBeRef.get(beId + '|' + k) ?? 0;             // saisi sous CE BE
      if (quantitesConcordent(papier, saisie, info.desig)) continue;     // OK : égal ou conditionnement
      // Réf au conditionnement (X500, boîte de N…) : et peuvent être en unités
      // différentes (pièces vs boîtes) → écart à vérifier, pas un manque ferme.
      const conditionne = facteurConditionnement(info.desig) > 1;
      const condMotif = `À vérifier (conditionnement « ${info.desig} ») ${k} sur ${numBe} : BL papier ${papier} / saisi ${saisie} — écart probablement dû aux unités (pièces/boîtes)`;
      const condAction = `⚠ Conditionnement (« ${info.desig} ») : vérifier les unités (pièces vs boîtes) — ${numBe} : papier ${papier} / saisi ${saisie}.`;
      if (saisie > papier + 0.001) {
        // La log a saisi PLUS que le BL papier → sur-saisie APPARENTE.
        // GARDE-FOU faux positif « dispatch » : une réf livrée pour PLUSIEURS commandes sur
        // un même bon, avec un scan papier incomplet, fait saisi-du-bon > papier-du-bon SANS
        // qu'il y ait d'erreur (reçu = commandé). On ne lève donc la sur-saisie QUE s'il y a
        // une VRAIE sur-réception au niveau commande (reçu réel > commandé) sur une des
        // commandes de ce (bon, réf). Les vrais doublons (lignes identiques) sont déjà pris
        // par §3g en amont (dupBeRef) ; le vrai écart papier/reçu par réf est en §3c-bis/§3h.
        const cmdsDuBon = cmdRefsByBeRef.get(beId + '|' + k) ?? new Set<string>();
        const vraieSurReception = [...cmdsDuBon].some((cr) => surReceptionByCmdRef.has(`${cr}|${k}`));
        if (!vraieSurReception) continue;   // dispatch / papier incomplet → pas une erreur
        for (const cr of cmdsDuBon) cmdRefSurSaisie.add(`${cr}|${k}`);
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
        // Le BL papier montre PLUS que la saisie sous ce BE (② > ③). Deux vraies causes,
        // départagées comme au moteur écran (causeEcart) :
        //  • la COMMANDE ATTEND ENCORE du reliquat → la réception n'a pas été saisie =
        //    OUBLI LOG (cf 2227 : papier 40, saisi 4, #4842 attend 36 — la marchandise est
        //    là, CL croit toujours l'attendre) → destinataire log, action « saisir » ;
        //  • commandes SOLDÉES → l'excédent est un SURPLUS COLOMBI à arbitrer côté achat
        //    (régule / retour / stock) → jugé PAR RÉFÉRENCE en §3c-bis, destinataire Colombi.
        const manque = papier - saisie;
        // CAS LOG (cas 1/2) : réf en manque MAIS saisie sous un n° de BE INVALIDE (mois > 12)
        // → erreur de n° de BE de la log (la marchandise est saisie, juste mal numérotée),
        // PAS un surplus → à recoller sur le bon BE.
        // ⚠ On ne rattache le BE invalide qu'à son JUMEAU (même signature année+séquence) :
        // BE-25-13-0787 ne recolle que sur BE-25-12-0787, pas sur un autre manque de la réf
        // (sinon, avec plusieurs manques, on génère une anomalie redondante mal aiguillée).
        const sig = beSignature(numBe);
        const sousInvalide = (saisieSousBeInvalide.get(k) ?? []).filter((x) => sig && beSignature(x.numBe) === sig);
        if (sousInvalide.length) {
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
        // Saisi ailleurs : RIEN saisi sous CE bon mais la réf est reçue ailleurs dans
        // Centralink → mal numéroté OU oubli masqué par le total. On ne gomme plus : collecté,
        // émis après la boucle (le total ne prouve pas CE bon — leçon RGA4412).
        if (saisie <= 0.001 && (recuTotalParRef.get(k) ?? 0) > 0.001) {
          (exoSilencieuses.get(beId) ?? exoSilencieuses.set(beId, []).get(beId)!)
            .push({ k, numBe, papier, saisie, manque, via: 'ailleurs', nd: 0 });
          continue;
        }
        // Détail incomplet : la part du Livré global NON VENTILÉE par bon couvre le manque →
        // la marchandise est comptée (niveau commande) mais pas rattachée à ce bon. Probable
        // détail perdu par order/view — collecté, émis après la boucle (à confirmer d'un œil).
        if ((nonDetailleParRef.get(k) ?? 0) >= manque - 0.001) {
          (exoSilencieuses.get(beId) ?? exoSilencieuses.set(beId, []).get(beId)!)
            .push({ k, numBe, papier, saisie, manque, via: 'non ventilé', nd: nonDetailleParRef.get(k) ?? 0 });
          continue;
        }
        // ÉCART RÉCEPTION (BL papier > reçu CL, commande encore en attente) : le BL déclare
        // PLUS que ce que CL a reçu. On NE PRÉSUME PAS le coupable — impossible depuis le seul
        // papier : soit Colombi a livré court (manquant → réclamer / reliquat à attendre), soit
        // la log a oublié de saisir (marchandise en stock → à saisir). SEUL UN CONTRÔLE PHYSIQUE
        // tranche (doctrine Rémy : on est le contrôle, on ne lit pas les annotations manuscrites,
        // et la log peut même ne pas avoir vu le manquant). On corrèle avec le reliquat CL
        // (cohérent avec un manquant Colombi) et on laisse l'humain vérifier. Type NEUTRE
        // « réception incomplète » (libellé écran « Livraison partielle »), destinataire à vérifier.
        const reste = resteParRef.get(k) ?? 0;
        if (reste > 0.001) {
          oubliLogRefs.add(k);   // avant le seen : §3c-bis ne double pas, même si l'anomalie existe déjà
          if (seen.has(key('pointage', beId, k, 'réception incomplète'))) continue;
          nouvelles.push({
            origine: 'pointage', destinataire: 'à vérifier', type_exception: 'réception incomplète',
            be_id: beId, reference_article: k,
            motif: `Écart réception ${k} sur ${numBe} : le BL papier déclare ${papier}, CL n'a reçu que ${saisie} → ${manque.toFixed(0)} manquant(s), ${reste.toFixed(0)} en reliquat sur commande → à contrôler physiquement (livraison courte Colombi OU oubli de saisie).${bcHint(k, [beYYMM(numBe)], manque)}`,
            valeur_attendue: papier, valeur_obtenue: saisie, ecart: -manque,
            statut_exception: 'ouverte', niveau_priorite: 'moyenne',
            suggestion_action_ia: `Contrôler physiquement ${k} (BL ${papier} / reçu CL ${saisie}, ${reste.toFixed(0)} en reliquat) : si la marchandise est en stock → la saisir sous ${numBe} (oubli log) ; si elle est absente du colis → manquant Colombi à réclamer (avoir) ou reliquat à attendre. Seul le contrôle physique tranche.`,
          });
          continue;
        }
        // Sinon (commandes soldées) : le vrai écart déclaration/comptage est jugé PAR
        // RÉFÉRENCE (total vs total) en §3c-bis, où avoirs et régules sont pris en compte.
      }
    }
  }
  // (L'ÉMISSION des écarts expliqués-par-le-total collectés ci-dessus se fait APRÈS §3c-bis :
  //  une réf déjà jugée au niveau réf — réception incomplète, non détaillée, compensé… — ne
  //  doit pas re-figurer dans l'anomalie de bon. UNE réf = UNE histoire, cf. doublon CFT36.)

  // ── 3c-bis) SURPLUS COLOMBI EXACT, PAR RÉFÉRENCE ──────────────────────────────
  // Surplus = ce que Colombi a livré sur NOS bons scannés (papier) mais qui n'est ni saisi
  // sur ces bons, ni refusé (avoir), ni gardé via régule. On compare le papier aux SAISIES
  // SUR LES BONS QU'ON A SCANNÉS (fiable, même période) — pas au reçu commande toutes périodes,
  // qui mélange l'historique d'avant nos scans et fausse le calcul.
  //   surplus = papier − saisi(sur nos bons) − avoir − régule
  // Ex. 19803 : 29 − 14 − 8 − 3 = 4.
  const papierTotParRef = new Map<string, { qte: number; desig: string | null; beId: string }>();
  const bonsParRef = new Map<string, { numBe: string; qte: number }[]>();  // répartition du papier par bon
  for (const [beId, refs] of lbByBe) {
    for (const [k, info] of refs) {
      const cur = papierTotParRef.get(k) ?? { qte: 0, desig: info.desig, beId };
      cur.qte += info.qte;
      if (!cur.desig && info.desig) cur.desig = info.desig;
      papierTotParRef.set(k, cur);
      const arr = bonsParRef.get(k) ?? [];
      arr.push({ numBe: beNumById.get(beId) ?? '', qte: info.qte });
      bonsParRef.set(k, arr);
    }
  }
  // Le papier d'une réf peut être RÉPARTI sur plusieurs bons (ex. CFT36 : 10 sur BE-…-1362 +
  // 3 sur BE-…-0289 = 13). L'anomalie est « par référence » mais la colonne BE de l'écran n'en
  // montre qu'UN → on liste la répartition dans le motif pour que le total colle à ce qu'on voit.
  const repartBons = (k: string): string => {
    const bons = (bonsParRef.get(k) ?? []).filter((b) => b.qte > 0);
    if (bons.length <= 1) return '';
    return ` · réparti sur ${bons.length} bons : ${bons.map((b) => `${b.numBe} (${b.qte})`).join(', ')}`;
  };
  // Détail CONCRET du manque : sur quel(s) bon(s) le papier > la saisie CL, et de combien.
  // Bien plus parlant qu'un total agrégé (« sur le bon X : papier 5, CL 2 → 3 manquent »).
  const manqueParBon = (k: string): { numBe: string; papier: number; cl: number; manque: number }[] => {
    const out: { numBe: string; papier: number; cl: number; manque: number }[] = [];
    for (const [beId, refs] of lbByBe) {
      const info = refs.get(k);
      if (!info || info.qte <= 0) continue;
      const s = saisieByBeRef.get(beId + '|' + k) ?? 0;
      if (info.qte > s + 0.001) out.push({ numBe: beNumById.get(beId) ?? '', papier: info.qte, cl: s, manque: info.qte - s });
    }
    return out;
  };
  const manqueTexte = (k: string): string =>
    manqueParBon(k).map((b) => `${b.numBe} (papier ${b.papier}, CL ${b.cl} → ${b.manque.toFixed(0)} manquant${b.manque > 1 ? 's' : ''})`).join(', ');
  // SANITÉ TEMPORELLE de l'exonération « Bien reçu » : le « Livré couvre » ne vaut que si la
  // réception est du BON moment. Si le papier est sur un bon PLUS RÉCENT que toute réception
  // saisie de la réf (ex. KI0010 : bon 02/2026 mais dernière saisie/commande = 2025), le
  // « couvert par le Livré » compare à des réceptions PÉRIMÉES → suspect (probable entrée
  // bar-code / hors commande, pas un « bien reçu »). AAMM extrait du n° de bon (beYYMM, défini plus haut).
  const dernSaisieYYMM = new Map<string, number>();
  for (const s of saisies) { const k = aliasRef(s.reference_article); const ym = beYYMM(s.numero_be); if (ym > (dernSaisieYYMM.get(k) ?? 0)) dernSaisieYYMM.set(k, ym); }
  const dernPapierYYMM = new Map<string, number>();
  for (const [beId, refs] of lbByBe) { const ym = beYYMM(beNumById.get(beId)); for (const kk of refs.keys()) if (ym > (dernPapierYYMM.get(kk) ?? 0)) dernPapierYYMM.set(kk, ym); }
  // Saisi sur les bons SCANNÉS, par réf (saisieByBeRef est déjà restreint à nos BE).
  const saisieScanParRef = new Map<string, number>();
  for (const [kk, v] of saisieByBeRef) {
    const k = kk.slice(kk.indexOf('|') + 1);
    saisieScanParRef.set(k, (saisieScanParRef.get(k) ?? 0) + v);
  }
  // Les saisies sous un n° de BE INVALIDE (typo mois>12, ex. BE-25-13-0787) sont NOS
  // marchandises, juste mal numérotées (déjà signalées par l'anomalie « recoller » §3c).
  // On les compte donc comme saisies ici, sinon le surplus par-réf re-compte le même manque
  // → double anomalie sur le même écart (cf. CR00002 : 16 du typo affiché 2×).
  for (const [k, arr] of saisieSousBeInvalide) {
    const q = arr.reduce((s, x) => s + (Number(x.qte) || 0), 0);
    if (q > 0) saisieScanParRef.set(k, (saisieScanParRef.get(k) ?? 0) + q);
  }
  // Commandes de RÉGULE (note « Surplus … » dans bls_centralink) = surplus gardé régularisé.
  const reguleCmdIds = new Set(
    (cmdR.data ?? []).filter((c) => /surplus/i.test(c.bls_centralink || '')).map((c) => c.id),
  );
  const avoirParRef = new Map<string, number>();
  const reguleParRef = new Map<string, number>();
  for (const l of lignesCmd) {
    const k = aliasRef(l.reference_article);
    const r = Number(l.quantite_receptionnee_reelle) || 0;
    if (r < 0) avoirParRef.set(k, (avoirParRef.get(k) ?? 0) + (-r));                          // refusé/rendu
    if (reguleCmdIds.has(l.commande_id)) reguleParRef.set(k, (reguleParRef.get(k) ?? 0) + Math.max(0, r)); // gardé
  }
  // (resteParRef est calculé plus haut, avant §3c — partagé avec la détection d'oubli log.)
  for (const [k, info] of papierTotParRef) {
    if (!refsCommandees.has(k)) continue;                  // hors-commande/SAV → traité ailleurs
    if (facteurConditionnement(info.desig) > 1) continue;  // conditionnement → géré par BE (unités)
    if (oubliLogRefs.has(k)) continue;                     // déjà porté en « oubli log » par BE (reliquat) → pas de doublon
    const pap = info.qte;
    const saisi = saisieScanParRef.get(k) ?? 0;            // saisi sur NOS bons
    const avoir = avoirParRef.get(k) ?? 0;                 // refusé/rendu
    const regule = reguleParRef.get(k) ?? 0;               // gardé via régule
    const surplus = pap - saisi - avoir - regule;
    if (surplus < 0.5) {
      // Compensé au TOTAL (saisi ailleurs / avoir / régule) : rien à réclamer. MAIS si un bon
      // précis reste en manque (papier > saisi sur CE bon), on le MONTRE au lieu de le gommer
      // (audit 10/07 : 11319 ②60③58, VES004 ②42③38, 491033 avoir 6 — invisibles avant).
      // Faible : la marchandise est expliquée, seul le rangement par bon diffère.
      const mb = manqueParBon(k).filter((b) => b.manque >= 1);
      if (mb.length && !seen.has(key('pointage', info.beId, k, 'réception non détaillée'))) {
        const detailNet = `papier ${pap}, saisi ${saisi}${avoir > 0 ? `, avoir ${avoir}` : ''}${regule > 0 ? `, régule ${regule}` : ''}`;
        nouvelles.push({
          origine: 'pointage', destinataire: 'interne', type_exception: 'réception non détaillée',
          be_id: info.beId, reference_article: k,
          motif: `✓ Rien à réclamer ${k} : l'écart par bon (${manqueTexte(k)}) est COMPENSÉ au total (${detailNet}) → marchandise expliquée par un avoir / une saisie sous un autre bon, juste pas rangée sous le bon attendu. Détail à l'œil si besoin.`,
          valeur_attendue: pap, valeur_obtenue: saisi, ecart: -mb.reduce((s, b) => s + b.manque, 0),
          statut_exception: 'ouverte', niveau_priorite: 'faible',
          suggestion_action_ia: `Rien à réclamer : le total de ${k} est couvert (${detailNet}). Si tu veux le détail exact, vérifier sur quel bon/avoir les ${mb.reduce((s, b) => s + b.manque, 0).toFixed(0)} du (des) bon(s) ${mb.map((b) => b.numBe).join(', ')} sont rangés. Tu peux classer « résolu ».`,
        });
      }
      continue;
    }
    const reste = resteParRef.get(k) ?? 0;                 // reliquat CL (autoritaire : commande non soldée)
    const recuReel = recuTotalParRef.get(k) ?? 0;          // Livré total (reçu réel)
    const detail = `papier ${pap}, saisi ${saisi}${avoir > 0 ? `, avoir ${avoir}` : ''}${regule > 0 ? `, régule ${regule}` : ''}`;
    // SCOPE PAR COMMANDE (colonne « Référence cde client » du BE) : quand on SAIT quelle(s)
    // commande(s) ce bon sert pour cette réf, on juge sur CELLE-là, pas sur le total. Si toutes
    // sont soldées (reliquat scopé = 0) ET leur Livré couvre le papier → reçu mais pas ventilé
    // (RO00033 : bon → #5567, soldée, Livré 3 ≥ papier 3). Précis, sans piège M2M. Ne s'applique
    // qu'aux bons importés AVEC la cde client ; sinon on retombe sur la logique reliquat-total ci-dessous.
    const cdes = cdeClientsByRef.get(k);
    if (cdes && cdes.size) {
      let resteScope = 0, livreScope = 0;
      for (const c of cdes) {
        resteScope += resteByNormCmdRef.get(`${c}|${k}`) ?? 0;
        livreScope += livreByNormCmdRef.get(`${c}|${k}`) ?? 0;
      }
      if (resteScope < 0.001 && livreScope >= pap - 0.001) {
        if (seen.has(key('pointage', info.beId, k, 'réception non détaillée'))) continue;
        nouvelles.push({
          origine: 'pointage', destinataire: 'interne', type_exception: 'réception non détaillée',
          be_id: info.beId, reference_article: k,
          motif: `✅ Bien reçu — RIEN À FAIRE. ${k} : la commande ${[...cdes].map((c) => '#' + c).join(', ')} est soldée, tout est reçu. Les ${surplus.toFixed(0)} de ce bon sont juste saisis sous un autre n° de bon dans Centralink — aucun impact sur le stock ni la facture.`,
          valeur_attendue: pap, valeur_obtenue: saisi, ecart: -surplus,
          statut_exception: 'ouverte', niveau_priorite: 'faible',
          suggestion_action_ia: `Rien à faire : ${k} est bien reçu, commande ${[...cdes].map((c) => '#' + c).join(', ')} soldée. Les ${surplus.toFixed(0)} sont juste rangés sous un autre n° de bon dans Centralink. Tu peux classer « résolu ».`,
        });
        continue;
      }
      // scope connu mais reliquat > 0 OU Livré < papier → vrai écart sur CETTE commande → on ne
      // l'exonère pas ; il tombe dans la logique ci-dessous (réception incomplète / surplus).
    }
    // Le RELIQUAT CL est le seul juge fiable de « reste-t-il quelque chose à recevoir ? » (CL
    // le calcule commande par commande). On NE compare JAMAIS le papier (périmètre partiel, nos
    // bons scannés) au Livré TOTAL (toutes commandes/périodes) pour exonérer : ce serait le piège
    // M2M (un Livré historique élevé masquerait un manque réel sur une commande en cours).
    if (reste > 0.001) {
      // Commande encore en attente → l'écart papier > reçu peut être un MANQUE réel (livraison
      // courte Colombi) ou une saisie sous un autre bon. On ne présume rien → à contrôler.
      if (seen.has(key('pointage', info.beId, k, 'réception incomplète'))) continue;
      nouvelles.push({
        origine: 'pointage', destinataire: 'à vérifier', type_exception: 'réception incomplète',
        be_id: info.beId, reference_article: k,
        motif: `⚠ Il manque ${surplus.toFixed(0)} ${k} dans Centralink → sur ${manqueTexte(k)}. Et il reste ${reste.toFixed(0)} à recevoir sur une commande ouverte. À CONTRÔLER : reliquat qui arrive ; saisi sous un autre bon ; oubli de saisie ; ou Colombi a livré court. Regarder le colis avant de réclamer.${bcHint(k, manqueParBon(k).map((b) => beYYMM(b.numBe)), surplus)}`,
        valeur_attendue: pap, valeur_obtenue: saisi, ecart: -surplus,
        statut_exception: 'ouverte', niveau_priorite: 'moyenne',
        suggestion_action_ia: `Regarde ${k} en rayon : si présent mais saisi sous un autre bon → rien à faire ; si présent mais absent de Centralink → la log saisit ; s'il manque vraiment → c'est le reliquat qui arrive (attendre) ou un manquant Colombi à réclamer. Ne rien réclamer avant d'avoir regardé.`,
      });
      continue;
    }
    // reste = 0 : CL confirme que TOUT le commandé est reçu (aucun manque possible). L'écart
    // papier > saisi est donc soit du reçu non ventilé sous ce bon, soit une vraie sur-livraison.
    if (recuReel >= pap - 0.001) {
      if (seen.has(key('pointage', info.beId, k, 'réception non détaillée'))) continue;
      // GARDE-FOU TEMPOREL : le papier est-il plus récent que toute réception saisie de la réf ?
      // Si oui, le « Livré couvre » compare à des réceptions périmées → PAS un « bien reçu » sûr :
      // c'est un bon récent sans commande ni saisie correspondante (probable entrée bar-code /
      // hors commande, cf KI0010 : bon 02/2026, dernières réceptions 2025). → à confirmer.
      const suspectTemporel = (dernPapierYYMM.get(k) ?? 0) > (dernSaisieYYMM.get(k) ?? 0) + 0.5;
      if (suspectTemporel) {
        nouvelles.push({
          origine: 'pointage', destinataire: 'à vérifier', type_exception: 'réception non détaillée',
          be_id: info.beId, reference_article: k,
          motif: `⚠ À CONFIRMER ${k} : le bon est PLUS RÉCENT que toute réception enregistrée (dernières commandes/saisies périmées) — le « Livré ${recuReel.toFixed(0)} » ne prouve donc PAS que les ${surplus.toFixed(0)} de ce bon sont reçus. Aucune commande ne les couvre.${bcHint(k, manqueParBon(k).map((b) => beYYMM(b.numBe)), surplus)}${repartBons(k)}`,
          valeur_attendue: pap, valeur_obtenue: saisi, ecart: -surplus,
          statut_exception: 'ouverte', niveau_priorite: 'moyenne',
          suggestion_action_ia: `Vérifier sur la fiche Centralink de ${k} (table des mouvements) : y a-t-il ~${surplus.toFixed(0)} entrées « Barcode » autour de la date du bon ? Si oui → bien reçu au scan (classer résolu) ; sinon → vrai manque à réclamer à Colombi. NE PAS se fier au Livré (il date d'anciennes commandes).`,
        });
        continue;
      }
      // Sinon (pas de scope commande via cde_client) : le Livré TOTAL couvre le papier, mais c'est
      // un TOTAL toutes commandes/bons — il ne prouve PAS que les X de CE bon sont saisis. Ils
      // peuvent être (a) rattachés à un autre bon dans CL (mal numéroté → rien à faire) ou (b)
      // GÉNUINEMENT non saisis = oubli, stock CL court (cf RGA4412 : 5 physiques sur le 0712,
      // 2 dans CL, les 3 manquent vraiment). On NE tranche PAS sans le comptage physique par bon
      // → « à vérifier », destinataire log-ou-vérif, pas un « Bien reçu » vert trompeur.
      nouvelles.push({
        origine: 'pointage', destinataire: 'à vérifier', type_exception: 'réception non détaillée',
        be_id: info.beId, reference_article: k,
        motif: `⚠ Il manque ${surplus.toFixed(0)} ${k} dans Centralink → sur ${manqueTexte(k)}. À CONTRÔLER, quelle est l'explication : soit saisis sous un AUTRE n° de bon (mal rangé → rien à faire) ; soit un oubli de saisie (la log les saisit) ; soit une sur-livraison Colombi / un manquant. Le comptage physique du bon tranche.${bcHint(k, manqueParBon(k).map((b) => beYYMM(b.numBe)), surplus)}`,
        valeur_attendue: pap, valeur_obtenue: saisi, ecart: -surplus,
        statut_exception: 'ouverte', niveau_priorite: 'moyenne',
        suggestion_action_ia: `Regarde le bon en rayon + la fiche Centralink de ${k} : ${stockByRef.get(k)?.has_barcode ? 'd\'abord les mouvements « Barcode » (réf gérée au code-barres → souvent entrée au scan sans commande, rien à faire) ; ' : ''}si présents et saisis sous un autre bon → mal rangé, rien à faire ; si présents mais absents de Centralink → la log saisit (oubli / sur-livraison à régulariser) ; si absents du rayon → réclamer Colombi.`,
      });
      continue;
    }
    // reste = 0 ET Livré < papier déclaré → le BL déclare plus que ce que CL a jamais reçu,
    // commandes soldées → vraie SUR-LIVRAISON Colombi (déclaré non encaissé) → à régulariser.
    if (seen.has(key('pointage', info.beId, k, 'sur-livraison'))) continue;
    nouvelles.push({
      origine: 'pointage', destinataire: 'Colombi', type_exception: 'sur-livraison',
      be_id: info.beId, reference_article: k,
      motif: `Surplus Colombi ${k} : ${surplus.toFixed(0)} livré(s) en plus, ni saisi(s) ni rendu(s) ni régularisé(s) (${detail}, commandes soldées, Livré ${recuReel.toFixed(0)} < papier) → à régulariser${repartBons(k)}`,
      valeur_attendue: pap, valeur_obtenue: saisi, ecart: -surplus,
      statut_exception: 'ouverte', niveau_priorite: 'moyenne',
      suggestion_action_ia: `Surplus Colombi à régulariser : ${k} → ${surplus.toFixed(0)} en trop (${detail}), commandes déjà soldées. Action : commande de régule (avec le n° de BL) pour les encaisser, ou réclamer/retourner à Colombi.`,
    });
  }

  // ÉMISSION des écarts expliqués-par-le-total (collectés en §3c, ex-continue silencieux).
  // UNE RÉF = UNE HISTOIRE : une réf déjà portée au niveau réf (réception incomplète §3c-bis,
  // non détaillée, compensé, ou une anomalie existante/travaillée) est EXCLUE — sinon le même
  // manque sort deux fois (doublon CFT36 : bon-agg + réception incomplète reliquat). Puis :
  //  • ≥ 3 réfs restantes du MÊME bon → UNE anomalie de bon (l'histoire est par bon) ;
  //  • sinon par réf → faible (Livré non ventilé couvre) ou moyenne (juste « reçue ailleurs »).
  const refsDejaPortees = new Set<string>();
  for (const e of (exR.data ?? [])) {
    for (const t of String(e.reference_article ?? '').split(', ')) { const a = aliasRef(t); if (a) refsDejaPortees.add(a); }
  }
  for (const n of nouvelles) {
    if (n.origine !== 'pointage' || !n.reference_article || n.reference_article.includes(', ')) continue;
    const a = aliasRef(n.reference_article); if (a) refsDejaPortees.add(a);
  }
  for (const [beId, items0] of exoSilencieuses) {
    const items = items0.filter((x) => !refsDejaPortees.has(x.k));
    if (!items.length) continue;
    const numBe = items[0]?.numBe ?? (beNumById.get(beId) ?? '');
    if (items.length >= 3) {
      // La réf de l'anomalie de bon = la LISTE des réfs (triée, stable) : la colonne
      // Référence n'est pas vide et la recherche par réf retrouve l'anomalie du bon.
      const refsListe = items.map((x) => x.k).sort().join(', ');
      if (seen.has(key('pointage', beId, refsListe, 'réception non détaillée'))) continue;
      const unites = items.reduce((s, x) => s + x.manque, 0);
      const bonVide = !bonsAvecSaisie.has(beId);
      const refsTxt = `${items.slice(0, 10).map((x) => `${x.k} (${x.manque.toFixed(0)})`).join(', ')}${items.length > 10 ? '…' : ''}`;
      nouvelles.push({
        origine: 'pointage', destinataire: 'log', type_exception: 'réception non détaillée',
        be_id: beId, reference_article: refsListe,
        motif: bonVide
          ? `⚠ Bon ${numBe} JAMAIS saisi sous ce n° dans Centralink (${items.length} réfs papier, ${unites.toFixed(0)} unités) — les réfs se retrouvent ailleurs dans CL (autres bons / Livré non ventilé) → la log a probablement saisi ce bon sous un AUTRE n° (ou oublié de le saisir). Réfs : ${refsTxt}.`
          : `⚠ ${items.length} réfs du bon ${numBe} (${unites.toFixed(0)} unités) sans saisie complète sous ce n° MAIS retrouvées ailleurs dans CL (autres bons / Livré non ventilé) → probable saisie sous un autre n° ou détail perdu par CL — l'histoire se vérifie par bon, pas réf par réf. Réfs : ${refsTxt}.`,
        valeur_attendue: unites, valeur_obtenue: 0, ecart: -unites,
        statut_exception: 'ouverte', niveau_priorite: 'moyenne',
        suggestion_action_ia: bonVide
          ? `Chercher dans Centralink sous quel n° la log a saisi le bon ${numBe} (réceptions du même jour, mêmes réfs). Si trouvé → recoller le n° ; si introuvable → faire saisir le bon par la log (oubli entier).`
          : `Comparer le bon ${numBe} papier aux réceptions CL de la même période : les réfs listées sont probablement saisies sous un autre n° de bon. Si oui → rien à faire (mal numéroté) ; sinon → oubli(s) de saisie à faire corriger par la log.`,
      });
      continue;
    }
    for (const x of items) {
      if (seen.has(key('pointage', beId, x.k, 'réception non détaillée'))) continue;
      const estNV = x.via === 'non ventilé';
      nouvelles.push({
        origine: 'pointage', destinataire: 'à vérifier', type_exception: 'réception non détaillée',
        be_id: beId, reference_article: x.k,
        motif: estNV
          ? `${x.manque.toFixed(0)} ${x.k} manquants sur ${x.numBe} (papier ${x.papier}, saisi ${x.saisie}) MAIS couverts par du Livré NON VENTILÉ par bon (${x.nd.toFixed(0)} comptés au niveau commande sans n° de bon) → probablement reçus et comptés, juste pas rattachés à ce bon. À confirmer d'un œil.${bcHint(x.k, [beYYMM(x.numBe)], x.manque)}`
          : `⚠ RIEN saisi sous ${x.numBe} pour ${x.k} (papier ${x.papier}) mais la réf est reçue AILLEURS dans Centralink → soit saisie sous un autre n° de bon (mal numéroté → rien à faire), soit oubli sur CE bon masqué par le total. Le total ne prouve jamais CE bon → à vérifier.${bcHint(x.k, [beYYMM(x.numBe)], x.manque)}`,
        valeur_attendue: x.papier, valeur_obtenue: x.saisie, ecart: -x.manque,
        statut_exception: 'ouverte', niveau_priorite: estNV ? 'faible' : 'moyenne',
        suggestion_action_ia: estNV
          ? `Vérifier la vue comptable (delivery_note) de la commande pour ${x.k} : les ${x.manque.toFixed(0)} non rattachés à ${x.numBe} y figurent probablement sans n° de bon. Si oui → rien à faire (détail perdu par order/view) ; sinon → contrôler physiquement.`
          : `Chercher ${x.k} dans les autres bons de Centralink (même période que ${x.numBe}) : si saisie sous un autre n° → rien à faire ; sinon → oubli de saisie sur ce bon (la log saisit) ou manquant à contrôler physiquement.`,
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
    if (!l.hors_systeme) normalBeRef.add(l.be_id + '|' + aliasRef(l.reference_article));
  }
  const horsSysByBeRef = new Set<string>();
  for (const l of lignesBe) {
    if (!l.hors_systeme) continue;
    const kk = l.be_id + '|' + aliasRef(l.reference_article);
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

  // (stockByRef est chargé plus haut, avant §3c — sert aussi à la mention bar-code des oublis.)

  // ── 3h) RÉCEPTION NON DÉTAILLÉE (Livré > détail saisi par bon) → à vérifier ───
  // Le reçu réel (colonne Livré, autoritaire) dépasse la somme du détail saisi par bon :
  // Centralink a compté des réceptions qu'order/view ne détaille pas dans sa section « Bon
  // de Livraison ». Deux causes possibles :
  //   • réf au CODE-BARRES sans sur-réception (reçu ≤ commandé) → entrées scan, le
  //     fonctionnement NORMAL (validé sur VES001/LTL006/… : reçu = commandé pile, zéro
  //     enjeu) → on NE CRÉE PAS d'anomalie (c'était du bruit pur, 10 fausses « faible »).
  //   • sinon → vrai signal : angle mort order/view (double-saisie qui gonfle le reçu,
  //     réception sans n° de bon) OU bar-code AVEC sur-réception (risque réel) → remonté.
  // On ne traite QUE les couples au détail PARTIEL (détail > 0) : un détail à 0 = bon
  // jamais détaillé (sujet « BE à scanner »). Déjà signalés §3b/§3c/§3g exclus (cmdRefSurSaisie).
  // (cmdIdByNum est déclaré plus haut, avant §3g — partagé.)
  for (const [kk, recuReel] of recuReelByCmdRef) {
    const detail = detailByCmdRef.get(kk) ?? 0;
    if (detail <= 0) continue;                       // bon jamais détaillé → autre sujet (BE à scanner)
    const manque = recuReel - detail;
    if (manque < 1) continue;                        // détail complet → rien
    if (cmdRefSurSaisie.has(kk)) continue;           // déjà signalé comme sur-réception ailleurs
    const sep = kk.indexOf('|');
    const numCmd = kk.slice(0, sep);
    const k = kk.slice(sep + 1);
    const barcode = stockByRef.get(k)?.has_barcode === true;
    const surRecue = surReceptionByCmdRef.has(kk);
    if (barcode && !surRecue) continue;              // canal code-barres, reçu ≤ commandé → normal, pas une anomalie
    const cmdId = cmdIdByNum.get(numCmd);
    if (!cmdId) continue;
    if (seen.has(key('réception', cmdId, k, 'réception non détaillée'))) continue;
    const bcMention = barcode ? ` ⚠ Réf au code-barres MAIS en sur-réception (reçu > commandé) → le scan n'explique pas tout.` : '';
    nouvelles.push({
      origine: 'réception', destinataire: 'à vérifier', type_exception: 'réception non détaillée',
      commande_id: cmdId, reference_article: k,
      motif: `Réception non détaillée ${k} sur ${numCmd} : Centralink compte ${recuReel} reçus (colonne Livré) mais le détail par bon n'en montre que ${detail} → ${manque.toFixed(0)} non détaillé(s). order/view perd des lignes que la vue comptable (delivery_note) a → à vérifier (souvent double-saisie qui gonfle le reçu, parfois réception sans n° de bon).${bcMention}`,
      valeur_attendue: detail, valeur_obtenue: recuReel, ecart: manque,
      statut_exception: 'ouverte', niveau_priorite: manque >= 10 ? 'moyenne' : 'faible',
      suggestion_action_ia: `Vérifier dans Centralink (vue comptabilité → bon de livraison) la réception de ${k} sur ${numCmd} : le Livré (${recuReel}) dépasse le détail visible (${detail}) de ${manque.toFixed(0)} → confirmer s'il s'agit d'une double-saisie à supprimer (gonfle le reçu, risque facturation) ou d'une réception réelle non rattachée.${bcMention}`,
    });
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
  // (stockByRef est chargé plus haut, avant §3h.)
  for (const n of nouvelles) {
    const st = stockByRef.get(aliasRef(n.reference_article));
    if (!st || st.has_barcode !== true) continue;            // pas de bar-code connu → inchangé
    const S = Math.abs(Number(n.ecart) || 0);                // ampleur de l'écart
    const stock = Number(st.stock_cl) || 0;
    const ventes = Number(st.ventes) || 0;
    const src = st.stock_source === 'fiche' ? 'temps réel' : 'snapshot minuit';
    const couvre = stock + ventes >= S - 0.001;

    // (a) SUR-LIVRAISON §1 (reçu > commandé, dest. Colombi) + surplus §3c-bis par-réf
    // (papier ② > pointage ③), « Colombi » (cmde soldée) ou « à vérifier » (cmde ouverte).
    // Cas CR00031 : papier non pointé mais entré au code-barres → faux manque.
    if (n.type_exception === 'sur-livraison' && (n.destinataire === 'Colombi' || n.destinataire === 'à vérifier')) {
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
      continue;
    }

    // (b) SUR-SAISIE LOG (saisi ③ > papier ②) sur réf au code-barres : le surplus peut venir
    // d'une ENTRÉE SCAN (2 canaux : réception + code-barres), pas forcément un doublon de
    // commande à supprimer (cf 17655). ⚠ On NE conclut PAS « supprime » : supprimer une vraie
    // entrée scan créerait un stock négatif. Mais ce n'est pas non plus blanchi : un vrai
    // doublon de commande gonfle le reçu (facture). On annote + on baisse la priorité (haute →
    // moyenne) pour que l'humain vérifie le canal AVANT de corriger. (faire remonter, pas gommer)
    // Le sous-type « SAV saisi sous commande » est indépendant du canal stock : le SAV ne doit
    // pas compter dans le reçu, code-barres ou pas → on le laisse tel quel (reste haute).
    if (n.type_exception === 'sur-saisie log' && !/^SAV saisi sous commande/.test(n.motif) && !/^Réception saisie en double/.test(n.motif)) {
      if (n.niveau_priorite === 'haute') n.niveau_priorite = 'moyenne';
      n.motif += ` · 🏷 BAR-CODE : réf gérée au code-barres (stock CL ${src} ${stock}, ventes 90j ${ventes}) → le surplus ${S.toFixed(0)} peut être une entrée scan, PAS forcément un doublon de commande`;
      n.suggestion_action_ia = `⚠ ${n.reference_article} est géré au code-barres : AVANT de réduire la saisie, vérifier sur la fiche Centralink si le surplus ${S.toFixed(0)} est une vraie double-saisie de commande (→ corriger, impacte la facture) ou une entrée code-barres (→ NE PAS toucher, sinon stock négatif). Recouper avec le stock dispo / les mouvements.`;
      continue;
    }

    // (Les « réception non détaillée » bar-code sans sur-réception ne sont plus CRÉÉES (§3h
    //  filtre à la source) ; celles qui restent portent leur mention dès la création.)
  }

  // ── FUSION « RÉF MAL LUE À L'IMPORT » (qualité de scan) ──────────────────────
  // Une mauvaise lecture du scan (P lu au lieu de F, O au lieu de 0, chiffre inséré) crée
  // DEUX anomalies trompeuses sur le MÊME bon : la réf du papier passe « hors commande »
  // (②P sans commande) et la vraie réf saisie par la log passe « saisi hors papier » (③C
  // sans papier). Quand P et C sont à une lettre près, avec la MÊME quantité, sur le même
  // bon, c'est presque sûrement une coquille de lecture → on FUSIONNE en UNE anomalie claire
  // « corriger la réf du scan » (destinataire interne) et on retire les deux fantômes.
  // (On ne corrige rien en silence : on remonte le vrai problème = la donnée de scan à fixer.)
  const distance1 = (a: string, b: string): boolean => {
    const x = normalizeRef(a), y = normalizeRef(b);          // normalizeRef fait déjà O→0 + upper
    if (x === y) return false;                               // identiques après normalisation → pas une coquille (alias)
    if (Math.abs(x.length - y.length) > 1) return false;
    // Levenshtein ≤ 1 (substitution, insertion ou suppression d'un seul caractère)
    if (x.length === y.length) {
      let diff = 0;
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) diff++;
      return diff === 1;
    }
    const [court, long] = x.length < y.length ? [x, y] : [y, x];
    for (let i = 0, j = 0, sauts = 0; j < long.length; ) {
      if (court[i] === long[j]) { i++; j++; }
      else { if (++sauts > 1) return false; j++; }
    }
    return true;
  };
  // Saisies CL agrégées par bon + réf BRUTE (pour retrouver la vraie réf saisie par la log).
  const saisieBruteByBe = new Map<string, Map<string, number>>();
  for (const s of saisies) {
    const beId = beIdByNum.get(nbe(s.numero_be));
    if (!beId) continue;
    const ref = String(s.reference_article ?? '').trim();
    if (!ref) continue;
    const m = saisieBruteByBe.get(beId) ?? new Map<string, number>();
    m.set(ref, (m.get(ref) ?? 0) + (Number(s.quantite_recue) || 0));
    saisieBruteByBe.set(beId, m);
  }
  // On travaille PAR BON, directement sur les données (pas seulement sur les anomalies déjà
  // créées) : pour chaque réf du PAPIER non saisie sous ce bon, on cherche une réf PROCHE (à un
  // caractère près) saisie sous ce bon mais ABSENTE du papier, avec la MÊME quantité. Ça attrape
  // aussi le cas où la réf du papier est un VRAI produit commandé ailleurs (16553 Steyr au papier
  // vs 16533 CZ saisi = coquille FOURNISSEUR), que l'ancienne version (réf jamais commandée) ratait.
  const aRetirer = new Set<NewExc>();
  const vusPair = new Set<string>();
  for (const [B, refsP] of lbByBe) {
    const numBe = beNumById.get(B) ?? '';
    const saisiesB = saisieBruteByBe.get(B);
    if (!saisiesB) continue;
    for (const [P, infoP] of refsP) {
      if (infoP.qte <= 0) continue;
      if ((saisieByBeRef.get(B + '|' + P) ?? 0) > 0.001) continue; // la réf du papier EST saisie ici → vraie ligne
      let C: string | null = null, qtyC = 0;
      for (const [rawC, qC] of saisiesB) {
        const kC = aliasRef(rawC);
        if (kC === P || qC <= 0.001 || refsP.has(kC)) continue;      // C sur le papier → vraie ligne, pas un mélange
        if (Math.abs(qC - infoP.qte) > 0.5) continue;
        if (!distance1(P, kC)) continue;
        C = kC; qtyC = qC; break;
      }
      if (!C) continue;
      const dedup = `${B}|${P}|${C}`;
      if (vusPair.has(dedup)) continue;
      vusPair.add(dedup);
      // Retire les fantômes des DEUX réfs sur CE bon → une seule anomalie claire à la place.
      for (const n of nouvelles) {
        if (n.be_id !== B) continue;
        const kn = aliasRef(n.reference_article);
        if (kn === P && ['hors-commande', 'réception non détaillée', 'réception incomplète'].includes(n.type_exception)) aRetirer.add(n);
        if (kn === C && n.type_exception === 'sur-saisie log' && /^Saisi hors papier/.test(n.motif)) aRetirer.add(n);
      }
      if (seen.has(key('pointage', B, P, 'hors-commande'))) continue;
      // Papier JAMAIS commandé + CL commandé même qté = coquille de LECTURE (verdict ferme, ex.
      // FR004→PR004). Papier commandé aussi = deux vrais produits → NE PAS conclure (coquille
      // fournisseur, mauvaise saisie, ou scan) → « à vérifier ».
      const misread = !refsCommandees.has(P) && refsCommandees.has(C);
      nouvelles.push({
        origine: 'pointage', destinataire: misread ? 'interne' : 'à vérifier', type_exception: 'hors-commande',
        be_id: B, reference_article: P,
        motif: misread
          ? `Réf probablement MAL LUE au scan sur ${numBe} : le bon indique « ${P} » (qté ${infoP.qte}, jamais commandée) alors que la log a saisi « ${C} » (même qté, réf commandée) → coquille de lecture, PAS une vraie anomalie.`
          : `Référence à vérifier sur ${numBe} : le papier indique « ${P} » (qté ${infoP.qte}, non saisie sous ce bon) mais CL a saisi « ${C} » (même qté ${qtyC}, réf commandée) — deux réfs à un caractère près → coquille fournisseur, mauvaise saisie, ou scan à vérifier.`,
        valeur_attendue: infoP.qte, valeur_obtenue: qtyC, ecart: 0,
        statut_exception: 'ouverte', niveau_priorite: 'faible',
        suggestion_action_ia: misread
          ? `Corriger la référence du scan de ${numBe} : « ${P} » → « ${C} » (bouton « Re-scanner le BL » ou correction manuelle). L'anomalie disparaîtra ensuite.`
          : `Vérifier le produit physique et le BL de ${numBe} : « ${P} » vs « ${C} » (même quantité). Si le BL Colombi porte la mauvaise réf → corriger la ligne du scan vers la réf réellement reçue ; si la log a saisi la mauvaise réf → corriger dans Centralink.`,
      });
    }
  }
  if (aRetirer.size) {
    for (let i = nouvelles.length - 1; i >= 0; i--) if (aRetirer.has(nouvelles[i])) nouvelles.splice(i, 1);
  }

  let inserted = 0;
  if (nouvelles.length > 0) {
    // n° de BE en texte sur CHAQUE anomalie (affichage colonne BE + tri par bon) :
    // celui du bon importé (be_id), sinon celui déjà posé (bon CL jamais importé, §3g).
    for (const n of nouvelles) {
      if (!n.numero_be_libre && n.be_id) n.numero_be_libre = beNumById.get(n.be_id) ?? null;
    }
    // GRAPHIE RÉELLE des réfs : le moteur travaille sur des clés normalisées (O→0 : PO0022
    // devient P00022) — imbattable pour matcher, mais INTROUVABLE en recherche Centralink.
    // À l'insertion, on remet la graphie telle qu'elle s'écrit (papier en priorité — côté
    // alias Colombi — sinon saisie CL), dans la réf ET les textes. Garde-fou : uniquement si
    // même réf à normalisation près (O↔0) — on ne remplace JAMAIS un code par son alias
    // (LTL014 reste LTL014, pas LTLPK03). Idempotence intacte : key() normalise déjà.
    const rawByKey = new Map<string, string>();
    for (const s of saisies) {
      const k2 = aliasRef(s.reference_article); const raw = String(s.reference_article ?? '').trim();
      if (k2 && raw && !rawByKey.has(k2)) rawByKey.set(k2, raw);
    }
    for (const l of lignesBe) {
      const k2 = aliasRef(l.reference_article); const raw = String(l.reference_article ?? '').trim();
      if (k2 && raw) rawByKey.set(k2, raw);   // le papier écrase (graphie de référence)
    }
    for (const n of nouvelles) {
      if (!n.reference_article) continue;
      // anomalie de BON : la réf est une LISTE « A, B, C » → graphie réelle réf par réf
      for (const k2 of n.reference_article.split(', ')) {
        if (!k2) continue;
        const raw = rawByKey.get(aliasRef(k2));
        if (raw && raw !== k2 && normalizeRef(raw) === normalizeRef(k2)) {
          n.motif = n.motif.split(k2).join(raw);
          if (n.suggestion_action_ia) n.suggestion_action_ia = n.suggestion_action_ia.split(k2).join(raw);
          n.reference_article = n.reference_article.split(k2).join(raw);
        }
      }
    }
    const { error, count } = await sb.from('exceptions').insert(nouvelles, { count: 'exact' });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    inserted = count ?? nouvelles.length;
  }

  const parOrigine = (o: string) => nouvelles.filter((n) => n.origine === o).length;
  return NextResponse.json({
    inserees: inserted,
    purgees,
    detail: { réception: parOrigine('réception'), pointage: parOrigine('pointage'), facturation: parOrigine('facturation') },
    deja_presentes: seen.size,
  });
}
