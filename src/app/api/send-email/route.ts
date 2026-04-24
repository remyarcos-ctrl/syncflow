import { NextRequest, NextResponse } from 'next/server';
import { getValidToken, sendEmail } from '@/lib/gmail-api';
import { createClient } from '@supabase/supabase-js';

function adminSb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

export async function POST(req: NextRequest) {
  const { to, subject, body, beId } = await req.json() as {
    to: string;
    subject: string;
    body: string;
    beId?: string;
  };

  if (!to || !subject || !body) {
    return NextResponse.json({ error: 'to, subject et body requis' }, { status: 400 });
  }

  const tokenData = await getValidToken();
  if (!tokenData) {
    return NextResponse.json({ error: 'Gmail non connecté ou token invalide' }, { status: 401 });
  }

  try {
    await sendEmail(tokenData.token, {
      from: tokenData.config.email,
      to,
      subject,
      body,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('403') || msg.includes('insufficient')) {
      return NextResponse.json({
        error: 'Scope Gmail insuffisant — reconnectez votre compte Gmail pour autoriser l\'envoi',
        code: 'SCOPE_MISSING',
      }, { status: 403 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  // Journal d'activité
  if (beId) {
    await adminSb().from('journal_activite').insert({
      type_action: 'email_avoir_envoye',
      entite_type: 'be_reception',
      entite_id: beId,
      details_action: JSON.stringify({ to, subject }),
    });
  }

  return NextResponse.json({ ok: true });
}
