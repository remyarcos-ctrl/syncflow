'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { selectAll } from '@/lib/select-all';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { formatDate, cn } from '@/utils';
import { RefreshCw, AlertTriangle, CheckCircle2, ChevronRight, Download } from 'lucide-react';
import { comparerPointage, aEcart, verdictPointage, causeEcart, aliasRef, type ResolutionRow, type CauseCode } from '@/lib/pointage';
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
      return await selectAll<LigneBE>(() => supabase.from('lignes_be').select('be_id, reference_article, designation, quantite_receptionnee, statut_retour, hors_systeme'));
    },
    refetchInterval: 10000,
  });

  const { data: saisies = [] } = useQuery<SaisieCL[]>({
    queryKey: ['rp_saisies'],
    queryFn: async () => {
      return await selectAll<SaisieCL>(() => supabase.from('saisies_cl').select('numero_be, reference_article, quantite_recue, commande_ref'));
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
  const { data: refsCmd = [] } = useQuery<{ reference_article: string | null; quantite_restante_a_recevoir: number | null; quantite_receptionnee_reelle: number | null; quantite_commandee: number | null }[]>({
    queryKey: ['rp_refs_cmd'],
    queryFn: async () => {
      return await selectAll<{ reference_article: string | null; quantite_restante_a_recevoir: number | null; quantite_receptionnee_reelle: number | null; quantite_commandee: number | null }>(
        () => supabase.from('lignes_commande').select('reference_article, quantite_restante_a_recevoir, quantite_receptionnee_reelle, quantite_commandee'));
    },
    refetchInterval: 30000,
  });

  // Réfs gérées au code-barres (stocks_cl) : un ③>② sur ces réfs peut être une entrée scan.
  const { data: refsBarcode = new Set<string>() } = useQuery<Set<string>>({
    queryKey: ['rp_barcode'],
    queryFn: async () => {
      const rows = await selectAll<{ reference_article: string | null; has_barcode: boolean | null }>(
        () => supabase.from('stocks_cl').select('reference_article, has_barcode'));
      return new Set(rows.filter(r => r.has_barcode === true).map(r => aliasRef(r.reference_article)).filter(Boolean));
    },
    staleTime: 300_000,
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
    // Contextes par réf (clés normalisées-ALIASÉES, cohérentes avec le moteur) :
    const refsReliquat = new Set(
      refsCmd.filter(r => (r.quantite_restante_a_recevoir ?? 0) > 0.001)
        .map(r => aliasRef(r.reference_article)).filter(Boolean),
    );
    const recuParRef = new Map<string, number>();
    // VRAIE sur-réception = reçu > commandé sur au moins une ligne de commande (commandé > 0
    // pour écarter les retours/avoirs négatifs) — le juge de paix de l'audit du 01/07.
    const refsSurRecues = new Set<string>();
    for (const r of refsCmd) {
      const k = aliasRef(r.reference_article);
      const recu = Number(r.quantite_receptionnee_reelle) || 0;
      const cmd = Number(r.quantite_commandee) || 0;
      recuParRef.set(k, (recuParRef.get(k) ?? 0) + recu);
      if (cmd > 0 && recu > cmd + 0.001) refsSurRecues.add(k);
    }
    const refsRecues = new Set([...recuParRef].filter(([, v]) => v > 0).map(([k]) => k));
    // Part du Livré ABSENTE du détail par bon (order/view perd des lignes — cf 17655) :
    // si elle couvre un manque ②>③, ce n'est pas un oubli mais un détail incomplet.
    const saisiTotalParRef = new Map<string, number>();
    for (const s of saisies) {
      const k = aliasRef(s.reference_article);
      saisiTotalParRef.set(k, (saisiTotalParRef.get(k) ?? 0) + (Number(s.quantite_recue) || 0));
    }
    const nonDetailleByRef = new Map<string, number>();
    for (const [k, recu] of recuParRef) {
      const nd = recu - (saisiTotalParRef.get(k) ?? 0);
      if (nd > 0.001) nonDetailleByRef.set(k, nd);
    }

    return bes
      .map(be => {
        const sa = saisiesByBe.get(be.numero_be) ?? [];
        if (!sa.length) return null; // pas de saisie CL → pas rapprochable
        const rows = comparerPointage(lignesByBe.get(be.id) ?? [], sa, resByBe.get(be.numero_be) ?? [],
          { refsReliquat, refsRecues, recuTotalByRef: recuParRef, refsSurRecues, refsBarcode, nonDetailleByRef });
        const ecarts = rows.filter(aEcart);
        const aAnalyser = ecarts.filter(e => !STATUTS_RESOLUS.has(e.statut));
        return { be, nbRefs: rows.length, nbEcarts: ecarts.length, nbAAnalyser: aAnalyser.length, ecarts };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  }, [bes, lignes, saisies, resolutions, refsCmd, refsBarcode]);

  const avecEcarts = parBe.filter(b => b.nbEcarts > 0);
  const liste = (filtre === 'a_analyser' ? avecEcarts.filter(b => b.nbAAnalyser > 0) : avecEcarts)
    .sort((a, b) => b.nbAAnalyser - a.nbAAnalyser || b.nbEcarts - a.nbEcarts);

  const kpiBesRapprochables = parBe.length;
  const kpiEcartsAAnalyser = avecEcarts.reduce((s, b) => s + b.nbAAnalyser, 0);

  const causeCounts: Record<CauseCode, number> = { conforme: 0, oubli_log: 0, sur_saisie: 0, hors_commande: 0, dispatch: 0, detail_incomplet: 0 };
  for (const b of avecEcarts) for (const e of b.ecarts) if (aEcart(e)) causeCounts[causeEcart(e).code]++;
  const kpiFauxEcarts = causeCounts.dispatch + causeCounts.detail_incomplet;

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
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-4">
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
        <Card><CardContent className="p-4">
          <div className="text-xs text-gray-500">Faux écarts probables</div>
          <div className="text-2xl font-bold text-gray-400">{kpiFauxEcarts}</div>
          <div className="text-xs text-gray-400">dispatch multi-cmd / détail incomplet</div>
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
