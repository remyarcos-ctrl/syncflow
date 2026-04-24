'use client';

import { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import Link from 'next/link';
import PageHeader from '@/components/shared/PageHeader';
import StatusBadge from '@/components/shared/StatusBadge';
import EmptyState from '@/components/shared/EmptyState';
import Pagination from '@/components/shared/Pagination';
import SortableHeader from '@/components/shared/SortableHeader';
import { useTableFeatures } from '@/hooks/useTableFeatures';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatEur, formatDate, exportToCsv } from '@/utils';
import { ShoppingCart, Plus, ChevronRight, Trash2, Download, Search, X } from 'lucide-react';
import { toast } from 'sonner';
import type { Commande, LigneCommande, Fournisseur } from '@/types';

const PAGE_SIZE = 25;
const STATUTS: Commande['statut_commande'][] = [
  'ouverte', 'partiellement réceptionnée', 'réceptionnée',
  'partiellement facturée', 'soldée', 'en anomalie'
];

export default function CommandesPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [filtreStatut, setFiltreStatut] = useState('all');
  const [filtreFournisseur, setFiltreFournisseur] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ numero_commande_interne: '', fournisseur: '', date_commande: '' });
  const [lignesForm, setLignesForm] = useState<{ reference_article: string; designation: string; quantite_commandee: string; pu_commande: string }[]>([]);
  const [newLigne, setNewLigne] = useState({ reference_article: '', designation: '', quantite_commandee: '', pu_commande: '' });
  const [confirmDelete, setConfirmDelete] = useState<Commande | null>(null);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);

  const { data: commandes = [] } = useQuery<Commande[]>({
    queryKey: ['commandes'],
    queryFn: async () => {
      const { data } = await supabase.from('commandes').select('*').order('created_at', { ascending: false }).limit(500);
      return data ?? [];
    },
    refetchInterval: 5000,
  });

  const { data: lignes = [] } = useQuery<LigneCommande[]>({
    queryKey: ['lignes_commande'],
    queryFn: async () => {
      const { data } = await supabase.from('lignes_commande').select('*').limit(2000);
      return data ?? [];
    },
    staleTime: 30000,
  });

  const { data: fournisseurs = [] } = useQuery<Fournisseur[]>({
    queryKey: ['fournisseurs'],
    queryFn: async () => {
      const { data } = await supabase.from('fournisseurs').select('*').order('nom').limit(200);
      return data ?? [];
    },
    staleTime: 60000,
  });

  const filtered = useMemo(() => commandes.filter(c => {
    if (filtreStatut !== 'all' && c.statut_commande !== filtreStatut) return false;
    if (filtreFournisseur && !c.fournisseur?.toLowerCase().includes(filtreFournisseur.toLowerCase())) return false;
    if (search && !c.numero_commande_interne?.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  }), [commandes, filtreStatut, filtreFournisseur, search]);

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
  const pageIds = paginated.map(c => c.id);

  const getLignes = (cmdId: string) => lignes.filter(l => l.commande_id === cmdId);

  const createMutation = useMutation({
    mutationFn: async () => {
      const montant = lignesForm.reduce((s, l) => s + (parseFloat(l.quantite_commandee) || 0) * (parseFloat(l.pu_commande) || 0), 0);
      const { data: cmd, error } = await supabase.from('commandes').insert({
        numero_commande_interne: form.numero_commande_interne,
        fournisseur: form.fournisseur,
        date_commande: form.date_commande || null,
        montant_total_commande: montant || null,
      }).select().single();
      if (error) throw error;
      if (lignesForm.length > 0 && cmd) {
        await supabase.from('lignes_commande').insert(
          lignesForm.map((l, i) => {
            const qte = parseFloat(l.quantite_commandee) || 0;
            const pu = parseFloat(l.pu_commande) || 0;
            return {
              commande_id: cmd.id, ligne_no: i + 1,
              reference_article: l.reference_article,
              designation: l.designation,
              quantite_commandee: qte, pu_commande: pu,
              montant_ht_commande: qte * pu,
              quantite_restante_a_recevoir: qte,
            };
          })
        );
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['commandes'] });
      qc.invalidateQueries({ queryKey: ['lignes_commande'] });
      setShowCreate(false);
      setForm({ numero_commande_interne: '', fournisseur: '', date_commande: '' });
      setLignesForm([]);
      toast.success('Commande créée');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteMutation = useMutation({
    mutationFn: async (cmd: Commande) => {
      await supabase.from('lignes_commande').delete().eq('commande_id', cmd.id);
      await supabase.from('liaison_be_commande').delete().eq('commande_id', cmd.id);
      await supabase.from('liaison_facture_commande').delete().eq('commande_id', cmd.id);
      const { error } = await supabase.from('commandes').delete().eq('id', cmd.id);
      if (error) throw error;
    },
    onSuccess: (_d, cmd) => {
      qc.invalidateQueries({ queryKey: ['commandes'] });
      qc.invalidateQueries({ queryKey: ['lignes_commande'] });
      setConfirmDelete(null);
      toast.success(`Commande ${cmd.numero_commande_interne} supprimée`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const bulkDeleteMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      for (const id of ids) {
        await supabase.from('lignes_commande').delete().eq('commande_id', id);
        await supabase.from('liaison_be_commande').delete().eq('commande_id', id);
        await supabase.from('liaison_facture_commande').delete().eq('commande_id', id);
        await supabase.from('commandes').delete().eq('id', id);
      }
      return ids.length;
    },
    onSuccess: (count) => {
      qc.invalidateQueries({ queryKey: ['commandes'] });
      qc.invalidateQueries({ queryKey: ['lignes_commande'] });
      clearSelection();
      setConfirmBulkDelete(false);
      toast.success(`${count} commande${count > 1 ? 's' : ''} supprimée${count > 1 ? 's' : ''}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const handleAddLigne = () => {
    if (!newLigne.reference_article.trim()) return;
    setLignesForm([...lignesForm, newLigne]);
    setNewLigne({ reference_article: '', designation: '', quantite_commandee: '', pu_commande: '' });
  };

  return (
    <div>
      <PageHeader
        title="Commandes"
        subtitle={`${commandes.length} commande${commandes.length > 1 ? 's' : ''}`}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => exportToCsv('commandes.csv', commandes as unknown as Record<string, unknown>[], [
              { label: 'N° commande', key: 'numero_commande_interne' },
              { label: 'Fournisseur', key: 'fournisseur' },
              { label: 'Date', getValue: r => formatDate(r.date_commande as string) },
              { label: 'Statut', key: 'statut_commande' },
              { label: 'Montant', getValue: r => String(r.montant_total_commande ?? '') },
            ])}>
              <Download className="w-4 h-4" /> Export CSV
            </Button>
            <Button size="sm" onClick={() => setShowCreate(true)}>
              <Plus className="w-4 h-4" /> Nouvelle commande
            </Button>
          </div>
        }
      />

      <div className="flex gap-3 mb-4 flex-wrap items-center">
        <select
          value={filtreStatut}
          onChange={e => { setFiltreStatut(e.target.value); setPage(1); }}
          className="h-9 rounded-lg border border-gray-200 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          <option value="all">Tous les statuts</option>
          {STATUTS.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 w-4 h-4 text-gray-400" />
          <Input
            placeholder="N° commande..."
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }}
            className="w-56 pl-8"
          />
        </div>
        <Input
          placeholder="Fournisseur..."
          value={filtreFournisseur}
          onChange={e => { setFiltreFournisseur(e.target.value); setPage(1); }}
          className="w-52"
        />
      </div>

      {selected.size > 0 && (
        <div className="flex items-center gap-3 mb-3 px-4 py-2.5 bg-indigo-50 border border-indigo-100 rounded-xl text-sm">
          <span className="text-indigo-700 font-medium">{selected.size} sélectionné(s)</span>
          <button onClick={() => setConfirmBulkDelete(true)} className="ml-auto flex items-center gap-1.5 text-red-600 hover:text-red-700 font-medium">
            <Trash2 className="w-4 h-4" />Supprimer la sélection
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
              <SortableHeader label="N° commande" field="numero_commande_interne" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <SortableHeader label="Fournisseur" field="fournisseur" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <SortableHeader label="Date" field="date_commande" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Qté cmd</th>
              <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Qté reçue</th>
              <SortableHeader label="Montant" field="montant_total_commande" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" />
              <SortableHeader label="Statut" field="statut_commande" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {paginated.map(cmd => {
              const cl = getLignes(cmd.id);
              const qteCmd = cl.reduce((s, l) => s + (l.quantite_commandee || 0), 0);
              const qteRecue = cl.reduce((s, l) => s + (l.quantite_receptionnee_reelle || 0), 0);
              const montant = cmd.montant_total_commande
                ?? (cl.reduce((s, l) => s + (l.montant_ht_commande ?? ((l.quantite_commandee ?? 0) * (l.pu_commande ?? 0))), 0) || null);
              const isSelected = selected.has(cmd.id);
              return (
                <tr
                  key={cmd.id}
                  className={`hover:bg-gray-50/50 cursor-pointer ${isSelected ? 'bg-indigo-50/30' : ''}`}
                  onClick={() => router.push(`/commandes/${cmd.id}`)}
                >
                  <td className="w-10 px-4 py-3" onClick={e => { e.stopPropagation(); toggleOne(cmd.id); }}>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleOne(cmd.id)}
                      className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                    />
                  </td>
                  <td className="px-4 py-3 font-medium font-mono">{cmd.numero_commande_interne}</td>
                  <td className="px-4 py-3 text-gray-600">{cmd.fournisseur}</td>
                  <td className="px-4 py-3 text-gray-500">{formatDate(cmd.date_commande)}</td>
                  <td className="px-4 py-3 text-right font-mono">{qteCmd}</td>
                  <td className="px-4 py-3 text-right font-mono">{qteRecue}</td>
                  <td className="px-4 py-3 text-right font-mono">{formatEur(montant)}</td>
                  <td className="px-4 py-3"><StatusBadge status={cmd.statut_commande} /></td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1" onClick={e => e.stopPropagation()}>
                      <button
                        className="p-1.5 rounded hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors"
                        onClick={() => setConfirmDelete(cmd)}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                      <Link href={`/commandes/${cmd.id}`} className="p-1.5 rounded hover:bg-gray-100" onClick={e => e.stopPropagation()}>
                        <ChevronRight className="w-4 h-4 text-gray-400" />
                      </Link>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {filtered.length === 0 && <EmptyState icon={ShoppingCart} title="Aucune commande" />}
        <Pagination page={page} pageSize={PAGE_SIZE} total={filtered.length} onChange={setPage} />
      </div>

      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-xl max-h-[90vh] overflow-y-auto p-6">
            <h2 className="text-base font-semibold text-gray-900 mb-4">Nouvelle commande</h2>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-gray-700 mb-1 block">N° commande *</label>
                  <Input value={form.numero_commande_interne} onChange={e => setForm({ ...form, numero_commande_interne: e.target.value })} placeholder="BC-2024-001" />
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-700 mb-1 block">Fournisseur *</label>
                  <select
                    value={form.fournisseur}
                    onChange={e => setForm({ ...form, fournisseur: e.target.value })}
                    className="h-9 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  >
                    <option value="">Choisir...</option>
                    {fournisseurs.map(f => <option key={f.id} value={f.nom}>{f.nom}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-gray-700 mb-1 block">Date commande</label>
                <Input type="date" value={form.date_commande} onChange={e => setForm({ ...form, date_commande: e.target.value })} className="w-48" />
              </div>

              <div>
                <p className="text-xs font-semibold text-gray-700 mb-2">Lignes articles</p>
                {lignesForm.length > 0 && (
                  <table className="w-full text-xs mb-2 border rounded-lg overflow-hidden">
                    <thead className="bg-gray-50"><tr>
                      <th className="text-left px-2 py-1.5 font-medium text-gray-500">Réf.</th>
                      <th className="text-left px-2 py-1.5 font-medium text-gray-500">Désignation</th>
                      <th className="text-right px-2 py-1.5 font-medium text-gray-500">Qté</th>
                      <th className="text-right px-2 py-1.5 font-medium text-gray-500">PU €</th>
                      <th className="px-2 py-1.5"></th>
                    </tr></thead>
                    <tbody className="divide-y">
                      {lignesForm.map((l, idx) => (
                        <tr key={idx}>
                          <td className="px-2 py-1.5 font-mono">{l.reference_article}</td>
                          <td className="px-2 py-1.5 text-gray-500 truncate max-w-[100px]">{l.designation}</td>
                          <td className="px-2 py-1.5 text-right">{l.quantite_commandee}</td>
                          <td className="px-2 py-1.5 text-right">{l.pu_commande}</td>
                          <td className="px-2 py-1.5 text-right">
                            <button onClick={() => setLignesForm(lignesForm.filter((_, i) => i !== idx))} className="text-gray-300 hover:text-red-500">✕</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <div className="grid grid-cols-4 gap-2">
                  <Input value={newLigne.reference_article} onChange={e => setNewLigne({ ...newLigne, reference_article: e.target.value })} placeholder="Réf. *" className="text-xs h-8" />
                  <Input value={newLigne.designation} onChange={e => setNewLigne({ ...newLigne, designation: e.target.value })} placeholder="Désignation" className="text-xs h-8" />
                  <Input type="number" value={newLigne.quantite_commandee} onChange={e => setNewLigne({ ...newLigne, quantite_commandee: e.target.value })} placeholder="Qté" className="text-xs h-8" />
                  <Input type="number" step="0.01" value={newLigne.pu_commande} onChange={e => setNewLigne({ ...newLigne, pu_commande: e.target.value })} placeholder="PU €" className="text-xs h-8" />
                </div>
                <Button type="button" variant="outline" size="sm" onClick={handleAddLigne} className="w-full mt-2 text-xs h-7">
                  <Plus className="w-3 h-3" /> Ajouter une ligne
                </Button>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <Button variant="outline" onClick={() => setShowCreate(false)}>Annuler</Button>
              <Button
                onClick={() => createMutation.mutate()}
                disabled={createMutation.isPending || !form.numero_commande_interne || !form.fournisseur}
              >
                {createMutation.isPending ? 'Création...' : 'Créer'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-sm">
            <h2 className="text-base font-semibold text-gray-900 mb-2">Supprimer la commande ?</h2>
            <p className="text-sm text-gray-600 mb-4">
              La commande <strong>{confirmDelete.numero_commande_interne}</strong> et toutes ses lignes seront définitivement supprimées.
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
            <h2 className="text-base font-semibold text-gray-900 mb-2">Supprimer {selected.size} commande(s) ?</h2>
            <p className="text-sm text-gray-600 mb-4">
              Ces commandes et toutes leurs lignes seront définitivement supprimées.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setConfirmBulkDelete(false)}>Annuler</Button>
              <Button variant="destructive" onClick={() => bulkDeleteMutation.mutate([...selected])} disabled={bulkDeleteMutation.isPending}>
                {bulkDeleteMutation.isPending ? 'Suppression...' : 'Supprimer'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
