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
import { formatDate, exportToCsv } from '@/utils';
import { Package, ChevronRight, Trash2, Download, Search, Upload, X, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import type { BEReception } from '@/types';

const PAGE_SIZE = 25;
const STATUTS: BEReception['statut_be'][] = ['reçu', 'partiellement facturé', 'facturé', 'soldé', 'en anomalie'];

export default function BEReceptionsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const qc = useQueryClient();

  const search = searchParams.get('q') ?? '';
  const filtreStatut = searchParams.get('statut') ?? 'all';
  const filtreFournisseur = searchParams.get('fournisseur') ?? '';
  const filtreEcart = searchParams.get('ecart') === '1';
  const dateDebut = searchParams.get('debut') ?? '';
  const dateFin = searchParams.get('fin') ?? '';
  const page = parseInt(searchParams.get('page') ?? '1', 10);

  const [confirmDelete, setConfirmDelete] = useState<BEReception | null>(null);
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

  const { data: bes = [] } = useQuery<BEReception[]>({
    queryKey: ['bes'],
    queryFn: async () => {
      const { data } = await supabase.from('be_receptions').select('*').order('created_at', { ascending: false }).limit(500);
      return data ?? [];
    },
    refetchInterval: 5000,
  });

  const { data: besIdAvecEcart = new Set<string>() } = useQuery<Set<string>>({
    queryKey: ['bes_ecarts'],
    queryFn: async () => {
      const { data } = await supabase
        .from('lignes_be')
        .select('be_id, quantite_receptionnee, quantite_document_be')
        .not('quantite_document_be', 'is', null);
      const ids = new Set<string>();
      for (const l of data ?? []) {
        if (l.quantite_document_be !== l.quantite_receptionnee) ids.add(l.be_id);
      }
      return ids;
    },
    refetchInterval: 10000,
  });

  const filtered = useMemo(() => bes.filter(b => {
    if (filtreStatut !== 'all' && b.statut_be !== filtreStatut) return false;
    if (filtreFournisseur && !b.fournisseur?.toLowerCase().includes(filtreFournisseur.toLowerCase())) return false;
    if (search && !b.numero_be?.toLowerCase().includes(search.toLowerCase())) return false;
    if (filtreEcart && !besIdAvecEcart.has(b.id)) return false;
    if (dateDebut && b.date_bl && b.date_bl < dateDebut) return false;
    if (dateFin && b.date_bl && b.date_bl > dateFin) return false;
    return true;
  }), [bes, filtreStatut, filtreFournisseur, search, filtreEcart, besIdAvecEcart, dateDebut, dateFin]);

  const {
    sorted,
    sortKey,
    sortDir,
    toggleSort,
    selected,
    toggleOne,
    togglePage,
    clearSelection,
    isPageChecked,
    isPageIndeterminate,
  } = useTableFeatures(filtered);

  const paginated = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const pageIds = paginated.map(b => b.id);

  const deleteMutation = useMutation({
    mutationFn: async (be: BEReception) => {
      await supabase.from('lignes_be').delete().eq('be_id', be.id);
      await supabase.from('rapprochements').delete().eq('be_id', be.id);
      await supabase.from('liaison_be_commande').delete().eq('be_id', be.id);
      const { error } = await supabase.from('be_receptions').delete().eq('id', be.id);
      if (error) throw error;
    },
    onSuccess: (_d, be) => {
      qc.invalidateQueries({ queryKey: ['bes'] });
      setConfirmDelete(null);
      toast.success(`BE ${be.numero_be} supprimé`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      for (const id of ids) {
        await supabase.from('lignes_be').delete().eq('be_id', id);
        await supabase.from('rapprochements').delete().eq('be_id', id);
        await supabase.from('liaison_be_commande').delete().eq('be_id', id);
        await supabase.from('be_receptions').delete().eq('id', id);
      }
      return ids.length;
    },
    onSuccess: (count) => {
      qc.invalidateQueries({ queryKey: ['bes'] });
      clearSelection();
      setConfirmBulkDelete(false);
      toast.success(`${count} BE(s) supprimé(s)`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div>
      <PageHeader
        title="BE / Réceptions"
        subtitle={`${bes.length} bordereau${bes.length > 1 ? 'x' : ''}`}
        actions={
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => setShowImport(true)}>
              <Upload className="w-4 h-4" /> Importer PDF
            </Button>
            <Button variant="outline" size="sm" onClick={() => exportToCsv('be-receptions.csv', bes as unknown as Record<string, unknown>[], [
              { label: 'N° BE', key: 'numero_be' },
              { label: 'Fournisseur', key: 'fournisseur' },
              { label: 'Date BL', getValue: r => formatDate(r.date_bl as string) },
              { label: 'Statut', key: 'statut_be' },
            ])}>
              <Download className="w-4 h-4" /> Export CSV
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
          <Input placeholder="N° BE..." value={search} onChange={e => setFilter('q', e.target.value)} className="w-48 pl-8" />
        </div>
        <Input placeholder="Fournisseur..." value={filtreFournisseur} onChange={e => setFilter('fournisseur', e.target.value)} className="w-48" />
        <button
          onClick={() => setFilter('ecart', filtreEcart ? '' : '1')}
          className={`inline-flex items-center gap-1.5 rounded-lg border px-3 h-9 text-sm font-medium transition-colors ${filtreEcart ? 'bg-orange-500 border-orange-500 text-white' : 'bg-white border-gray-200 text-gray-600 hover:border-orange-300 hover:text-orange-600'}`}
        >
          <AlertTriangle className="w-3.5 h-3.5" />
          Écarts{besIdAvecEcart.size > 0 && <span className={`rounded-full px-1.5 py-0.5 text-xs font-semibold ${filtreEcart ? 'bg-white text-orange-600' : 'bg-orange-100 text-orange-700'}`}>{besIdAvecEcart.size}</span>}
        </button>
        <input type="date" value={dateDebut} onChange={e => setFilter('debut', e.target.value)} className="h-9 rounded-lg border border-gray-200 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" title="Date BL depuis" />
        <input type="date" value={dateFin} onChange={e => setFilter('fin', e.target.value)} className="h-9 rounded-lg border border-gray-200 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" title="Date BL jusqu'à" />
        {(search || filtreStatut !== 'all' || filtreFournisseur || filtreEcart || dateDebut || dateFin) && (
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
              <SortableHeader label="N° BE" field="numero_be" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <SortableHeader label="Fournisseur" field="fournisseur" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <SortableHeader label="Date BL" field="date_bl" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Commande liée</th>
              <SortableHeader label="Statut" field="statut_be" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {paginated.map(be => (
              <tr
                key={be.id}
                className={`hover:bg-gray-50/50 cursor-pointer ${selected.has(be.id) ? 'bg-indigo-50/30' : ''}`}
                onClick={() => router.push(`/be-receptions/${be.id}`)}
              >
                <td className="w-10 px-4 py-3" onClick={e => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selected.has(be.id)}
                    onChange={() => toggleOne(be.id)}
                    className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                  />
                </td>
                <td className="px-4 py-3 font-medium font-mono">
                  <div className="flex items-center gap-2">
                    {be.numero_be}
                    {besIdAvecEcart.has(be.id) && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-orange-50 border border-orange-200 px-1.5 py-0.5 text-xs font-medium text-orange-700">
                        <AlertTriangle className="w-3 h-3" /> Écart
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-4 py-3 text-gray-600">{be.fournisseur || '—'}</td>
                <td className="px-4 py-3 text-gray-500">{formatDate(be.date_bl)}</td>
                <td className="px-4 py-3 text-gray-500 text-xs">{be.commande_id ? <span className="text-indigo-600">Lié</span> : <span className="text-amber-500">Non lié</span>}</td>
                <td className="px-4 py-3"><StatusBadge status={be.statut_be} /></td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-1" onClick={e => e.stopPropagation()}>
                    <button className="p-1.5 rounded hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors" onClick={() => setConfirmDelete(be)}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                    <Link href={`/be-receptions/${be.id}`} className="p-1.5 rounded hover:bg-gray-100" onClick={e => e.stopPropagation()}>
                      <ChevronRight className="w-4 h-4 text-gray-400" />
                    </Link>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && <EmptyState icon={Package} title="Aucun bordereau de réception" />}
        <Pagination page={page} pageSize={PAGE_SIZE} total={sorted.length} onChange={setPage} />
      </div>

      <PdfImportModal
        open={showImport}
        title="Importer des BEs / Factures PDF"
        onClose={() => setShowImport(false)}
        onSuccess={() => qc.invalidateQueries({ queryKey: ['bes'] })}
      />

      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-sm">
            <h2 className="text-base font-semibold text-gray-900 mb-2">Supprimer ce BE ?</h2>
            <p className="text-sm text-gray-600 mb-4">
              Le BE <strong>{confirmDelete.numero_be}</strong> et toutes ses lignes seront définitivement supprimés.
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

      {confirmBulkDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-sm">
            <h2 className="text-base font-semibold text-gray-900 mb-2">Supprimer {selected.size} BE(s) ?</h2>
            <p className="text-sm text-gray-600 mb-4">
              Ces {selected.size} bordereau(x) et toutes leurs lignes seront définitivement supprimés.
            </p>
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
