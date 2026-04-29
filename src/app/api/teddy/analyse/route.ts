import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

function adminSb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

// Seuils par défaut — surchargés par teddy_memory si présents
const DEFAULT_SEUIL_ECART = 5;        // % écart de prix auto-résolvable
const DEFAULT_SEUIL_SCORE = 0.85;     // score rapprochement auto-validable
const DEFAULT_SEUIL_BE_JOURS = 10;    // jours sans facture avant relance proposée

async function getThreshold(sb: ReturnType<typeof adminSb>, cle: string, defaut: number): Promise<number> {
  const { data } = await sb.from('teddy_memory').select('valeur').eq('cle', cle).maybeSingle();
  return data ? parseFloat(String(data.valeur)) || defaut : defaut;
}

export async function POST() {
  const sb = adminSb();

  const [seuilEcart, seuilScore, seuilBeJours] = await Promise.all([
    getThreshold(sb, 'seuil_auto_ecart_pct', DEFAULT_SEUIL_ECART),
    getThreshold(sb, 'seuil_auto_score_rapprochement', DEFAULT_SEUIL_SCORE),
    getThreshold(sb, 'seuil_be_jours_sans_facture', DEFAULT_SEUIL_BE_JOURS),
  ]);

  const actionsAInserer: object[] = [];

  // ── 1. Exceptions avec écart de prix dans la tolérance ──────────────────────
  const { data: exceptions } = await sb
    .from('exceptions')
    .select('id, type_exception, motif, entite_type, entite_id, niveau_priorite')
    .in('statut_exception', ['ouverte', 'en cours'])
    .ilike('type_exception', '%prix%')
    .limit(50);

  for (const ex of exceptions ?? []) {
    const motif = String((ex as Record<string, unknown>).motif ?? '');
    const ecartMatch = motif.match(/(\d+[.,]\d+)\s*%/);
    if (!ecartMatch) continue;
    const ecartPct = parseFloat(ecartMatch[1].replace(',', '.'));
    if (ecartPct <= seuilEcart) {
      actionsAInserer.push({
        type_action: 'resoudre_exception',
        description: `Exception d'écart de prix de **${ecartPct.toFixed(1)}%** — dans la tolérance de ${seuilEcart}%. Résolution automatique possible.`,
        entite_type: 'exception',
        entite_id: (ex as Record<string, unknown>).id as string,
        payload: { exception_id: (ex as Record<string, unknown>).id, ecart_pct: ecartPct },
        risque: 'low',
      });
    }
  }

  // ── 2. Rapprochements proposés avec score élevé ──────────────────────────────
  const { data: rapprochements } = await sb
    .from('rapprochements')
    .select('id, score_match, facture_id, be_id')
    .eq('statut_validation', 'proposé')
    .gte('score_match', seuilScore)
    .limit(30);

  for (const r of rapprochements ?? []) {
    const row = r as Record<string, unknown>;
    const score = Number(row.score_match ?? 0);
    actionsAInserer.push({
      type_action: 'valider_rapprochement',
      description: `Rapprochement avec un score de **${Math.round(score * 100)}%** — au-dessus du seuil de ${Math.round(seuilScore * 100)}%. Validation automatique possible.`,
      entite_type: 'rapprochement',
      entite_id: row.id as string,
      payload: { rapprochement_id: row.id, score },
      risque: 'low',
    });
  }

  // ── 3. Lignes commande sans prix mais catalogue disponible ───────────────────
  const { data: lignesSansPrix } = await sb
    .from('lignes_commande')
    .select('id, reference_article, designation, quantite_commandee, commande_id')
    .is('pu_commande', null)
    .not('reference_article', 'is', null)
    .limit(30);

  for (const l of lignesSansPrix ?? []) {
    const row = l as Record<string, unknown>;
    if (!row.reference_article) continue;
    const { data: prix } = await sb
      .from('prix_reference')
      .select('pu_last')
      .eq('reference_article', row.reference_article)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!prix) continue;
    actionsAInserer.push({
      type_action: 'corriger_prix',
      description: `Ligne **${row.designation ?? row.reference_article}** sans prix — prix catalogue disponible : **${Number(prix.pu_last).toFixed(2)} €**. Mise à jour automatique possible.`,
      entite_type: 'ligne_commande',
      entite_id: row.id as string,
      payload: {
        ligne_id: row.id,
        commande_id: row.commande_id,
        pu_catalogue: prix.pu_last,
        quantite: row.quantite_commandee,
        reference: row.reference_article,
      },
      risque: 'low',
    });
  }

  // ── 4. BEs anciens sans facture (relance recommandée) ────────────────────────
  const cutoff = new Date(Date.now() - seuilBeJours * 86400000).toISOString();
  const { data: besAnciens } = await sb
    .from('be_receptions')
    .select('id, numero_be, fournisseur, date_reception, created_at')
    .in('statut_be', ['reçu', 'partiellement facturé'])
    .lte('created_at', cutoff)
    .limit(20);

  for (const be of besAnciens ?? []) {
    const row = be as Record<string, unknown>;
    const jours = Math.floor((Date.now() - new Date(row.created_at as string).getTime()) / 86400000);
    actionsAInserer.push({
      type_action: 'relance_be',
      description: `BE **${row.numero_be}** (${row.fournisseur}) — **${jours} jours** sans facture. Relance fournisseur recommandée.`,
      entite_type: 'be_reception',
      entite_id: row.id as string,
      payload: { be_id: row.id, numero_be: row.numero_be, fournisseur: row.fournisseur, jours },
      risque: 'medium',
    });
  }

  // ── Insérer uniquement les nouvelles actions (pas de doublons sur entite_id) ──
  if (actionsAInserer.length > 0) {
    const { data: existantes } = await sb
      .from('teddy_actions_proposees')
      .select('entite_id')
      .eq('statut', 'proposée');
    const existantesIds = new Set((existantes ?? []).map((e: Record<string, unknown>) => e.entite_id));
    const nouvelles = actionsAInserer.filter((a) => {
      const row = a as Record<string, unknown>;
      return !existantesIds.has(row.entite_id as string);
    });
    if (nouvelles.length > 0) {
      await sb.from('teddy_actions_proposees').insert(nouvelles);
    }
  }

  const { data: toutes, count } = await sb
    .from('teddy_actions_proposees')
    .select('*', { count: 'exact' })
    .eq('statut', 'proposée')
    .order('created_at', { ascending: false });

  return NextResponse.json({ actions: toutes ?? [], total: count ?? 0, nouvelles_creees: actionsAInserer.length });
}
