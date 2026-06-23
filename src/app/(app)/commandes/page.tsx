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
import PeriodeChips from '@/components/shared/PeriodeChips';
import SortableHeader from '@/components/shared/SortableHeader';
import TableSkeleton from '@/components/shared/TableSkeleton';
import { useTableFeatures } from '@/hooks/useTableFeatures';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatEur, formatDate, exportToCsv, cn } from '@/utils';
import { ShoppingCart, Plus, ChevronRight, Trash2, Download, Search, X, Package, Bot } from 'lucide-react';
import { toast } from 'sonner';
import type { Commande, Fournisseur } from '@/types';

const PAGE_SIZE = 25;
const STATUTS: Commande['statut_commande'][] = [
  'ouverte', 'partiellement réceptionnée', 'réceptionnée',
  'partiellement facturée', 'soldée', 'en anomalie',
];

function CommandesPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const qc = useQueryClient();

  const search = searchParams.get('q') ?? '';
  const filtreStatut = searchParams.get('statut') ?? 'all';
  const filtreFournisseur = searchParams.get('fournisseur') ?? '';
  const filtreReliquats = searchParams.get('reliquats') === '1';
  const page = parseInt(searchParams.get('page') ?? '1', 10);
  const sortKey = searchParams.get('sortKey') ?? 'numero_commande_interne';
  const sortDir = (searchParams.get('sortDir') ?? 'desc') as 'asc' | 'desc';
  const annee = searchParams.get('annee') ?? '';
  const mois = searchParams.get('mois') ?? '';

  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ numero_commande_interne: '', fournisseur: '', date_commande: '' });
  const [lignesForm, setLignesForm] = useState<{ reference_article: string; designation: string; quantite_commandee: string; pu_commande: string }[]>([]);
  const [newLigne, setNewLigne] = useState({ reference_article: '', designation: '', quantite_commandee: '', pu_commande: '' });
  const [confirmDelete, setConfirmDelete] = useState<Commande | null>(null);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [prixSuggere, setPrixSuggere] = useState<{ pu: number; designation: string | null } | null>(null);

  const setFilter = useCallback((key: string, value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete('page');
    if (value && value !== 'all') params.set(key, value);
    else params.delete(key);
    router.replace(`${pathname}?${params.toString()}`);
  }, [searchParams, pathname, router]);

  // Filtre période : choisir une année réinitialise le mois ; choisir un mois le pose.
  const setPeriode = useCallback((key: 'annee' | 'mois', value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete('page');
    if (key === 'annee') { params.delete('mois'); if (value) params.set('annee', value); else { params.delete('annee'); } }
    else { if (value) params.set('mois', value); else params.delete('mois'); }
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

  const { data: queryResult, isError, isLoading } = useQuery({
    queryKey: ['commandes', page, filtreStatut, filtreFournisseur, search, sortKey, sortDir, filtreReliquats, annee, mois],
    queryFn: async () => {
      let q = supabase.from('commandes').select('*', { count: 'exact' });
      if (filtreReliquats) {
        q = q.in('statut_commande', ['ouverte', 'partiellement réceptionnée']);
      } else if (filtreStatut !== 'all') {
        q = q.eq('statut_commande', filtreStatut);
      }
      if (annee) {
        const m = mois ? parseInt(mois, 10) : 0;
        const debut = mois ? `${annee}-${mois}-01` : `${annee}-01-01`;
        const fin = mois
          ? (m === 12 ? `${+annee + 1}-01-01` : `${annee}-${String(m + 1).padStart(2, '0')}-01`)
          : `${+annee + 1}-01-01`;
        q = q.gte('date_commande', debut).lt('date_commande', fin);
      }
      if (filtreFournisseur) q = q.ilike('fournisseur', `%${filtreFournisseur}%`);
      if (search) q = q.ilike('numero_commande_interne', `%${search}%`);
      q = q.order(sortKey || 'numero_commande_interne', { ascending: sortDir === 'asc' });
      q = q.range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
      const { data, count } = await q;
      return { commandes: (data ?? []) as Commande[], total: count ?? 0 };
    },
    staleTime: 30_000,
  });

  const commandes = queryResult?.commandes ?? [];
  const totalCount = queryResult?.total ?? 0;

  const { data: fournisseurs = [] } = useQuery<Fournisseur[]>({
    queryKey: ['fournisseurs'],
    queryFn: async () => {
      const { data } = await supabase.from('fournisseurs').select('*').order('nom').limit(200);
      return data ?? [];
    },
    staleTime: 60000,
  });

  const { selected, toggleOne, togglePage, clearSelection, isPageChecked, isPageIndeterminate } = useTableFeatures(commandes);
  const pageIds = commandes.map(c => c.id);

  const { data: aggParCommande = { reste: {}, montant: {} } } = useQuery<{ reste: Record<string, number>; montant: Record<string, number> }>({
    queryKey: ['commandes-agg', pageIds.join(',')],
    queryFn: async () => {
      const { data } = await supabase
        .from('lignes_commande')
        .select('commande_id, quantite_restante_a_recevoir, quantite_commandee, pu_commande, montant_ht_commande')
        .in('commande_id', pageIds);
      const reste: Record<string, number> = {};
      const montant: Record<string, number> = {};
      for (const l of data ?? []) {
        reste[l.commande_id] = (reste[l.commande_id] ?? 0) + (l.quantite_restante_a_recevoir ?? 0);
        const m = l.montant_ht_commande != null ? l.montant_ht_commande : (l.quantite_commandee ?? 0) * (l.pu_commande ?? 0);
        montant[l.commande_id] = (montant[l.commande_id] ?? 0) + m;
      }
      return { reste, montant };
    },
    enabled: pageIds.length > 0,
    staleTime: 30_000,
  });
  const resteParCommande = aggParCommande.reste;
  const montantParCommande = aggParCommande.montant;

  const changeStatutMutation = useMutation({
    mutationFn: async ({ cmdId, statut }: { cmdId: string; statut: string }) => {
      const { error } = await supabase.from('commandes').update({ statut_commande: statut }).eq('id', cmdId);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['commandes'] }),
    onError: (e: Error) => toast.error(e.message),
  });

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
      clearSelection();
      setConfirmBulkDelete(false);
      toast.success(`${count} commande${count > 1 ? 's' : ''} supprimée${count > 1 ? 's' : ''}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const lookupPrix = async (ref: string, fournisseur: string) => {
    if (!ref.trim() || !fournisseur) { setPrixSuggere(null); return; }
    const { data } = await supabase
      .from('prix_reference')
      .select('pu_last, designation')
      .eq('reference_article', ref.trim())
      .ilike('fournisseur', `%${fournisseur.slice(0, 5)}%`)
      .maybeSingle();
    if (data) {
      setPrixSuggere({ pu: data.pu_last, designation: data.designation });
      setNewLigne(prev => ({
        ...prev,
        pu_commande: prev.pu_commande || String(data.pu_last),
        designation: prev.designation || data.designation || '',
      }));
    } else {
      setPrixSuggere(null);
    }
  };

  const handleAddLigne = () => {
    if (!newLigne.reference_article.trim()) return;
    setLignesForm([...lignesForm, newLigne]);
    setNewLigne({ reference_article: '', designation: '', quantite_commandee: '', pu_commande: '' });
    setPrixSuggere(null);
  };

  return (
    <div>
      <PageHeader
        title="Commandes"
        subtitle={`${totalCount} commande${totalCount > 1 ? 's' : ''}`}
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

      {isError && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          Erreur lors du chargement des commandes. Vérifiez votre connexion.
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
          <Input
            placeholder="N° commande..."
            value={search}
            onChange={e => setFilter('q', e.target.value)}
            className="w-56 pl-8"
          />
        </div>
        <Input
          placeholder="Fournisseur..."
          value={filtreFournisseur}
          onChange={e => setFilter('fournisseur', e.target.value)}
          className="w-52"
        />
        <button
          onClick={() => {
            const params = new URLSearchParams(searchParams.toString());
            params.delete('page');
            if (filtreReliquats) params.delete('reliquats');
            else { params.set('reliquats', '1'); params.delete('statut'); }
            router.replace(`${pathname}?${params.toString()}`);
          }}
          className={cn(
            'flex items-center gap-1.5 h-9 px-3 rounded-lg border text-xs font-medium transition-colors',
            filtreReliquats
              ? 'bg-orange-100 border-orange-300 text-orange-700'
              : 'border-gray-200 text-gray-500 hover:border-orange-300 hover:text-orange-600'
          )}
        >
          <Package className="w-3.5 h-3.5" /> Reliquats
        </button>
        {(search || filtreStatut !== 'all' || filtreFournisseur || filtreReliquats || annee) && (
          <button onClick={() => router.replace(pathname)} className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1">
            <X className="w-3.5 h-3.5" /> Reset
          </button>
        )}
      </div>

      {/* Filtre période (puces année / mois) */}
      <div className="mb-4">
        <PeriodeChips annees={['2026', '2025']} annee={annee} mois={mois}
          onAnnee={(a) => setPeriode('annee', a)} onMois={(m) => setPeriode('mois', m)} />
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

      {isLoading && <TableSkeleton rows={8} cols={7} />}

      {!isLoading && <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
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
              <SortableHeader label="N° commande" field="numero_commande_interne" sortKey={sortKey} sortDir={sortDir} onSort={handleSortColumn} />
              <SortableHeader label="Fournisseur" field="fournisseur" sortKey={sortKey} sortDir={sortDir} onSort={handleSortColumn} />
              <SortableHeader label="Date" field="date_commande" sortKey={sortKey} sortDir={sortDir} onSort={handleSortColumn} />
              <SortableHeader label="Montant" field="montant_total_commande" sortKey={sortKey} sortDir={sortDir} onSort={handleSortColumn} align="right" />
              <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide text-right">Reste à recevoir</th>
              <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Statut</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {commandes.map(cmd => {
              const isSelected = selected.has(cmd.id);
              return (
                <tr
                  key={cmd.id}
                  className={`hover:bg-gray-50/50 cursor-pointer ${isSelected ? 'bg-indigo-50/30' : ''}`}
                  onClick={() => router.push(`/commandes/${cmd.id}`)}
                >
                  <td className="w-10 px-4 py-3" onClick={e => e.stopPropagation()}>
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
                  <td className="px-4 py-3 text-right font-mono">
                    {cmd.montant_total_commande != null
                      ? formatEur(cmd.montant_total_commande)
                      : montantParCommande[cmd.id]
                        ? <span title="Total calculé depuis les lignes (non encore figé en base)">{formatEur(montantParCommande[cmd.id])}</span>
                        : <span className="text-gray-300">—</span>}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {(() => {
                      const reste = resteParCommande[cmd.id];
                      if (reste === undefined) return <span className="text-gray-300 text-xs">—</span>;
                      if (reste <= 0) return <span style={{ color: '#059669', fontSize: '0.7rem', fontWeight: 600 }}>✓ Complet</span>;
                      return <span style={{ backgroundColor: '#fef3c7', color: '#92400e', borderColor: '#fbbf24', fontSize: '0.7rem', fontWeight: 600, padding: '2px 6px', borderRadius: 4, border: '1px solid' }}>{reste} art.</span>;
                    })()}
                  </td>
                  <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                    <div className="relative group/statut inline-block">
                      <StatusBadge status={cmd.statut_commande} />
                      <select
                        value={cmd.statut_commande}
                        onChange={e => changeStatutMutation.mutate({ cmdId: cmd.id, statut: e.target.value })}
                        onClick={e => e.stopPropagation()}
                        className="absolute inset-0 w-full opacity-0 cursor-pointer"
                      >
                        {STATUTS.map(s => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1" onClick={e => e.stopPropagation()}>
                      <button
                        className="p-1.5 rounded hover:bg-indigo-50 text-gray-400 hover:text-indigo-500 transition-colors"
                        title="Demander à Teddy"
                        onClick={() => window.dispatchEvent(new CustomEvent('teddy-ask', { detail: { prompt: `Analyse la commande ${cmd.numero_commande_interne} : lignes, statut, avancement livraison et anomalies éventuelles.` } }))}
                      >
                        <Bot className="w-3.5 h-3.5" />
                      </button>
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
        {commandes.length === 0 && <EmptyState icon={ShoppingCart} title="Aucune commande" />}
        <Pagination page={page} pageSize={PAGE_SIZE} total={totalCount} onChange={setPage} />
      </div>}

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
                  <Input
                    value={newLigne.reference_article}
                    onChange={e => { setNewLigne({ ...newLigne, reference_article: e.target.value }); setPrixSuggere(null); }}
                    onBlur={e => lookupPrix(e.target.value, form.fournisseur)}
                    placeholder="Réf. *"
                    className="text-xs h-8"
                  />
                  <Input value={newLigne.designation} onChange={e => setNewLigne({ ...newLigne, designation: e.target.value })} placeholder="Désignation" className="text-xs h-8" />
                  <Input type="number" value={newLigne.quantite_commandee} onChange={e => setNewLigne({ ...newLigne, quantite_commandee: e.target.value })} placeholder="Qté" className="text-xs h-8" />
                  <Input
                    type="number"
                    step="0.01"
                    value={newLigne.pu_commande}
                    onChange={e => setNewLigne({ ...newLigne, pu_commande: e.target.value })}
                    placeholder="PU €"
                    className={`text-xs h-8 ${prixSuggere && newLigne.pu_commande && parseFloat(newLigne.pu_commande) !== prixSuggere.pu ? 'border-amber-400 focus:ring-amber-400' : ''}`}
                  />
                </div>
                {prixSuggere && (
                  <p className="text-xs mt-1 text-gray-400">
                    Dernier prix connu : <span className="font-semibold text-gray-600">{prixSuggere.pu.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' })}</span>
                    {newLigne.pu_commande && parseFloat(newLigne.pu_commande) !== prixSuggere.pu && (
                      <span className="ml-2 text-amber-600 font-medium">⚠ prix modifié</span>
                    )}
                  </p>
                )}
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

export default function CommandesPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-gray-400">Chargement...</div>}>
      <CommandesPageInner />
    </Suspense>
  );
}
