import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

const SYSTEM = `Tu es l'assistant IA de SyncFlow, un logiciel de rapprochement de factures fournisseurs.
Tu aides les utilisateurs comptables à analyser leurs données : factures, bons d'entrée (BE), rapprochements, exceptions.
Réponds toujours en français. Sois concis et direct. Utilise les outils pour accéder aux données réelles.
Formate les montants en euros avec séparateur de milliers. Si tu n'as pas assez d'info, demande une précision.`;

const tools = [
  {
    name: 'get_kpis',
    description: 'Retourne les KPIs globaux : nombre total de factures par statut, taux moyen de rapprochement, nombre d\'exceptions ouvertes, BEs non facturés',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_factures',
    description: 'Liste les factures avec filtres optionnels. Retourne max 15 résultats.',
    input_schema: {
      type: 'object',
      properties: {
        statut: { type: 'string', description: 'statut_facture: importée | en cours de rapprochement | partiellement rapprochée | rapprochée | en anomalie' },
        fournisseur: { type: 'string', description: 'Filtre partiel sur le nom du fournisseur' },
        date_debut: { type: 'string', description: 'Date ISO YYYY-MM-DD' },
        date_fin: { type: 'string', description: 'Date ISO YYYY-MM-DD' },
        limit: { type: 'number', description: 'Nombre de résultats (1-15, défaut 10)' },
      },
      required: [],
    },
  },
  {
    name: 'list_exceptions',
    description: 'Liste les exceptions avec filtres optionnels.',
    input_schema: {
      type: 'object',
      properties: {
        statut: { type: 'string', description: 'ouverte | en cours | résolue | ignorée' },
        type_exception: { type: 'string' },
        niveau_priorite: { type: 'string', description: 'faible | moyenne | haute | critique' },
        limit: { type: 'number' },
      },
      required: [],
    },
  },
  {
    name: 'list_be_receptions',
    description: 'Liste les bons d\'entrée (BE) avec filtres optionnels.',
    input_schema: {
      type: 'object',
      properties: {
        statut: { type: 'string', description: 'reçu | partiellement facturé | facturé | soldé | en anomalie' },
        fournisseur: { type: 'string' },
        date_debut: { type: 'string' },
        date_fin: { type: 'string' },
        limit: { type: 'number' },
      },
      required: [],
    },
  },
  {
    name: 'get_fournisseur_stats',
    description: 'Statistiques par fournisseur : nombre de factures, montant total HT, taux de rapprochement moyen',
    input_schema: {
      type: 'object',
      properties: {
        fournisseur: { type: 'string', description: 'Nom partiel du fournisseur (optionnel, sinon top 10)' },
      },
      required: [],
    },
  },
  {
    name: 'get_activite_recente',
    description: 'Retourne les dernières actions du journal d\'activité',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '1-20, défaut 10' },
      },
      required: [],
    },
  },
];

type ToolInput = Record<string, unknown>;

