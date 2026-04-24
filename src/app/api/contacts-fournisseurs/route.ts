import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

function adminSb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

export async function GET(req: NextRequest) {
  const fournisseur = req.nextUrl.searchParams.get('fournisseur');
  if (!fournisseur) return NextResponse.json({ error: 'fournisseur requis' }, { status: 400 });

  const { data, error } = await adminSb()
    .from('contacts_fournisseurs')
    .select('*')
    .eq('fournisseur', fournisseur)
    .order('created_at');

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  const body = await req.json() as { fournisseur: string; nom?: string; email: string; role?: string };
  if (!body.fournisseur || !body.email) {
    return NextResponse.json({ error: 'fournisseur et email requis' }, { status: 400 });
  }

  const { data, error } = await adminSb()
    .from('contacts_fournisseurs')
    .insert({ fournisseur: body.fournisseur, nom: body.nom ?? null, email: body.email, role: body.role ?? null })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id requis' }, { status: 400 });

  const { error } = await adminSb().from('contacts_fournisseurs').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
