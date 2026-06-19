import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { normalizeRef } from '@/lib/reception';

function adminSb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(),
  );
}

// POST   : classe une référence / une anomalie en pièce détachée SAV (hors Centralink).
//   - enregistre la réf dans refs_sav → ses futures « hors-commande » iront en SAV,
//     et ses sur-livraisons porteront le badge « réf aussi SAV ».
//   - bascule l'anomalie cliquée (exception_id, peu importe son type) vers SAV.
//   - bascule aussi toutes ses hors-commande ouvertes (cas non ambigu : jamais commandé).
// DELETE  : opération inverse (retire la réf du SAV, repasse les anomalies en Colombi).
async function handle(req: Request, retirer: boolean) {
  const sb = adminSb();
  let body: { reference_article?: string; exception_id?: string; note?: string };
  try { body = await req.json(); } catch { body = {}; }
  const refLabel = (body.reference_article ?? '').trim();
  const ref = normalizeRef(refLabel);
  if (!ref) return NextResponse.json({ error: 'Référence manquante' }, { status: 400 });

  const dest = retirer ? 'Colombi' : 'SAV';
  const prio = retirer ? 'moyenne' : 'faible';

  if (retirer) await sb.from('refs_sav').delete().eq('reference_article', ref);
  else {
    const up = await sb.from('refs_sav')
      .upsert({ reference_article: ref, ref_label: refLabel, note: body.note ?? null }, { onConflict: 'reference_article' });
    if (up.error) return NextResponse.json({ error: up.error.message }, { status: 500 });
  }

  // 1) l'anomalie cliquée (n'importe quel type : hors-commande OU sur-livraison)
  if (body.exception_id) {
    const { error } = await sb.from('exceptions')
      .update({ destinataire: dest, niveau_priorite: prio })
      .eq('id', body.exception_id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // 2) toutes les hors-commande ouvertes de cette réf (cas non ambigu)
  const bulk = await sb.from('exceptions')
    .update({ destinataire: dest, niveau_priorite: prio })
    .eq('type_exception', 'hors-commande').eq('reference_article', refLabel)
    .eq('destinataire', retirer ? 'SAV' : 'Colombi')
    .in('statut_exception', ['ouverte', 'en cours']);
  if (bulk.error) return NextResponse.json({ error: bulk.error.message }, { status: 500 });

  return NextResponse.json({ ok: true, sav: !retirer, reference_article: ref });
}

export async function POST(req: Request) { return handle(req, false); }
export async function DELETE(req: Request) { return handle(req, true); }
