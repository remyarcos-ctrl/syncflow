import { NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return Response.json({ error: 'CRON_SECRET non configuré' }, { status: 500 });
  }
  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${cronSecret}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { data: factures } = await supabase
    .from('factures')
    .select('id')
    .in('statut_facture', ['importée', 'partiellement rapprochée', 'en cours de rapprochement'])
    .limit(50);

  let total = 0;
  for (const f of (factures ?? [])) {
    const res = await fetch(`${BASE_URL}/api/matching`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ facture_id: f.id }),
    });
    if (res.ok) {
      const json = await res.json() as { rapprochements_crees?: number };
      total += json.rapprochements_crees ?? 0;
    }
  }

  if (total > 0) {
    await supabase.from('notifications').insert({
      type: 'matching_auto',
      message: `🔄 Matching du soir : ${total} nouveau${total > 1 ? 'x' : ''} rapprochement${total > 1 ? 's' : ''} créé${total > 1 ? 's' : ''} sur ${factures?.length ?? 0} facture${(factures?.length ?? 0) > 1 ? 's' : ''} traitée${(factures?.length ?? 0) > 1 ? 's' : ''}.`,
      lu: false,
    });
  }

  return Response.json({ ok: true, factures_traitees: factures?.length ?? 0, rapprochements_crees: total });
}