async function executeTool(name: string, input: ToolInput): Promise<string> {
  try {
    if (name === 'get_kpis') {
      const [
        { count: totalFactures },
        { data: facturesParStatut },
        { count: exceptionsOuvertes },
        { count: besNonFactures },
        { data: tauxData },
      ] = await Promise.all([
        supabase.from('factures').select('id', { count: 'exact', head: true }),
        supabase.from('factures').select('statut_facture'),
        supabase.from('exceptions').select('id', { count: 'exact', head: true }).in('statut_exception', ['ouverte', 'en cours']),
        supabase.from('be_receptions').select('id', { count: 'exact', head: true }).in('statut_be', ['reçu', 'partiellement facturé']),
        supabase.from('factures').select('taux_rapprochement'),
      ]);

      const statutCounts: Record<string, number> = {};
      for (const f of (facturesParStatut ?? [])) {
        const s = (f as { statut_facture: string }).statut_facture;
        statutCounts[s] = (statutCounts[s] ?? 0) + 1;
      }
      const tauxMoyen = tauxData && tauxData.length > 0
        ? Math.round(tauxData.reduce((sum, f) => sum + ((f as { taux_rapprochement: number }).taux_rapprochement ?? 0), 0) / tauxData.length)
        : 0;

      return JSON.stringify({
        total_factures: totalFactures,
        par_statut: statutCounts,
        taux_rapprochement_moyen: `${tauxMoyen}%`,
        exceptions_actives: exceptionsOuvertes,
        bes_en_attente_facturation: besNonFactures,
      });
    }

    if (name === 'list_factures') {
      const limit = Math.min(Number(input.limit ?? 10), 15);
      let q = supabase.from('factures').select('numero_facture, fournisseur, date_facture, total_ht, statut_facture, taux_rapprochement').order('created_at', { ascending: false }).limit(limit);
      if (input.statut) q = q.eq('statut_facture', input.statut);
      if (input.fournisseur) q = q.ilike('fournisseur', `%${input.fournisseur}%`);
      if (input.date_debut) q = q.gte('date_facture', input.date_debut);
      if (input.date_fin) q = q.lte('date_facture', input.date_fin);
      const { data } = await q;
      return JSON.stringify(data ?? []);
    }

    if (name === 'list_exceptions') {
      const limit = Math.min(Number(input.limit ?? 10), 15);
      let q = supabase.from('exceptions').select('type_exception, niveau_priorite, statut_exception, motif, ecart, created_at').order('created_at', { ascending: false }).limit(limit);
      if (input.statut) q = q.eq('statut_exception', input.statut);
      if (input.type_exception) q = q.eq('type_exception', input.type_exception);
      if (input.niveau_priorite) q = q.eq('niveau_priorite', input.niveau_priorite);
      const { data } = await q;
      return JSON.stringify(data ?? []);
    }

    if (name === 'list_be_receptions') {
      const limit = Math.min(Number(input.limit ?? 10), 15);
      let q = supabase.from('be_receptions').select('numero_be, fournisseur, date_bl, statut_be, created_at').order('created_at', { ascending: false }).limit(limit);
      if (input.statut) q = q.eq('statut_be', input.statut);
      if (input.fournisseur) q = q.ilike('fournisseur', `%${input.fournisseur}%`);
      if (input.date_debut) q = q.gte('date_bl', input.date_debut);
      if (input.date_fin) q = q.lte('date_bl', input.date_fin);
      const { data } = await q;
      return JSON.stringify(data ?? []);
    }

    if (name === 'get_fournisseur_stats') {
      let q = supabase.from('factures').select('fournisseur, total_ht, taux_rapprochement').limit(500);
      if (input.fournisseur) q = q.ilike('fournisseur', `%${input.fournisseur}%`);
      const { data } = await q;
      const stats: Record<string, { count: number; total_ht: number; taux_sum: number }> = {};
      for (const f of (data ?? [])) {
        const frow = f as { fournisseur: string | null; total_ht: number | null; taux_rapprochement: number };
        const key = frow.fournisseur ?? 'Inconnu';
        if (!stats[key]) stats[key] = { count: 0, total_ht: 0, taux_sum: 0 };
        stats[key].count++;
        stats[key].total_ht += frow.total_ht ?? 0;
        stats[key].taux_sum += frow.taux_rapprochement ?? 0;
      }
      const result = Object.entries(stats)
        .map(([nom, s]) => ({ fournisseur: nom, factures: s.count, total_ht: Math.round(s.total_ht * 100) / 100, taux_moyen: Math.round(s.taux_sum / s.count) }))
        .sort((a, b) => b.total_ht - a.total_ht)
        .slice(0, 10);
      return JSON.stringify(result);
    }

    if (name === 'get_activite_recente') {
      const limit = Math.min(Number(input.limit ?? 10), 20);
      const { data } = await supabase.from('journal_activite').select('type_action, entite_type, details_action, created_at').order('created_at', { ascending: false }).limit(limit);
      return JSON.stringify(data ?? []);
    }

    return JSON.stringify({ error: `Outil inconnu: ${name}` });
  } catch (e) {
    return JSON.stringify({ error: String(e) });
  }
}

interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string | ClaudeContentBlock[];
}

interface ClaudeContentBlock {
  type: string;
  id?: string;
  name?: string;
  input?: ToolInput;
  text?: string;
  tool_use_id?: string;
  content?: string;
}

interface ClaudeResponse {
  stop_reason: string;
  content: ClaudeContentBlock[];
}

export async function POST(req: NextRequest) {
  try {
    const { messages } = await req.json() as { messages: Array<{ role: 'user' | 'assistant'; content: string }> };

    const claudeMessages: ClaudeMessage[] = messages.map(m => ({ role: m.role, content: m.content }));

    let iterations = 0;
    while (iterations < 5) {
      iterations++;
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY!,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1024,
          system: SYSTEM,
          tools,
          messages: claudeMessages,
        }),
      });

      const data = await res.json() as ClaudeResponse;

      if (data.stop_reason === 'end_turn') {
        const text = data.content.find(c => c.type === 'text')?.text ?? '';
        return NextResponse.json({ reply: text });
      }

      if (data.stop_reason === 'tool_use') {
        claudeMessages.push({ role: 'assistant', content: data.content });

        const toolResults: ClaudeContentBlock[] = [];
        for (const block of data.content) {
          if (block.type === 'tool_use' && block.id && block.name) {
            const result = await executeTool(block.name, block.input ?? {});
            toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
          }
        }
        claudeMessages.push({ role: 'user', content: toolResults });
        continue;
      }

      // Unexpected stop reason
      const text = data.content.find((c: ClaudeContentBlock) => c.type === 'text')?.text ?? 'Je ne peux pas répondre pour le moment.';
      return NextResponse.json({ reply: text });
    }

    return NextResponse.json({ reply: 'Désolé, je n\'ai pas pu traiter votre demande.' });
  } catch (err) {
    console.error('[assistant]', err);
    return NextResponse.json({ error: 'Erreur interne' }, { status: 500 });
  }
}
