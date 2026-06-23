'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import PeriodeChips from '@/components/shared/PeriodeChips';
import { cn } from '@/utils';
import { ScanLine, CheckCircle2, Layers, AlertTriangle, Printer } from 'lucide-react';

// Statuts de commande « actives » : on ne demande de scanner QUE les BE qui servent
// au moins une commande encore en cours (ouverte / partielle / en anomalie). Les BE
// ne servant que des commandes soldées/réceptionnées sont inutiles → ignorés.
const ACTIFS = new Set(['ouverte', 'partiellement réceptionnée', 'en anomalie']);
const normBe = (s: string | null | undefined) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const moisInvalide = (raw: string) => { const m = raw.toUpperCase().match(/BE-?\d{2}-?(\d{2})/); return m ? +m[1] < 1 || +m[1] > 12 : false; };
// Période d'un BE depuis son numéro (BE-YY-MM-…) → { an:'2026', mo:'03' }.
const bePeriode = (raw: string) => { const m = raw.toUpperCase().match(/BE-?(\d{2})-?(\d{2})/); return m ? { an: `20${m[1]}`, mo: m[2] } : { an: '', mo: '' }; };

const statutBadge = (s: string | null): string => {
  switch (s) {
    case 'en anomalie': return 'bg-red-50 text-red-700';
    case 'partiellement réceptionnée': return 'bg-amber-50 text-amber-700';
    case 'ouverte': return 'bg-blue-50 text-blue-700';
    default: return 'bg-gray-100 text-gray-600';
  }
};

