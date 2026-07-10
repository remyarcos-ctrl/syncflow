// AUDIT DE COUVERTURE : est-ce que CHAQUE écart réel (recalculé par le moteur de pointage
// sur les données live) a bien son anomalie au Centre (table exceptions) ?
// + contrôles de PÉRIMÈTRE : bons présents dans CL jamais importés (non contrôlés),
// bons importés inconnus de CL, doubles saisies.
// Lecture seule. Exécution : npx tsx tests/audit-couverture.ts
import fs from 'node:fs';
import { comparerPointage, causeEcart, aEcart, aliasRef, type EcartPointage } from '../src/lib/pointage';

const env: Record<string, string> = {};
for (const line of fs.readFileSync('C:/Users/Compta-02/syncflow/.env.local', 'utf8').split('\n')) {
  const m = line.trim().match(/^([^#=]+)=(.*)$/); if (m) env[m[1].trim()] = m[2].trim();
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL!, KEY = (env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

async function all<T>(path: string): Promise<T[]> {
  let out: T[] = [], from = 0;
  for (;;) {
    const r = await fetch(`${SB}/rest/v1/${path}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Range: `${from}-${from + 999}` } });
    if (!r.ok) throw new Error(`${path} → ${r.status}`);
    const part = await r.json() as T[];
    out = out.concat(part);
    if (part.length < 1000) break;
    from += 1000;
  }
  return out;
}
const nbe = (s: string | null | undefined) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

(async () => {
  const [bes, lignesBe, saisies, lignesCmd, stocks, resolutions, exceptions] = await Promise.all([
    all<{ id: string; numero_be: string }>('be_receptions?select=id,numero_be'),
    all<{ be_id: string; reference_article: string; designation: string | null; quantite_receptionnee: number; hors_systeme: boolean }>('lignes_be?select=be_id,reference_article,designation,quantite_receptionnee,hors_systeme'),
    all<{ numero_be: string; reference_article: string; quantite_recue: number; commande_ref: string | null }>('saisies_cl?select=numero_be,reference_article,quantite_recue,commande_ref'),
    all<{ reference_article: string | null; quantite_restante_a_recevoir: number | null; quantite_receptionnee_reelle: number | null; quantite_commandee: number | null }>('lignes_commande?select=reference_article,quantite_restante_a_recevoir,quantite_receptionnee_reelle,quantite_commandee'),
    all<{ reference_article: string | null; has_barcode: boolean | null }>('stocks_cl?select=reference_article,has_barcode'),
    all<{ numero_be: string; reference_article: string; statut: string; note: string | null }>('pointage_resolution?select=numero_be,reference_article,statut,note'),
    all<{ reference_article: string | null; type_exception: string; statut_exception: string; origine: string | null; be_id: string | null }>('exceptions?select=reference_article,type_exception,statut_exception,origine,be_id'),
  ]);
  console.log(`Données : ${bes.length} bons importés · ${lignesBe.length} lignes papier · ${saisies.length} saisies · ${exceptions.length} exceptions (tous statuts)`);

  // ── mêmes contextes que l'écran / le balayage ──
  const refsReliquat = new Set(lignesCmd.filter(r => (r.quantite_restante_a_recevoir ?? 0) > 0.001).map(r => aliasRef(r.reference_article)).filter(Boolean));
  const recuParRef = new Map<string, number>();
  const refsSurRecues = new Set<string>();
  for (const r of lignesCmd) {
    const k = aliasRef(r.reference_article);
    const recu = Number(r.quantite_receptionnee_reelle) || 0, cmd = Number(r.quantite_commandee) || 0;
    recuParRef.set(k, (recuParRef.get(k) ?? 0) + recu);
    if (cmd > 0 && recu > cmd + 0.001) refsSurRecues.add(k);
  }
  const refsRecues = new Set([...recuParRef].filter(([, v]) => v > 0).map(([k]) => k));
  const saisiTotalParRef = new Map<string, number>();
  for (const s of saisies) {
    const k = aliasRef(s.reference_article);
    saisiTotalParRef.set(k, (saisiTotalParRef.get(k) ?? 0) + (Number(s.quantite_recue) || 0));
  }
  const nonDetailleByRef = new Map<string, number>();
  for (const [k, recu] of recuParRef) { const nd = recu - (saisiTotalParRef.get(k) ?? 0); if (nd > 0.001) nonDetailleByRef.set(k, nd); }
  const refsBarcode = new Set(stocks.filter(s => s.has_barcode === true).map(s => aliasRef(s.reference_article)).filter(Boolean));
  const opts = { refsReliquat, refsRecues, recuTotalByRef: recuParRef, refsSurRecues, refsBarcode, nonDetailleByRef };

  const lignesByBe = new Map<string, typeof lignesBe>();
  for (const l of lignesBe) { (lignesByBe.get(l.be_id) ?? lignesByBe.set(l.be_id, []).get(l.be_id)!).push(l); }
  const saisiesByBe = new Map<string, typeof saisies>();
  for (const s of saisies) { (saisiesByBe.get(s.numero_be) ?? saisiesByBe.set(s.numero_be, []).get(s.numero_be)!).push(s); }
  const resByBe = new Map<string, typeof resolutions>();
  for (const r of resolutions) { (resByBe.get(r.numero_be) ?? resByBe.set(r.numero_be, []).get(r.numero_be)!).push(r); }

  // ── balayage : collecter tous les écarts réels ──
  const ecarts: { be: string; e: EcartPointage; cause: string }[] = [];
  for (const be of bes) {
    const sa = saisiesByBe.get(be.numero_be) ?? [];
    if (!sa.length) continue;
    const rows = comparerPointage(lignesByBe.get(be.id) ?? [], sa, resByBe.get(be.numero_be) ?? [], opts);
    for (const e of rows) {
      const c = causeEcart(e);
      if (aEcart(e) && c.code !== 'conforme') ecarts.push({ be: be.numero_be, e, cause: c.code });
    }
  }

  // ── exceptions par réf aliasée (tous statuts : une anomalie travaillée/résolue COMPTE
  //    comme couverte — elle a été remontée) ──
  const excByRef = new Map<string, { type: string; statut: string }[]>();
  const excBonEntier = new Set<string>();   // be_id porteurs d'une anomalie de bon (réf vide)
  for (const x of exceptions) {
    const k = aliasRef(x.reference_article ?? '');
    if (!k) { if (x.be_id) excBonEntier.add(x.be_id); continue; }
    (excByRef.get(k) ?? excByRef.set(k, []).get(k)!).push({ type: x.type_exception, statut: x.statut_exception });
  }
  const beIdByNum2 = new Map(bes.map(b => [nbe(b.numero_be), b.id]));

  // ── LE TEST : chaque écart (hors dispatch, géré par design) doit avoir une exception ──
  // dispatch = saisi sous un bon partagé alors que reçu=commandé partout : par design le
  // Centre ne le porte pas (aucune marchandise en jeu, pur rangement de n° de bon).
  let manques = 0, couverts = 0, dispatchSkip = 0;
  console.log('\n═══ COUVERTURE DES ÉCARTS PAR LE CENTRE ═══');
  for (const { be, e, cause } of ecarts.sort((a, b) => Math.abs(b.e.ecart) - Math.abs(a.e.ecart))) {
    if (cause === 'dispatch') { dispatchSkip++; continue; }
    const k = aliasRef(e.ref);
    const hits = excByRef.get(k) ?? [];
    if (hits.length) { couverts++; continue; }
    // crédit anomalie de BON ENTIER (réf vide, ancre be_id) : couvre toutes les réfs du bon
    if (excBonEntier.has(beIdByNum2.get(nbe(be)) ?? '')) { couverts++; continue; }
    manques++;
    console.log(`  ❌ NON COUVERT : ${be} ${e.ref} (②${e.papier ?? '—'} ③${e.cl ?? '—'} écart ${e.ecart}, cause ${cause}) — AUCUNE exception pour cette réf`);
  }
  console.log(`  → ${couverts} écarts couverts par une exception · ${dispatchSkip} dispatch (par design) · ${manques} NON COUVERTS`);

  // ── PÉRIMÈTRE 1 : bons connus de CL jamais importés (non contrôlés) ──
  const importes = new Set(bes.map(b => nbe(b.numero_be)));
  const bonsCL = new Map<string, number>();
  for (const s of saisies) { const n = nbe(s.numero_be); if (n) bonsCL.set(n, (bonsCL.get(n) ?? 0) + 1); }
  const nonImportes = [...bonsCL].filter(([n]) => !importes.has(n));
  console.log(`\n═══ PÉRIMÈTRE : bons CL jamais importés (non contrôlés) : ${nonImportes.length} ═══`);
  for (const [n, cnt] of nonImportes.sort().slice(-15)) console.log(`  ${n} (${cnt} saisies)`);
  if (nonImportes.length > 15) console.log(`  … et ${nonImportes.length - 15} autres (plus anciens)`);

  // ── PÉRIMÈTRE 2 : bons importés inconnus de CL (0 saisie sous ce numéro) ──
  const sansSaisie = bes.filter(b => !bonsCL.has(nbe(b.numero_be)));
  console.log(`\n═══ PÉRIMÈTRE : bons importés SANS AUCUNE saisie CL sous ce n° : ${sansSaisie.length} ═══`);
  let perim2Suspects = 0;
  for (const b of sansSaisie) {
    const lg = lignesByBe.get(b.id) ?? [];
    const actives = lg.filter(l => !l.hors_systeme && (Number(l.quantite_receptionnee) || 0) > 0);
    const q = actives.reduce((s, l) => s + (Number(l.quantite_receptionnee) || 0), 0);
    // couvert si : bon 100% SAV (hors système → 0 saisie NORMAL), avoir/retour (qté ≤ 0),
    // anomalie de BON ENTIER sur ce be_id, ou toutes les réfs actives portées au Centre.
    const bonEntier = excBonEntier.has(b.id);
    const refsOk = actives.every(l => (excByRef.get(aliasRef(l.reference_article)) ?? []).length > 0);
    const etat = !actives.length ? '→ SAV/avoir (hors système, pas de saisie attendue)'
      : bonEntier ? '→ couvert (anomalie de bon entier)'
      : refsOk ? '→ réfs portées au Centre'
      : (perim2Suspects++, '→ ⚠ VÉRIFIER : réfs pas toutes au Centre');
    console.log(`  ${b.numero_be} (${lg.length} lignes, ${q} unités actives) ${etat}`);
  }

  // ── PÉRIMÈTRE 3 : doubles saisies strictement identiques (échantillon de contrôle) ──
  const comptes = new Map<string, number>();
  for (const s of saisies) {
    const key = `${nbe(s.numero_be)}|${aliasRef(s.reference_article)}|${s.quantite_recue}|${s.commande_ref ?? ''}`;
    comptes.set(key, (comptes.get(key) ?? 0) + 1);
  }
  const doubles = [...comptes].filter(([, n]) => n > 1);
  console.log(`\n═══ DOUBLES SAISIES IDENTIQUES (be|réf|qté|cmd en ≥ 2 exemplaires) : ${doubles.length} ═══`);
  let dblNonCouverts = 0;
  for (const [key, n] of doubles) {
    const [be, ref] = key.split('|');
    if (ref === 'EXTRA') { console.log(`  ${be} EXTRA ×${n} (exclu par design : ligne de frais, pas un article)`); continue; }
    const hits = excByRef.get(ref) ?? [];
    const ok = hits.length > 0;
    if (!ok) dblNonCouverts++;
    console.log(`  ${be} ${ref} ×${n} ${ok ? '(couvert au Centre)' : '❌ NON COUVERT'}`);
  }

  console.log(`\n═══ BILAN AUDIT ═══`);
  console.log(`écarts moteur non couverts : ${manques} · doubles saisies non couvertes : ${dblNonCouverts} · bons CL hors périmètre : ${nonImportes.length}`);
  if (manques + dblNonCouverts > 0) process.exit(1);
})();
