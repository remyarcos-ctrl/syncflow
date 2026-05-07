import { NextRequest, NextResponse } from 'next/server';

export const maxDuration = 60;
import { createClient } from '@supabase/supabase-js';
import {
  getValidToken,
  listThreads,
  getThread,
  getHeader,
  extractMessageParts,
  markThreadsProcessed,
} from '@/lib/gmail-api';
import { parseCommandeFromEmail } from '@/lib/document-parser';
import type { GmailMessage } from '@/lib/gmail-api';

function adminSb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

interface SyncResult {
  commandes_importees: number;
  doublons_ignores: number;
  filtres_ignores: number;
  erreurs: string[];
  details: string[];
}

// ── Détection doublon par numéro normalisé (100% seuil - CONTEXT.md) ─────────

function normalizeDocNum(s: string): string {
  return String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

async function isDuplicate(sb: ReturnType<typeof adminSb>, table: string, field: string, value: string): Promise<boolean> {
  const { data } = await sb.from(table).select(field);
  if (!data) return false;
  const norm = normalizeDocNum(value);
  return data.some((row) => normalizeDocNum(String((row as unknown as Record<string, unknown>)[field] ?? '')) === norm);
}

// ── Import Commande ───────────────────────────────────────────────────────────

async function importCommande(
  sb: ReturnType<typeof adminSb>,
  token: string,
  message: GmailMessage,
  result: SyncResult,
  filtresFournisseurs: string[],
) {
  const { text } = extractMessageParts(message);
  if (!text) { result.erreurs.push(`Message ${message.id}: pas de texte`); return; }

  const subject = getHeader(message, 'subject');
  const from = getHeader(message, 'from');

  const parsed = await parseCommandeFromEmail(text, subject, from);
  if (!parsed) { result.filtres_ignores++; result.details.push(`⏭ ${message.id}: parsing échoué (email hors sujet ?)`); return; }

  // Rejeter si structure invalide (email hors sujet mal parsé)
  if (!parsed.numero_commande_interne || String(parsed.numero_commande_interne).trim().length < 3) {
    result.filtres_ignores++;
    result.details.push(`⏭ Numéro commande invalide, ignoré (sujet: "${subject}")`);
    return;
  }
  if (!parsed.lignes || parsed.lignes.length === 0) {
    result.filtres_ignores++;
    result.details.push(`⏭ Aucune ligne article détectée, ignoré (sujet: "${subject}")`);
    return;
  }

  // Filtre fournisseur — si la liste est vide, tout passe
  if (filtresFournisseurs.length > 0 && parsed.fournisseur) {
    const fournNorm = parsed.fournisseur.toLowerCase();
    const match = filtresFournisseurs.some(f => fournNorm.includes(f.toLowerCase()));
    if (!match) {
      result.filtres_ignores++;
      result.details.push(`⏭ Ignoré (hors filtre) : ${parsed.numero_commande_interne} — ${parsed.fournisseur}`);
      return;
    }
  }

  // Doublon
  if (await isDuplicate(sb, 'commandes', 'numero_commande_interne', parsed.numero_commande_interne)) {
    result.doublons_ignores++;
    result.details.push(`Doublon commande ignoré : ${parsed.numero_commande_interne}`);
    return;
  }

  const { data: cmd, error } = await sb.from('commandes').insert({
    numero_commande_interne: parsed.numero_commande_interne,
    fournisseur: parsed.fournisseur,
    date_commande: parsed.date_commande,
    montant_total_commande: parsed.montant_total_commande,
    statut_commande: 'ouverte',
    type_source: 'email',
  }).select('id').single();

  if (error || !cmd) { result.erreurs.push(`Erreur insert commande: ${error?.message}`); return; }

  // Lignes
  if (parsed.lignes.length > 0) {
    const { data: insertedLines } = await sb.from('lignes_commande').insert(
      parsed.lignes.map((l, i) => ({
        commande_id: cmd.id,
        ligne_no: i + 1,
        reference_article: l.reference_article,
        designation: l.designation,
        quantite_commandee: l.quantite_commandee,
        pu_commande: l.pu_commande ?? null,
        quantite_receptionnee_reelle: 0,
        quantite_facturee: 0,
        quantite_restante_a_recevoir: l.quantite_commandee,
        quantite_restante_a_facturer: l.quantite_commandee,
      })),
    ).select('id, reference_article, quantite_commandee, pu_commande');

    // Compléter les prix manquants depuis le catalogue
    const sansPrix = (insertedLines ?? []).filter(l => l.pu_commande == null && l.reference_article);
    for (const ligne of sansPrix) {
      const { data: prix } = await sb.from('prix_reference')
        .select('pu_last')
        .eq('reference_article', ligne.reference_article)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (prix) {
        await sb.from('lignes_commande').update({
          pu_commande: prix.pu_last,
          montant_ht_commande: ligne.quantite_commandee * prix.pu_last,
        }).eq('id', ligne.id);
      }
    }
  }

  await sb.from('journal_activite').insert({
    type_action: 'import_email',
    entite_type: 'commande',
    entite_id: cmd.id,
    details_action: JSON.stringify({ source: 'gmail', sujet: subject, lignes: parsed.lignes.length }),
  });

  result.commandes_importees++;
  result.details.push(`✓ Commande importée : ${parsed.numero_commande_interne} (${parsed.lignes.length} lignes)`);
}

// ── Route principale ──────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const auth = await getValidToken();
    if (!auth) {
      return NextResponse.json({ error: 'Gmail non connecté' }, { status: 401 });
    }

    const { token, config } = auth;
    const sb = adminSb();

    // Paramètres optionnels passés par l'appelant (ex: agent IA)
    let body: { fournisseur?: string; force?: boolean } = {};
    try { body = await req.json() as { fournisseur?: string; force?: boolean }; } catch { /* body vide */ }
    const filtresFournisseurs = body.fournisseur
      ? [body.fournisseur]
      : config.filtres_fournisseurs ?? [];
    const force = body.force === true;

    const result: SyncResult = {
      commandes_importees: 0,
      doublons_ignores: 0,
      filtres_ignores: 0,
      erreurs: [],
      details: [],
    };

    // processed_thread_ids stocke désormais des message IDs (plus fiable que thread IDs
    // car Gmail groupe tous les emails Centralink dans un seul thread)
    const processedSet = new Set(config.processed_thread_ids);
    const newMessageIds: string[] = [];

    // ── 1. Threads Centralink directs + emails transférés/internes ───────────
    // Deux queries : source directe Centralink ET toute autre source (emails transférés)
    const cmdQueries = [
      // Emails directs depuis n'importe quel expéditeur @centralink.fr
      'from:centralink.fr subject:COMMANDE',
      // Emails internes avec le format "Commande SD pour [Fournisseur]"
      'subject:"Commande SD" from:orchidee-innovation.fr newer_than:30d',
    ];

    const seenThreadIds = new Set<string>();
    const DEADLINE_MS = 50_000; // s'arrêter à 50s pour laisser 10s de marge avant le timeout Vercel
    const startedAt = Date.now();

    for (const cmdQuery of cmdQueries) {
      if (Date.now() - startedAt > DEADLINE_MS) break;
      const cmdThreadIds = await listThreads(token, cmdQuery, 50);

      for (const threadId of cmdThreadIds) {
        if (Date.now() - startedAt > DEADLINE_MS) break;
        if (seenThreadIds.has(threadId)) continue;
        seenThreadIds.add(threadId);
        const threadNewIds: string[] = [];
        try {
          const thread = await getThread(token, threadId);
          for (const msg of thread.messages ?? []) {
            if (!force && processedSet.has(msg.id)) continue;
            const subject = getHeader(msg, 'subject');
            if (/COMMANDE/i.test(subject) || /commande\s+sd/i.test(subject)) {
              await importCommande(sb, token, msg, result, filtresFournisseurs);
              threadNewIds.push(msg.id);
              newMessageIds.push(msg.id);
            } else {
              result.details.push(`⏭ Sujet non reconnu ignoré : "${subject}"`);
            }
          }
        } catch (err) {
          result.erreurs.push(`Thread ${threadId}: ${err instanceof Error ? err.message : String(err)}`);
        }
        // Sauvegarder la progression après chaque thread — si timeout, les suivants reprennent là où on s'est arrêté
        if (threadNewIds.length > 0) {
          await markThreadsProcessed(config.id, threadNewIds);
          threadNewIds.forEach(id => processedSet.add(id));
        }
      }
    }

    return NextResponse.json({
      ...result,
      interrompu: Date.now() - startedAt > DEADLINE_MS,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Erreur scan Gmail: ${message}` }, { status: 500 });
  }
}
