// Import manuel des 2 scans du 17/07 (crédit API épuisé — lus page à page par Claude) :
//  • BE-26-07-0549 (10 pages, 445 produits, 22 383,44 € HT, cde client 5651) : NOUVEAU bon,
//    lignes vérifiées contre le total imprimé (±0,03 € d'arrondis d'impression).
//  • BE-26-06-1720 : REMPLACE l'import tronqué (29 lignes) par le bon complet lu le 17/07 :
//    RO00007 ×200 (35 820 €) + RO00031 ×4 (644,40 €) = 204 produits, total 36 464,40 € ✓.
// Upload des PDF du Bureau en storage (pdf_url), puis détection complète.
// Exécution : npx tsx tests/import-bons-0549-1720.ts
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const env: Record<string, string> = {};
for (const line of fs.readFileSync('C:/Users/Compta-02/syncflow/.env.local', 'utf8').split('\n')) {
  const m = line.trim().match(/^([^#=]+)=(.*)$/); if (m) env[m[1].trim()] = m[2].trim();
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, (env.SUPABASE_SERVICE_ROLE_KEY || '').trim());
const APP = (env.SYNCFLOW_URL || 'https://syncflow-teal.vercel.app').replace(/\/+$/, '');

type L = { ref: string; d: string; q: number; sav?: boolean; cde?: string };
// ── BE-26-07-0549 (10/07/2026) — SAV 0 € en hors_systeme, le reste cde 5651 ──
const L0549: L[] = [
  { ref: '70', d: 'SAV SOUS GARANTIE (1077×2, LB600×2, SR1000X, CANIK LTL×2, VESTA, TACC, PP30×2, SR1200S×2)', q: 13, sav: true },
  { ref: '19485', d: 'PISTOLET CZ SHADOW 2 BB CO2 — Échange SAV', q: 1, sav: true },
  { ref: '490041', d: 'REVOLVER VIGILANTE CO2 — Échange SAV', q: 1, sav: true },
  { ref: 'PR004', d: 'SHOCKER LAMPE W6 — Échange SAV', q: 3, sav: true },
  { ref: '491014', d: 'PISTOLET TAC31 CO2+LASER — Échange SAV', q: 1, sav: true },
  { ref: 'SN0021', d: 'REVOLVER CP300 C50 — Échange SAV', q: 1, sav: true },
  { ref: '490051', d: 'CARABINE VANTAGE BOIS NP — Échange SAV', q: 1, sav: true },
  { ref: 'PR007', d: 'SHOCKER GLOSS PINK — Échange SAV', q: 1, sav: true },
  { ref: '18911', d: 'REVOLVER SCHOFIELD 6" — Échange SAV', q: 1, sav: true },
  { ref: 'REM007', d: 'CARABINE TYRANT BOIS — Échange SAV', q: 1, sav: true },
  { ref: '17181', d: 'PISTOLET 6MM STI TAC MASTER GAZ BLOWBACK', q: 3, cde: '5651' },
  { ref: 'CR00022', d: 'CARABINE 1077 TACTICAL CO2 C4.5 8J', q: 5, cde: '5651' },
  { ref: '325000', d: 'BUSCADERO CUIR', q: 5, cde: '5651' },
  { ref: 'CR00034', d: 'PISTOLET CM9B MAKO C4.5 3J (promo)', q: 6, cde: '5651' },
  { ref: '16183', d: 'REVOLVER GNB DAN WESSON 8" BRONZE MAT', q: 6, cde: '5651' },
  { ref: '2227', d: 'NECESSAIRE NETTOYAGE BOITE PLASTIQUE LAITON C4.5MM', q: 30, cde: '5651' },
  { ref: 'REM002', d: 'CARABINE T-REX BULLPUP PCP C5.5 + LUNETTE 3-9X40', q: 3, cde: '5651' },
  { ref: '18524', d: 'PISTOLET CZ P-09 DUTY FDE BB 4.5', q: 6, cde: '5651' },
  { ref: '490146', d: 'CARABINE MAG FIRE MISSION NP 4.5 + LUNETTE 4X32', q: 3, cde: '5651' },
  { ref: 'CR00002', d: 'CARABINE FIRE NP 4.5 19.9J + LUNETTE 4X32', q: 10, cde: '5651' },
  { ref: '8444', d: 'BOURRE FEUTRE C44 X200', q: 20, cde: '5651' },
  { ref: '16085', d: 'LAMPE TACTICAL SUPER XENON', q: 10, cde: '5651' },
  { ref: '76035', d: 'BARILLET RM ACIER INOX C44 FINI + 11', q: 10, cde: '5651' },
  { ref: '5332', d: 'LANCE PIERRE DRAGON', q: 15, cde: '5651' },
  { ref: '440036', d: 'PISTOLET AG92 C4.5 - PLOMBS', q: 12, cde: '5651' },
  { ref: '2226', d: 'NECESSAIRE NETTOYAGE ETUI SKAI CAL 4.5 (2 lignes : 2+18)', q: 20, cde: '5651' },
  { ref: 'PR010', d: 'SHOCKER LAMPE RED BLACK 3 000 000 V', q: 20, cde: '5651' },
  { ref: '490072', d: 'CARABINE SHOCKWAVE NP 4.5 + LUNETTE 4X32', q: 5, cde: '5651' },
  { ref: '17302', d: 'PISTOLET BERSA THUNDER 9 PRO NB 4.5', q: 12, cde: '5651' },
  { ref: 'REM007', d: 'CARABINE TYRANT BOIS C4.5 + LUNETTE 4X32', q: 5, cde: '5651' },
  { ref: 'VES002', d: 'CHARGEUR RAPIDE 6 BILLES PISTOLET PDW50 C50', q: 10, cde: '5651' },
  { ref: 'PR021', d: 'BILLES CAOUTCHOUC / ACIER C50 X50', q: 100, cde: '5651' },
  { ref: '490142', d: 'CHARGEUR RAPIDE QR CARABINE DPMS 300 CPS C4.5', q: 2, cde: '5651' },
  { ref: '70004', d: 'BARILLET REVOLVER VIGILANTE/357 PLOMB DIABOLO X3', q: 16, cde: '5651' },
  { ref: '490070', d: 'BARILLET REVOLVER VIGILANTE BBS X3', q: 15, cde: '5651' },
  { ref: 'SA0008', d: 'BALLES BFS C12/76 MAGNUM X6', q: 10, cde: '5651' },
  { ref: 'CPP44', d: 'REPLIQUE 1862 COLT POCKET POLICE ACIER SHERIFF CAL 44 PN (30 n° de série P144272→P154584)', q: 30, cde: '5651' },
  { ref: 'RGB4412', d: 'REPLIQUE 1858 RM BUFFALO LAITON 12 POUCES CAL 44 PN (R596653/55/61)', q: 3, cde: '5651' },
  { ref: 'RO00020', d: 'CARABINE 8122 22LR BOIS (10 n° de série BA26003087→BA26003199)', q: 10, cde: '5651' },
  { ref: 'RO00033', d: 'CARABINE PUMA TACTICAL 44MAG BLACK (NZB5259392, NZB5260569)', q: 2, cde: '5651' },
  { ref: 'EK0007', d: 'PISTOLET BOTAN NOIR 9MM PA (5 n° de série)', q: 5, cde: '5651' },
  { ref: 'PI00008', d: 'REPLIQUE 1851 NAVY MILLENIUM US MARTIAL LAITON (10 n° de série 808573→808582)', q: 10, cde: '5651' },
  { ref: 'EK0003', d: 'PISTOLET FIRAT MAGNUM NOIR 9MM PA (15 n° de série)', q: 15, cde: '5651' },
];
// ── BE-26-06-1720 complet (16 pages) ──
const L1720: L[] = [
  { ref: 'RO00007', d: 'CARABINE 8122 22LR (200 n° de série, pointés un à un sur le papier)', q: 200 },
  { ref: 'RO00031', d: 'CARABINE 8122 22LR TACTICAL (ACSO, ACSV, ACTD, ACTF)', q: 4 },
];

async function uploadPdf(local: string, nom: string): Promise<string> {
  try {
    const buf = fs.readFileSync(local);
    const path = `pdf/${Date.now()}-${nom}`;
    const up = await sb.storage.from('documents').upload(path, buf, { contentType: 'application/pdf', upsert: true });
    if (up.error) return '';
    return sb.storage.from('documents').getPublicUrl(path).data.publicUrl;
  } catch { return ''; }
}
const lignesRows = (beId: string, lignes: L[]) => lignes.map((l, ix) => ({
  be_id: beId, ligne_no: ix + 1, reference_article: l.ref, designation: l.d,
  quantite_receptionnee: l.q, quantite_document_be: l.q,
  quantite_facturee: 0, quantite_restante_a_facturer: l.sav ? 0 : l.q,
  hors_systeme: !!l.sav, ref_cde_client: l.cde ?? null,
}));

(async () => {
  // 1) BE-26-07-0549 — nouveau
  const { data: ex0549 } = await sb.from('be_receptions').select('id').eq('numero_be', 'BE-26-07-0549').limit(1);
  if (ex0549?.length) {
    console.log('BE-26-07-0549 déjà présent — rien à faire');
  } else {
    const url = await uploadPdf('C:/Users/Compta-02/Desktop/DOC170726-17072026143647.pdf', 'BE-26-07-0549.pdf');
    const { data: rec, error } = await sb.from('be_receptions').insert({
      numero_be: 'BE-26-07-0549', fournisseur: 'COLOMBI-SPORTS', date_bl: '2026-07-10', statut_be: 'reçu', pdf_url: url,
    }).select('id').single();
    if (error || !rec) throw new Error(`0549: ${error?.message}`);
    await sb.from('lignes_be').insert(lignesRows(rec.id, L0549));
    await sb.from('journal_activite').insert({ type_action: 'import_pdf', entite_type: 'be_reception', entite_id: rec.id, details_action: JSON.stringify({ fichier: 'DOC170726-143647 (scan Bureau)', lignes: L0549.length, source: 'extraction-manuelle-claude 17/07 — 445 produits, 22 383,44 € vérifié' }) });
    console.log(`OK BE-26-07-0549 : ${L0549.length} lignes (dont ${L0549.filter((l) => l.sav).length} SAV), cde 5651`);
  }

  // 2) BE-26-06-1720 — remplacer les lignes tronquées par le bon complet
  // stocké sans tirets (« BE26061720 ») — import précédent venu d'un scan joint à une facture
  const { data: b1720 } = await sb.from('be_receptions').select('id').eq('id', 'e7eeb165-c002-4da9-b61e-aba9bbd87499').limit(1).single();
  // normaliser la graphie au passage (format canonique à tirets, comme les autres bons)
  if (b1720) await sb.from('be_receptions').update({ numero_be: 'BE-26-06-1720' }).eq('id', b1720.id);
  if (!b1720) throw new Error('BE-26-06-1720 introuvable (attendu : import tronqué existant)');
  const { data: old } = await sb.from('lignes_be').select('id, reference_article, quantite_receptionnee').eq('be_id', b1720.id);
  console.log(`1720 : ${old?.length ?? 0} anciennes lignes (tronquées) → remplacement par RO00007 ×200 + RO00031 ×4`);
  await sb.from('lignes_be').delete().eq('be_id', b1720.id);
  await sb.from('lignes_be').insert(lignesRows(b1720.id, L1720));
  const url1720 = await uploadPdf('C:/Users/Compta-02/Desktop/DOC170726-17072026143629.pdf', 'BE-26-06-1720-complet.pdf');
  if (url1720) await sb.from('be_receptions').update({ pdf_url: url1720 }).eq('id', b1720.id);
  await sb.from('journal_activite').insert({ type_action: 'rescan_be', entite_type: 'be_reception', entite_id: b1720.id, details_action: JSON.stringify({ numero_be: 'BE-26-06-1720', note: 'Re-scan COMPLET 17/07 (ancien scan tronqué à 29 lignes) : RO00007 ×200 + RO00031 ×4 = 204 produits, 36 464,40 € vérifié. Pointage série par série visible sur le papier.', source: 'extraction-manuelle-claude' }) });
  console.log('OK BE-26-06-1720 : remplacé (200 + 4)');

  // 3) détection complète
  const r = await fetch(`${APP}/api/detect-anomalies?refresh=1`, { method: 'POST' });
  console.log('DETECTION:', JSON.stringify(await r.json().catch(() => ({}))));
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
