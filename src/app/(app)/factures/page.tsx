'use client';

import { useState, useMemo, useCallback } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import Link from 'next/link';
import PageHeader from '@/components/shared/PageHeader';
import StatusBadge from '@/components/shared/StatusBadge';
import EmptyState from '@/components/shared/EmptyState';
import Pagination from '@/components/shared/Pagination';
import PdfImportModal from '@/components/shared/PdfImportModal';
import SortableHeader from '@/components/shared/SortableHeader';
import { useTableFeatures } from '@/hooks/useTableFeatures';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatEur, formatDate, exportToCsv } from '@/utils';
import { FileText, ChevronRight, Trash2, Download, Upload, Search, X } from 'lucide-react';
import { toast } from 'sonner';
import type { Facture } from '@/types';

const isAvoir = (f: Facture) =>
  (f.total_ht ?? 0) < 0 || /avoir|credit|cn[-_sd]/i.test(f.numero_facture);

const PAGE_SIZE = 25;
const STATUTS: Facture['statut_facture'][] = ['importée', 'en cours de rapprochement', 'partiellement rapprochée', 'rapprochée', 'en anomalie'];

export default function FacturesPage() {
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

  const [confirmDelete, setConfirmDelete] = useState<Facture | null>(null);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [showImport, setShowImport] = useState(false);

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

  const { data: factures = [] } = useQuery<Facture[]>({
    queryKey: ['factures'],
    queryFn: async () => {
      const { data } = await supabase.from('factures').select('*').order('created_at', { ascending: false }).limit(500);
      return data ?? [];
    },
    refetchInterval: 5000,
  });

  const filtered = useMemo(() => factures.filter(f => {
    if (filtreStatut !== 'all' && f.statut_facture !== filtreStatut) return false;
    if (filtreFournisseur && !f.fournisseur?.toLowerCase().includes(filtreFournisseur.toLowerCase())) return false;
    if (search && !f.numero_facture?.toLowerCase().includes(search.toLowerCase())) return false;
    if (dateDebut && f.date_facture && f.date_facture < dateDebut) return false;
    if (dateFin && f.date_facture && f.date_facture > dateFin) return false;
    return true;
  }), [factures, filtreStatut, filtreFournisseur, search, dateDebut, dateFin]);

  const { sorted, sortKey, sortDir, toggleSort, selected, toggleOne, togglePage, clearSelection, isPageChecked, isPageIndeterminate } = useTableFeatures(filtered);

  const paginated = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const pageIds = paginated.map(f => f.id);

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

  return (
    <div>
      <PageHeader
        title="Factures"
        subtitle={`${factures.length} facture${factures.length > 1 ? 's' : ''}`}
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
              <SortableHeader label="N° facture" field="numero_facture" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <SortableHeader label="Fournisseur" field="fournisseur" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <SortableHeader label="Date" field="date_facture" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <SortableHeader label="Total HT" field="total_ht" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" />
              <SortableHeader label="Rapproché" field="taux_rapprochement" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" />
              <SortableHeader label="Statut" field="statut_facture" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {paginated.map(f => {
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
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1" onClick={e => e.stopPropagation()}>
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
        {filtered.length === 0 && <EmptyState icon={FileText} title="Aucune facture" />}
        <Pagination page={page} pageSize={PAGE_SIZE} total={sorted.length} onChange={setPage} />
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
