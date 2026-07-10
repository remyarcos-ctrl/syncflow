import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// File de sync Centralink à la demande. L'appli (Vercel) ne peut PAS lancer le
// scraper Playwright (il tourne sur le poste local, avec les creds locaux) :
// le bouton dépose une DEMANDE ici ; le watcher local (tâche planifiée chaque
// minute, centralink-recon/watch_sync.js) l'exécute puis marque le résultat.
export const dynamic = 'force-dynamic';

function adminSb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(),
  );
}

// État courant : demande active (demandée/en cours) + dernière sync terminée (manuelle ou auto).
export async function GET() {
  const sb = adminSb();
  const [active, derniere] = await Promise.all([
    sb.from('sync_requests').select('*').in('statut', ['demandée', 'en cours'])
      .order('demandee_a', { ascending: false }).limit(1).maybeSingle(),
    sb.from('sync_requests').select('*').in('statut', ['terminée', 'erreur'])
      .order('terminee_a', { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (active.error || derniere.error) {
    return NextResponse.json({ error: String(active.error?.message ?? derniere.error?.message) }, { status: 500 });
  }
  return NextResponse.json({ active: active.data, derniere: derniere.data });
}

// Nouvelle demande de sync manuelle. Idempotent : si une demande est déjà en
// file (demandée/en cours depuis < 20 min), on la renvoie au lieu d'empiler.
export async function POST() {
  const sb = adminSb();
  const { data: enCours } = await sb.from('sync_requests').select('*')
    .in('statut', ['demandée', 'en cours'])
    .gte('demandee_a', new Date(Date.now() - 20 * 60_000).toISOString())
    .order('demandee_a', { ascending: false }).limit(1).maybeSingle();
  if (enCours) return NextResponse.json({ demande: enCours, deja_en_file: true });
  const { data, error } = await sb.from('sync_requests')
    .insert({ type: 'manuel', statut: 'demandée' }).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ demande: data, deja_en_file: false });
}
