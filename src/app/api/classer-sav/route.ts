import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { normalizeRef } from '@/lib/reception';

function adminSb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(),
  );
}

// POST   : classe une référence en pièce détachée SAV (hors Centralink).
//          → ajoute la réf à refs_sav + bascule ses anomalies hors-commande ouvertes
//            vers le destinataire « SAV » (priorité faible). Géré pour toujours.
// DELETE  : retire la réf du SAV → ses anomalies hors-commande repassent « Colombi ».
async function handle(req: Request, retirer: boolean) {
  const sb = adminSb();
  let body: { reference_article?: string; note?: string };
  try { body = await req.json(); } catch { body = {}; }
  const refLabel = (body.reference_article ?? '').trim();
  const ref = normalizeRef(refLabel);
  if (!ref) return NextResponse.json({ error: 'Référence manquante' }, { status: 400 });

  if (retirer) {
    await sb.from('refs_sav').delete().eq('reference_article', ref);
    const { error } = await sb.from('exceptions')
      .update({ destinataire: 'Colombi', niveau_priorite: 'moyenne' })
      .eq('type_exception', 'hors-commande').eq('destinataire', 'SAV')
      .in('statut_exception', ['ouverte', 'en cours']).eq('reference_article', refLabel);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, sav: false, reference_article: ref });
  }

  const up = await sb.from('refs_sav')
    .upsert({ reference_article: ref, ref_label: refLabel, note: body.note ?? null }, { onConflict: 'reference_article' });
  if (up.error) return NextResponse.json({ error: up.error.message }, { status: 500 });

  // Bascule les anomalies hors-commande ouvertes de cette réf vers SAV.
  const { error } = await sb.from('exceptions')
    .update({
      destinataire: 'SAV', niveau_priorite: 'faible',
      motif: `Pièce détachée SAV ${refLabel} : livrée hors commande (hors Centralink)`,
    })
    .eq('type_exception', 'hors-commande')
    .in('statut_exception', ['ouverte', 'en cours']).eq('reference_article', refLabel);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, sav: true, reference_article: ref });
}

export async function POST(req: Request) { return handle(req, false); }
export async function DELETE(req: Request) { return handle(req, true); }
