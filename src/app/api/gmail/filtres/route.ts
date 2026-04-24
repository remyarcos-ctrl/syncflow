import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getGmailConfig } from '@/lib/gmail-api';

function adminSb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

export async function GET() {
  const config = await getGmailConfig();
  return NextResponse.json({ filtres: config?.filtres_fournisseurs ?? [] });
}

export async function PATCH(req: NextRequest) {
  const { filtres } = await req.json() as { filtres: string[] };
  if (!Array.isArray(filtres)) {
    return NextResponse.json({ error: 'filtres doit être un tableau' }, { status: 400 });
  }

  const config = await getGmailConfig();
  if (!config) {
    return NextResponse.json({ error: 'Gmail non configuré' }, { status: 404 });
  }

  const clean = filtres.map(f => String(f).trim()).filter(Boolean);
  const sb = adminSb();
  const { error } = await sb.from('gmail_config').update({ filtres_fournisseurs: clean }).eq('id', config.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, filtres: clean });
}
