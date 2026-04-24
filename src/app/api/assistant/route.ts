import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

const SYSTEM = `Tu es l'assistant IA de SyncFlow, logiciel de rapprochement de factures fournisseurs.
Tu peux consulter les données ET exécuter des actions (suppressions, matching, validations).
Réponds toujours en français. Sois concis et direct.

RÈGLE ABSOLUE pour toute action destructive (suppression) :
1. Appelle d'abord un outil de lecture pour connaître exactement ce qui sera affecté
2. Décris précisément ce qui va être supprimé (nombre, noms, montants si pertinent)
3. Demande "Tu confirmes ?" et attends la réponse
4. N'exécute l'outil de suppression QU'APRÈS une confirmation explicite ("oui", "confirme", "ok", "vas-y")
5. Si l'utilisateur dit "non" ou change d'avis, annule sans agir

Pour les actions non destructives (matching, validation, résolution), tu peux les exécuter directement sans confirmation.
Formate les montants en euros avec séparateur de milliers.`;

const tools = [
  // ── Lecture ──────────────────────────────────────────────────────────────────
  {
    name: 'get_kpis',
    description: 'KPIs globaux : factures par statut, taux moyen rapprochement, exceptions ouvertes, BEs en attente',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_factures',
    description: 'Liste les factures. Retourne id, numero, fournisseur, date, montant, statut, taux.',
    input_schema: {
      type: 'object',
      properties: {
        statut: { type: 'string', description: 'importée | en cours de rapprochement | partiellement rapprochée | rapprochée | en anomalie' },
        fournisseur: { type: 'string' },
        date_debut: { type: 'string', description: 'YYYY-MM-DD' },
        date_fin: { type: 'string', description: 'YYYY-MM-DD' },
        limit: { type: 'number', description: 'défaut 15, max 200' },
      },
      required: [],
    },
  },
  {
    name: 'list_be_receptions',
    description: 'Liste les bons d\'entrée. Retourne id, numero_be, fournisseur, date, statut.',
    input_schema: {
      type: 'object',
      properties: {
        statut: { type: 'string', description: 'reçu | partiellement facturé | facturé | soldé | en anomalie' },
        fournisseur: { type: 'string' },
        date_debut: { type: 'string' },
        date_fin: { type: 'string' },
        limit: { type: 'number', description: 'défaut 15, max 200' },
      },
      required: [],
    },
  },
  {
    name: 'list_commandes',
    description: 'Liste les commandes. Retourne id, numero, fournisseur, date, montant, statut.',
    input_schema: {
      type: 'object',
      properties: {
        statut: { type: 'string', description: 'ouverte | partiellement réceptionnée | réceptionnée | partiellement facturée | soldée | en anomalie' },
        fournisseur: { type: 'string' },
        limit: { type: 'number', description: 'défaut 15, max 200' },
      },
      required: [],
    },
  },
  {
    name: 'list_exceptions',
    description: 'Liste les exceptions. Retourne id, type, priorité, statut, motif, écart.',
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
    name: 'list_rapprochements',
    description: 'Liste les rapprochements avec leur statut de validation.',
    input_schema: {
      type: 'object',
      properties: {
        statut_validation: { type: 'string', description: 'proposé | validé | rejeté | à revoir' },
        score_min: { type: 'number', description: 'Score minimum (0-1)' },
        limit: { type: 'number' },
      },
      required: [],
    },
  },
  {
    name: 'get_fournisseur_stats',
    description: 'Stats par fournisseur : nb factures, montant total HT, taux moyen',
    input_schema: {
      type: 'object',
      properties: { fournisseur: { type: 'string' } },
      required: [],
    },
  },
  {
    name: 'get_activite_recente',
    description: 'Journal des dernières actions',
    input_schema: {
      type: 'object',
      properties: { limit: { type: 'number', description: '1-20, défaut 10' } },
      required: [],
    },
  },

  // ── Actions ───────────────────────────────────────────────────────────────────
  {
    name: 'supprimer_factures',
    description: 'Supprime des factures et toutes leurs données liées (lignes, rapprochements, liaisons). TOUJOURS confirmer avant d\'appeler cet outil.',
    input_schema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: 'IDs spécifiques à supprimer' },
        statut: { type: 'string', description: 'Supprimer toutes les factures avec ce statut' },
        fournisseur: { type: 'string', description: 'Supprimer toutes les factures de ce fournisseur (partiel)' },
        tous: { type: 'boolean', description: 'Supprimer TOUTES les factures' },
      },
      required: [],
    },
  },
  {
    name: 'supprimer_bes',
    description: 'Supprime des BEs et leurs lignes/liaisons. TOUJOURS confirmer avant d\'appeler cet outil.',
    input_schema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' } },
        statut: { type: 'string' },
        fournisseur: { type: 'string' },
        tous: { type: 'boolean' },
      },
      required: [],
    },
  },
  {
    name: 'supprimer_commandes',
    description: 'Supprime des commandes et leurs lignes/liaisons. TOUJOURS confirmer avant d\'appeler cet outil.',
    input_schema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' } },
        statut: { type: 'string' },
        fournisseur: { type: 'string' },
        tous: { type: 'boolean' },
      },
      required: [],
    },
  },
  {
    name: 'supprimer_exceptions',
    description: 'Supprime des exceptions. TOUJOURS confirmer avant d\'appeler cet outil.',
    input_schema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' } },
        statut: { type: 'string' },
        tous: { type: 'boolean' },
      },
      required: [],
    },
  },
  {
    name: 'lancer_matching',
    description: 'Lance le matching automatique pour une ou plusieurs factures. Pas besoin de confirmation.',
    input_schema: {
      type: 'object',
      properties: {
        facture_id: { type: 'string', description: 'ID d\'une facture spécifique' },
        toutes_non_rapprochees: { type: 'boolean', description: 'Lancer sur toutes les factures importées ou partiellement rapprochées' },
      },
      required: [],
    },
  },
  {
    name: 'valider_rapprochements',
    description: 'Valide des rapprochements proposés. Pas besoin de confirmation.',
    input_schema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: 'IDs de rapprochements à valider' },
        facture_id: { type: 'string', description: 'Valider tous les rapprochements proposés d\'une facture' },
        score_min: { type: 'number', description: 'Valider tous les rapprochements avec score >= cette valeur (0-1)' },
      },
      required: [],
    },
  },
  {
    name: 'resoudre_exceptions',
    description: 'Résout ou ignore des exceptions. Pas besoin de confirmation.',
    input_schema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' } },
        nouveau_statut: { type: 'string', description: 'résolue | ignorée' },
        commentaire: { type: 'string' },
      },
      required: ['nouveau_statut'],
    },
  },
  {
    name: 'lancer_scan_gmail',
    description: 'Lance le scan Gmail pour importer les nouvelles commandes. Pas besoin de confirmation.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
];

