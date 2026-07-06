// BALAYAGE RÉEL : exécute le VRAI moteur de pointage (lib/pointage) sur TOUS les bons
// scannés, avec les données Supabase live, en reconstruisant les contextes exactement
// comme l'écran /rapprochement-pointage. Sort chaque écart + son verdict + des contrôles
// de santé. Lecture seule. Exécution : npx tsx tests/balayage-reel.ts
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

(async () => {
  const [bes, lignesBe, saisies, lignesCmd, stocks, resolutions] = await Promise.all([
    all<{ id: string; numero_be: string }>('be_receptions?select=id,numero_be'),
    all<{ be_id: string; reference_article: string; designation: string | null; quantite_receptionnee: number; hors_systeme: boolean }>('lignes_be?select=be_id,reference_article,designation,quantite_receptionnee,hors_systeme'),
    all<{ numero_be: string; reference_article: string; quantite_recue: number; commande_ref: string | null }>('saisies_cl?select=numero_be,reference_article,quantite_recue,commande_ref'),
    all<{ reference_article: string | null; quantite_restante_a_recevoir: number | null; quantite_receptionnee_reelle: number | null; quantite_commandee: number | null }>('lignes_commande?select=reference_article,quantite_restante_a_recevoir,quantite_receptionnee_reelle,quantite_commandee'),
    all<{ reference_article: string | null; has_barcode: boolean | null }>('stocks_cl?select=reference_article,has_barcode'),
    all<{ numero_be: string; reference_article: string; statut: string; note: string | null }>('pointage_resolution?select=numero_be,reference_article,statut,note'),
  ]);
  console.log(`Données : ${bes.length} bons · ${lignesBe.length} lignes papier · ${saisies.length} saisies · ${lignesCmd.length} lignes cmd · ${stocks.length} stocks`);

  // ── contextes IDENTIQUES à la page ──
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

  // ── balayage ──
  const counts: Record<string, number> = {};
  const ecarts: { be: string; e: EcartPointage; cause: string; label: string }[] = [];
  let sante = 0;
  let rapprochables = 0, refsTotal = 0;
  for (const be of bes) {
    const sa = saisiesByBe.get(be.numero_be) ?? [];
    if (!sa.length) continue;
    rapprochables++;
    const rows = comparerPointage(lignesByBe.get(be.id) ?? [], sa, resByBe.get(be.numero_be) ?? [], opts);
    refsTotal += rows.length;
    for (const e of rows) {
      const c = causeEcart(e);
      counts[c.code] = (counts[c.code] ?? 0) + 1;
      // contrôles de santé
      if (!aEcart(e) && c.code !== 'conforme') { console.log(`⚠ SANTÉ: écart 0 mais cause ${c.code} — ${be.numero_be}/${e.ref}`); sante++; }
      if (aEcart(e) && c.code === 'conforme') { console.log(`⚠ SANTÉ: écart ${e.ecart} mais conforme — ${be.numero_be}/${e.ref}`); sante++; }
      if (e.papier === null && e.cl === null) { console.log(`⚠ SANTÉ: ligne sans papier NI saisie — ${be.numero_be}/${e.ref}`); sante++; }
      if (aEcart(e)) ecarts.push({ be: be.numero_be, e, cause: c.code, label: c.label });
    }
  }

  console.log(`\n═══ ${rapprochables} bons rapprochables · ${refsTotal} lignes (bon,réf) · santé: ${sante === 0 ? 'OK' : sante + ' PROBLÈME(S)'} ═══`);
  console.log('Répartition des causes :', JSON.stringify(counts));
  console.log(`\n═══ TOUS LES ÉCARTS (${ecarts.length}) ═══`);
  const ordre = ['sur_saisie', 'oubli_log', 'hors_commande', 'dispatch', 'detail_incomplet'];
  for (const code of ordre) {
    const grp = ecarts.filter(x => x.cause === code);
    if (!grp.length) continue;
    console.log(`\n── ${code} (${grp.length}) ──`);
    for (const { be, e, label } of grp.sort((a, b) => Math.abs(b.e.ecart) - Math.abs(a.e.ecart))) {
      console.log(`  ${be}  ${String(e.ref).padEnd(12)} ②${String(e.papier ?? '—').padStart(6)} ③${String(e.cl ?? '—').padStart(6)}  écart ${String(e.ecart).padStart(6)}  ${e.statut !== 'à analyser' ? `[${e.statut}] ` : ''}${label.slice(0, 90)}`);
    }
  }
})();
