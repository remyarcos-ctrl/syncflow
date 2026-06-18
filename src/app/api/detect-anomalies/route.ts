import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { controlerReceptions, normalizeRef, type LigneBeInput, type LigneCmdInput } from '@/lib/reception';
import {
  controlerLignesFacture,
  type LigneFactureInput, type LigneCommandeInput, type CommandeInput, type SaisieInput,
} from '@/lib/facturation';

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
}

// POST : détecte les anomalies des 3 contrôles et les déverse dans `exceptions`
// (idempotent : clé = origine | ancre (be/facture) | réf | type).
export async function POST() {
  const sb = adminSb();

  const [lbeR, lcR, saisR, beR, lfR, factR, cmdR, exR] = await Promise.all([
    sb.from('lignes_be').select('be_id, reference_article, designation, quantite_receptionnee, hors_systeme, statut_retour'),
    sb.from('lignes_commande').select('commande_id, reference_article, quantite_commandee, pu_commande, quantite_receptionnee_reelle, quantite_restante_a_recevoir'),
    sb.from('saisies_cl').select('numero_be, reference_article, quantite_recue, commande_ref'),
    sb.from('be_receptions').select('id, numero_be'),
    sb.from('lignes_facture').select('id, facture_id, ligne_no, reference_article, designation, quantite_facturee, pu_facture, montant_ht, numero_be_detecte'),
    sb.from('factures').select('id'),
    sb.from('commandes').select('id, numero_commande_interne, bls_centralink'),
    sb.from('exceptions').select('be_id, facture_id, reference_article, type_exception, origine')
      .in('origine', ['réception', 'pointage', 'facturation']),
  ]);

  const lignesBe = lbeR.data ?? [];
  const lignesCmd = (lcR.data ?? []);
  const saisies = saisR.data ?? [];
  const lignesFact = (lfR.data ?? []) as LigneFactureInput[];
  const commandes = (cmdR.data ?? []) as CommandeInput[];

  // clés déjà présentes
  const seen = new Set(
    (exR.data ?? []).map((e) => `${e.origine}|${e.be_id ?? e.facture_id ?? ''}|${normalizeRef(e.reference_article)}|${e.type_exception}`),
  );
  const key = (o: string, ancre: string, ref: string, type: string) => `${o}|${ancre}|${normalizeRef(ref)}|${type}`;
  const nouvelles: NewExc[] = [];

  // ── 1) RÉCEPTION → Colombi ──────────────────────────────────────────────────
  const beForRecep = lignesBe.filter((l) => !l.hors_systeme && (l.quantite_receptionnee ?? 0) > 0) as LigneBeInput[];
  const recep = controlerReceptions(beForRecep, lignesCmd as LigneCmdInput[]);
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
    nouvelles.push({
      origine: 'réception', destinataire: 'Colombi', type_exception: type, be_id: c.be_id, reference_article: c.ref,
      motif: c.verdict === 'sur_livraison'
        ? `Sur-livraison ${c.ref} : commandé ${c.totalCommande} / reçu ${c.totalRecu}${c.totalRetour ? ` / déjà retourné ${c.totalRetour}` : ''} → +${ecart} à traiter`
        : `Hors commande ${c.ref} : reçu ${c.qteBe}, jamais commandé`,
      valeur_attendue: c.verdict === 'sur_livraison' ? c.totalCommande : null,
      valeur_obtenue: c.verdict === 'sur_livraison' ? c.totalRecu : c.qteBe,
      ecart, statut_exception: 'ouverte', niveau_priorite: 'moyenne',
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
      if (seen.has(key('pointage', '', badN, 'numéro BE invalide'))) continue;
      nouvelles.push({
        origine: 'pointage', destinataire: 'log', type_exception: 'numéro BE invalide',
        commande_id: c.id, reference_article: badN,
        motif: `N° de BE impossible « ${badN} » (mois ${m[2]}) — probable faute de frappe à corriger dans Centralink`,
        valeur_attendue: null, valeur_obtenue: null, ecart: null,
        statut_exception: 'ouverte', niveau_priorite: 'faible',
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
