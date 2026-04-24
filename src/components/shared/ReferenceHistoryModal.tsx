'use client';

import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { X, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { formatEur, formatDate, cn } from '@/utils';
import Link from 'next/link';

interface Props {
  reference: string;
  fournisseur?: string | null;
  onClose: () => void;
}

interface HistoryRow {
  id: string;
  commande_id: string;
  numero_commande_interne: string;
  date_commande: string | null;
  fournisseur: string | null;
  designation: string | null;
  quantite_commandee: number;
  pu_commande: number | null;
}

export default function ReferenceHistoryModal({ reference, fournisseur, onClose }: Props) {
  const { data: rows = [], isLoading } = useQuery<HistoryRow[]>({
    queryKey: ['ref_history', reference, fournisseur],
    queryFn: async () => {
      let q = supabase
        .from('lignes_commande')
        .select('id, commande_id, designation, quantite_commandee, pu_commande, commandes(numero_commande_interne, date_commande, fournisseur)')
        .eq('reference_article', reference)
        .order('created_at', { ascending: false })
        .limit(100);

      const { data } = await q;
      return (data ?? []).map((r: Record<string, unknown>) => {
        const cmd = r.commandes as Record<string, unknown> | null;
        return {
          id: r.id as string,
          commande_id: r.commande_id as string,
          numero_commande_interne: (cmd?.numero_commande_interne as string) ?? '—',
          date_commande: (cmd?.date_commande as string) ?? null,
          fournisseur: (cmd?.fournisseur as string) ?? null,
          designation: r.designation as string | null,
          quantite_commandee: r.quantite_commandee as number,
          pu_commande: r.pu_commande as number | null,
        };
      });
    },
  });

  const { data: prixActuel } = useQuery<number | null>({
    queryKey: ['prix_ref', reference, fournisseur],
    queryFn: async () => {
      let q = supabase.from('prix_reference').select('pu_last').eq('reference_article', reference);
      if (fournisseur) q = q.ilike('fournisseur', `%${fournisseur.slice(0, 5)}%`);
      const { data } = await q.maybeSingle();
      return data?.pu_last ?? null;
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between px-5 py-4 border-b border-gray-100 shrink-0">
          <div>
            <p className="text-xs text-gray-400 uppercase tracking-wide font-medium mb-0.5">Historique référence</p>
            <h2 className="text-lg font-bold text-gray-900 font-mono">{reference}</h2>
            {fournisseur && <p className="text-xs text-gray-500 mt-0.5">{fournisseur}</p>}
          </div>
          <div className="flex items-center gap-3">
            {prixActuel != null && (
              <div className="text-right">
                <p className="text-xs text-gray-400">Prix actuel</p>
                <p className="text-sm font-bold text-indigo-700">{formatEur(prixActuel)}</p>
              </div>
            )}
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Table */}
        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="flex items-center justify-center h-32 text-sm text-gray-400">Chargement…</div>
          ) : rows.length === 0 ? (
            <div className="flex items-center justify-center h-32 text-sm text-gray-400">Aucun historique trouvé</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-gray-50/90 backdrop-blur-sm">
                <tr className="border-b border-gray-100">
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500">Date</th>
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500">N° commande</th>
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500">Fournisseur</th>
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 max-w-[160px]">Désignation</th>
                  <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-500">Qté</th>
                  <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-500">PU €</th>
                  <th className="px-4 py-2.5 text-xs font-semibold text-gray-500">Évolution</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {rows.map((row, idx) => {
                  const nextRow = rows[idx + 1];
                  const prevPu = nextRow?.pu_commande ?? null;
                  const curPu = row.pu_commande;
                  let trend: 'up' | 'down' | 'same' | null = null;
                  let pct: number | null = null;
                  if (curPu != null && prevPu != null && prevPu !== 0) {
                    const diff = curPu - prevPu;
                    pct = Math.round((diff / prevPu) * 100);
                    trend = diff > 0 ? 'up' : diff < 0 ? 'down' : 'same';
                  }
                  return (
                    <tr key={row.id} className="hover:bg-gray-50/50">
                      <td className="px-4 py-2.5 text-xs text-gray-500 tabular-nums">{formatDate(row.date_commande)}</td>
                      <td className="px-4 py-2.5">
                        <Link
                          href={`/commandes/${row.commande_id}`}
                          className="font-mono text-xs font-medium text-indigo-600 hover:underline"
                          onClick={onClose}
                        >
                          #{row.numero_commande_interne}
                        </Link>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-gray-500">{row.fournisseur ?? '—'}</td>
                      <td className="px-4 py-2.5 text-xs text-gray-600 max-w-[160px] truncate">{row.designation ?? '—'}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-xs">{row.quantite_commandee}</td>
                      <td className={cn(
                        'px-4 py-2.5 text-right font-mono text-xs font-semibold',
                        trend === 'up' ? 'text-red-600' : trend === 'down' ? 'text-emerald-600' : 'text-gray-800'
                      )}>
                        {curPu != null ? formatEur(curPu) : '—'}
                      </td>
                      <td className="px-4 py-2.5">
                        {trend === 'same' && <Minus className="w-3.5 h-3.5 text-gray-300" />}
                        {trend === 'up' && (
                          <span className="inline-flex items-center gap-0.5 text-xs text-red-500 font-medium">
                            <TrendingUp className="w-3.5 h-3.5" /> +{pct}%
                          </span>
                        )}
                        {trend === 'down' && (
                          <span className="inline-flex items-center gap-0.5 text-xs text-emerald-600 font-medium">
                            <TrendingDown className="w-3.5 h-3.5" /> {pct}%
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="px-5 py-3 border-t border-gray-100 shrink-0">
          <p className="text-xs text-gray-400">{rows.length} occurrence{rows.length > 1 ? 's' : ''} — cliquer sur un N° commande pour y accéder</p>
        </div>
      </div>
    </div>
  );
}
