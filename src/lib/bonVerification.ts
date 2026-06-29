import { supabase } from '@/lib/supabase';
import { normalizeRef } from '@/lib/reception';

// Bon de vérification stock — partagé par /stock et /anomalies.
// Sort les anomalies ACTIVES localisables (présentes en stock CL) avec leur emplacement,
// Dispo / Floating / Réel théo. (Dispo+Floating = quantité physiquement présente au rayon),
// l'écart de l'anomalie et le bon. Ouvre une fenêtre imprimable, triée par emplacement,
// avec colonnes « Compté » / « OK ? » à remplir, et la réf cliquable vers l'anomalie.
type StockRow = { reference_article: string; titre: string | null; stock_cl: number | null; floating: number | null; emplacement: string | null };

export async function ouvrirBonVerification(): Promise<number> {
  const { data: exc } = await supabase
    .from('exceptions')
    .select('reference_article, ecart, motif')
    .in('statut_exception', ['ouverte', 'en cours']);

  const stocks: StockRow[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await supabase
      .from('stocks_cl')
      .select('reference_article, titre, stock_cl, floating, emplacement')
      .range(from, from + 999);
    if (!data || !data.length) break;
    stocks.push(...(data as StockRow[]));
    if (data.length < 1000) break;
  }
  const byRef = new Map<string, StockRow>();
  for (const s of stocks) { const k = normalizeRef(s.reference_article); if (k && !byRef.has(k)) byRef.set(k, s); }

  const esc = (s: unknown) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));
  const items = (exc ?? [])
    .map((e) => {
      const s = byRef.get(normalizeRef(e.reference_article));
      const bon = (String(e.motif ?? '').match(/BE-\d{2}-\d{2}-\d{3,5}/) ?? [''])[0];
      const dispo = s?.stock_cl ?? null;
      const floating = s?.floating ?? null;
      const reel = dispo != null ? (Number(dispo) || 0) + (Number(floating) || 0) : null;
      return { ref: e.reference_article, desig: s?.titre ?? '', emplacement: s?.emplacement ?? '', dispo, floating, reel, ecart: e.ecart, bon, s };
    })
    .filter((it) => it.s)
    .sort((a, b) => String(a.emplacement).localeCompare(String(b.emplacement)));

  const origin = window.location.origin;
  const lignes = items.map((it) => `<tr><td><a href="${origin}/exceptions?ref=${encodeURIComponent(it.ref)}" target="_blank" style="color:#4f46e5;font-weight:600;text-decoration:none">${esc(it.ref)} ↗</a></td><td>${esc(it.desig)}</td><td style="font-weight:700">${esc(it.emplacement || '—')}</td><td style="text-align:right">${it.dispo ?? '—'}</td><td style="text-align:right;color:#666">${it.floating ? '+' + it.floating : '0'}</td><td style="text-align:right;font-weight:700">${it.reel ?? '—'}</td><td style="text-align:right">${it.ecart != null ? (Number(it.ecart) > 0 ? '+' : '') + Number(it.ecart) : ''}</td><td>${esc(it.bon)}</td><td></td><td></td></tr>`).join('');
  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Bon de vérification stock</title><style>body{font-family:system-ui,sans-serif;font-size:12px;color:#111;padding:24px}h1{font-size:17px;margin:0 0 4px}p{color:#555;margin:0 0 14px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #cbd5e1;padding:6px 8px;text-align:left}th{background:#f1f5f9;font-size:11px}td:nth-child(9),td:nth-child(10),th:nth-child(9),th:nth-child(10){width:64px;text-align:center}button{margin-bottom:14px;padding:6px 14px;font-size:13px;cursor:pointer}@media print{button{display:none}}</style></head><body><h1>Bon de vérification stock — ${new Date().toLocaleDateString('fr-FR')}</h1><p>${items.length} référence(s) à vérifier · trié par emplacement. Compter le réel au rayon et comparer au <b>Réel théo. (Dispo + Floating)</b> — c'est la quantité physiquement présente.</p><button onclick="window.print()">Imprimer</button><table><thead><tr><th>Réf</th><th>Désignation</th><th>📍 Emplacement</th><th>Dispo</th><th>Float.</th><th>Réel théo. (D+F)</th><th>Écart anomalie</th><th>Bon</th><th>Compté</th><th>OK ?</th></tr></thead><tbody>${lignes || '<tr><td colspan="10" style="text-align:center;color:#999;padding:24px">Aucune anomalie active à vérifier.</td></tr>'}</tbody></table></body></html>`;
  const w = window.open('', '_blank');
  if (w) { w.document.write(html); w.document.close(); }
  return items.length;
}
