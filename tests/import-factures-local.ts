// IMPORT LOCAL des factures Colombi 2026 (Pennylane → storage → parse local → insert).
// Pourquoi local : les grosses factures multi-pages dépassent le timeout Vercel (60 s,
// « 504 ») — ici pas de limite. Reprend la logique EXACTE de /api/import-pdf (dédup par
// n° normalisé, move temp/→pdf/, insertion lignes, journal, coût) via les modules de l'appli.
// Relançable sans risque (doublons ignorés). Exécution : npx tsx tests/import-factures-local.ts
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { parsePdfDocuments, normalizeRef } from '../src/lib/document-parser';
import { chargerCatalogue, controlerRefsCatalogue } from '../src/lib/catalogue';

const env: Record<string, string> = {};
for (const line of fs.readFileSync('C:/Users/Compta-02/syncflow/.env.local', 'utf8').split('\n')) {
  const m = line.trim().match(/^([^#=]+)=(.*)$/); if (m) env[m[1].trim()] = m[2].trim();
}
process.env.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;      // le parseur lit process.env
const PLKEY = (process.env.PENNYLANE_API_KEY || '').trim();
if (!PLKEY) { console.error('PENNYLANE_API_KEY absente'); process.exit(1); }
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, (env.SUPABASE_SERVICE_ROLE_KEY || '').trim());
const APP = (env.SYNCFLOW_URL || 'https://syncflow-teal.vercel.app').replace(/\/+$/, '');

const normNum = (s: string) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
async function isDuplicate(table: string, field: string, value: string): Promise<boolean> {
  const norm = normNum(value);
  const { data: exact } = await sb.from(table).select('id').eq(field, value).limit(1);
  if ((exact?.length ?? 0) > 0) return true;
  const suffix = norm.slice(-8);
  if (suffix.length < 4) return false;
  const { data } = await sb.from(table).select(field).ilike(field, `%${suffix}%`);
  return (data ?? []).some((row) => normNum(String((row as unknown as Record<string, unknown>)[field] ?? '')) === norm);
}

async function listeColombi() {
  let cursor: string | null = null; const all: Record<string, unknown>[] = [];
  for (let i = 0; i < 20; i++) {
    const q = new URLSearchParams({ limit: '100', sort: '-date', filter: JSON.stringify([{ field: 'date', operator: 'gteq', value: '2026-01-01' }]) });
    if (cursor) q.set('cursor', cursor);
    const r = await fetch(`https://app.pennylane.com/api/external/v2/supplier_invoices?${q}`, { headers: { Authorization: `Bearer ${PLKEY}` } });
    if (!r.ok) throw new Error(`Pennylane ${r.status}`);
    const d = await r.json() as { items?: Record<string, unknown>[]; has_more?: boolean; next_cursor?: string };
    all.push(...(d.items ?? []));
    if (!d.has_more || !d.next_cursor) break;
    cursor = d.next_cursor;
  }
  const nom = (it: Record<string, unknown>) => String((it.supplier as { name?: string })?.name ?? it.label ?? '?');
  return all.filter((it) => /colombi/i.test(nom(it) + '|' + String(it.label ?? '')));
}

// Log ÉCRIT EN DIRECT (append synchrone) : le stdout d'un process détaché est bufferisé
// par blocs → log invisible pendant des minutes. appendFileSync = chaque ligne visible.
const LOG = 'C:/Users/Compta-02/syncflow/import-factures.log';
const log = (s: string) => { fs.appendFileSync(LOG, s + '\n'); };
// Garde-fou anti-blocage : une requête (Pennylane, Claude, Supabase) qui se fige sans
// timeout bloquait TOUTE la chaîne séquentielle (vécu : 30 min sans activité). Chaque
// document a 4 min max, sinon on le saute et on continue.
const avecTimeout = <T,>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms / 1000}s`)), ms))]);

(async () => {
  const colombi = await listeColombi();
  log(`${colombi.length} documents Colombi (relance : les déjà-importés seront des doublons)`);
  const catalogue = await chargerCatalogue(sb).catch(() => new Set<string>());
  let factOk = 0, beOk = 0, dbl = 0, echecs = 0, coutTotal = 0;
  for (const [i, it] of colombi.entries()) {
    const label = `${it.date} ${it.invoice_number ?? '?'} (${it.amount} €)`;
    try {
      if (!it.public_file_url) { log(`SKIP  ${label} — pas de fichier`); echecs++; continue; }
      // PRÉ-DÉDUP par n° Pennylane : évite de re-parser (temps + argent) un document déjà
      // importé. Les n° non significatifs (« 003 ») passent au parsing (dédup post-parse).
      const num = String(it.invoice_number ?? '');
      if (/^(FA|BE)/i.test(num) && (await isDuplicate('factures', 'numero_facture', num) || await isDuplicate('be_receptions', 'numero_be', num))) {
        dbl++; log(`DÉJÀ  [${i + 1}/${colombi.length}] ${label} — importé, pas de re-parsing`); continue;
      }
      const fr = await avecTimeout(fetch(String(it.public_file_url)), 60_000);
      if (!fr.ok) throw new Error(`download ${fr.status}`);
      const buf = Buffer.from(await avecTimeout(fr.arrayBuffer(), 60_000));
      const safe = String(it.filename || `${it.invoice_number || it.id}.pdf`).replace(/[^a-zA-Z0-9._-]/g, '_');

      // Parse LOCAL — 4 min max par document (multi-pages compris)
      const { docs, coutEUR } = await avecTimeout(parsePdfDocuments(buf.toString('base64'), safe), 240_000);
      coutTotal += coutEUR;

      // Storage : directement en pdf/ (chemin permanent, comme après le move de la route)
      const permanentPath = `pdf/${Date.now()}-${safe}`;
      let pdfUrl = '';
      const up = await sb.storage.from('documents').upload(permanentPath, buf, { contentType: 'application/pdf', upsert: true });
      if (!up.error) pdfUrl = sb.storage.from('documents').getPublicUrl(permanentPath).data.publicUrl;

      const details: string[] = [];
      for (const doc of docs) {
        if (doc.type === 'inconnu') { details.push(`inconnu: ${doc.raison.slice(0, 80)}`); continue; }
        if (doc.type === 'be') {
          if (await isDuplicate('be_receptions', 'numero_be', doc.data.numero_be)) { dbl++; details.push(`dbl BE ${doc.data.numero_be}`); continue; }
          const { data: beRec, error } = await sb.from('be_receptions').insert({
            numero_be: doc.data.numero_be, fournisseur: doc.data.fournisseur, date_bl: doc.data.date_bl,
            statut_be: 'reçu', pdf_url: pdfUrl,
          }).select('id').single();
          if (error || !beRec) { details.push(`ERR BE ${doc.data.numero_be}: ${error?.message?.slice(0, 60)}`); continue; }
          if (doc.data.lignes.length) {
            await sb.from('lignes_be').insert(doc.data.lignes.map((l, ix) => ({
              be_id: beRec.id, ligne_no: ix + 1, reference_article: l.reference_article, designation: l.designation,
              quantite_receptionnee: l.quantite_receptionnee, quantite_document_be: l.quantite_receptionnee,
              quantite_facturee: 0, quantite_restante_a_facturer: l.hors_systeme ? 0 : l.quantite_receptionnee,
              hors_systeme: l.hors_systeme ?? false,
            })));
          }
          await sb.from('journal_activite').insert({ type_action: 'import_pdf', entite_type: 'be_reception', entite_id: beRec.id, details_action: JSON.stringify({ fichier: safe, lignes: doc.data.lignes.length, source: 'pennylane-local' }) });
          beOk++;
          details.push(`✓ BE ${doc.data.numero_be} (${doc.data.lignes.length}l)`);
          for (const a of doc.data.avertissements ?? []) details.push(`⚠ ${a.slice(0, 100)}`);
          details.push(...controlerRefsCatalogue(doc.data.lignes.map((l) => ({ reference_article: l.reference_article, quantite: l.quantite_receptionnee })), catalogue).map((a) => `⚠ ${a.slice(0, 100)}`));
        }
        if (doc.type === 'facture') {
          if (await isDuplicate('factures', 'numero_facture', doc.data.numero_facture)) { dbl++; details.push(`dbl FACT ${doc.data.numero_facture}`); continue; }
          const { data: factRec, error } = await sb.from('factures').insert({
            numero_facture: doc.data.numero_facture, fournisseur: doc.data.fournisseur, date_facture: doc.data.date_facture,
            total_ht: doc.data.total_ht, total_ttc: doc.data.total_ttc, taux_rapprochement: 0, statut_facture: 'importée', pdf_url: pdfUrl,
          }).select('id').single();
          if (error || !factRec) { details.push(`ERR FACT ${doc.data.numero_facture}: ${error?.message?.slice(0, 60)}`); continue; }
          // agrégation par (BE, réf, PU) comme la route
          const aggMap = new Map<string, typeof doc.data.lignes[0]>();
          for (const l of doc.data.lignes) {
            const k = `${l.numero_be_detecte ?? ''}|${normalizeRef(l.reference_article ?? '')}|${Math.round((l.prix_unitaire ?? 0) * 10000)}`;
            const ex = aggMap.get(k);
            if (ex) { ex.quantite_facturee += l.quantite_facturee; ex.montant_ht = (ex.montant_ht ?? 0) + (l.montant_ht ?? 0); }
            else aggMap.set(k, { ...l });
          }
          const lignes = [...aggMap.values()].map((l) => ({
            ...l, prix_unitaire: l.montant_ht && l.quantite_facturee > 0 ? l.montant_ht / l.quantite_facturee : l.prix_unitaire,
          }));
          if (lignes.length) {
            await sb.from('lignes_facture').insert(lignes.map((l, ix) => ({
              facture_id: factRec.id, ligne_no: ix + 1, reference_article: l.reference_article, designation: l.designation,
              quantite_facturee: l.quantite_facturee, pu_facture: l.prix_unitaire, montant_ht: l.montant_ht,
              numero_be_detecte: l.numero_be_detecte,
            })));
          }
          await sb.from('journal_activite').insert({ type_action: 'import_pdf', entite_type: 'facture', entite_id: factRec.id, details_action: JSON.stringify({ fichier: safe, lignes: lignes.length, source: 'pennylane-local' }) });
          factOk++;
          details.push(`✓ FACT ${doc.data.numero_facture} (${lignes.length}l)`);
        }
      }
      if (coutEUR > 0) await sb.from('journal_activite').insert({ type_action: 'cout_claude', entite_type: 'import', details_action: JSON.stringify({ fichier: safe, cout_eur: coutEUR, source: 'pennylane-local' }) });
      log(`OK    [${i + 1}/${colombi.length}] ${label} → ${details.join(' | ').slice(0, 260)}`);
    } catch (e) {
      echecs++;
      log(`ÉCHEC [${i + 1}/${colombi.length}] ${label} — ${String((e as Error).message).slice(0, 150)}`);
    }
  }
  log(`BILAN : ${factOk} factures + ${beOk} BE importés · ${dbl} doublons · ${echecs} échecs · coût parsing ≈ ${coutTotal.toFixed(2)} €`);
  const r = await fetch(`${APP}/api/detect-anomalies?refresh=1`, { method: 'POST' });
  log('DETECTION: ' + JSON.stringify(await r.json().catch(() => ({}))));
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
