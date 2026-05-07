import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

function adminSb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(),
  );
}

export async function POST(req: NextRequest) {
  const { fileName } = await req.json() as { fileName: string };
  const sanitized = String(fileName ?? 'document.pdf').replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `temp/${Date.now()}-${Math.random().toString(36).slice(2)}-${sanitized}`;

  const sb = adminSb();
  const { data, error } = await sb.storage
    .from('documents')
    .createSignedUploadUrl(path);

  if (error || !data) {
    return NextResponse.json({ error: error?.message ?? 'Erreur storage' }, { status: 500 });
  }

  return NextResponse.json({ signedUrl: data.signedUrl, path, token: data.token });
}
