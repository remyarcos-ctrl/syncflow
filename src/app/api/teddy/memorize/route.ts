import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const maxDuration = 60;
function adminSb() {
  return createClient(
    (process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim(),
    (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim(),
  );
}

export async function POST(req: NextRequest) {
  const { messages } = await req.json() as { messages: { role: string; content: string }[] };

  const textMessages = (messages ?? []).filter(m => typeof m.content === 'string' && m.content.trim().length > 10);
  if (textMessages.length < 3) return NextResponse.json({ ok: true, skipped: 'too_short' });

  const conversationText = textMessages
    .map(m => `${m.role === 'user' ? 'Rémy' : 'Teddy'}: ${m.content}`)
    .join('\n\n')
    .slice(0, 8000);

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY!,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      system: `Tu es un système d'extraction de mémoire pour SyncFlow (SD Équipements / Orchidée Innovation, Rémy Arcos). Extrais les informations importantes d'une conversation entre Rémy et Teddy (l'assistant IA). Réponds uniquement en JSON valide, sans markdown, sans explication.`,
      messages: [{
        role: 'user',
        content: `Conversation :\n${conversationText}\n\nExtrais en JSON strict :\n{"resume":"résumé 2-3 phrases","faits_cles":["fait 1"],"themes":["prix|fournisseur|exception|rapprochement|commande|be"],"memoire_persistante":[{"cle":"clé unique snake_case","valeur":"valeur à retenir","categorie":"prix|fournisseur|preference|règle"}]}\n\nNe mets dans memoire_persistante que des faits vraiment importants (prix négociés, seuils, décisions, règles métier). Tableau vide si rien d'important.`,
      }],
    }),
  });

  if (!res.ok) return NextResponse.json({ ok: false, error: `Claude ${res.status}` });

  const data = await res.json() as { content?: { type: string; text: string }[] };
  const text = (data.content?.[0]?.text ?? '').trim();

  let extracted: {
    resume?: string;
    faits_cles?: string[];
    themes?: string[];
    memoire_persistante?: { cle: string; valeur: string; categorie: string }[];
  } = {};
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) extracted = JSON.parse(match[0]);
  } catch {
    return NextResponse.json({ ok: false, error: 'json_parse' });
  }

  if (!extracted.resume) return NextResponse.json({ ok: true, skipped: 'no_resume' });

  const sb = adminSb();

  await sb.from('teddy_conversations').insert({
    resume: extracted.resume,
    faits_cles: extracted.faits_cles ?? [],
    themes: extracted.themes ?? [],
  });

  for (const m of (extracted.memoire_persistante ?? [])) {
    if (m.cle && m.valeur) {
      await sb.from('teddy_memory').upsert(
        { cle: m.cle, valeur: m.valeur, categorie: m.categorie ?? 'général', updated_at: new Date().toISOString() },
        { onConflict: 'cle' },
      );
    }
  }

  return NextResponse.json({ ok: true, resume: extracted.resume });
}
