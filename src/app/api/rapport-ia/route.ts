import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

export async function GET() {
  try {
    const today = new Date().toISOString().slice(0, 10);

    // Check if today's report already exists
    const { data: existing } = await supabase
      .from('rapport_ia')
      .select('contenu, created_at')
      .eq('date_rapport', today)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (existing) {
      return NextResponse.json({ rapport: existing.contenu, cached: true, generated_at: existing.created_at });
    }

    // Gather data for the report
    const since = new Date();
    since.setDate(since.getDate() - 1); // Last 24h
    const sinceISO = since.toISOString();

    const [
      { count: facturesImportees },
      { count: rapproches },
      { count: exceptionsCreees },
      { count: exceptionsOuvertes },
      { data: journalRecent },
      { data: facturesEnAnomalieHT },
    ] = await Promise.all([
      supabase.from('factures').select('id', { count: 'exact', head: true }).gte('created_at', sinceISO),
      supabase.from('rapprochements').select('id', { count: 'exact', head: true }).gte('created_at', sinceISO).eq('statut_validation', 'validé'),
      supabase.from('exceptions').select('id', { count: 'exact', head: true }).gte('created_at', sinceISO),
      supabase.from('exceptions').select('id', { count: 'exact', head: true }).in('statut_exception', ['ouverte', 'en cours']),
      supabase.from('journal_activite').select('type_action, details_action, created_at').gte('created_at', sinceISO).order('created_at', { ascending: false }).limit(20),
      supabase.from('factures').select('fournisseur, total_ht').eq('statut_facture', 'en anomalie').limit(5),
    ]);

    const contextData = {
      période: 'Dernières 24h',
      factures_importées: facturesImportees ?? 0,
      rapprochements_validés: rapproches ?? 0,
      exceptions_créées: exceptionsCreees ?? 0,
      exceptions_actives_total: exceptionsOuvertes ?? 0,
      activité_récente: (journalRecent ?? []).slice(0, 10).map((j: { type_action: string | null; details_action: string | null }) => j.type_action),
      factures_en_anomalie: (facturesEnAnomalieHT ?? []).map((f: { fournisseur: string | null; total_ht: number | null }) => `${f.fournisseur ?? '?'} (${f.total_ht?.toLocaleString('fr-FR')} €)`),
    };

    const prompt = `Tu es l'assistant de SyncFlow, un logiciel de rapprochement de factures. Génère un résumé opérationnel concis pour le comptable.

Données du jour (${today}) :
${JSON.stringify(contextData, null, 2)}

Génère un résumé en 3-5 phrases courtes :
- Commence par l'essentiel (chiffres du jour)
- Signale les points d'attention (exceptions critiques, factures en anomalie)
- Termine par une recommandation d'action si nécessaire
- Ton professionnel et direct, pas de formules de politesse
- Réponds en français`;

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY!,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const aiData = await aiRes.json() as { content: Array<{ type: string; text?: string }> };
    const rapport = aiData.content.find(c => c.type === 'text')?.text ?? 'Résumé indisponible.';

    // Cache the report
    await supabase.from('rapport_ia').insert({ date_rapport: today, contenu: rapport });

    return NextResponse.json({ rapport, cached: false, generated_at: new Date().toISOString() });
  } catch (err) {
    console.error('[rapport-ia]', err);
    return NextResponse.json({ error: 'Erreur génération rapport' }, { status: 500 });
  }
}

export async function DELETE() {
  // Force regeneration by deleting today's cache
  const today = new Date().toISOString().slice(0, 10);
  await supabase.from('rapport_ia').delete().eq('date_rapport', today);
  return NextResponse.json({ ok: true });
}
