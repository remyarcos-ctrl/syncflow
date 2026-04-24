'use client';

import { useState, useMemo, useRef, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import Link from 'next/link';
import PageHeader from '@/components/shared/PageHeader';
import EmptyState from '@/components/shared/EmptyState';
import Pagination from '@/components/shared/Pagination';
import { Button } from '@/components/ui/button';
import { formatDate } from '@/utils';
import { AlertTriangle, TrendingUp, Package, FileText, CheckCircle2, Eye, XCircle, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import type { Exception, Facture, BEReception, Commande } from '@/types';
import { cn } from '@/utils';

const PAGE_SIZE = 50;

const TYPE_CONFIG: Record<string, { color: string; label: string }> = {
  'surfacturation quantité':  { color: 'text-red-600 bg-red-50',    label: 'Surfacturation Qté' },
  'réception incomplète':     { color: 'text-orange-600 bg-orange-50', label: 'Livraison partielle' },
  'écart prix':               { color: 'text-amber-600 bg-amber-50', label: 'Écart de prix' },
  'be introuvable':           { color: 'text-red-600 bg-red-50',    label: 'BE introuvable' },
  'ligne non rapprochée':     { color: 'text-gray-600 bg-gray-50',  label: 'Non rapprochée' },
  'prix commande manquant':   { color: 'text-blue-600 bg-blue-50',  label: 'Prix manquant' },
  'quantité incohérente':     { color: 'text-red-600 bg-red-50',    label: 'Qté incohérente' },
  'prix incohérent':          { color: 'text-amber-600 bg-amber-50',label: 'Prix incohérent' },
};

const PRIORITE_CONFIG: Record<string, string> = {
  haute:    'bg-red-100 text-red-700 border-red-200',
  moyenne:  'bg-orange-100 text-orange-700 border-orange-200',
  faible:   'bg-blue-100 text-blue-700 border-blue-200',
  critique: 'bg-red-200 text-red-800 border-red-300',
};

export default function ExceptionsPage() {
  const qc = useQueryClient();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [filterStatut, setFilterStatut] = useState('actives');
  const [filterType, setFilterType] = useState('all');
  const [filterPriorite, setFilterPriorite] = useState('all');
  const [showDetail, setShowDetail] = useState<Exception | null>(null);
  const [comment, setComment] = useState('');
  const [updating, setUpdating] = useState<string | null>(null);

  const { data: exceptionsResult = { exceptions: [], total: 0 }, isError } = useQuery<{ exceptions: Exception[]; total: number }>({
    queryKey: ['exceptions', page, filterStatut, filterType, filterPriorite],
    queryFn: async () => {
      let query = supabase
        .from('exceptions')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false });

      if (filterStatut === 'actives') query = query.in('statut_exception', ['ouverte', 'en cours']);
      else if (filterStatut === 'résolues') query = query.in('statut_exception', ['résolue', 'ignorée']);

      if (filterType !== 'all') query = query.eq('type_exception', filterType);
      if (filterPriorite !== 'all') query = query.eq('niveau_priorite', filterPriorite);

      query = query.range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);

      const { data, count } = await query;
      return { exceptions: data ?? [], total: count ?? 0 };
    },
    staleTime: 30_000,
  });

  const { exceptions, total } = exceptionsResult;

  // Separate lightweight query for KPI counts (always active exceptions)
  const { data: kpiData = { total: 0, haute: 0, prixEcart: 0, qteEcart: 0 } } = useQuery<{ total: number; haute: number; prixEcart: number; qteEcart: number }>({
    queryKey: ['exceptions-kpis'],
    queryFn: async () => {
      const { data } = await supabase
        .from('exceptions')
        .select('type_exception, niveau_priorite')
        .in('statut_exception', ['ouverte', 'en cours']);
      const rows = data ?? [];
      return {
        total: rows.length,
        haute: rows.filter(e => ['haute', 'critique'].includes(e.niveau_priorite)).length,
        prixEcart: rows.filter(e => e.type_exception === 'écart prix').length,
        qteEcart: rows.filter(e => ['surfacturation quantité', 'réception incomplète', 'quantité incohérente'].includes(e.type_exception)).length,
      };
    },
    staleTime: 30_000,
  });

  useEffect(() => {
    const channel = supabase
      .channel('exceptions-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'exceptions' }, () => {
        clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
          void qc.invalidateQueries({ queryKey: ['exceptions'] });
          void qc.invalidateQueries({ queryKey: ['exceptions-kpis'] });
        }, 200);
      })
      .subscribe();
    return () => {
      clearTimeout(debounceRef.current);
      void supabase.removeChannel(channel);
    };
  }, [qc]);

  const { data: factures = [] } = useQuery<Pick<Facture, 'id' | 'numero_facture'>[]>({
    queryKey: ['factures-slim'],
    queryFn: async () => { const { data } = await supabase.from('factures').select('id,numero_facture').limit(500); return (data ?? []) as Pick<Facture, 'id' | 'numero_facture'>[]; },
    staleTime: 30000,
  });

  const { data: bes = [] } = useQuery<Pick<BEReception, 'id' | 'numero_be'>[]>({
    queryKey: ['bes-slim'],
    queryFn: async () => { const { data } = await supabase.from('be_receptions').select('id,numero_be').limit(500); return (data ?? []) as Pick<BEReception, 'id' | 'numero_be'>[]; },
    staleTime: 30000,
  });

  const { data: commandes = [] } = useQuery<Pick<Commande, 'id' | 'numero_commande_interne'>[]>({
    queryKey: ['commandes-slim'],
    queryFn: async () => { const { data } = await supabase.from('commandes').select('id,numero_commande_interne').limit(500); return (data ?? []) as Pick<Commande, 'id' | 'numero_commande_interne'>[]; },
    staleTime: 30000,
  });

  const factureMap = useMemo(() => Object.fromEntries(factures.map(f => [f.id, f])) as Record<string, Pick<Facture, 'id' | 'numero_facture'>>, [factures]);
  const beMap = useMemo(() => Object.fromEntries(bes.map(b => [b.id, b])) as Record<string, Pick<BEReception, 'id' | 'numero_be'>>, [bes]);
  const cmdMap = useMemo(() => Object.fromEntries(commandes.map(c => [c.id, c])) as Record<string, Pick<Commande, 'id' | 'numero_commande_interne'>>, [commandes]);

  const updateStatut = async (exc: Exception, statut: Exception['statut_exception']) => {
    setUpdating(exc.id);
    try {
      const { error } = await supabase.from('exceptions').update({
        statut_exception: statut,
        commentaire: comment || exc.commentaire,
      }).eq('id', exc.id);
      if (error) throw error;
      qc.invalidateQueries({ queryKey: ['exceptions'] });
      qc.invalidateQueries({ queryKey: ['exceptions-kpis'] });
      setShowDetail(null);
      setComment('');
      toast.success(`Exception ${statut}`);
    } catch (e) {
      console.error(e);
      toast.error('Erreur lors de la mise à jour');
    } finally {
      setUpdating(null);
    }
  };

  return (
    <div>
      <PageHeader
        title="Anomalies / Exceptions"
        subtitle={`${kpiData.total} exception${kpiData.total > 1 ? 's' : ''} active${kpiData.total > 1 ? 's' : ''}`}
      />

      {isError && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          Erreur lors du chargement des exceptions.
        </div>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-4 gap-4 mb-5">
        {[
          { label: 'Actives', value: kpiData.total, color: 'text-gray-900' },
          { label: 'Haute priorité', value: kpiData.haute, color: 'text-red-600' },
          { label: 'Écarts prix', value: kpiData.prixEcart, color: 'text-amber-600' },
          { label: 'Écarts quantité', value: kpiData.qteEcart, color: 'text-orange-600' },
        ].map(k => (
          <div key={k.label} className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
            <p className="text-xs text-gray-500">{k.label}</p>
            <p className={`text-2xl font-bold mt-1 ${k.color}`}>{k.value}</p>
          </div>
        ))}
      </div>

      {/* Filtres */}
      <div className="flex gap-3 mb-4 flex-wrap items-center">
        {['actives', 'résolues', 'toutes'].map(s => (
          <button key={s} onClick={() => { setFilterStatut(s); setPage(1); }}
            className={cn('px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
              filterStatut === s ? 'bg-indigo-600 text-white' : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50')}>
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
        <select value={filterType} onChange={e => { setFilterType(e.target.value); setPage(1); }}
          className="h-9 rounded-lg border border-gray-200 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
          <option value="all">Tous les types</option>
          {Object.keys(TYPE_CONFIG).map(t => <option key={t} value={t}>{TYPE_CONFIG[t].label}</option>)}
        </select>
        <select value={filterPriorite} onChange={e => { setFilterPriorite(e.target.value); setPage(1); }}
          className="h-9 rounded-lg border border-gray-200 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
          <option value="all">Toutes priorités</option>
          {['faible', 'moyenne', 'haute', 'critique'].map(p => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50/50 border-b border-gray-100">
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Type</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Priorité</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Motif</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Facture</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">BE</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Date</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Statut</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {exceptions.map(exc => {
              const tc = TYPE_CONFIG[exc.type_exception] ?? { color: 'text-gray-600 bg-gray-50', label: exc.type_exception };
              return (
                <tr key={exc.id} className={cn('hover:bg-gray-50/50', ['haute', 'critique'].includes(exc.niveau_priorite) ? 'border-l-2 border-l-red-400' : exc.niveau_priorite === 'moyenne' ? 'border-l-2 border-l-orange-300' : '')}>
                  <td className="px-4 py-3">
                    <span className={cn('text-xs font-medium px-2 py-0.5 rounded-full', tc.color)}>{tc.label}</span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={cn('text-xs font-medium px-2 py-0.5 rounded-full border', PRIORITE_CONFIG[exc.niveau_priorite] ?? '')}>{exc.niveau_priorite}</span>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-700 max-w-[200px] truncate">{exc.motif}</td>
                  <td className="px-4 py-3 text-xs">
                    {exc.facture_id && factureMap[exc.facture_id] && (
                      <Link href={`/factures/${exc.facture_id}`} className="text-indigo-600 hover:underline">{factureMap[exc.facture_id].numero_facture}</Link>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {exc.be_id && beMap[exc.be_id] && (
                      <Link href={`/be-receptions/${exc.be_id}`} className="text-indigo-600 hover:underline">{beMap[exc.be_id].numero_be}</Link>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-500">{formatDate(exc.created_at)}</td>
                  <td className="px-4 py-3">
                    <span className={cn('text-xs px-1.5 py-0.5 rounded',
                      exc.statut_exception === 'résolue' ? 'bg-emerald-100 text-emerald-700' :
                      exc.statut_exception === 'en cours' ? 'bg-blue-100 text-blue-700' :
                      exc.statut_exception === 'ignorée' ? 'bg-gray-100 text-gray-500' :
                      'bg-red-50 text-red-600')}>
                      {exc.statut_exception}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      {['ouverte', 'en cours'].includes(exc.statut_exception) ? (
                        <>
                          <button
                            title="Résoudre"
                            disabled={updating === exc.id}
                            onClick={() => updateStatut(exc, 'résolue')}
                            className={cn(
                              'p-1.5 rounded text-emerald-600 hover:bg-emerald-50 transition-colors',
                              updating === exc.id && 'opacity-40 cursor-not-allowed',
                            )}
                          >
                            <CheckCircle2 className="w-3.5 h-3.5" />
                          </button>
                          <button
                            title="Ignorer"
                            disabled={updating === exc.id}
                            onClick={() => updateStatut(exc, 'ignorée')}
                            className={cn(
                              'p-1.5 rounded text-gray-400 hover:bg-gray-100 transition-colors',
                              updating === exc.id && 'opacity-40 cursor-not-allowed',
                            )}
                          >
                            <XCircle className="w-3.5 h-3.5" />
                          </button>
                          <button
                            title="Détail"
                            disabled={updating === exc.id}
                            onClick={() => { setShowDetail(exc); setComment(exc.commentaire ?? ''); }}
                            className={cn(
                              'p-1.5 rounded text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors',
                              updating === exc.id && 'opacity-40 cursor-not-allowed',
                            )}
                          >
                            <Eye className="w-3.5 h-3.5" />
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            title="Rouvrir"
                            disabled={updating === exc.id}
                            onClick={() => updateStatut(exc, 'ouverte')}
                            className={cn(
                              'p-1.5 rounded text-gray-400 hover:bg-gray-100 transition-colors',
                              updating === exc.id && 'opacity-40 cursor-not-allowed',
                            )}
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                          </button>
                          <button
                            title="Détail"
                            disabled={updating === exc.id}
                            onClick={() => { setShowDetail(exc); setComment(exc.commentaire ?? ''); }}
                            className={cn(
                              'p-1.5 rounded text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors',
                              updating === exc.id && 'opacity-40 cursor-not-allowed',
                            )}
                          >
                            <Eye className="w-3.5 h-3.5" />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {exceptions.length === 0 && <EmptyState icon={AlertTriangle} title="Aucune exception" description="Aucune anomalie détectée" />}
        <Pagination page={page} pageSize={PAGE_SIZE} total={total} onChange={setPage} />
      </div>

      {/* Modale détail */}
      {showDetail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-md">
            <div className="flex items-center gap-2 mb-3">
              <AlertTriangle className="w-4 h-4 text-amber-500" />
              <h2 className="text-base font-semibold text-gray-900">{TYPE_CONFIG[showDetail.type_exception]?.label ?? showDetail.type_exception}</h2>
              <span className={cn('text-xs px-2 py-0.5 rounded-full border ml-auto', PRIORITE_CONFIG[showDetail.niveau_priorite] ?? '')}>{showDetail.niveau_priorite}</span>
            </div>
            <p className="text-sm text-gray-700 mb-3">{showDetail.motif}</p>
            <div className="grid grid-cols-2 gap-3 text-xs text-gray-500 mb-4">
              {showDetail.facture_id && factureMap[showDetail.facture_id] && <div><p className="text-gray-400">Facture</p><Link href={`/factures/${showDetail.facture_id}`} className="text-indigo-600 hover:underline">{factureMap[showDetail.facture_id].numero_facture}</Link></div>}
              {showDetail.be_id && beMap[showDetail.be_id] && <div><p className="text-gray-400">BE</p><Link href={`/be-receptions/${showDetail.be_id}`} className="text-indigo-600 hover:underline">{beMap[showDetail.be_id].numero_be}</Link></div>}
              {showDetail.commande_id && cmdMap[showDetail.commande_id] && <div><p className="text-gray-400">Commande</p><Link href={`/commandes/${showDetail.commande_id}`} className="text-indigo-600 hover:underline">{cmdMap[showDetail.commande_id].numero_commande_interne}</Link></div>}
            </div>
            <textarea
              value={comment}
              onChange={e => setComment(e.target.value)}
              placeholder="Commentaire / note de résolution..."
              className="w-full border border-gray-200 rounded-lg p-2 text-sm resize-none h-20 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            {['ouverte', 'en cours'].includes(showDetail.statut_exception) && (
              <div className="flex gap-2 mt-3">
                <Button size="sm" onClick={() => updateStatut(showDetail, 'résolue')} className="flex-1">
                  <CheckCircle2 className="w-4 h-4" /> Résoudre
                </Button>
                <Button variant="outline" size="sm" onClick={() => updateStatut(showDetail, 'en cours')}>En cours</Button>
                <Button variant="ghost" size="sm" onClick={() => updateStatut(showDetail, 'ignorée')}>Ignorer</Button>
              </div>
            )}
            <Button variant="outline" className="w-full mt-2" size="sm" onClick={() => setShowDetail(null)}>Fermer</Button>
          </div>
        </div>
      )}
    </div>
  );
}
