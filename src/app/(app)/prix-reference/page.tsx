'use client';

import { useState, useCallback } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import PageHeader from '@/components/shared/PageHeader';
import Pagination from '@/components/shared/Pagination';
import SortableHeader from '@/components/shared/SortableHeader';
import { useTableFeatures } from '@/hooks/useTableFeatures';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatEur, formatDate } from '@/utils';
import { Tag, Search, X, Save, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

interface PrixReference {
  id: string;
  reference_article: string;
  fournisseur: string | null;
  designation: string | null;
  pu_last: number;
  updated_at: string;
}

const PAGE_SIZE = 50;

export default function PrixReferencePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const qc = useQueryClient();

  const search = searchParams.get('q') ?? '';
  const page = parseInt(searchParams.get('page') ?? '1', 10);
  const sortKey = searchParams.get('sortKey') ?? 'updated_at';
  const sortDir = (searchParams.get('sortDir') ?? 'desc') as 'asc' | 'desc';

  const [editingPU, setEditingPU] = useState<{ id: string; value: string } | null>(null);
  const [editingDesig, setEditingDesig] = useState<{ id: string; value: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<PrixReference | null>(null);

  const setFilter = useCallback((key: string, value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete('page');
    if (value) params.set(key, value);
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
      params.set('sortDir', sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      params.set('sortKey', field);
      params.set('sortDir', 'asc');
    }
    router.replace(`${pathname}?${params.toString()}`);
  }, [searchParams, pathname, router, sortKey, sortDir]);

  const { data: queryResult } = useQuery({
    queryKey: ['prix_reference', page, search, sortKey, sortDir],
    queryFn: async () => {
      let q = supabase.from('prix_reference').select('*', { count: 'exact' });
      if (search) q = q.or(`reference_article.ilike.%${search}%,fournisseur.ilike.%${search}%,designation.ilike.%${search}%`);
      q = q.order(sortKey || 'updated_at', { ascending: sortDir === 'asc' });
      q = q.range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
      const { data, count } = await q;
      return { items: (data ?? []) as PrixReference[], total: count ?? 0 };
    },
    staleTime: 30_000,
  });

  const items = queryResult?.items ?? [];
  const totalCount = queryResult?.total ?? 0;

  const { selected, toggleOne, togglePage, clearSelection, isPageChecked, isPageIndeterminate } = useTableFeatures(items);
  const pageIds = items.map(p => p.id);

  const savePUMutation = useMutation({
    mutationFn: async ({ itemId, pu }: { itemId: string; pu: number }) => {
      const { error } = await supabase.from('prix_reference').update({ pu_last: pu }).eq('id', itemId);
      if (error) throw error;
    },
    onSuccess: (_data, { itemId }) => {
      qc.invalidateQueries({ queryKey: ['prix_reference'] });
      setEditingPU(prev => prev?.id === itemId ? null : prev);
      toast.success('Prix mis à jour');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const saveDesigMutation = useMutation({
    mutationFn: async ({ itemId, designation }: { itemId: string; designation: string }) => {
      const { error } = await supabase.from('prix_reference').update({ designation }).eq('id', itemId);
      if (error) throw error;
    },
    onSuccess: (_data, { itemId }) => {
      qc.invalidateQueries({ queryKey: ['prix_reference'] });
      setEditingDesig(prev => prev?.id === itemId ? null : prev);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteMutation = useMutation({
    mutationFn: async (item: PrixReference) => {
      const { error } = await supabase.from('prix_reference').delete().eq('id', item.id);
      if (error) throw error;
    },
    onSuccess: (_d, item) => {
      qc.invalidateQueries({ queryKey: ['prix_reference'] });
      setConfirmDelete(null);
      toast.success(`Référence ${item.reference_article} supprimée`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      const { error } = await supabase.from('prix_reference').delete().in('id', ids);
      if (error) throw error;
      return ids.length;
    },
    onSuccess: (count) => {
      qc.invalidateQueries({ queryKey: ['prix_reference'] });
      clearSelection();
      toast.success(`${count} référence(s) supprimée(s)`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div>
      <PageHeader
        title="Catalogue prix"
        subtitle={`${totalCount} référence${totalCount > 1 ? 's' : ''}`}
      />

      <div className="flex gap-3 mb-4 flex-wrap items-center">
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 w-4 h-4 text-gray-400" />
          <Input
            placeholder="Réf., fournisseur, désignation..."
            value={search}
            onChange={e => setFilter('q', e.target.value)}
            className="w-72 pl-8"
          />
        </div>
        {search && (
          <button onClick={() => router.replace(pathname)} className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1">
            <X className="w-3.5 h-3.5" /> Reset
          </button>
        )}
      </div>

      {selected.size > 0 && (
        <div className="flex items-center gap-3 mb-3 px-4 py-2.5 bg-indigo-50 border border-indigo-100 rounded-xl text-sm">
          <span className="text-indigo-700 font-medium">{selected.size} sélectionné(s)</span>
          <button
            onClick={() => bulkDeleteMutation.mutate(Array.from(selected))}
            disabled={bulkDeleteMutation.isPending}
            className="ml-auto flex items-center gap-1.5 text-red-600 hover:text-red-700 font-medium disabled:opacity-50"
          >
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
              <SortableHeader label="Référence" field="reference_article" sortKey={sortKey} sortDir={sortDir} onSort={handleSortColumn} />
              <SortableHeader label="Fournisseur" field="fournisseur" sortKey={sortKey} sortDir={sortDir} onSort={handleSortColumn} />
              <SortableHeader label="Désignation" field="designation" sortKey={sortKey} sortDir={sortDir} onSort={handleSortColumn} />
              <SortableHeader label="Dernier PU €" field="pu_last" sortKey={sortKey} sortDir={sortDir} onSort={handleSortColumn} align="right" />
              <SortableHeader label="Mis à jour" field="updated_at" sortKey={sortKey} sortDir={sortDir} onSort={handleSortColumn} />
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {items.map(item => (
              <tr key={item.id} className="hover:bg-gray-50/50">
                <td className="w-10 px-4 py-2.5">
                  <input
                    type="checkbox"
                    checked={selected.has(item.id)}
                    onChange={() => toggleOne(item.id)}
                    className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                  />
                </td>
                <td className="px-4 py-2.5 font-mono text-xs font-medium text-gray-800">{item.reference_article}</td>
                <td className="px-4 py-2.5 text-xs text-gray-500">{item.fournisseur || '—'}</td>
                <td className="px-4 py-2.5 text-xs max-w-[220px]">
                  {editingDesig?.id === item.id ? (
                    <div className="flex items-center gap-1">
                      <Input
                        value={editingDesig.value}
                        onChange={e => setEditingDesig({ id: item.id, value: e.target.value })}
                        onKeyDown={e => {
                          if (e.key === 'Escape') { setEditingDesig(null); return; }
                          if (e.key === 'Enter') saveDesigMutation.mutate({ itemId: item.id, designation: editingDesig.value });
                        }}
                        className="h-6 text-xs flex-1"
                        autoFocus
                      />
                      <button onClick={() => saveDesigMutation.mutate({ itemId: item.id, designation: editingDesig.value })} className="text-emerald-500 hover:text-emerald-700 shrink-0"><Save className="w-3 h-3" /></button>
                      <button onClick={() => setEditingDesig(null)} className="text-gray-400 hover:text-gray-600 shrink-0"><X className="w-3 h-3" /></button>
                    </div>
                  ) : (
                    <span
                      className="cursor-pointer text-gray-600 hover:underline hover:text-gray-900 truncate block"
                      onClick={() => setEditingDesig({ id: item.id, value: item.designation ?? '' })}
                      title={item.designation ?? 'Cliquer pour saisir'}
                    >
                      {item.designation || <span className="text-gray-300 italic">—</span>}
                    </span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-right font-mono text-xs">
                  {editingPU?.id === item.id ? (
                    <div className="flex items-center justify-end gap-1">
                      <Input
                        type="number" step="0.0001"
                        value={editingPU.value}
                        onChange={e => setEditingPU({ id: item.id, value: e.target.value })}
                        onKeyDown={e => {
                          if (e.key === 'Escape') { setEditingPU(null); return; }
                          if (e.key === 'Enter') savePUMutation.mutate({ itemId: item.id, pu: parseFloat(editingPU.value) });
                        }}
                        className="w-20 h-6 text-xs"
                        autoFocus
                      />
                      <button onClick={() => savePUMutation.mutate({ itemId: item.id, pu: parseFloat(editingPU.value) })} className="text-emerald-500 hover:text-emerald-700"><Save className="w-3 h-3" /></button>
                      <button onClick={() => setEditingPU(null)} className="text-gray-400 hover:text-gray-600"><X className="w-3 h-3" /></button>
                    </div>
                  ) : (
                    <span
                      className="cursor-pointer hover:underline text-indigo-600"
                      onClick={() => setEditingPU({ id: item.id, value: String(item.pu_last) })}
                      title="Cliquer pour modifier le prix"
                    >
                      {formatEur(item.pu_last)}
                    </span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-xs text-gray-400">{formatDate(item.updated_at)}</td>
                <td className="px-4 py-2.5">
                  <button
                    className="p-1.5 rounded hover:bg-red-50 text-gray-300 hover:text-red-500 transition-colors"
                    onClick={() => setConfirmDelete(item)}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {items.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-gray-400">
            <Tag className="w-8 h-8 mb-2 text-gray-200" />
            <p className="text-sm">Aucune référence dans le catalogue</p>
            <p className="text-xs mt-1">Les prix sont alimentés automatiquement à l&apos;import des commandes</p>
          </div>
        )}
        <Pagination page={page} pageSize={PAGE_SIZE} total={totalCount} onChange={setPage} />
      </div>

      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-sm">
            <h2 className="text-base font-semibold text-gray-900 mb-2">Supprimer cette référence ?</h2>
            <p className="text-sm text-gray-600 mb-4">
              La référence <strong>{confirmDelete.reference_article}</strong> sera supprimée du catalogue.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setConfirmDelete(null)}>Annuler</Button>
              <Button variant="destructive" onClick={() => deleteMutation.mutate(confirmDelete)} disabled={deleteMutation.isPending}>
                {deleteMutation.isPending ? 'Suppression...' : 'Supprimer'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
