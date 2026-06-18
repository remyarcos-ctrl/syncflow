import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { controlerReceptions, normalizeRef, type LigneBeInput, type LigneCmdInput } from '@/lib/reception';
import { comparerPointage, causeEcart } from '@/lib/pointage';
import type { LigneBE, SaisieCL } from '@/types';
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
  be_id?: string | null; facture_id?: string | null; reference_article: string;
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
    sb.from('commandes').select('id, numero_commande_interne'),
    sb.from('exceptions').select('be_id, facture_id, reference_article, type_exception, origine')
      .in('origine', ['réception', 'pointage', 'facturation']),
  ]);

  const lignesBe = lbeR.data ?? [];
  const lignesCmd = (lcR.data ?? []);
  const saisies = saisR.data ?? [];
  const bes = beR.data ?? [];
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
  for (const c of recep) {
    if (c.verdict !== 'sur_livraison' && c.verdict !== 'hors_commande') continue;
    const type = TYPE_R[c.verdict];
    if (seen.has(key('réception', c.be_id, c.ref, type))) continue;
    const ecart = c.verdict === 'sur_livraison' ? (c.totalRecu ?? 0) - (c.totalCommande ?? 0) : c.qteBe;
    nouvelles.push({
      origine: 'réception', destinataire: 'Colombi', type_exception: type, be_id: c.be_id, reference_article: c.ref,
      motif: c.verdict === 'sur_livraison'
        ? `Sur-livraison ${c.ref} : commandé ${c.totalCommande} / reçu ${c.totalRecu} (+${ecart})`
        : `Hors commande ${c.ref} : reçu ${c.qteBe}, jamais commandé`,
      valeur_attendue: c.verdict === 'sur_livraison' ? c.totalCommande : null,
      valeur_obtenue: c.verdict === 'sur_livraison' ? c.totalRecu : c.qteBe,
      ecart, statut_exception: 'ouverte', niveau_priorite: 'moyenne',
    });
  }

  // ── 2) POINTAGE → log ───────────────────────────────────────────────────────
  const refsReliquat = new Set(
    lignesCmd.filter((l) => (l.quantite_restante_a_recevoir ?? 0) > 0.001).map((l) => normalizeRef(l.reference_article)).filter(Boolean),
  );
  // Réfs reçues quelque part dans Centralink (reçu > 0) → saisies, même si sous un autre BE.
  const recuParRef = new Map<string, number>();
  for (const l of lignesCmd) {
    const k = normalizeRef(l.reference_article);
    recuParRef.set(k, (recuParRef.get(k) ?? 0) + (Number(l.quantite_receptionnee_reelle) || 0));
  }
  const refsRecues = new Set([...recuParRef].filter(([, v]) => v > 0).map(([k]) => k));
  const lbeByBe = new Map<string, LigneBE[]>();
  for (const l of lignesBe) { const a = lbeByBe.get(l.be_id) ?? []; a.push(l as unknown as LigneBE); lbeByBe.set(l.be_id, a); }
  const saisByBe = new Map<string, SaisieCL[]>();
  for (const s of saisies) { const a = saisByBe.get(s.numero_be) ?? []; a.push(s as unknown as SaisieCL); saisByBe.set(s.numero_be, a); }
  const TYPE_P: Record<string, string> = { oubli_log: 'oubli log', sur_saisie: 'sur-saisie log' };
  for (const be of bes) {
    const sa = saisByBe.get(be.numero_be); if (!sa?.length) continue;
    const rows = comparerPointage(lbeByBe.get(be.id) ?? [], sa, [], refsReliquat, refsRecues);
    for (const e of rows) {
      const code = causeEcart(e).code;
      if (code !== 'oubli_log' && code !== 'sur_saisie') continue;
      const type = TYPE_P[code];
      if (seen.has(key('pointage', be.id, e.ref, type))) continue;
      nouvelles.push({
        origine: 'pointage', destinataire: 'log', type_exception: type, be_id: be.id, reference_article: e.ref,
        motif: `${causeEcart(e).label} — ${e.ref} : BL ${e.papier ?? 0} / CL ${e.cl ?? 0}`,
        valeur_attendue: e.papier, valeur_obtenue: e.cl, ecart: e.ecart,
        statut_exception: 'ouverte', niveau_priorite: 'moyenne',
      });
    }
  }

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
