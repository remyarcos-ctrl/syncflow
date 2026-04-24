'use client';

import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import PageHeader from '@/components/shared/PageHeader';
import EmptyState from '@/components/shared/EmptyState';
import Pagination from '@/components/shared/Pagination';
import { Input } from '@/components/ui/input';
import { ClipboardList, Search } from 'lucide-react';
import { formatDate } from '@/utils';
import { cn } from '@/utils';
import type { JournalActivite } from '@/types';

const PAGE_SIZE = 50;

const ACTION_COLORS: Record<string, string> = {
  Import: 'bg-blue-50 text-blue-700 border-blue-200',
  Création: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  Validation: 'bg-green-50 text-green-700 border-green-200',
  Rejet: 'bg-red-50 text-red-700 border-red-200',
  Résolution: 'bg-purple-50 text-purple-700 border-purple-200',
  Modification: 'bg-amber-50 text-amber-700 border-amber-200',
};

function getActionColor(type: string | null | undefined): string {
  if (!type) return 'bg-gray-50 text-gray-700 border-gray-200';
  for (const [key, cls] of Object.entries(ACTION_COLORS)) {
    if (type.includes(key)) return cls;
  }
  return 'bg-gray-50 text-gray-700 border-gray-200';
}

export default function JournalPage() {
  const [search, setSearch] = useState('');
  const [filterType, setFilterType] = useState('all');
  const [page, setPage] = useState(1);

  const { data: journal = [] } = useQuery<JournalActivite[]>({
    queryKey: ['journal'],
    queryFn: async () => {
      const { data } = await supabase.from('journal_activite').select('*').order('created_at', { ascending: false }).limit(500);
      return data ?? [];
    },
    refetchInterval: 5000,
  });

  const actionTypes = useMemo(() => [...new Set(journal.map(e => e.type_action).filter(Boolean))].sort(), [journal]);

  const filtered = useMemo(() => journal.filter(e => {
    if (filterType !== 'all' && e.type_action !== filterType) return false;
    if (search) {
      const q = search.toLowerCase();
      return (
        e.type_action?.toLowerCase().includes(q) ||
        e.utilisateur?.toLowerCase().includes(q) ||
        e.details_action?.toLowerCase().includes(q)
      );
    }
    return true;
  }), [journal, filterType, search]);

  const paginated = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div>
      <PageHeader title="Journal d'activité" subtitle={`${journal.length} entrée${journal.length > 1 ? 's' : ''}`} />

      <div className="flex gap-3 mb-4 flex-wrap items-center">
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 w-4 h-4 text-gray-400" />
          <Input placeholder="Rechercher..." value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} className="w-64 pl-8" />
        </div>
        <select value={filterType} onChange={e => { setFilterType(e.target.value); setPage(1); }}
          className="h-9 rounded-lg border border-gray-200 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
          <option value="all">Toutes les actions</option>
          {actionTypes.map(t => <option key={t!} value={t!}>{t}</option>)}
        </select>
      </div>

      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50/50 border-b border-gray-100">
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Date</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Action</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Utilisateur</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Détails</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {paginated.map(entry => (
              <tr key={entry.id} className="hover:bg-gray-50/30">
                <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{formatDate(entry.created_at)}</td>
                <td className="px-4 py-3">
                  <span className={cn('text-xs font-medium px-2 py-0.5 rounded-full border', getActionColor(entry.type_action))}>
                    {entry.type_action ?? '—'}
                  </span>
                </td>
                <td className="px-4 py-3 text-xs text-gray-600">{entry.utilisateur ?? '—'}</td>
                <td className="px-4 py-3 text-xs text-gray-600 max-w-[350px] truncate">{entry.details_action ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && <EmptyState icon={ClipboardList} title="Aucune activité" />}
        <Pagination page={page} pageSize={PAGE_SIZE} total={filtered.length} onChange={setPage} />
      </div>
    </div>
  );
}
