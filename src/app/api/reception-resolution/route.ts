import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

function adminSb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

const CLASSEMENTS = [
  'à classer', 'pièce détachée', 'sur-livraison Colombi',
  'hors-commande Colombi', 'commandé autrement', 'surplus vu DH (gardé)', 'résolu',
].map(s => s.normalize('NFC'));

// POST : étiqueter une anomalie de réception (BE + référence)
export async function POST(req: NextRequest) {
  const { be_id, reference_article, classement, note } = await req.json() as {
    be_id: string; reference_article: string; classement?: string; note?: string | null;
  };

  if (!be_id || !reference_article) {
    return NextResponse.json({ error: 'be_id et reference_article requis' }, { status: 400 });
  }
  const classNorm = classement !== undefined ? classement.normalize('NFC') : undefined;
  if (classNorm !== undefined && !CLASSEMENTS.includes(classNorm)) {
    return NextResponse.json({ error: 'classement invalide' }, { status: 400 });
  }

  const sb = adminSb();
  const payload: Record<string, unknown> = {
    be_id, reference_article, updated_at: new Date().toISOString(),
  };
  if (classNorm !== undefined) payload.classement = classNorm;
  if (note !== undefined) payload.note = note;

  const { error } = await sb
    .from('reception_resolution')
    .upsert(payload, { onConflict: 'be_id,reference_article' });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
