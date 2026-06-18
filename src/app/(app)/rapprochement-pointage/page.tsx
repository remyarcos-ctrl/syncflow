'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { formatDate, cn } from '@/utils';
import { RefreshCw, AlertTriangle, CheckCircle2, ChevronRight, Download } from 'lucide-react';
import { comparerPointage, aEcart, verdictPointage, causeEcart, normalizeRef, type ResolutionRow, type CauseCode } from '@/lib/pointage';
import type { BEReception, LigneBE, SaisieCL } from '@/types';

const STATUTS_RESOLUS = new Set(['vérifié', 'corrigé', 'accepté', 'ignoré']);

export default function RapprochementPointagePage() {
  const [filtre, setFiltre] = useState<'a_analyser' | 'tous'>('a_analyser');

  const { data: bes = [] } = useQuery<BEReception[]>({
    queryKey: ['rp_bes'],
    queryFn: async () => {
      const { data } = await supabase.from('be_receptions').select('*').order('date_bl', { ascending: false });
      return data ?? [];
    },
    refetchInterval: 10000,
  });

  const { data: lignes = [] } = useQuery<LigneBE[]>({
    queryKey: ['rp_lignes_be'],
    queryFn: async () => {
      const { data } = await supabase.from('lignes_be').select('be_id, reference_article, quantite_receptionnee, statut_retour, hors_systeme');
      return (data as LigneBE[]) ?? [];
    },
    refetchInterval: 10000,
  });

  const { data: saisies = [] } = useQuery<SaisieCL[]>({
    queryKey: ['rp_saisies'],
    queryFn: async () => {
      const { data } = await supabase.from('saisies_cl').select('numero_be, reference_article, quantite_recue');
      return (data as SaisieCL[]) ?? [];
    },
    refetchInterval: 10000,
  });

  const { data: resolutions = [] } = useQuery<{ numero_be: string; reference_article: string; statut: string; note: string | null }[]>({
    queryKey: ['rp_resolutions'],
    queryFn: async () => {
      const { data, error } = await supabase.from('pointage_resolution').select('numero_be, reference_article, statut, note');
      if (error) return []; // table pas encore créée → tout "à analyser"
      return data ?? [];
    },
    refetchInterval: 10000,
  });

  // Réfs ayant une commande avec reliquat à recevoir → distingue oubli log / hors-commande
  const { data: refsCmd = [] } = useQuery<{ reference_article: string | null; quantite_restante_a_recevoir: number | null }[]>({
    queryKey: ['rp_refs_cmd'],
    queryFn: async () => {
      const { data } = await supabase.from('lignes_commande').select('reference_article, quantite_restante_a_recevoir');
      return data ?? [];
    },
    refetchInterval: 30000,
  });

  // Calcul des écarts par BE
  const parBe = useMemo(() => {
    const lignesByBe = new Map<string, LigneBE[]>();
    for (const l of lignes) {
      const arr = lignesByBe.get(l.be_id) ?? [];
      arr.push(l); lignesByBe.set(l.be_id, arr);
    }
    const saisiesByBe = new Map<string, SaisieCL[]>();
    for (const s of saisies) {
      const arr = saisiesByBe.get(s.numero_be) ?? [];
      arr.push(s); saisiesByBe.set(s.numero_be, arr);
    }
    const resByBe = new Map<string, ResolutionRow[]>();
    for (const r of resolutions) {
      const arr = resByBe.get(r.numero_be) ?? [];
      arr.push({ reference_article: r.reference_article, statut: r.statut, note: r.note });
      resByBe.set(r.numero_be, arr);
    }
    const refsReliquat = new Set(
      refsCmd.filter(r => (r.quantite_restante_a_recevoir ?? 0) > 0.001)
        .map(r => normalizeRef(r.reference_article)).filter(Boolean),
    );

    return bes
      .map(be => {
        const sa = saisiesByBe.get(be.numero_be) ?? [];
        if (!sa.length) return null; // pas de saisie CL → pas rapprochable
        const rows = comparerPointage(lignesByBe.get(be.id) ?? [], sa, resByBe.get(be.numero_be) ?? [], refsReliquat);
        const ecarts = rows.filter(aEcart);
        const aAnalyser = ecarts.filter(e => !STATUTS_RESOLUS.has(e.statut));
        return { be, nbRefs: rows.length, nbEcarts: ecarts.length, nbAAnalyser: aAnalyser.length, ecarts };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  }, [bes, lignes, saisies, resolutions, refsCmd]);

  const avecEcarts = parBe.filter(b => b.nbEcarts > 0);
  const liste = (filtre === 'a_analyser' ? avecEcarts.filter(b => b.nbAAnalyser > 0) : avecEcarts)
    .sort((a, b) => b.nbAAnalyser - a.nbAAnalyser || b.nbEcarts - a.nbEcarts);

  const kpiBesRapprochables = parBe.length;
  const kpiEcartsAAnalyser = avecEcarts.reduce((s, b) => s + b.nbAAnalyser, 0);

  const causeCounts: Record<CauseCode, number> = { conforme: 0, oubli_log: 0, sur_saisie: 0, hors_commande: 0 };
  for (const b of avecEcarts) for (const e of b.ecarts) if (aEcart(e)) causeCounts[causeEcart(e).code]++;

  const exportCsv = () => {
    const head = ['BE', 'Référence', '② BL papier', '③ saisie CL', 'Écart', 'Cause', 'Verdict', 'Statut', 'Note'];
    const rows = (filtre === 'a_analyser' ? avecEcarts.filter(b => b.nbAAnalyser > 0) : avecEcarts)
      .flatMap(b => b.ecarts
        .filter(e => filtre === 'tous' || !STATUTS_RESOLUS.has(e.statut))
        .map(e => [b.be.numero_be, e.ref, e.papier ?? '', e.cl ?? '', e.ecart, causeEcart(e).label, verdictPointage(e).label, e.statut, e.note ?? '']));
    const csv = [head, ...rows]
      .map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(';'))
      .join('\r\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ecarts-pointage-${filtre}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Rapprochement pointage log</h1>
        <p className="text-sm text-gray-500 mt-1">
          ② BL papier scanné vs ③ saisie de réception Centralink — écarts = erreurs de pointage de la log à analyser.
        </p>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <Card><CardContent className="p-4">
          <div className="text-xs text-gray-500">BE rapprochables</div>
          <div className="text-2xl font-bold text-gray-900">{kpiBesRapprochables}</div>
          <div className="text-xs text-gray-400">avec saisie Centralink</div>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <div className="text-xs text-gray-500">Écarts à analyser</div>
          <div className={cn('text-2xl font-bold', kpiEcartsAAnalyser ? 'text-red-600' : 'text-emerald-600')}>{kpiEcartsAAnalyser}</div>
          <div className="text-xs text-gray-400">non encore traités</div>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <div className="text-xs text-gray-500">Oublis log</div>
          <div className={cn('text-2xl font-bold', causeCounts.oubli_log ? 'text-red-600' : 'text-gray-400')}>{causeCounts.oubli_log}</div>
          <div className="text-xs text-gray-400">commande en attente, non saisi</div>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <div className="text-xs text-gray-500">Sur-saisie log</div>
          <div className={cn('text-2xl font-bold', causeCounts.sur_saisie ? 'text-red-600' : 'text-gray-400')}>{causeCounts.sur_saisie}</div>
          <div className="text-xs text-gray-400">③ &gt; ② (CL a plus que le BL)</div>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <div className="text-xs text-gray-500">Hors commande</div>
          <div className={cn('text-2xl font-bold', causeCounts.hors_commande ? 'text-orange-600' : 'text-gray-400')}>{causeCounts.hors_commande}</div>
          <div className="text-xs text-gray-400">à investiguer (Colombi)</div>
        </CardContent></Card>
      </div>

      <Card>
        <CardHeader className="pb-3 flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm">
            <RefreshCw className="w-4 h-4 text-indigo-600" /> BE à traiter
          </CardTitle>
          <div className="flex gap-1">
            <Button variant={filtre === 'a_analyser' ? 'default' : 'outline'} size="sm" onClick={() => setFiltre('a_analyser')}>À analyser</Button>
            <Button variant={filtre === 'tous' ? 'default' : 'outline'} size="sm" onClick={() => setFiltre('tous')}>Tous les écarts</Button>
            <Button variant="outline" size="sm" onClick={exportCsv} disabled={!avecEcarts.length}>
              <Download className="w-3.5 h-3.5 mr-1" /> Exporter (log)
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {liste.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-gray-500 flex flex-col items-center gap-2">
              <CheckCircle2 className="w-8 h-8 text-emerald-500" />
              {filtre === 'a_analyser' ? 'Aucun écart de pointage à analyser. 🎉' : 'Aucun écart de pointage.'}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50/50 border-y border-gray-100">
                    <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500">BE</th>
                    <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500">Fournisseur</th>
                    <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500">Date BL</th>
                    <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-500">Réfs</th>
                    <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-500">Écarts</th>
                    <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-500">À analyser</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {liste.map(({ be, nbRefs, nbEcarts, nbAAnalyser }) => (
                    <tr key={be.id} className="border-b border-gray-50 hover:bg-gray-50/50">
                      <td className="px-4 py-2.5 font-medium">
                        <Link href={`/be-receptions/${be.id}`} className="text-indigo-600 hover:underline">{be.numero_be}</Link>
                      </td>
                      <td className="px-4 py-2.5 text-gray-600">{be.fournisseur}</td>
                      <td className="px-4 py-2.5 text-gray-500">{be.date_bl ? formatDate(be.date_bl) : '—'}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-gray-500">{nbRefs}</td>
                      <td className="px-4 py-2.5 text-right">
                        <span className="inline-flex items-center gap-1 text-amber-700 font-semibold tabular-nums">
                          <AlertTriangle className="w-3.5 h-3.5" />{nbEcarts}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        <span className={cn('font-semibold', nbAAnalyser ? 'text-red-600' : 'text-emerald-600')}>{nbAAnalyser}</span>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <Link href={`/be-receptions/${be.id}`}><ChevronRight className="w-4 h-4 text-gray-400" /></Link>
                      </td>
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
