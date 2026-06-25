'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import PageHeader from '@/components/shared/PageHeader';
import { normalizeRef } from '@/lib/reception';
import { cn } from '@/utils';
import { Boxes, Barcode, AlertTriangle, CheckCircle2, PackageX, Search } from 'lucide-react';

// ── Types des sources ────────────────────────────────────────────────────────
interface StockRow {
  reference_article: string;
  ean13: string | null;
  titre: string | null;
  stock_cl: number | null;
  floating: number | null;
  stock_source: string | null;   // 'fiche' = temps réel · 'etat' = snapshot minuit
  prix_ht: number | null;
  has_barcode: boolean | null;
  entrees_reception: number | null;
  entrees_barcode: number | null;
  ventes: number | null;          // ventes 90j (fiable)
  reconstitue_ok: boolean | null;
}
interface LigneCmd { reference_article: string | null; quantite_commandee: number | null; quantite_receptionnee_reelle: number | null; }
interface LigneBe { reference_article: string | null; quantite_receptionnee: number | null; hors_systeme: boolean | null; designation: string | null; }

// Une ligne agrégée par référence contrôlée.
interface Row {
  ref: string;            // clé normalisée
  refBrute: string;       // réf telle qu'affichée
  designation: string | null;
  stock: number | null;
  floating: number | null;
  tempsReel: boolean;     // stock_source === 'fiche'
  ventes: number | null;  // ventes 90j
  prixHt: number | null;
  hasBarcode: boolean | null;
  reconstitueOk: boolean | null;
  cmd: number;            // ① commandé
  recu: number;           // ③ reçu CL (autoritaire)
  papier: number;         // ② BE papier (hors SAV)
  enStock: boolean;       // présent dans stocks_cl
}

type Filtre = 'tous' | 'barcode' | 'surplus' | 'a_verifier' | 'recon_ko' | 'sans_stock';

const fmt = (n: number | null | undefined) => (n == null ? '—' : new Intl.NumberFormat('fr-FR').format(n));

