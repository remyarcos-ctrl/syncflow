// Wrapper Gmail REST API — sans googleapis (économise ~50 MB de dépendances)

import { createClient } from '@supabase/supabase-js';

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

// ── Config Supabase admin ──────────────────────────────────────────────────────

function adminSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GmailConfig {
  id: string;
  email: string;
  access_token: string;
  refresh_token: string;
  token_expiry: string | null;
  last_sync_at: string | null;
  processed_thread_ids: string[];
}

interface GmailMessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { size: number; data?: string; attachmentId?: string };
  parts?: GmailMessagePart[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  payload?: GmailMessagePart;
  snippet?: string;
}

export interface GmailThread {
  id: string;
  messages?: GmailMessage[];
}

// ── Token management ──────────────────────────────────────────────────────────

export async function getGmailConfig(): Promise<GmailConfig | null> {
  const sb = adminSupabase();
  const { data } = await sb.from('gmail_config').select('*').limit(1).maybeSingle();
  if (!data) return null;
  return { ...data, processed_thread_ids: data.processed_thread_ids ?? [] } as GmailConfig;
}

export async function getValidToken(): Promise<{ token: string; config: GmailConfig } | null> {
  const config = await getGmailConfig();
  if (!config) return null;

  // Token valide encore 2 min+
  if (config.token_expiry && new Date(config.token_expiry) > new Date(Date.now() + 120_000)) {
    return { token: config.access_token, config };
  }

  // Refresh
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: config.refresh_token,
      grant_type: 'refresh_token',
    }),
  });

  if (!resp.ok) return null;
  const tokens = await resp.json() as { access_token: string; expires_in: number };

  const expiry = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
  const sb = adminSupabase();
  await sb.from('gmail_config').update({
    access_token: tokens.access_token,
    token_expiry: expiry,
  }).eq('id', config.id);

  return { token: tokens.access_token, config: { ...config, access_token: tokens.access_token, token_expiry: expiry } };
}

export async function saveGmailConfig(params: {
  email: string;
  access_token: string;
  refresh_token: string;
  expires_in: number;
}) {
  const sb = adminSupabase();
  const expiry = new Date(Date.now() + params.expires_in * 1000).toISOString();
  const existing = await getGmailConfig();

  if (existing) {
    await sb.from('gmail_config').update({
      email: params.email,
      access_token: params.access_token,
      refresh_token: params.refresh_token,
      token_expiry: expiry,
    }).eq('id', existing.id);
  } else {
    await sb.from('gmail_config').insert({
      email: params.email,
      access_token: params.access_token,
      refresh_token: params.refresh_token,
      token_expiry: expiry,
      processed_thread_ids: [],
    });
  }
}

export async function markThreadsProcessed(configId: string, threadIds: string[]) {
  const sb = adminSupabase();
  const config = await getGmailConfig();
  if (!config) return;
  const all = [...new Set([...config.processed_thread_ids, ...threadIds])];
  await sb.from('gmail_config').update({
    processed_thread_ids: all,
    last_sync_at: new Date().toISOString(),
  }).eq('id', configId);
}

// ── Gmail API calls ───────────────────────────────────────────────────────────

async function gmailFetch<T>(token: string, path: string): Promise<T> {
  const resp = await fetch(`${GMAIL_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`Gmail API ${path}: ${resp.status}`);
  return resp.json() as Promise<T>;
}

/** Liste les threads selon une query Gmail */
export async function listThreads(token: string, query: string, maxResults = 50): Promise<string[]> {
  const params = new URLSearchParams({ q: query, maxResults: String(maxResults) });
  const data = await gmailFetch<{ threads?: { id: string }[] }>(token, `/users/me/threads?${params}`);
  return (data.threads ?? []).map((t) => t.id);
}

/** Récupère un thread complet avec tous ses messages */
export async function getThread(token: string, threadId: string): Promise<GmailThread> {
  return gmailFetch<GmailThread>(token, `/users/me/threads/${threadId}?format=full`);
}

/** Récupère une pièce jointe (retourne le contenu base64url) */
export async function getAttachment(token: string, messageId: string, attachmentId: string): Promise<string> {
  const data = await gmailFetch<{ data: string }>(token, `/users/me/messages/${messageId}/attachments/${attachmentId}`);
  return data.data; // base64url
}

// ── Helpers MIME ──────────────────────────────────────────────────────────────

/** Récupère le header d'un message */
export function getHeader(msg: GmailMessage, name: string): string {
  return msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

/** Décode un body base64url en string UTF-8 */
export function decodeBase64(data: string): string {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

// ── Envoi d'email ─────────────────────────────────────────────────────────────

/** Envoie un email via l'API Gmail avec le token OAuth de l'utilisateur */
export async function sendEmail(token: string, params: {
  from: string;
  to: string;
  subject: string;
  body: string;
}): Promise<void> {
  const message = [
    `From: ${params.from}`,
    `To: ${params.to}`,
    `Subject: =?UTF-8?B?${Buffer.from(params.subject).toString('base64')}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(params.body).toString('base64'),
  ].join('\r\n');

  const raw = Buffer.from(message).toString('base64url');

  const resp = await fetch(`${GMAIL_BASE}/users/me/messages/send`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Gmail send error ${resp.status}: ${err}`);
  }
}

/** Walk récursif des parts MIME pour trouver le texte plain et les pièces jointes PDF */
export function extractParts(part: GmailMessagePart): {
  text: string | null;
  attachments: { filename: string; attachmentId: string; messageId: string }[];
} {
  let text: string | null = null;
  const attachments: { filename: string; attachmentId: string; messageId: string }[] = [];

  function walk(p: GmailMessagePart, msgId: string) {
    if (p.mimeType === 'text/plain' && p.body?.data && !text) {
      text = decodeBase64(p.body.data).slice(0, 12000); // limite CONTEXT.md
    }
    if (p.filename && p.filename.toLowerCase().endsWith('.pdf') && p.body?.attachmentId) {
      attachments.push({ filename: p.filename, attachmentId: p.body.attachmentId, messageId: msgId });
    }
    if (p.parts) {
      for (const child of p.parts) walk(child, msgId);
    }
  }

  // msgId n'est pas dans le part — on le passera depuis l'appelant
  walk(part, '');
  return { text, attachments };
}

/** Extraction des parts d'un message complet */
export function extractMessageParts(msg: GmailMessage): {
  text: string | null;
  attachments: { filename: string; attachmentId: string; messageId: string }[];
} {
  if (!msg.payload) return { text: null, attachments: [] };

  let text: string | null = null;
  const attachments: { filename: string; attachmentId: string; messageId: string }[] = [];

  function walk(p: GmailMessagePart) {
    if (p.mimeType === 'text/plain' && p.body?.data && !text) {
      text = decodeBase64(p.body.data).slice(0, 12000);
    }
    if (p.mimeType === 'text/html' && p.body?.data && !text) {
      const html = decodeBase64(p.body.data);
      // Strip HTML tags pour avoir le texte brut
      text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 12000);
    }
    if (p.filename && p.filename.toLowerCase().endsWith('.pdf') && p.body?.attachmentId) {
      attachments.push({ filename: p.filename, attachmentId: p.body.attachmentId, messageId: msg.id });
    }
    if (p.parts) {
      for (const child of p.parts) walk(child);
    }
  }

  walk(msg.payload);
  return { text, attachments };
}
