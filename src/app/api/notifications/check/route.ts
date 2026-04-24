import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getValidToken, sendEmail } from '@/lib/gmail-api';

function adminSb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

// GET : vérifie les conditions et envoie les alertes configurées
export async function GET() {
  const sb = adminSb();
  const now = new Date();
  const alerts: { type: string; count: number; detail: string }[] = [];

  // 1. BEs sans commande depuis +7 jours
  const { data: besAnciensNonLies } = await sb
    .from('be_receptions')
    .select('id, numero_be, fournisseur, created_at')
    .is('commande_id', null)
    .lt('created_at', new Date(now.getTime() - 7 * 86400_000).toISOString());
  if (besAnciensNonLies?.length) {
    alerts.push({
      type: 'be_sans_commande',
      count: besAnciensNonLies.length,
      detail: besAnciensNonLies.slice(0, 5).map(b => `${b.numero_be} (${b.fournisseur ?? '—'})`).join(', '),
    });
  }

  // 2. Factures non rapprochées depuis +14 jours
  const { data: factAnciennesNonRap } = await sb
    .from('factures')
    .select('id, numero_facture, fournisseur, total_ht, created_at')
    .eq('statut_facture', 'importée')
    .lt('created_at', new Date(now.getTime() - 14 * 86400_000).toISOString())
    .gt('total_ht', 0);
  if (factAnciennesNonRap?.length) {
    alerts.push({
      type: 'factures_non_rapprochees',
      count: factAnciennesNonRap.length,
      detail: factAnciennesNonRap.slice(0, 5).map(f => `${f.numero_facture} (${f.total_ht?.toFixed(0) ?? '?'} €)`).join(', '),
    });
  }

  // 3. Retours fournisseur en attente
  const { data: retours } = await sb
    .from('lignes_be')
    .select('id, statut_retour')
    .not('statut_retour', 'is', null)
    .neq('statut_retour', 'avoir_recu');
  if (retours?.length) {
    const aRetourner = retours.filter(r => r.statut_retour === 'a_retourner').length;
    const avoirDemande = retours.filter(r => r.statut_retour === 'avoir_demande').length;
    alerts.push({
      type: 'retours_en_attente',
      count: retours.length,
      detail: [
        aRetourner > 0 && `${aRetourner} à retourner`,
        avoirDemande > 0 && `${avoirDemande} avoir(s) attendus`,
      ].filter(Boolean).join(', '),
    });
  }

  if (!alerts.length) {
    return NextResponse.json({ sent: false, message: 'Aucune alerte à envoyer', alerts: [] });
  }

  // Récupérer les règles de notification actives
  const { data: regles } = await sb
    .from('regles_notifications')
    .select('*')
    .eq('actif', true);

  let emailsSent = 0;

  for (const regle of regles ?? []) {
    try {
      const relevantAlerts = alerts.filter(a => {
        if (regle.type_alerte === 'all') return true;
        return a.type === regle.type_alerte;
      });
      if (!relevantAlerts.length) continue;

      const destinataires = (regle.destinataires ?? '').split(',').map((e: string) => e.trim()).filter(Boolean);
      if (!destinataires.length) continue;

      const subject = `[SyncFlow] ${relevantAlerts.length} alerte(s) — ${new Date().toLocaleDateString('fr-FR')}`;
      const body = [
        'Bonjour,',
        '',
        'SyncFlow a détecté les situations suivantes nécessitant votre attention :',
        '',
        ...relevantAlerts.map(a => `• ${a.count} ${a.type.replace(/_/g, ' ')} : ${a.detail}`),
        '',
        'Accédez à SyncFlow pour traiter ces éléments.',
        '',
        'Cordialement,',
        'SyncFlow — SD Équipements',
      ].join('\n');

      const tokenData = await getValidToken();
      if (tokenData) {
        for (const to of destinataires) {
          await sendEmail(tokenData.token, { from: tokenData.config.email, to, subject, body });
          emailsSent++;
        }
      }
    } catch (e) {
      console.error('[notifications/check] email error:', e);
    }
  }

  return NextResponse.json({ sent: emailsSent > 0, emailsSent, alerts });
}