export default function StockPage() {
  const [filtre, setFiltre] = useState<Filtre>('tous');
  const [q, setQ] = useState('');

  const { data: stocks = [], isLoading: lS } = useQuery<StockRow[]>({
    queryKey: ['stocks_cl'],
    queryFn: async () => {
      const all: StockRow[] = [];
      let from = 0;
      for (;;) {
        const { data } = await supabase
          .from('stocks_cl')
          .select('reference_article, ean13, titre, stock_cl, floating, stock_source, prix_ht, has_barcode, entrees_reception, entrees_barcode, ventes, reconstitue_ok')
          .range(from, from + 999);
        if (!data || !data.length) break;
        all.push(...(data as StockRow[]));
        if (data.length < 1000) break;
        from += 1000;
      }
      return all;
    },
  });

  const { data: cmds = [], isLoading: lC } = useQuery<LigneCmd[]>({
    queryKey: ['stock_lignes_commande'],
    queryFn: async () => {
      const all: LigneCmd[] = [];
      let from = 0;
      for (;;) {
        const { data } = await supabase
          .from('lignes_commande')
          .select('reference_article, quantite_commandee, quantite_receptionnee_reelle')
          .range(from, from + 999);
        if (!data || !data.length) break;
        all.push(...(data as LigneCmd[]));
        if (data.length < 1000) break;
        from += 1000;
      }
      return all;
    },
  });

  const { data: bes = [], isLoading: lB } = useQuery<LigneBe[]>({
    queryKey: ['stock_lignes_be'],
    queryFn: async () => {
      const all: LigneBe[] = [];
      let from = 0;
      for (;;) {
        const { data } = await supabase
          .from('lignes_be')
          .select('reference_article, quantite_receptionnee, hors_systeme, designation')
          .range(from, from + 999);
        if (!data || !data.length) break;
        all.push(...(data as LigneBe[]));
        if (data.length < 1000) break;
        from += 1000;
      }
      return all;
    },
  });

  const loading = lS || lC || lB;

  const rows = useMemo<Row[]>(() => {
    // index du stock par réf normalisée
    const stockByRef = new Map<string, StockRow>();
    for (const s of stocks) {
      const k = normalizeRef(s.reference_article);
      if (k && !stockByRef.has(k)) stockByRef.set(k, s);
    }

    // agrégation des réfs contrôlées
    const agg = new Map<string, Row>();
    const get = (k: string, brute: string): Row => {
      let r = agg.get(k);
      if (!r) {
        const s = stockByRef.get(k);
        r = {
          ref: k, refBrute: brute, designation: s?.titre ?? null,
          stock: s?.stock_cl ?? null, floating: s?.floating ?? null,
          tempsReel: s?.stock_source === 'fiche', ventes: s?.ventes ?? null,
          prixHt: s?.prix_ht ?? null,
          hasBarcode: s?.has_barcode ?? null, reconstitueOk: s?.reconstitue_ok ?? null,
          cmd: 0, recu: 0, papier: 0, enStock: !!s,
        };
        agg.set(k, r);
      }
      return r;
    };

    for (const l of cmds) {
      const k = normalizeRef(l.reference_article);
      if (!k) continue;
      const r = get(k, l.reference_article ?? k);
      r.cmd += Math.max(0, Number(l.quantite_commandee) || 0);
      r.recu += Math.max(0, Number(l.quantite_receptionnee_reelle) || 0);
    }
    for (const l of bes) {
      if (l.hors_systeme) continue; // SAV / hors-système exclu du contrôle
      const k = normalizeRef(l.reference_article);
      if (!k) continue;
      const r = get(k, l.reference_article ?? k);
      r.papier += Math.max(0, Number(l.quantite_receptionnee) || 0);
      if (!r.designation) r.designation = l.designation ?? null;
    }

    return [...agg.values()].sort((a, b) => a.ref.localeCompare(b.ref));
  }, [stocks, cmds, bes]);

  // surplus = reçu OU papier dépasse le commandé (indicateur au niveau réf ;
  // le surplus exact à réclamer est calculé par le moteur d'anomalies, par BE).
  const estSurplus = (r: Row) => r.cmd > 0 && (r.recu > r.cmd + 0.001 || r.papier > r.cmd + 0.001);
  const ampleurSurplus = (r: Row) => Math.max(r.recu, r.papier) - r.cmd;
  // Garde-fou bar-code : un surplus géré au bar-code est un FAUX surplus SEULEMENT si le
  // stock CL réel + ventes 90j couvrent l'excédent (marchandise réellement absorbée).
  // Sinon le bar-code n'explique pas tout → reste « à vérifier » (vraie erreur visible).
  const surplusCouvert = (r: Row) =>
    (Number(r.stock) || 0) + (Number(r.ventes) || 0) >= ampleurSurplus(r) - 0.001;
  const fauxSurplus = (r: Row) => estSurplus(r) && r.hasBarcode === true && surplusCouvert(r);
  const barcodeNonCouvert = (r: Row) => estSurplus(r) && r.hasBarcode === true && !surplusCouvert(r);

  const filtered = useMemo(() => {
    let list = rows;
    if (filtre === 'barcode') list = list.filter(r => r.hasBarcode === true);
    else if (filtre === 'surplus') list = list.filter(estSurplus);
    else if (filtre === 'a_verifier') list = list.filter(barcodeNonCouvert);
    else if (filtre === 'recon_ko') list = list.filter(r => r.reconstitueOk === false);
    else if (filtre === 'sans_stock') list = list.filter(r => !r.enStock);
    if (q.trim()) {
      const nq = normalizeRef(q);
      list = list.filter(r => r.ref.includes(nq) || (r.designation ?? '').toLowerCase().includes(q.toLowerCase()));
    }
    return list;
  }, [rows, filtre, q]);

  // compteurs
  const stats = useMemo(() => ({
    total: rows.length,
    enStock: rows.filter(r => r.enStock).length,
    tempsReel: rows.filter(r => r.tempsReel).length,
    barcode: rows.filter(r => r.hasBarcode === true).length,
    surplus: rows.filter(estSurplus).length,
    faux: rows.filter(fauxSurplus).length,
    aVerifier: rows.filter(barcodeNonCouvert).length,
    reconKo: rows.filter(r => r.reconstitueOk === false).length,
    sansStock: rows.filter(r => !r.enStock).length,
  }), [rows]);

  const CHIPS: { id: Filtre; label: string; count: number; tone: string }[] = [
    { id: 'tous', label: 'Toutes', count: stats.total, tone: 'indigo' },
    { id: 'barcode', label: 'Bar-code', count: stats.barcode, tone: 'amber' },
    { id: 'surplus', label: 'Surplus (②/③ > ①)', count: stats.surplus, tone: 'orange' },
    { id: 'a_verifier', label: 'Bar-code à vérifier', count: stats.aVerifier, tone: 'rose' },
    { id: 'recon_ko', label: 'Reconstruction KO', count: stats.reconKo, tone: 'rose' },
    { id: 'sans_stock', label: 'Sans stock CL', count: stats.sansStock, tone: 'slate' },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Rapprochement stock Centralink"
        subtitle={`${stats.total} réfs contrôlées · ${stats.tempsReel} en stock temps réel · ${stats.barcode} gérées au bar-code · ${stats.faux} faux surplus · ${stats.aVerifier} bar-code à vérifier`}
      />

      {/* Bandeau d'explication faux surplus + garde-fou */}
      {(stats.faux > 0 || stats.aVerifier > 0) && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 flex items-start gap-2">
          <Barcode className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
          <div className="text-sm text-amber-800 space-y-1">
            {stats.faux > 0 && (
              <p>
                <span className="font-semibold">{stats.faux} faux surplus</span> : en surplus mais rentré au bar-code,
                {' '}et le <span className="font-semibold">stock réel + ventes 90j couvrent l&apos;excédent</span> → déjà en stock,
                {' '}<span className="font-semibold">pas</span> une réclamation Colombi.
              </p>
            )}
            {stats.aVerifier > 0 && (
              <p>
                <span className="font-semibold">{stats.aVerifier} bar-code à vérifier</span> : surplus géré au bar-code
                {' '}mais le <span className="font-semibold">stock réel + ventes ne couvrent PAS</span> l&apos;excédent → le bar-code
                {' '}n&apos;explique pas tout, à contrôler (vraie sur-livraison ou erreur de saisie).
              </p>
            )}
          </div>
        </div>
      )}

      {/* Filtres + recherche */}
      <div className="flex flex-wrap items-center gap-2">
        {CHIPS.map(c => (
          <button
            key={c.id}
            onClick={() => setFiltre(c.id)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors',
              filtre === c.id
                ? 'bg-indigo-600 border-indigo-600 text-white'
                : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
            )}
          >
            {c.label}
            <span className={cn('rounded-full px-1.5 py-0.5 text-[10px] font-semibold',
              filtre === c.id ? 'bg-white/20 text-white' : 'bg-gray-100 text-gray-500')}>{c.count}</span>
          </button>
        ))}
        <div className="ml-auto relative">
          <Search className="w-3.5 h-3.5 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Réf. ou désignation…"
            className="pl-8 pr-3 py-1.5 text-xs border border-gray-200 rounded-lg w-56 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>
      </div>

      {/* Tableau */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50/60">
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-400">Réf.</th>
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-400">Désignation</th>
              <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-400">Stock CL</th>
              <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-400">Floating</th>
              <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-400">Ventes 90j</th>
              <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-400">Cmd ①</th>
              <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-400">Reçu ③</th>
              <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-400">Papier ②</th>
              <th className="text-center px-4 py-2.5 text-xs font-semibold text-gray-400">Bar-code</th>
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-400">État</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {loading ? (
              <tr><td colSpan={10} className="px-4 py-16 text-center text-gray-400 text-sm">Chargement…</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={10} className="px-4 py-16 text-center text-gray-400 text-sm">Aucune référence.</td></tr>
            ) : filtered.map(r => {
              const surplus = estSurplus(r);
              const faux = fauxSurplus(r);
              return (
                <tr key={r.ref} className="hover:bg-gray-50/50">
                  <td className="px-4 py-2.5 font-mono text-xs font-medium text-gray-800">{r.refBrute}</td>
                  <td className="px-4 py-2.5 text-xs text-gray-500 max-w-[260px] truncate" title={r.designation ?? ''}>{r.designation ?? '—'}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-xs font-semibold text-gray-900">
                    {r.enStock ? (
                      <span className="inline-flex items-center gap-1 justify-end">
                        {fmt(r.stock)}
                        {r.tempsReel
                          ? <span title="Stock temps réel (fiche produit)" className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block" />
                          : <span title="Snapshot product/state (mis à jour à minuit)" className="w-1.5 h-1.5 rounded-full bg-gray-300 inline-block" />}
                      </span>
                    ) : <span className="text-gray-300">absent</span>}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-xs text-gray-500">{r.floating != null && r.floating > 0 ? fmt(r.floating) : <span className="text-gray-300">—</span>}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-xs text-gray-500">{r.ventes != null ? fmt(r.ventes) : <span className="text-gray-300">—</span>}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-xs text-gray-600">{fmt(r.cmd)}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-xs text-gray-600">{fmt(r.recu)}</td>
                  <td className={cn('px-4 py-2.5 text-right font-mono text-xs', r.papier > r.recu + 0.001 ? 'text-orange-600 font-semibold' : 'text-gray-600')}>{fmt(r.papier)}</td>
                  <td className="px-4 py-2.5 text-center">
                    {r.hasBarcode === true
                      ? <span title="Entrées bar-code détectées"><Barcode className="w-4 h-4 text-amber-500 inline" /></span>
                      : r.hasBarcode === false ? <span className="text-gray-300 text-xs">non</span>
                      : <span className="text-gray-300 text-xs">?</span>}
                  </td>
                  <td className="px-4 py-2.5">
                    {faux ? (
                      <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                        <Barcode className="w-3 h-3" /> Faux surplus (bar-code)
                      </span>
                    ) : barcodeNonCouvert(r) ? (
                      <span title="Stock réel + ventes ne couvrent pas le surplus" className="inline-flex items-center gap-1 rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-[11px] font-medium text-rose-700">
                        <AlertTriangle className="w-3 h-3" /> Bar-code à vérifier
                      </span>
                    ) : surplus ? (
                      <span className="inline-flex items-center gap-1 rounded-full border border-orange-200 bg-orange-50 px-2 py-0.5 text-[11px] font-medium text-orange-700">
                        <AlertTriangle className="w-3 h-3" /> Surplus à instruire
                      </span>
                    ) : !r.enStock ? (
                      <span className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[11px] font-medium text-gray-500">
                        <PackageX className="w-3 h-3" /> Hors stock CL
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-100 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-600">
                        <CheckCircle2 className="w-3 h-3" /> OK
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-gray-400 flex items-center gap-1.5">
        <Boxes className="w-3.5 h-3.5" />
        Stock CL : <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 mx-0.5" /> = temps réel (fiche produit) ·
        sinon snapshot product/state (minuit). Bar-code, floating &amp; ventes 90j = fiche produit.
        Le montant exact des entrées bar-code n&apos;est pas fiable (remises à zéro) ; seuls le stock, le floating et la présence bar-code le sont.
      </p>
    </div>
  );
}