export default function BeAScannerPage() {
  const { data: commandes = [], isLoading: l1 } = useQuery<{ numero_commande_interne: string; statut_commande: string | null }[]>({
    queryKey: ['bas_commandes'],
    queryFn: async () => (await supabase.from('commandes').select('numero_commande_interne, statut_commande')).data ?? [],
    refetchInterval: 15000,
  });
  const { data: scannedBes = [], isLoading: l2 } = useQuery<{ numero_be: string }[]>({
    queryKey: ['bas_scanned_be'],
    queryFn: async () => (await supabase.from('be_receptions').select('numero_be')).data ?? [],
    refetchInterval: 15000,
  });
  const { data: saisies = [], isLoading: l3 } = useQuery<{ numero_be: string | null; commande_ref: string | null }[]>({
    queryKey: ['bas_saisies'],
    queryFn: async () => {
      let out: { numero_be: string | null; commande_ref: string | null }[] = [], from = 0;
      for (;;) {
        const { data } = await supabase.from('saisies_cl').select('numero_be, commande_ref').range(from, from + 999);
        out = out.concat(data ?? []);
        if (!data || data.length < 1000) break;
        from += 1000;
      }
      return out;
    },
    refetchInterval: 15000,
  });

  const [annee, setAnnee] = useState('');
  const [mois, setMois] = useState('');

  const { aImporter, nScannesActifs, nTotalActifs } = useMemo(() => {
    const statutDe = new Map(commandes.map((c) => [c.numero_commande_interne, c.statut_commande]));
    const scanned = new Set(scannedBes.map((b) => normBe(b.numero_be)));
    // Par BE : les commandes ACTIVES qu'il sert (lien BE↔commande = saisies_cl, comme CL).
    const beToCmd = new Map<string, { raw: string; cmds: Set<string> }>();
    for (const s of saisies) {
      if (!s.numero_be || !s.commande_ref) continue;
      if (!ACTIFS.has(statutDe.get(s.commande_ref) ?? '')) continue; // ne compte que les commandes actives
      const k = normBe(s.numero_be);
      if (!beToCmd.has(k)) beToCmd.set(k, { raw: s.numero_be, cmds: new Set() });
      beToCmd.get(k)!.cmds.add(s.commande_ref);
    }
    // Filtre période (puces) : année + mois optionnel, sur la date du n° de BE.
    const tousActifs = [...beToCmd.values()].filter((b) => {
      const p = bePeriode(b.raw);
      if (annee && p.an !== annee) return false;
      if (mois && p.mo !== mois) return false;
      return true;
    });
    const aImporter = tousActifs
      .filter((b) => !scanned.has(normBe(b.raw)))
      .map((b) => ({ raw: b.raw, cmds: [...b.cmds].sort(), invalide: moisInvalide(b.raw) }))
      // priorité : un BE qui débloque le PLUS de commandes actives en premier
      .sort((a, b) => b.cmds.length - a.cmds.length || (a.raw < b.raw ? 1 : -1));
    return {
      aImporter,
      nScannesActifs: tousActifs.filter((b) => scanned.has(normBe(b.raw))).length,
      nTotalActifs: tousActifs.length,
    };
  }, [commandes, scannedBes, saisies, annee, mois]);

  const isLoading = l1 || l2 || l3;
  const pct = nTotalActifs > 0 ? Math.round((nScannesActifs / nTotalActifs) * 100) : 0;

  const imprimer = () => {
    const periode = annee ? (mois ? `${mois}/${annee}` : annee) : 'toutes périodes';
    const rows = aImporter.map((b, i) => `<tr>
      <td class="chk">☐</td><td class="num">${i + 1}</td>
      <td class="be">${b.raw}${b.invalide ? ' ⚠ (n° invalide)' : ''}</td>
      <td class="n">${b.cmds.length}</td>
      <td class="cmd">${b.cmds.join(', ')}</td></tr>`).join('');
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>BE à scanner</title><style>
      body{font-family:system-ui,Arial,sans-serif;margin:22px;color:#111}
      h1{font-size:17px;margin:0 0 3px}
      .sub{color:#666;font-size:11px;margin:0 0 14px}
      table{width:100%;border-collapse:collapse;font-size:12px}
      th,td{text-align:left;padding:5px 7px;border-bottom:1px solid #ddd;vertical-align:top}
      th{font-size:9px;text-transform:uppercase;color:#777;letter-spacing:.03em}
      .chk{font-size:15px;width:22px}.num{width:26px;color:#999}
      .be{font-family:ui-monospace,monospace;font-weight:600;white-space:nowrap}
      .n{text-align:center;width:54px;font-weight:600}
      .cmd{color:#444;font-family:ui-monospace,monospace;font-size:10.5px}
      tr{break-inside:avoid}@media print{body{margin:0}}
    </style></head><body>
      <h1>BE à scanner — ${aImporter.length} à importer</h1>
      <p class="sub">Triés par impact (nb de commandes débloquées) · période : ${periode} · imprimé le ${new Date().toLocaleDateString('fr-FR')}</p>
      <table><thead><tr><th></th><th>#</th><th>BE</th><th>Débloque</th><th>Commandes actives servies</th></tr></thead><tbody>${rows}</tbody></table>
    </body></html>`;
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(html); w.document.close(); w.focus();
    setTimeout(() => w.print(), 250);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 flex items-center gap-2">
            <ScanLine className="w-5 h-5 text-indigo-500" /> BE à scanner
          </h1>
          <p className="text-sm text-gray-500 mt-0.5 max-w-3xl">
            Les <strong>BE référencés par Centralink</strong> (pour des commandes encore <strong>actives</strong>) mais
            dont le <strong>papier (②) n&apos;est pas encore importé</strong>. Triés par <strong>impact</strong> : en haut,
            ceux qui débloquent le plus de commandes d&apos;un coup. La liste se vide à mesure que tu scannes.
          </p>
        </div>
        <button onClick={imprimer} disabled={aImporter.length === 0}
          className="shrink-0 inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed">
          <Printer className="w-4 h-4" /> Imprimer
        </button>
      </div>

      {/* Filtre période (puces année / mois) */}
      <PeriodeChips annees={['2026', '2025']} annee={annee} mois={mois}
        onAnnee={(a) => { setAnnee(a); setMois(''); }} onMois={setMois} />

      {/* Compteur d'avancement */}
      <Card>
        <CardContent className="py-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-700">Couverture des commandes actives</span>
            <span className="text-sm font-semibold text-gray-900">{nScannesActifs} / {nTotalActifs} BE importés</span>
          </div>
          <div className="h-2.5 w-full rounded-full bg-gray-100 overflow-hidden">
            <div className="h-full rounded-full bg-indigo-500 transition-all" style={{ width: `${pct}%` }} />
          </div>
          <p className="text-xs text-gray-400 mt-1.5">
            <strong className="text-amber-600">{aImporter.length}</strong> BE restants à importer · {pct}% couvert
          </p>
        </CardContent>
      </Card>

      {/* Liste priorisée */}
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <p className="text-sm text-gray-400 p-6 text-center">Chargement…</p>
          ) : aImporter.length === 0 ? (
            <div className="p-8 text-center">
              <CheckCircle2 className="w-8 h-8 text-emerald-400 mx-auto mb-2" />
              <p className="text-sm font-medium text-gray-700">Tout est couvert 🎉</p>
              <p className="text-xs text-gray-400 mt-1">Chaque commande active a ses BE scannés.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 text-left text-xs text-gray-500">
                    <th className="px-4 py-2.5 font-medium">BE à scanner</th>
                    <th className="px-4 py-2.5 font-medium text-center">Débloque</th>
                    <th className="px-4 py-2.5 font-medium">Commandes actives servies</th>
                  </tr>
                </thead>
                <tbody>
                  {aImporter.map((b) => (
                    <tr key={b.raw} className="border-b border-gray-50 hover:bg-gray-50/50 align-top">
                      <td className="px-4 py-2.5">
                        <span className="font-mono font-medium text-indigo-700">{b.raw}</span>
                        {b.invalide && (
                          <span className="ml-2 inline-flex items-center gap-1 text-[11px] text-red-600" title="Mois impossible → faute de frappe de la log, à corriger dans Centralink avant de pouvoir scanner">
                            <AlertTriangle className="w-3 h-3" /> n° invalide
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-center">
                        <span className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold',
                          b.cmds.length >= 3 ? 'bg-indigo-100 text-indigo-700' : 'bg-gray-100 text-gray-600')}>
                          <Layers className="w-3 h-3" />{b.cmds.length}
                        </span>
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex flex-wrap gap-1">
                          {b.cmds.map((cr) => (
                            <Link key={cr} href={`/commandes?q=${encodeURIComponent(cr.replace('#', ''))}`}
                              className={cn('px-1.5 py-0.5 rounded text-xs font-mono hover:underline', statutBadge(commandes.find((c) => c.numero_commande_interne === cr)?.statut_commande ?? null))}>
                              {cr}
                            </Link>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-gray-400 max-w-3xl">
        Périmètre : uniquement les BE servant une commande <strong>active</strong> (ouverte / partielle / en anomalie) —
        un BE qui ne sert que des commandes soldées n&apos;est pas demandé. Le lien BE↔commande vient de Centralink
        (section <em>Bon de Livraison</em>), donc on reflète exactement CL.
      </p>
    </div>
  );
}
