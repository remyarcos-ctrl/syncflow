import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

function adminSb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

export async function GET() {
  const sb = adminSb();
  const { data, error } = await sb
    .from('notifications')
    .select('*')
    .order('lu', { ascending: true })
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ notifications: data ?? [] });
}

export async function PATCH(req: NextRequest) {
  const body = await req.json() as { ids?: string[]; all?: boolean };
  const sb = adminSb();

  let query = sb.from('notifications').update({ lu: true });
  if (body.all) {
    query = query.eq('lu', false);
  } else if (body.ids?.length) {
    query = query.in('id', body.ids);
  } else {
    return NextResponse.json({ error: 'ids ou all requis' }, { status: 400 });
  }

  const { error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  const sb = adminSb();
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  await sb.from('notifications').delete().eq('lu', true).lt('created_at', cutoff);
  return NextResponse.json({ ok: true });
}
