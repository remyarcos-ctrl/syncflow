import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

export async function POST(req: NextRequest) {
  try {
    const { exceptionId } = await req.json() as { exceptionId: string };
    if (!exceptionId) return NextResponse.json({ error: 'exceptionId requis' }, { status: 400 });

    // Fetch exception with context
    const { data: exc } = await supabase
      .from('exceptions')
      .select('*, factures(numero_facture, fournisseur, total_ht, date_facture)')
      .eq('id', exceptionId)
      .single();

    if (!exc) return NextResponse.json({ error: 'Exception introuvable' }, { status: 404 });

    const facture = exc.factures as { numero_facture: string; fournisseur: string | null; total_ht: number | null; date_facture: string | null } | null;

    const prompt = `Tu es un expert en comptabilité fournisseurs. Analyse cette exception de rapprochement et génère :
1. Une explication claire (1-2 phrases maximum) compréhensible par un comptable non-technique
2. Une suggestion d'action concrète (1 phrase)

Exception :
- Type : ${exc.type_exception}
- Motif : ${exc.motif ?? 'non précisé'}
- Priorité : ${exc.niveau_priorite}
- Valeur attendue : ${exc.valeur_attendue ?? 'N/A'} €
- Valeur obtenue : ${exc.valeur_obtenue ?? 'N/A'} €
- Écart : ${exc.ecart != null ? `${(exc.ecart as number).toFixed(1)}%` : 'N/A'}
${facture ? `Facture : ${facture.numero_facture} — ${facture.fournisseur ?? 'fournisseur inconnu'} — ${facture.total_ht != null ? `${facture.total_ht.toLocaleString('fr-FR')} € HT` : ''} — ${facture.date_facture ?? ''}` : ''}

Réponds en JSON strict :
{"explication": "...", "suggestion": "..."}`;

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY!,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const aiData = await aiRes.json() as { content: Array<{ type: string; text?: string }> };
    const text = aiData.content.find(c => c.type === 'text')?.text ?? '{}';

    let parsed: { explication?: string; suggestion?: string } = {};
    try {
      // Extract JSON from text (Claude might add extra text)
      const match = text.match(/\{[\s\S]*\}/);
      if (match) parsed = JSON.parse(match[0]) as { explication?: string; suggestion?: string };
    } catch {
      parsed = { explication: text.slice(0, 200), suggestion: '' };
    }

    // Update the exception
    await supabase.from('exceptions').update({
      explication_ia: parsed.explication ?? null,
      suggestion_ia: parsed.suggestion ?? null,
    }).eq('id', exceptionId);

    return NextResponse.json({ ok: true, explication: parsed.explication, suggestion: parsed.suggestion });
  } catch (err) {
    console.error('[exception-ia]', err);
    return NextResponse.json({ error: 'Erreur IA' }, { status: 500 });
  }
}
