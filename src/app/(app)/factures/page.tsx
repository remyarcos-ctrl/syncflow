'use client';

import { useState, useCallback, Suspense } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import Link from 'next/link';
import PageHeader from '@/components/shared/PageHeader';
import StatusBadge from '@/components/shared/StatusBadge';
import EmptyState from '@/components/shared/EmptyState';
import Pagination from '@/components/shared/Pagination';
import PdfImportModal from '@/components/shared/PdfImportModal';
import { useTableFeatures } from '@/hooks/useTableFeatures';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatEur, formatDate, exportToCsv } from '@/utils';
import { FileText, ChevronRight, Trash2, Download, Upload, Search, X, AlertTriangle, Zap, ChevronUp, ChevronDown, ChevronsUpDown, Bot } from 'lucide-react';
import { toast } from 'sonner';
import type { Facture } from '@/types';

const isAvoir = (f: Facture) =>
  (f.total_ht ?? 0) < 0 || /avoir|credit|cn[-_sd]/i.test(f.numero_facture);

const PAGE_SIZE = 25;
const STATUTS: Facture['statut_facture'][] = ['importée', 'en cours de rapprochement', 'partiellement rapprochée', 'rapprochée', 'en anomalie'];

function FacturesPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const qc = useQueryClient();

  const search = searchParams.get('q') ?? '';
  const filtreStatut = searchParams.get('statut') ?? 'all';
  const filtreFournisseur = searchParams.get('fournisseur') ?? '';
  const dateDebut = searchParams.get('debut') ?? '';
  const dateFin = searchParams.get('fin') ?? '';
  const page = parseInt(searchParams.get('page') ?? '1', 10);
  const sortKey = searchParams.get('sortKey') ?? 'created_at';
  const sortDir = searchParams.get('sortDir') ?? 'desc';

  const [confirmDelete, setConfirmDelete] = useState<Facture | null>(null);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [isBulkMatching, setIsBulkMatching] = useState(false);

  const setFilter = useCallback((key: string, value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete('page');
    if (value && value !== 'all') params.set(key, value);
    else params.delete(key);
    router.replace(`${pathname}?${params.toString()}`);
  }, [searchParams, pathname, router]);

  const setPage = useCallback((p: number) => {
    const params = new URLSearchParams(searchParams.toString());
    if (p <= 1) params.delete('page');
    else params.set('page', String(p));
    router.replace(`${pathname}?${params.toString()}`);
  }, [searchParams, pathname, router]);

  const handleSortColumn = useCallback((field: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete('page');
    if (sortKey === field) {
      // toggle direction
      params.set('sortDir', sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      params.set('sortKey', field);
      params.set('sortDir', 'asc');
    }
    router.replace(`${pathname}?${params.toString()}`);
  }, [searchParams, pathname, router, sortKey, sortDir]);

  const { data: queryResult, isError } = useQuery({
    queryKey: ['factures', page, filtreStatut, filtreFournisseur, search, dateDebut, dateFin, sortKey, sortDir],
    queryFn: async () => {
      let q = supabase.from('factures').select('*', { count: 'exact' });
      if (filtreStatut !== 'all') q = q.eq('statut_facture', filtreStatut);
      if (filtreFournisseur) q = q.ilike('fournisseur', `%${filtreFournisseur}%`);
      if (search) q = q.ilike('numero_facture', `%${search}%`);
      if (dateDebut) q = q.gte('date_facture', dateDebut);
      if (dateFin) q = q.lte('date_facture', dateFin);
      const sortField = sortKey || 'created_at';
      const sortAsc = sortDir === 'asc';
      q = q.order(sortField, { ascending: sortAsc });
      q = q.range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
      const { data, count } = await q;
      return { factures: (data ?? []) as Facture[], total: count ?? 0 };
    },
    staleTime: 30_000,
  });

  const factures = queryResult?.factures ?? [];
  const totalCount = queryResult?.total ?? 0;

  const { data: facturesAvecRetour = new Set<string>() } = useQuery<Set<string>>({
    queryKey: ['factures_retours_actifs'],
    queryFn: async () => {
      const { data: raps } = await supabase
        .from('rapprochements')
        .select('facture_id, ligne_be_id')
        .not('ligne_be_id', 'is', null);
      if (!raps || raps.length === 0) return new Set<string>();

      const ligneBEIds = [...new Set(raps.map(r => r.ligne_be_id as string))];
      const { data: lignes } = await supabase
        .from('lignes_be')
        .select('id, statut_retour')
        .in('id', ligneBEIds)
        .not('statut_retour', 'is', null)
        .neq('statut_retour', 'avoir_recu');

      const withRetour = new Set((lignes ?? []).map((l: { id: string }) => l.id));
      const facIds = new Set<string>();
      for (const r of raps) {
        if (r.ligne_be_id && withRetour.has(r.ligne_be_id)) {
          facIds.add(r.facture_id);
        }
      }
      return facIds;
    },
    staleTime: 30_000,
  });

  const { selected, toggleOne, togglePage, clearSelection, isPageChecked, isPageIndeterminate } = useTableFeatures(factures);

  const pageIds = factures.map(f => f.id);

  const deleteMutation = useMutation({
    mutationFn: async (f: Facture) => {
      await supabase.from('rapprochements').delete().eq('facture_id', f.id);
      await supabase.from('lignes_facture').delete().eq('facture_id', f.id);
      await supabase.from('liaison_facture_commande').delete().eq('facture_id', f.id);
      const { error } = await supabase.from('factures').delete().eq('id', f.id);
      if (error) throw error;
    },
    onSuccess: (_d, f) => {
      qc.invalidateQueries({ queryKey: ['factures'] });
      setConfirmDelete(null);
      toast.success(`Facture ${f.numero_facture} supprimée`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      for (const id of ids) {
        await supabase.from('rapprochements').delete().eq('facture_id', id);
        await supabase.from('lignes_facture').delete().eq('facture_id', id);
        await supabase.from('liaison_facture_commande').delete().eq('facture_id', id);
        await supabase.from('factures').delete().eq('id', id);
      }
      return ids.length;
    },
    onSuccess: (count) => {
      clearSelection();
      setConfirmBulkDelete(false);
      qc.invalidateQueries({ queryKey: ['factures'] });
      toast.success(`${count} facture(s) supprimée(s)`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const handleBulkMatch = async () => {
    setIsBulkMatching(true);
    let successCount = 0;
    let errorCount = 0;
    for (const id of Array.from(selected)) {
      try {
        const res = await fetch('/api/matching', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ factureId: id }),
        });
        if (res.ok) successCount++;
        else errorCount++;
      } catch {
        errorCount++;
      }
    }
    setIsBulkMatching(false);
    qc.invalidateQueries({ queryKey: ['factures'] });
    if (successCount > 0) toast.success(`Matching lancé pour ${successCount} facture(s)`);
    if (errorCount > 0) toast.error(`Échec pour ${errorCount} facture(s)`);
    clearSelection();
  };

  const SortTh = ({ field, label, align = 'left' }: { field: string; label: string; align?: 'left' | 'right' }) => {
    const active = sortKey === field;
    const asc = sortDir === 'asc';
    return (
      <th
        onClick={() => handleSortColumn(field)}
        className={`px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide cursor-pointer select-none group${active ? ' text-indigo-600' : ''}${align === 'right' ? ' text-right' : ' text-left'}`}
      >
        <span className={`inline-flex items-center gap-1${align === 'right' ? ' flex-row-reverse' : ''}`}>
          {label}
          {active
            ? asc ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />
            : <ChevronsUpDown className="w-3 h-3 opacity-0 group-hover:opacity-40" />}
        </span>
      </th>
    );
  };

  return (
    <div>
      <PageHeader
        title="Factures"
        subtitle={`${totalCount} facture${totalCount > 1 ? 's' : ''}`}
        actions={
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => setShowImport(true)}>
              <Upload className="w-4 h-4" /> Importer PDF
            </Button>
            <Button variant="outline" size="sm" onClick={() => exportToCsv('factures.csv', factures as unknown as Record<string, unknown>[], [
              { label: 'N° facture', key: 'numero_facture' },
              { label: 'Fournisseur', key: 'fournisseur' },
              { label: 'Date', getValue: r => formatDate(r.date_facture as string) },
              { label: 'Total HT', getValue: r => String(r.total_ht ?? '') },
              { label: 'Statut', key: 'statut_facture' },
              { label: 'Taux rapprochement', getValue: r => `${r.taux_rapprochement}%` },
            ])}>
              <Download className="w-4 h-4" /> Export
            </Button>
          </div>
        }
      />

      {isError && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          Erreur lors du chargement des factures. Vérifiez votre connexion.
        </div>
      )}

      <div className="flex gap-3 mb-4 flex-wrap items-center">
        <select
          value={filtreStatut}
          onChange={e => setFilter('statut', e.target.value)}
          className="h-9 rounded-lg border border-gray-200 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          <option value="all">Tous les statuts</option>
          {STATUTS.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 w-4 h-4 text-gray-400" />
          <Input placeholder="N° facture..." value={search} onChange={e => setFilter('q', e.target.value)} className="w-48 pl-8" />
        </div>
        <Input placeholder="Fournisseur..." value={filtreFournisseur} onChange={e => setFilter('fournisseur', e.target.value)} className="w-48" />
        <input type="date" value={dateDebut} onChange={e => setFilter('debut', e.target.value)} className="h-9 rounded-lg border border-gray-200 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" title="Date facture depuis" />
        <input type="date" value={dateFin} onChange={e => setFilter('fin', e.target.value)} className="h-9 rounded-lg border border-gray-200 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" title="Date facture jusqu'à" />
        {(search || filtreStatut !== 'all' || filtreFournisseur || dateDebut || dateFin) && (
          <button onClick={() => router.replace(pathname)} className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1"><X className="w-3.5 h-3.5" /> Reset</button>
        )}
      </div>

      {selected.size > 0 && (
        <div className="flex items-center gap-3 mb-3 px-4 py-2.5 bg-indigo-50 border border-indigo-100 rounded-xl text-sm">
          <span className="text-indigo-700 font-medium">{selected.size} sélectionné(s)</span>
          <button
            onClick={handleBulkMatch}
            disabled={isBulkMatching}
            className="flex items-center gap-1.5 text-indigo-600 hover:text-indigo-700 font-medium disabled:opacity-50"
          >
            <Zap className="w-4 h-4" /> {isBulkMatching ? 'Matching...' : 'Lancer matching'}
          </button>
          <button onClick={() => setConfirmBulkDelete(true)} className="ml-auto flex items-center gap-1.5 text-red-600 hover:text-red-700 font-medium">
            <Trash2 className="w-4 h-4" /> Supprimer la sélection
          </button>
          <button onClick={clearSelection} className="text-gray-400 hover:text-gray-600"><X className="w-4 h-4" /></button>
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50/50 border-b border-gray-100">
              <th className="w-10 px-4 py-3">
                <input
                  type="checkbox"
                  checked={isPageChecked(pageIds)}
                  ref={el => { if (el) el.indeterminate = isPageIndeterminate(pageIds); }}
                  onChange={() => togglePage(pageIds)}
                  className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                />
              </th>
              <SortTh field="numero_facture" label="N° facture" />
              <SortTh field="fournisseur" label="Fournisseur" />
              <SortTh field="date_facture" label="Date" />
              <SortTh field="total_ht" label="Total HT" align="right" />
              <SortTh field="taux_rapprochement" label="Rapproché" align="right" />
              <SortTh field="statut_facture" label="Statut" />
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {factures.map(f => {
              const taux = f.taux_rapprochement ?? 0;
              const isSelected = selected.has(f.id);
              const avoir = isAvoir(f);
              return (
                <tr
                  key={f.id}
                  className={`cursor-pointer transition-colors ${isSelected ? 'bg-indigo-50/30' : 'hover:bg-gray-50/50'}`}
                  onClick={() => router.push(`/factures/${f.id}`)}
                >
                  <td className="w-10 px-4 py-3" onClick={e => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleOne(f.id)}
                      className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                    />
                  </td>
                  <td className="px-4 py-3 font-medium font-mono">{f.numero_facture}</td>
                  <td className="px-4 py-3 text-gray-600">{f.fournisseur || '—'}</td>
                  <td className="px-4 py-3 text-gray-500">{formatDate(f.date_facture)}</td>
                  <td className={`px-4 py-3 text-right font-mono${avoir ? ' text-teal-600 font-semibold' : ''}`}>{formatEur(f.total_ht)}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <div className="w-16 h-1.5 rounded-full bg-gray-100 overflow-hidden">
                        <div className={`h-full rounded-full ${taux === 100 ? 'bg-emerald-400' : taux > 50 ? 'bg-amber-400' : 'bg-red-300'}`} style={{ width: `${taux}%` }} />
                      </div>
                      <span className={`text-xs font-medium ${taux === 100 ? 'text-emerald-600' : taux > 0 ? 'text-amber-600' : 'text-gray-400'}`}>{taux}%</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {avoir
                      ? <span className="inline-flex items-center rounded-full bg-teal-50 border border-teal-200 px-2 py-0.5 text-xs font-medium text-teal-700">Avoir</span>
                      : <StatusBadge status={f.statut_facture} />
                    }
                    {facturesAvecRetour.has(f.id) && (
                      <span title="Retour fournisseur en attente" className="inline-flex items-center gap-0.5 rounded-full bg-orange-50 border border-orange-200 px-1.5 py-0.5 text-xs text-orange-600 ml-1">
                        <AlertTriangle className="w-3 h-3" /> Retour
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1" onClick={e => e.stopPropagation()}>
                      <button
                        className="p-1.5 rounded hover:bg-indigo-50 text-gray-400 hover:text-indigo-500 transition-colors"
                        title="Demander à Teddy"
                        onClick={() => window.dispatchEvent(new CustomEvent('teddy-ask', { detail: { prompt: `Analyse la facture ${f.numero_facture} (${f.fournisseur}) : statut rapprochement, écarts, actions recommandées.` } }))}
                      >
                        <Bot className="w-3.5 h-3.5" />
                      </button>
                      <button className="p-1.5 rounded hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors" onClick={() => setConfirmDelete(f)}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                      <Link href={`/factures/${f.id}`} className="p-1.5 rounded hover:bg-gray-100" onClick={e => e.stopPropagation()}>
                        <ChevronRight className="w-4 h-4 text-gray-400" />
                      </Link>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {factures.length === 0 && <EmptyState icon={FileText} title="Aucune facture" />}
        <Pagination page={page} pageSize={PAGE_SIZE} total={totalCount} onChange={setPage} />
      </div>

      <PdfImportModal
        open={showImport}
        title="Importer des factures PDF"
        onClose={() => setShowImport(false)}
        onSuccess={() => qc.invalidateQueries({ queryKey: ['factures'] })}
      />

      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-sm">
            <h2 className="text-base font-semibold text-gray-900 mb-2">Supprimer cette facture ?</h2>
            <p className="text-sm text-gray-600 mb-4">La facture <strong>{confirmDelete.numero_facture}</strong> sera définitivement supprimée.</p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setConfirmDelete(null)}>Annuler</Button>
              <Button variant="destructive" onClick={() => deleteMutation.mutate(confirmDelete)} disabled={deleteMutation.isPending}>
                {deleteMutation.isPending ? 'Suppression...' : 'Supprimer'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {confirmBulkDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-sm">
            <h2 className="text-base font-semibold text-gray-900 mb-2">Supprimer {selected.size} facture(s) ?</h2>
            <p className="text-sm text-gray-600 mb-4">Cette action est irréversible. Toutes les données liées seront supprimées.</p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setConfirmBulkDelete(false)}>Annuler</Button>
              <Button variant="destructive" onClick={() => bulkDeleteMutation.mutate(Array.from(selected))} disabled={bulkDeleteMutation.isPending}>
                {bulkDeleteMutation.isPending ? 'Suppression...' : 'Supprimer'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function FacturesPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-gray-400">Chargement...</div>}>
      <FacturesPageInner />
    </Suspense>
  );
}
