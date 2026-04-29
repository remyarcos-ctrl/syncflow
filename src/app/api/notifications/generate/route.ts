import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

function adminSb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

async function ensureNotif(
  sb: ReturnType<typeof adminSb>,
  params: {
    type: string;
    severite: 'info' | 'warning' | 'error';
    titre: string;
    message?: string;
    lien?: string;
    entite_type?: string;
    entite_id?: string;
  },
) {
  const { data: existing } = await sb
    .from('notifications')
    .select('id')
    .eq('type', params.type)
    .eq('entite_id', params.entite_id ?? '')
    .eq('lu', false)
    .maybeSingle();
  if (existing) return;

  await sb.from('notifications').insert({ ...params, lu: false });
}

export async function POST() {
  const sb = adminSb();
  const now = Date.now();

  // 1. BEs non liés à une commande depuis > 48h
  const { data: besNonLies } = await sb
    .from('be_receptions')
    .select('id, numero_be, fournisseur')
    .is('commande_id', null)
    .lt('created_at', new Date(now - 48 * 60 * 60 * 1000).toISOString())
    .in('statut_be', ['reçu', 'partiellement facturé', 'facturé']);

  for (const be of besNonLies ?? []) {
    await ensureNotif(sb, {
      type: 'be_non_lie',
      severite: 'warning',
      titre: `BE ${be.numero_be} non lié`,
      message: `${be.fournisseur ?? 'Fournisseur inconnu'} · Importé depuis plus de 48h sans commande associée`,
      lien: `/be-receptions/${be.id}`,
      entite_type: 'be_reception',
      entite_id: be.id,
    });
  }

  // 2. Rapprochements proposés en attente > 24h
  const { data: rapsEnAttente } = await sb
    .from('rapprochements')
    .select('id')
    .eq('statut_validation', 'proposé')
    .lt('created_at', new Date(now - 24 * 60 * 60 * 1000).toISOString());

  for (const rap of rapsEnAttente ?? []) {
    await ensureNotif(sb, {
      type: 'rapprochement_en_attente',
      severite: 'info',
      titre: 'Rapprochement en attente de validation',
      message: 'Un rapprochement proposé attend votre validation depuis plus de 24h',
      lien: '/rapprochements?statut=propos%C3%A9',
      entite_type: 'rapprochement',
      entite_id: rap.id,
    });
  }

  // 3. Commandes en anomalie
  const { data: cmdAnomalies } = await sb
    .from('commandes')
    .select('id, numero_commande_interne, fournisseur')
    .eq('statut_commande', 'en anomalie');

  for (const cmd of cmdAnomalies ?? []) {
    await ensureNotif(sb, {
      type: 'commande_anomalie',
      severite: 'error',
      titre: `Commande ${cmd.numero_commande_interne} en anomalie`,
      message: `${cmd.fournisseur} · Sur-réception ou sur-facturation détectée`,
      lien: `/commandes/${cmd.id}`,
      entite_type: 'commande',
      entite_id: cmd.id,
    });
  }

  // 4. BEs à facturer depuis > 7 jours
  const { data: besSansFacture } = await sb
    .from('be_receptions')
    .select('id, numero_be, fournisseur')
    .in('statut_be', ['reçu', 'partiellement facturé'])
    .lt('created_at', new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString());

  for (const be of besSansFacture ?? []) {
    await ensureNotif(sb, {
      type: 'be_sans_facture',
      severite: 'warning',
      titre: `BE ${be.numero_be} sans facture`,
      message: `${be.fournisseur ?? 'Fournisseur inconnu'} · Réceptionné depuis plus de 7 jours, facture manquante`,
      lien: '/a-facturer',
      entite_type: 'be_reception',
      entite_id: `facture_${be.id}`,
    });
  }

  // 5. BEs en anomalie
  const { data: besAnomalies } = await sb
    .from('be_receptions')
    .select('id, numero_be, fournisseur')
    .eq('statut_be', 'en anomalie');

  for (const be of besAnomalies ?? []) {
    await ensureNotif(sb, {
      type: 'be_anomalie',
      severite: 'error',
      titre: `BE ${be.numero_be} en anomalie`,
      message: `${be.fournisseur ?? 'Fournisseur inconnu'} · Écart de quantité détecté`,
      lien: `/be-receptions/${be.id}`,
      entite_type: 'be_reception',
      entite_id: be.id,
    });
  }

  return NextResponse.json({ ok: true });
}
