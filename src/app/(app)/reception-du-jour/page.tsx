'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import Link from 'next/link';
import PageHeader from '@/components/shared/PageHeader';
import StatusBadge from '@/components/shared/StatusBadge';
import EmptyState from '@/components/shared/EmptyState';
import { formatDate } from '@/utils';
import { Truck, CheckCircle2, AlertCircle, FileText, ChevronRight } from 'lucide-react';
import type { BEReception } from '@/types';

interface BEWithLines extends BEReception {
  total_lignes: number;
  lignes_liees: number;
}

export default function ReceptionDuJourPage() {
  const today = new Date().toISOString().slice(0, 10);

  const { data: bes = [], isLoading } = useQuery<BEWithLines[]>({
    queryKey: ['reception-du-jour', today],
    queryFn: async () => {
      const { data: beData } = await supabase
        .from('be_receptions')
        .select('*')
        .gte('created_at', `${today}T00:00:00`)
        .lte('created_at', `${today}T23:59:59`)
        .order('created_at', { ascending: false });

      const beList = (beData ?? []) as BEReception[];
      if (beList.length === 0) return [];

      const ids = beList.map(b => b.id);
      const { data: lignesData } = await supabase
        .from('lignes_be')
        .select('be_id, ligne_commande_id')
        .in('be_id', ids);

      const statsMap = new Map<string, { total: number; liees: number }>();
      for (const l of lignesData ?? []) {
        const s = statsMap.get(l.be_id) ?? { total: 0, liees: 0 };
        s.total += 1;
        if (l.ligne_commande_id) s.liees += 1;
        statsMap.set(l.be_id, s);
      }

      return beList.map(b => ({
        ...b,
        total_lignes: statsMap.get(b.id)?.total ?? 0,
        lignes_liees: statsMap.get(b.id)?.liees ?? 0,
      }));
    },
    staleTime: 30_000,
  });

  const stats = useMemo(() => ({
    total: bes.length,
    lies: bes.filter(b => b.commande_id).length,
    nonLies: bes.filter(b => !b.commande_id).length,
    totalLignes: bes.reduce((s, b) => s + b.total_lignes, 0),
    lignesLiees: bes.reduce((s, b) => s + b.lignes_liees, 0),
  }), [bes]);

  return (
    <div>
      <PageHeader
        title="Réception du jour"
        subtitle={`${today} · ${stats.total} BE${stats.total > 1 ? 's' : ''} importé${stats.total > 1 ? 's' : ''} aujourd'hui`}
      />

      {/* KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
          <p className="text-xs text-gray-500 mb-1">BEs du jour</p>
          <p className="text-2xl font-bold text-gray-900">{stats.total}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
          <p className="text-xs text-gray-500 mb-1">Liés à une commande</p>
          <p className="text-2xl font-bold" style={{ color: '#059669' }}>{stats.lies}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
          <p className="text-xs text-gray-500 mb-1">Non liés</p>
          <p className="text-2xl font-bold" style={{ color: stats.nonLies > 0 ? '#d97706' : '#059669' }}>{stats.nonLies}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
          <p className="text-xs text-gray-500 mb-1">Lignes attribuées</p>
          <p className="text-2xl font-bold text-gray-900">
            {stats.lignesLiees}<span className="text-sm font-normal text-gray-400">/{stats.totalLignes}</span>
          </p>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50/50 border-b border-gray-100">
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">N° BE</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Fournisseur</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Date BL</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Attribution</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Statut</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {bes.map(be => {
              const allLinked = be.total_lignes > 0 && be.lignes_liees === be.total_lignes;
              const noneLinked = be.lignes_liees === 0;
              return (
                <tr key={be.id} className="hover:bg-gray-50/50">
                  <td className="px-4 py-3 font-medium font-mono">
                    <div className="flex items-center gap-2">
                      {allLinked
                        ? <CheckCircle2 className="w-4 h-4 shrink-0" style={{ color: '#059669' }} />
                        : noneLinked
                          ? <AlertCircle className="w-4 h-4 shrink-0" style={{ color: '#d97706' }} />
                          : <AlertCircle className="w-4 h-4 shrink-0" style={{ color: '#6366f1' }} />
                      }
                      {be.numero_be}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{be.fournisseur || '—'}</td>
                  <td className="px-4 py-3 text-gray-500">{formatDate(be.date_bl)}</td>
                  <td className="px-4 py-3">
                    {be.total_lignes === 0 ? (
                      <span className="text-xs text-gray-400">Aucune ligne</span>
                    ) : (
                      <div className="flex items-center gap-2">
                        <div className="flex-1 bg-gray-100 rounded-full h-1.5 w-20 overflow-hidden">
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${Math.round((be.lignes_liees / be.total_lignes) * 100)}%`,
                              backgroundColor: allLinked ? '#059669' : '#6366f1',
                            }}
                          />
                        </div>
                        <span className="text-xs text-gray-500 whitespace-nowrap">
                          {be.lignes_liees}/{be.total_lignes} lignes
                        </span>
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3"><StatusBadge status={be.statut_be} /></td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      {be.pdf_url && (
                        <a href={be.pdf_url} target="_blank" rel="noopener noreferrer" className="p-1.5 rounded hover:bg-blue-50 text-gray-400 hover:text-blue-500 transition-colors" title="Voir le PDF">
                          <FileText className="w-3.5 h-3.5" />
                        </a>
                      )}
                      <Link href={`/be-receptions/${be.id}`} className="p-1.5 rounded hover:bg-gray-100">
                        <ChevronRight className="w-4 h-4 text-gray-400" />
                      </Link>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!isLoading && bes.length === 0 && (
          <EmptyState icon={Truck} title="Aucun BE importé aujourd'hui" description="Les BEs importés aujourd'hui apparaîtront ici automatiquement." />
        )}
      </div>
    </div>
  );
}
