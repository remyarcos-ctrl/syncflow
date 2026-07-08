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
  for (const l of lignesCmd) {
    const num = cmdNum.get(l.commande_id);
    if (!num) continue;
    const kk = `${num}|${aliasRef(l.reference_article)}`;
    recuReelByCmdRef.set(kk, (recuReelByCmdRef.get(kk) ?? 0) + (Number(l.quantite_receptionnee_reelle) || 0));
    if ((Number(l.quantite_receptionnee_reelle) || 0) > (Number(l.quantite_commandee) || 0) + 0.001) surReceptionByCmdRef.add(kk);
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
    sb.from('stocks_cl').select('reference_article, stock_cl, floating, has_barcode, ventes, stock_source'));
  const stockByRef = new Map<string, { stock_cl: number | null; floating: number | null; has_barcode: boolean | null; ventes: number | null; stock_source: string | null }>();
  for (const s of (stkR.data ?? [])) {
    const k = aliasRef(s.reference_article as string);
    if (k && !stockByRef.has(k)) stockByRef.set(k, s as never);
  }

  // ── 3g) DOUBLE SAISIE DE RÉCEPTION (lignes saisie STRICTEMENT identiques) ──────
  // Quand la log saisit la réception d'un même bon plusieurs fois dans Centralink, la même
  // ligne (n° BE + réf + qté + commande) revient à l'identique N fois → le « reçu » est gonflé.
  // On l'attrape DIRECTEMENT, AVANT les garde-fous code-barres/conditionnement — sinon le couac
  // est masqué (ex. PO0005 lu comme « conditionnement », 17655 adouci par le bar-code). C'est du
  // pointage en trop côté log (le STOCK réel n'est pas touché, cf. 2 couches Centralink distinctes).
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
    if (!beId) continue;                               // bon non scanné → pas d'ancre fiable
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
        // Saisi ailleurs (même garde-fou que l'écran) : RIEN saisi sous CE bon mais la réf
        // est reçue ailleurs dans Centralink → saisie sous un autre n° de bon, pas un oubli.
        if (saisie <= 0.001 && (recuTotalParRef.get(k) ?? 0) > 0.001) continue;
        // Détail incomplet (§3h) : la part du Livré global non détaillée par bon couvre le
        // manque → order/view perd des lignes, la marchandise EST comptée — pas un oubli.
        if ((nonDetailleParRef.get(k) ?? 0) >= manque - 0.001) continue;
        // OUBLI LOG : le BL papier déclare livré, la saisie sous ce bon est en dessous ET la
        // commande attend encore du reliquat → la réception n'a pas été saisie. Le reliquat
        // est le signal qui corrobore le papier : si la marchandise était saisie sous un
        // autre bon, la commande serait servie. Conséquences si on ne corrige pas : commande
        // jamais soldée, reçu ③ faux (base du contrôle factures ④), risque de re-commander.
        const reste = resteParRef.get(k) ?? 0;
        if (reste > 0.001) {
          oubliLogRefs.add(k);   // avant le seen : §3c-bis ne double pas, même si l'anomalie existe déjà
          if (seen.has(key('pointage', beId, k, 'oubli log'))) continue;
          const bc = stockByRef.get(k)?.has_barcode
            ? ' 🏷 Réf au code-barres : le stock physique est probablement déjà entré par scan — la saisie sous le bon reste à faire pour solder la commande (le pointage ne touche pas le stock).'
            : '';
          nouvelles.push({
            origine: 'pointage', destinataire: 'log', type_exception: 'oubli log',
            be_id: beId, reference_article: k,
            motif: `Oubli de saisie ${k} sur ${numBe} : BL papier ${papier} / saisi ${saisie} → ${manque.toFixed(0)} non saisi(s), commande(s) encore en attente (${reste.toFixed(0)} à recevoir)`,
            valeur_attendue: papier, valeur_obtenue: saisie, ecart: -manque,
            statut_exception: 'ouverte', niveau_priorite: 'moyenne',
            suggestion_action_ia: `Corriger dans Centralink : saisir ${manque.toFixed(0)} ${k} sous ${numBe} (BL papier ${papier}, saisi ${saisie}) — la commande en attente se soldera.${bc}`,
          });
          continue;
        }
        // Sinon (commandes soldées) : le vrai écart déclaration/comptage est jugé PAR
        // RÉFÉRENCE (total vs total) en §3c-bis, où avoirs et régules sont pris en compte.
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
  const cmdIdByNum = new Map((cmdR.data ?? []).map((c) => [c.numero_commande_interne, c.id]));
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
  const aRetirer = new Set<NewExc>();
  for (const hc of nouvelles.filter((n) => n.type_exception === 'hors-commande' && n.be_id)) {
    const B = hc.be_id!;
    const qP = Number(hc.valeur_obtenue) || 0;
    // La vraie réf saisie par la log sur CE bon : même quantité, commandée, absente du papier
    // de ce bon (sinon ce n'est pas une coquille), et à une lettre près de la réf du scan.
    let vraie: string | null = null;
    for (const [C, qC] of saisieBruteByBe.get(B) ?? []) {
      if (Math.abs(qC - qP) > 0.5) continue;
      if (!refsCommandees.has(aliasRef(C))) continue;
      if (lbByBe.get(B)?.has(aliasRef(C))) continue;
      if (!distance1(hc.reference_article, C)) continue;
      vraie = C; break;
    }
    if (!vraie) continue;
    aRetirer.add(hc);
    // Retire aussi le « saisi hors papier » fantôme de la vraie réf sur ce bon, s'il existe.
    const kVraie = aliasRef(vraie);
    for (const n of nouvelles) {
      if (n.be_id === B && n.type_exception === 'sur-saisie log'
          && aliasRef(n.reference_article) === kVraie && /^Saisi hors papier/.test(n.motif)) aRetirer.add(n);
    }
    const numBe = beNumById.get(B) ?? '';
    if (seen.has(key('pointage', B, hc.reference_article, 'hors-commande'))) continue;
    nouvelles.push({
      origine: 'pointage', destinataire: 'interne', type_exception: 'hors-commande',
      be_id: B, reference_article: hc.reference_article,
      motif: `Réf probablement MAL LUE au scan sur ${numBe} : le bon importé indique « ${hc.reference_article} » (qté ${qP}, jamais commandée) alors que la log a saisi « ${vraie} » (même qté, réf commandée) → coquille de lecture du scan, PAS une vraie anomalie.`,
      valeur_attendue: qP, valeur_obtenue: qP, ecart: 0,
      statut_exception: 'ouverte', niveau_priorite: 'faible',
      suggestion_action_ia: `Vérifier le BL papier de ${numBe} et corriger la référence du scan : « ${hc.reference_article} » → « ${vraie} » (bouton « Re-scanner le BL » ou correction manuelle). L'anomalie disparaîtra ensuite.`,
    });
  }
  if (aRetirer.size) {
    for (let i = nouvelles.length - 1; i >= 0; i--) if (aRetirer.has(nouvelles[i])) nouvelles.splice(i, 1);
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
    purgees,
    detail: { réception: parOrigine('réception'), pointage: parOrigine('pointage'), facturation: parOrigine('facturation') },
    deja_presentes: seen.size,
  });
}
