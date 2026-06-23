import { NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const maxDuration = 60;
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return Response.json({ error: 'CRON_SECRET non configuré' }, { status: 500 });
  }
  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${cronSecret}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const [resExc, resBes, resRapp, resFactNonRap] = await Promise.all([
    supabase.from('exceptions').select('id', { count: 'exact', head: true }).in('statut_exception', ['ouverte', 'en cours']),
    supabase.from('be_receptions').select('id', { count: 'exact', head: true }).in('statut_be', ['reçu', 'partiellement facturé']).lte('created_at', sevenDaysAgo),
    supabase.from('rapprochements').select('id', { count: 'exact', head: true }).eq('statut_validation', 'proposé'),
    supabase.from('factures').select('id', { count: 'exact', head: true }).in('statut_facture', ['importée', 'en cours de rapprochement', 'partiellement rapprochée']),
  ]);

  const anomalies = resExc.count ?? 0;
  const besAnciens = resBes.count ?? 0;
  const rapp = resRapp.count ?? 0;
  const factNonRap = resFactNonRap.count ?? 0;

  const parts: string[] = [];
  if (anomalies > 0) parts.push(`${anomalies} anomalie${anomalies > 1 ? 's' : ''} active${anomalies > 1 ? 's' : ''}`);
  if (besAnciens > 0) parts.push(`${besAnciens} BE${besAnciens > 1 ? 's' : ''} ancien${besAnciens > 1 ? 's' : ''} non facturé${besAnciens > 1 ? 's' : ''}`);
  if (rapp > 0) parts.push(`${rapp} rapprochement${rapp > 1 ? 's' : ''} proposé${rapp > 1 ? 's' : ''}`);
  if (factNonRap > 0) parts.push(`${factNonRap} facture${factNonRap > 1 ? 's' : ''} non rapprochée${factNonRap > 1 ? 's' : ''}`);

  const message = parts.length > 0
    ? `☀️ Brief du matin : ${parts.join(', ')}.`
    : '☀️ Brief du matin : tout est à jour, aucune action requise.';

  await supabase.from('notifications').insert({ type: 'brief_matin', message, lu: false });

  return Response.json({ ok: true, anomalies, besAnciens, rapp, factNonRap });
}