type ToolInput = Record<string, unknown>;

async function resolveIds(
  table: string,
  input: ToolInput,
  filters: { statut?: string; statut_col?: string; fournisseur?: string },
): Promise<string[]> {
  if (Array.isArray(input.ids) && input.ids.length > 0) return input.ids as string[];
  if (!input.tous && !input.statut && !input.fournisseur) return [];

  let q = supabase.from(table).select('id');
  if (input.statut && filters.statut_col) q = q.eq(filters.statut_col, input.statut);
  if (input.fournisseur) q = q.ilike('fournisseur', `%${input.fournisseur}%`);
  const { data } = await q;
  return (data ?? []).map((r: { id: string }) => r.id);
}

async function executeTool(name: string, input: ToolInput): Promise<string> {
  try {
    // ── Lecture ────────────────────────────────────────────────────────────────

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
        ? Math.round(tauxData.reduce((s, f) => s + ((f as { taux_rapprochement: number }).taux_rapprochement ?? 0), 0) / tauxData.length)
        : 0;
      return JSON.stringify({ total_factures: totalFactures, par_statut: statutCounts, taux_rapprochement_moyen: `${tauxMoyen}%`, exceptions_actives: exceptionsOuvertes, bes_en_attente_facturation: besNonFactures });
    }

    if (name === 'list_factures') {
      const limit = Math.min(Number(input.limit ?? 15), 200);
      let q = supabase.from('factures').select('id, numero_facture, fournisseur, date_facture, total_ht, statut_facture, taux_rapprochement').order('created_at', { ascending: false }).limit(limit);
      if (input.statut) q = q.eq('statut_facture', input.statut);
      if (input.fournisseur) q = q.ilike('fournisseur', `%${input.fournisseur}%`);
      if (input.date_debut) q = q.gte('date_facture', input.date_debut);
      if (input.date_fin) q = q.lte('date_facture', input.date_fin);
      const { data } = await q;
      return JSON.stringify(data ?? []);
    }

    if (name === 'list_be_receptions') {
      const limit = Math.min(Number(input.limit ?? 15), 200);
      let q = supabase.from('be_receptions').select('id, numero_be, fournisseur, date_bl, statut_be').order('created_at', { ascending: false }).limit(limit);
      if (input.statut) q = q.eq('statut_be', input.statut);
      if (input.fournisseur) q = q.ilike('fournisseur', `%${input.fournisseur}%`);
      if (input.date_debut) q = q.gte('date_bl', input.date_debut);
      if (input.date_fin) q = q.lte('date_bl', input.date_fin);
      const { data } = await q;
      return JSON.stringify(data ?? []);
    }

    if (name === 'list_commandes') {
      const limit = Math.min(Number(input.limit ?? 15), 200);
      let q = supabase.from('commandes').select('id, numero_commande_interne, fournisseur, date_commande, montant_total_commande, statut_commande').order('created_at', { ascending: false }).limit(limit);
      if (input.statut) q = q.eq('statut_commande', input.statut);
      if (input.fournisseur) q = q.ilike('fournisseur', `%${input.fournisseur}%`);
      const { data } = await q;
      return JSON.stringify(data ?? []);
    }

    if (name === 'list_exceptions') {
      const limit = Math.min(Number(input.limit ?? 15), 200);
      let q = supabase.from('exceptions').select('id, type_exception, niveau_priorite, statut_exception, motif, ecart, created_at').order('created_at', { ascending: false }).limit(limit);
      if (input.statut) q = q.eq('statut_exception', input.statut);
      if (input.type_exception) q = q.eq('type_exception', input.type_exception);
      if (input.niveau_priorite) q = q.eq('niveau_priorite', input.niveau_priorite);
      const { data } = await q;
      return JSON.stringify(data ?? []);
    }

    if (name === 'list_rapprochements') {
      const limit = Math.min(Number(input.limit ?? 15), 200);
      let q = supabase.from('rapprochements').select('id, facture_id, statut_validation, score_match, montant_rapproche, mode_match').order('created_at', { ascending: false }).limit(limit);
      if (input.statut_validation) q = q.eq('statut_validation', input.statut_validation);
      if (input.score_min) q = q.gte('score_match', input.score_min);
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
      return JSON.stringify(Object.entries(stats).map(([nom, s]) => ({ fournisseur: nom, factures: s.count, total_ht: Math.round(s.total_ht * 100) / 100, taux_moyen: Math.round(s.taux_sum / s.count) })).sort((a, b) => b.total_ht - a.total_ht).slice(0, 10));
    }

    if (name === 'get_activite_recente') {
      const limit = Math.min(Number(input.limit ?? 10), 20);
      const { data } = await supabase.from('journal_activite').select('type_action, entite_type, details_action, created_at').order('created_at', { ascending: false }).limit(limit);
      return JSON.stringify(data ?? []);
    }

    // ── Actions ────────────────────────────────────────────────────────────────

    if (name === 'supprimer_factures') {
      const ids = await resolveIds('factures', input, { statut_col: 'statut_facture', fournisseur: String(input.fournisseur ?? '') });
      if (ids.length === 0) return JSON.stringify({ supprimees: 0 });
      for (const id of ids) {
        await supabase.from('rapprochements').delete().eq('facture_id', id);
        await supabase.from('lignes_facture').delete().eq('facture_id', id);
        await supabase.from('liaison_facture_commande').delete().eq('facture_id', id);
        await supabase.from('factures').delete().eq('id', id);
      }
      return JSON.stringify({ supprimees: ids.length });
    }

    if (name === 'supprimer_bes') {
      const ids = await resolveIds('be_receptions', input, { statut_col: 'statut_be', fournisseur: String(input.fournisseur ?? '') });
      if (ids.length === 0) return JSON.stringify({ supprimes: 0 });
      for (const id of ids) {
        await supabase.from('lignes_be').delete().eq('be_id', id);
        await supabase.from('liaison_be_commande').delete().eq('be_id', id);
        await supabase.from('be_receptions').delete().eq('id', id);
      }
      return JSON.stringify({ supprimes: ids.length });
    }

    if (name === 'supprimer_commandes') {
      const ids = await resolveIds('commandes', input, { statut_col: 'statut_commande', fournisseur: String(input.fournisseur ?? '') });
      if (ids.length === 0) return JSON.stringify({ supprimees: 0 });
      for (const id of ids) {
        await supabase.from('lignes_commande').delete().eq('commande_id', id);
        await supabase.from('liaison_be_commande').delete().eq('commande_id', id);
        await supabase.from('liaison_facture_commande').delete().eq('commande_id', id);
        await supabase.from('commandes').delete().eq('id', id);
      }
      return JSON.stringify({ supprimees: ids.length });
    }

    if (name === 'supprimer_exceptions') {
      const ids = await resolveIds('exceptions', input, { statut_col: 'statut_exception' });
      if (ids.length === 0) return JSON.stringify({ supprimees: 0 });
      await supabase.from('exceptions').delete().in('id', ids);
      return JSON.stringify({ supprimees: ids.length });
    }

    if (name === 'lancer_matching') {
      if (input.facture_id) {
        const res = await fetch(`${BASE_URL}/api/matching`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ facture_id: input.facture_id }),
        });
        const json = await res.json() as { rapprochements_crees?: number; exceptions_creees?: number; message?: string };
        return JSON.stringify(json);
      }
      if (input.toutes_non_rapprochees) {
        const { data: factures } = await supabase.from('factures').select('id').in('statut_facture', ['importée', 'partiellement rapprochée', 'en cours de rapprochement']);
        let total = 0;
        for (const f of (factures ?? [])) {
          const res = await fetch(`${BASE_URL}/api/matching`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ facture_id: f.id }),
          });
          if (res.ok) {
            const json = await res.json() as { rapprochements_crees?: number };
            total += json.rapprochements_crees ?? 0;
          }
        }
        return JSON.stringify({ factures_traitees: factures?.length ?? 0, rapprochements_crees: total });
      }
      return JSON.stringify({ error: 'Précise facture_id ou toutes_non_rapprochees: true' });
    }

    if (name === 'valider_rapprochements') {
      let rapIds: string[] = Array.isArray(input.ids) ? input.ids as string[] : [];

      if (rapIds.length === 0 && input.facture_id) {
        const { data } = await supabase.from('rapprochements').select('id, facture_id').eq('facture_id', input.facture_id).eq('statut_validation', 'proposé');
        rapIds = (data ?? []).map((r: { id: string }) => r.id);
      }
      if (rapIds.length === 0 && input.score_min) {
        const { data } = await supabase.from('rapprochements').select('id, facture_id').eq('statut_validation', 'proposé').gte('score_match', input.score_min);
        rapIds = (data ?? []).map((r: { id: string }) => r.id);
      }

      let valides = 0;
      for (const rapId of rapIds) {
        const { data: rap } = await supabase.from('rapprochements').select('facture_id').eq('id', rapId).single();
        if (!rap) continue;
        const res = await fetch(`${BASE_URL}/api/rapprochements`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rapId, statut: 'validé', factureId: rap.facture_id }),
        });
        if (res.ok) valides++;
      }
      return JSON.stringify({ valides });
    }

    if (name === 'resoudre_exceptions') {
      const ids = Array.isArray(input.ids) ? input.ids as string[] : [];
      const statut = String(input.nouveau_statut ?? 'résolue');
      const commentaire = String(input.commentaire ?? '');
      if (ids.length === 0) return JSON.stringify({ resolues: 0 });
      const updates: Record<string, unknown> = { statut_exception: statut };
      if (commentaire) updates.commentaire = commentaire;
      if (statut === 'résolue') updates.date_resolution = new Date().toISOString();
      await supabase.from('exceptions').update(updates).in('id', ids);
      return JSON.stringify({ resolues: ids.length });
    }

    if (name === 'lancer_scan_gmail') {
      const res = await fetch(`${BASE_URL}/api/gmail/sync`, { method: 'POST' });
      const json = await res.json() as { commandes_importees?: number; doublons_ignores?: number; erreurs?: string[] };
      return JSON.stringify(json);
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
    while (iterations < 10) {
      iterations++;
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY!,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 2048,
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

      const text = data.content.find((c: ClaudeContentBlock) => c.type === 'text')?.text ?? 'Je ne peux pas répondre pour le moment.';
      return NextResponse.json({ reply: text });
    }

    return NextResponse.json({ reply: 'Je n\'ai pas pu traiter votre demande.' });
  } catch (err) {
    console.error('[assistant]', err);
    return NextResponse.json({ error: 'Erreur interne' }, { status: 500 });
  }
}
