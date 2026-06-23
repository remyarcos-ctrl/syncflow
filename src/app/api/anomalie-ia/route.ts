import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const maxDuration = 60;
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

export async function POST(req: NextRequest) {
  try {
    const { factureId } = await req.json() as { factureId: string };
    if (!factureId) return NextResponse.json({ error: 'factureId requis' }, { status: 400 });

    const { data: facture } = await supabase
      .from('factures')
      .select('*, lignes_facture(*)')
      .eq('id', factureId)
      .single();

    if (!facture) return NextResponse.json({ error: 'Facture introuvable' }, { status: 404 });

    // Check for potential duplicates (same fournisseur + similar amount in last 60 days)
    const since = new Date();
    since.setDate(since.getDate() - 60);
    const { data: similarFactures } = await supabase
      .from('factures')
      .select('id, numero_facture, total_ht, date_facture')
      .eq('fournisseur', facture.fournisseur)
      .gte('date_facture', since.toISOString().slice(0, 10))
      .neq('id', factureId)
      .not('total_ht', 'is', null);

    const montant = facture.total_ht ?? 0;
    const doublons = (similarFactures ?? []).filter((f: { total_ht: number | null }) => {
      const diff = Math.abs((f.total_ht ?? 0) - montant);
      return montant > 0 && diff / montant < 0.02; // within 2%
    });

    // Historical average for this supplier
    const { data: historique } = await supabase
      .from('factures')
      .select('total_ht')
      .eq('fournisseur', facture.fournisseur)
      .not('total_ht', 'is', null)
      .neq('id', factureId)
      .limit(20);

    let anomalie: string | null = null;

    if (doublons.length > 0) {
      const doublon = doublons[0] as { numero_facture: string; total_ht: number | null; date_facture: string | null };
      const prompt = `Une facture potentiellement en doublon a été détectée. Génère une alerte courte (1 phrase) pour le comptable.
Facture actuelle : ${facture.numero_facture} — ${facture.fournisseur} — ${montant.toLocaleString('fr-FR')} € — ${facture.date_facture ?? ''}
Facture similaire : ${doublon.numero_facture} — ${(doublon.total_ht ?? 0).toLocaleString('fr-FR')} € — ${doublon.date_facture ?? ''}
Commence par "⚠️ Doublon potentiel :"`;

      const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY!, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 150, messages: [{ role: 'user', content: prompt }] }),
      });
      const aiData = await aiRes.json() as { content: Array<{ type: string; text?: string }> };
      anomalie = aiData.content.find(c => c.type === 'text')?.text ?? null;
    } else if (historique && historique.length >= 3) {
      const avg = historique.reduce((s, f) => s + ((f as { total_ht: number }).total_ht ?? 0), 0) / historique.length;
      const ecartPct = avg > 0 ? Math.abs((montant - avg) / avg) * 100 : 0;

      if (ecartPct > 50) {
        const prompt = `Une facture avec un montant inhabituel a été reçue. Génère une alerte courte (1 phrase) pour le comptable.
Fournisseur : ${facture.fournisseur}
Montant de cette facture : ${montant.toLocaleString('fr-FR')} €
Montant moyen habituel : ${Math.round(avg).toLocaleString('fr-FR')} €
Écart : +${Math.round(ecartPct)}%
Commence par "⚠️ Montant inhabituel :"`;

        const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY!, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 150, messages: [{ role: 'user', content: prompt }] }),
        });
        const aiData = await aiRes.json() as { content: Array<{ type: string; text?: string }> };
        anomalie = aiData.content.find(c => c.type === 'text')?.text ?? null;
      }
    }

    if (anomalie) {
      await supabase.from('factures').update({ anomalie_ia: anomalie }).eq('id', factureId);
    }

    return NextResponse.json({ ok: true, anomalie });
  } catch (err) {
    console.error('[anomalie-ia]', err);
    return NextResponse.json({ error: 'Erreur' }, { status: 500 });
  }
}
