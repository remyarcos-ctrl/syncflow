import { createClient } from '@supabase/supabase-js';

export const maxDuration = 60;
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

export async function GET() {
  // Load thresholds from memory
  const { data: memRows } = await supabase
    .from('teddy_memory')
    .select('cle, valeur')
    .in('cle', ['seuil_alertes', 'seuil_anomalies', 'seuil_bes_anciens', 'seuil_factures_non_rap']);

  const mem = Object.fromEntries((memRows ?? []).map((r: { cle: string; valeur: string }) => [r.cle, Number(r.valeur)]));
  const seuilAlertes = mem.seuil_alertes ?? 5;
  const seuilAnomalies = mem.seuil_anomalies ?? 10;
  const seuilBesAnciens = mem.seuil_bes_anciens ?? 5;
  const seuilFacturesNonRap = mem.seuil_factures_non_rap ?? 20;

  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();

  const [resAlertes, resAnomalies, resBes, resFactures] = await Promise.all([
    supabase.from('notifications').select('id', { count: 'exact', head: true }).eq('lu', false),
    supabase.from('exceptions').select('id', { count: 'exact', head: true }).in('statut_exception', ['ouverte', 'en cours']),
    supabase.from('be_receptions').select('id', { count: 'exact', head: true }).in('statut_be', ['reçu', 'partiellement facturé']).lte('created_at', sevenDaysAgo),
    supabase.from('factures').select('id', { count: 'exact', head: true }).in('statut_facture', ['importée', 'en cours de rapprochement', 'partiellement rapprochée']),
  ]);

  const alertes = resAlertes.count ?? 0;
  const anomalies = resAnomalies.count ?? 0;
  const besAnciens = resBes.count ?? 0;
  const facturesNonRap = resFactures.count ?? 0;

  const notifications: { title: string; body: string }[] = [];

  if (alertes > seuilAlertes) notifications.push({ title: 'SyncFlow — Alertes', body: `${alertes} alertes non lues (seuil : ${seuilAlertes})` });
  if (anomalies > seuilAnomalies) notifications.push({ title: 'SyncFlow — Anomalies', body: `${anomalies} anomalies actives (seuil : ${seuilAnomalies})` });
  if (besAnciens > seuilBesAnciens) notifications.push({ title: 'SyncFlow — BEs anciens', body: `${besAnciens} BEs non facturés depuis +7j (seuil : ${seuilBesAnciens})` });
  if (facturesNonRap > seuilFacturesNonRap) notifications.push({ title: 'SyncFlow — Factures', body: `${facturesNonRap} factures non rapprochées (seuil : ${seuilFacturesNonRap})` });

  return Response.json({ notifications, kpis: { alertes, anomalies, besAnciens, facturesNonRap } });
}
