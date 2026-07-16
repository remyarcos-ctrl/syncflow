// Insertion des 6 factures Colombi de JANVIER 2026, extraites MANUELLEMENT (Claude a lu
// les PDF page par page — crédit API épuisé, cf jan-factures.json, sommes vérifiées au
// centime contre les totaux imprimés). Même chemin que l'import : dédup par n°, upload du
// PDF (pdf_url), lignes agrégées, journal. Puis détection complète.
// Exécution : npx tsx tests/import-jan-manual.ts
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const env: Record<string, string> = {};
for (const line of fs.readFileSync('C:/Users/Compta-02/syncflow/.env.local', 'utf8').split('\n')) {
  const m = line.trim().match(/^([^#=]+)=(.*)$/); if (m) env[m[1].trim()] = m[2].trim();
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, (env.SUPABASE_SERVICE_ROLE_KEY || '').trim());
const APP = (env.SYNCFLOW_URL || 'https://syncflow-teal.vercel.app').replace(/\/+$/, '');
const SCRATCH = 'C:/Users/COMPTA~1/AppData/Local/Temp/claude/C--Users-Compta-02/cf1c6277-5775-49e8-a3c7-326c0c789fae/scratchpad';

interface Ligne { ref: string; designation: string; qte: number; montant_ht: number; be: string }
interface Fact { numero_facture: string; date_facture: string; total_ht: number; total_ttc: number; pdf_local: string; lignes: Ligne[] }
// Fichier de données en argument (défaut : janvier). Ex : npx tsx tests/import-jan-manual.ts tests/dec-factures.json
const DATA_PATH = process.argv[2] ?? 'C:/Users/Compta-02/syncflow/tests/jan-factures.json';
const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')) as { factures: Fact[] };

(async () => {
  let ok = 0, dbl = 0;
  for (const f of data.factures) {
    const { data: exist } = await sb.from('factures').select('id').eq('numero_facture', f.numero_facture).limit(1);
    if (exist?.length) { console.log(`DÉJÀ  ${f.numero_facture}`); dbl++; continue; }

    // PDF → storage (pdf_url cliquable comme pour les imports normaux)
    let pdfUrl = '';
    try {
      const buf = fs.readFileSync(`${SCRATCH}/${f.pdf_local}`);
      const path = `pdf/${Date.now()}-${f.pdf_local}`;
      const up = await sb.storage.from('documents').upload(path, buf, { contentType: 'application/pdf', upsert: true });
      if (!up.error) pdfUrl = sb.storage.from('documents').getPublicUrl(path).data.publicUrl;
    } catch { /* pdf_url vide si fichier absent */ }

    const { data: rec, error } = await sb.from('factures').insert({
      numero_facture: f.numero_facture, fournisseur: 'COLOMBI-SPORTS', date_facture: f.date_facture,
      total_ht: f.total_ht, total_ttc: f.total_ttc, taux_rapprochement: 0, statut_facture: 'importée', pdf_url: pdfUrl,
    }).select('id').single();
    if (error || !rec) { console.log(`ERREUR ${f.numero_facture}: ${error?.message}`); continue; }

    await sb.from('lignes_facture').insert(f.lignes.map((l, ix) => ({
      facture_id: rec.id, ligne_no: ix + 1, reference_article: l.ref, designation: l.designation,
      quantite_facturee: l.qte, pu_facture: Math.round((l.montant_ht / l.qte) * 10000) / 10000,
      montant_ht: l.montant_ht, numero_be_detecte: l.be,
    })));
    await sb.from('journal_activite').insert({
      type_action: 'import_pdf', entite_type: 'facture', entite_id: rec.id,
      details_action: JSON.stringify({ fichier: f.pdf_local, lignes: f.lignes.length, source: 'extraction-manuelle-claude (jan-factures.json, sommes vérifiées au centime)' }),
    });
    ok++;
    console.log(`OK    ${f.numero_facture} (${f.lignes.length} lignes, ${f.total_ht} € HT)`);
  }
  console.log(`\nBILAN : ${ok} importées · ${dbl} déjà présentes`);
  const r = await fetch(`${APP}/api/detect-anomalies?refresh=1`, { method: 'POST' });
  console.log('DETECTION:', JSON.stringify(await r.json().catch(() => ({}))));
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
