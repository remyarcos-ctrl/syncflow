import { NextResponse } from 'next/server';
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
) {
  const { text } = extractMessageParts(message);
  if (!text) { result.erreurs.push(`Message ${message.id}: pas de texte`); return; }

  const subject = getHeader(message, 'subject');
  const from = getHeader(message, 'from');

  const parsed = await parseCommandeFromEmail(text, subject, from);
  if (!parsed) { result.erreurs.push(`Message ${message.id}: parsing commande échoué`); return; }

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
    await sb.from('lignes_commande').insert(
      parsed.lignes.map((l, i) => ({
        commande_id: cmd.id,
        ligne_no: i + 1,
        reference_article: l.reference_article,
        designation: l.designation,
        quantite_commandee: l.quantite_commandee,
        pu_commande: l.pu_commande,
        quantite_receptionnee_reelle: 0,
        quantite_facturee: 0,
        quantite_restante_a_recevoir: l.quantite_commandee,
        quantite_restante_a_facturer: l.quantite_commandee,
      })),
    );
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

export async function POST() {
  const auth = await getValidToken();
  if (!auth) {
    return NextResponse.json({ error: 'Gmail non connecté' }, { status: 401 });
  }

  const { token, config } = auth;
  const sb = adminSb();

  const result: SyncResult = {
    commandes_importees: 0,
    doublons_ignores: 0,
    erreurs: [],
    details: [],
  };

  // processed_thread_ids stocke désormais des message IDs (plus fiable que thread IDs
  // car Gmail groupe tous les emails Centralink dans un seul thread)
  const processedSet = new Set(config.processed_thread_ids);
  const newMessageIds: string[] = [];

  // ── 1. Threads Centralink (commandes) ─────────────────────────────────────
  const cmdQuery = 'from:no-reply@centralink.fr subject:COMMANDE';
  const cmdThreadIds = await listThreads(token, cmdQuery, 50);

  for (const threadId of cmdThreadIds) {
    try {
      const thread = await getThread(token, threadId);
      for (const msg of thread.messages ?? []) {
        if (processedSet.has(msg.id)) continue; // message déjà traité
        const subject = getHeader(msg, 'subject');
        if (/COMMANDE\s+POUR/i.test(subject)) {
          await importCommande(sb, token, msg, result);
        }
        newMessageIds.push(msg.id);
      }
    } catch (err) {
      result.erreurs.push(`Thread ${threadId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── 2. Marquer les messages comme traités ─────────────────────────────────
  if (newMessageIds.length > 0) {
    await markThreadsProcessed(config.id, newMessageIds);
  }

  return NextResponse.json(result);
}
