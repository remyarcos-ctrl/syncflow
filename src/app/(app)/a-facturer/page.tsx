'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import Link from 'next/link';
import PageHeader from '@/components/shared/PageHeader';
import StatusBadge from '@/components/shared/StatusBadge';
import EmptyState from '@/components/shared/EmptyState';
import { formatDate, formatEur } from '@/utils';
import { FileText, ChevronRight, Clock, CheckCircle2 } from 'lucide-react';
import type { BEReception } from '@/types';

interface BEAvecReste extends BEReception {
  jours: number;
  qte_restante: number;
}

function joursDepuis(dateStr: string): number {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24));
}

function urgenceColor(jours: number): string {
  if (jours >= 14) return '#dc2626';
  if (jours >= 7) return '#d97706';
  return '#6b7280';
}

export default function AFacturerPage() {
  const { data: bes = [], isLoading } = useQuery<BEAvecReste[]>({
    queryKey: ['a-facturer'],
    queryFn: async () => {
      const { data: beData } = await supabase
        .from('be_receptions')
        .select('*')
        .in('statut_be', ['reçu', 'partiellement facturé'])
        .order('created_at', { ascending: true });

      const beList = (beData ?? []) as BEReception[];
      if (beList.length === 0) return [];

      const ids = beList.map(b => b.id);
      const { data: lignesData } = await supabase
        .from('lignes_be')
        .select('be_id, quantite_restante_a_facturer')
        .in('be_id', ids)
        .gt('quantite_restante_a_facturer', 0);

      const resteMap = new Map<string, number>();
      for (const l of lignesData ?? []) {
        resteMap.set(l.be_id, (resteMap.get(l.be_id) ?? 0) + (l.quantite_restante_a_facturer ?? 0));
      }

      return beList.map(b => ({
        ...b,
        jours: joursDepuis(b.created_at),
        qte_restante: resteMap.get(b.id) ?? 0,
      }));
    },
    staleTime: 60_000,
  });

  // Group by fournisseur
  const byFournisseur = useMemo(() => {
    const map = new Map<string, BEAvecReste[]>();
    for (const be of bes) {
      const key = be.fournisseur ?? 'Fournisseur inconnu';
      const arr = map.get(key) ?? [];
      arr.push(be);
      map.set(key, arr);
    }
    return Array.from(map.entries()).sort((a, b) => {
      // Sort by oldest BE first
      const aMax = Math.max(...a[1].map(b => b.jours));
      const bMax = Math.max(...b[1].map(b => b.jours));
      return bMax - aMax;
    });
  }, [bes]);

  const stats = useMemo(() => ({
    total: bes.length,
    urgent: bes.filter(b => b.jours >= 14).length,
    avertissement: bes.filter(b => b.jours >= 7 && b.jours < 14).length,
  }), [bes]);

  return (
    <div>
      <PageHeader
        title="À facturer"
        subtitle={`${stats.total} BE${stats.total > 1 ? 's' : ''} en attente de facture`}
      />

      {/* KPIs */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
          <p className="text-xs text-gray-500 mb-1">BEs sans facture</p>
          <p className="text-2xl font-bold text-gray-900">{stats.total}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
          <p className="text-xs text-gray-500 mb-1">Urgents (&gt; 14 jours)</p>
          <p className="text-2xl font-bold" style={{ color: stats.urgent > 0 ? '#dc2626' : '#059669' }}>{stats.urgent}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
          <p className="text-xs text-gray-500 mb-1">À surveiller (7–14 j)</p>
          <p className="text-2xl font-bold" style={{ color: stats.avertissement > 0 ? '#d97706' : '#059669' }}>{stats.avertissement}</p>
        </div>
      </div>

      {/* Grouped by fournisseur */}
      <div className="space-y-4">
        {byFournisseur.map(([fournisseur, besList]) => (
          <div key={fournisseur} className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
            {/* Group header */}
            <div className="flex items-center justify-between px-4 py-3 bg-gray-50/50 border-b border-gray-100">
              <div className="flex items-center gap-3">
                <span className="font-semibold text-sm text-gray-900">{fournisseur}</span>
                <span className="text-xs text-gray-400">{besList.length} BE{besList.length > 1 ? 's' : ''}</span>
              </div>
              <div className="flex items-center gap-2">
                {besList.some(b => b.jours >= 14) && (
                  <span className="text-xs font-medium px-2 py-0.5 rounded-full" style={{ backgroundColor: '#fee2e2', color: '#dc2626' }}>
                    Urgent
                  </span>
                )}
              </div>
            </div>

            {/* BEs list */}
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-400 border-b border-gray-50">
                  <th className="px-4 py-2 text-left font-medium">N° BE</th>
                  <th className="px-4 py-2 text-left font-medium">Date BL</th>
                  <th className="px-4 py-2 text-left font-medium">Attente</th>
                  <th className="px-4 py-2 text-left font-medium">Qté restante à facturer</th>
                  <th className="px-4 py-2 text-left font-medium">Statut</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {besList.map(be => (
                  <tr key={be.id} className="hover:bg-gray-50/50">
                    <td className="px-4 py-3 font-medium font-mono text-xs">{be.numero_be}</td>
                    <td className="px-4 py-3 text-gray-500 text-xs">{formatDate(be.date_bl)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <Clock className="w-3.5 h-3.5 shrink-0" style={{ color: urgenceColor(be.jours) }} />
                        <span className="text-xs font-semibold" style={{ color: urgenceColor(be.jours) }}>
                          {be.jours}j
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {be.qte_restante > 0 ? (
                        <span className="text-xs font-semibold" style={{ color: '#d97706' }}>
                          {be.qte_restante} art.
                        </span>
                      ) : (
                        <span className="text-xs text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3"><StatusBadge status={be.statut_be} /></td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        {be.pdf_url && (
                          <a href={be.pdf_url} target="_blank" rel="noopener noreferrer" className="p-1.5 rounded hover:bg-blue-50 text-gray-400 hover:text-blue-500 transition-colors" title="PDF original">
                            <FileText className="w-3.5 h-3.5" />
                          </a>
                        )}
                        <Link href={`/be-receptions/${be.id}`} className="p-1.5 rounded hover:bg-gray-100">
                          <ChevronRight className="w-4 h-4 text-gray-400" />
                        </Link>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

        {!isLoading && bes.length === 0 && (
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm py-16 flex flex-col items-center justify-center text-gray-400">
            <CheckCircle2 className="w-10 h-10 mb-3" style={{ color: '#86efac' }} />
            <p className="text-sm font-medium text-gray-500">Tout est à jour</p>
            <p className="text-xs mt-1">Aucun BE en attente de facture</p>
          </div>
        )}
      </div>
    </div>
  );
}
