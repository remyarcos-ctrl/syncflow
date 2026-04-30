import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

function adminSb() {
  return createClient(
    (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim(),
    (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim(),
  );
}

export async function POST(req: NextRequest) {
  const { rating, message } = await req.json() as { rating: 'up' | 'down'; message?: string };
  if (!rating) return NextResponse.json({ ok: false, error: 'missing_rating' }, { status: 400 });

  const sb = adminSb();
  const key = `feedback_${rating}_${Date.now()}`;
  await sb.from('teddy_memory').insert({
    cle: key,
    valeur: message ? `[${rating.toUpperCase()}] ${message}` : rating,
    categorie: 'feedback',
    updated_at: new Date().toISOString(),
  });

  return NextResponse.json({ ok: true });
}
