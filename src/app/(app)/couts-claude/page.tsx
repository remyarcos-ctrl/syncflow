'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDate, cn } from '@/utils';
import { Coins, FileText, Cpu } from 'lucide-react';

interface JournalRow {
  id: string;
  created_at: string;
  details_action: string;
}

interface ImportCout {
  id: string;
  date: string;
  fichier: string;
  cout_eur: number;
  moteur: string;
  bes: number;
  factures: number;
  doublons: number;
}

const fmtEUR = (eur: number): string =>
  eur < 1 ? `${(eur * 100).toFixed(1).replace('.', ',')} c` : `${eur.toFixed(2).replace('.', ',')} €`;

export default function CoutsClaudePage() {
  const { data: rows = [], isLoading } = useQuery<JournalRow[]>({
    queryKey: ['couts_claude'],
    queryFn: async () => {
      const { data } = await supabase
        .from('journal_activite')
        .select('id, created_at, details_action')
        .eq('type_action', 'cout_claude')
        .order('created_at', { ascending: false })
        .limit(500);
      return data ?? [];
    },
    refetchInterval: 10000,
  });

  const imports = useMemo<ImportCout[]>(() => {
    return rows.map((r) => {
      let d: Record<string, unknown> = {};
      try { d = JSON.parse(r.details_action ?? '{}'); } catch { /* ignore */ }
      return {
        id: r.id,
        date: r.created_at,
        fichier: String(d.fichier ?? '—'),
        cout_eur: Number(d.cout_eur ?? 0),
        moteur: String(d.moteur ?? '—'),
        bes: Number(d.bes ?? 0),
        factures: Number(d.factures ?? 0),
        doublons: Number(d.doublons ?? 0),
      };
    });
  }, [rows]);

  const { total, mois, jour, nbSonnet } = useMemo(() => {
    const now = new Date();
    const ym = `${now.getFullYear()}-${now.getMonth()}`;
    const ymd = now.toDateString();
    let total = 0, mois = 0, jour = 0, nbSonnet = 0;
    for (const i of imports) {
      total += i.cout_eur;
      const dt = new Date(i.date);
      if (`${dt.getFullYear()}-${dt.getMonth()}` === ym) mois += i.cout_eur;
      if (dt.toDateString() === ymd) jour += i.cout_eur;
      if (i.moteur === 'sonnet') nbSonnet++;
    }
    return { total, mois, jour, nbSonnet };
  }, [imports]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900 flex items-center gap-2">
          <Coins className="w-5 h-5 text-indigo-500" /> Coûts Claude
        </h1>
        <p className="text-sm text-gray-500 mt-0.5">
          Coût de l&apos;IA pour la lecture des PDF importés (BE et factures). Haiku par défaut, Sonnet en repli si l&apos;extraction est douteuse.
        </p>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Card>
          <CardHeader className="pb-1"><CardTitle className="text-xs font-medium text-gray-500">Aujourd&apos;hui</CardTitle></CardHeader>
          <CardContent><p className="text-2xl font-semibold text-gray-900">{fmtEUR(jour)}</p></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1"><CardTitle className="text-xs font-medium text-gray-500">Ce mois</CardTitle></CardHeader>
          <CardContent><p className="text-2xl font-semibold text-gray-900">{fmtEUR(mois)}</p></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1"><CardTitle className="text-xs font-medium text-gray-500">Total (500 derniers)</CardTitle></CardHeader>
          <CardContent><p className="text-2xl font-semibold text-gray-900">{fmtEUR(total)}</p></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1"><CardTitle className="text-xs font-medium text-gray-500">Imports · replis Sonnet</CardTitle></CardHeader>
          <CardContent><p className="text-2xl font-semibold text-gray-900">{imports.length} <span className="text-sm font-normal text-gray-400">· {nbSonnet}</span></p></CardContent>
        </Card>
      </div>

      {/* Tableau */}
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <p className="text-sm text-gray-400 p-6 text-center">Chargement…</p>
          ) : imports.length === 0 ? (
            <p className="text-sm text-gray-400 p-6 text-center">
              Aucun import enregistré pour le moment. Le coût apparaîtra ici dès le prochain import de BE ou facture.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 text-left text-xs text-gray-500">
                    <th className="px-4 py-2.5 font-medium">Date</th>
                    <th className="px-4 py-2.5 font-medium">Fichier</th>
                    <th className="px-4 py-2.5 font-medium">Moteur</th>
                    <th className="px-4 py-2.5 font-medium text-center">Contenu</th>
                    <th className="px-4 py-2.5 font-medium text-right">Coût</th>
                  </tr>
                </thead>
                <tbody>
                  {imports.map((i) => (
                    <tr key={i.id} className="border-b border-gray-50 hover:bg-gray-50/50">
                      <td className="px-4 py-2.5 text-gray-500 whitespace-nowrap">{formatDate(i.date)}</td>
                      <td className="px-4 py-2.5 text-gray-800 max-w-[260px] truncate flex items-center gap-1.5">
                        <FileText className="w-3.5 h-3.5 text-gray-300 shrink-0" />{i.fichier}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className={cn(
                          'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium',
                          i.moteur === 'sonnet' ? 'bg-amber-50 text-amber-700' : 'bg-emerald-50 text-emerald-700',
                        )}>
                          <Cpu className="w-3 h-3" />{i.moteur}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-center text-xs text-gray-500">
                        {[
                          i.bes ? `${i.bes} BE` : '',
                          i.factures ? `${i.factures} fact.` : '',
                          i.doublons ? `${i.doublons} doublon${i.doublons > 1 ? 's' : ''}` : '',
                        ].filter(Boolean).join(' · ') || '—'}
                      </td>
                      <td className="px-4 py-2.5 text-right font-medium text-gray-900 whitespace-nowrap">{fmtEUR(i.cout_eur)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
