import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

function adminSb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

const STATUTS = ['à analyser', 'vérifié', 'corrigé', 'accepté', 'ignoré'].map(s => s.normalize('NFC'));

// POST : enregistrer/mettre à jour la décision sur un écart de pointage (BE + référence)
export async function POST(req: NextRequest) {
  const { numero_be, reference_article, statut, note } = await req.json() as {
    numero_be: string; reference_article: string; statut?: string; note?: string | null;
  };

  if (!numero_be || !reference_article) {
    return NextResponse.json({ error: 'numero_be et reference_article requis' }, { status: 400 });
  }
  const statutNorm = statut !== undefined ? statut.normalize('NFC') : undefined;
  if (statutNorm !== undefined && !STATUTS.includes(statutNorm)) {
    return NextResponse.json({ error: 'statut invalide' }, { status: 400 });
  }

  const sb = adminSb();
  const payload: Record<string, unknown> = {
    numero_be, reference_article, updated_at: new Date().toISOString(),
  };
  if (statutNorm !== undefined) payload.statut = statutNorm;
  if (note !== undefined) payload.note = note;

  const { error } = await sb
    .from('pointage_resolution')
    .upsert(payload, { onConflict: 'numero_be,reference_article' });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await sb.from('journal_activite').insert({
    type_action: 'pointage_resolution',
    entite_type: 'be_reception',
    entite_id: null,
    details_action: JSON.stringify({ numero_be, reference_article, statut, note }),
  });

  return NextResponse.json({ ok: true });
}
