'use client';

import { useState, useMemo, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/lib/supabase';
import PageHeader from '@/components/shared/PageHeader';
import StatusBadge from '@/components/shared/StatusBadge';
import EmptyState from '@/components/shared/EmptyState';
import Pagination from '@/components/shared/Pagination';
import { formatEur, formatDate, cn } from '@/utils';
import { Link2, CheckCircle2, XCircle, RotateCcw } from 'lucide-react';
import type { Rapprochement, Facture, BEReception, Commande, StatutValidation } from '@/types';
import Link from 'next/link';

const PAGE_SIZE = 50;

interface PatchPayload {
  rapId: string;
  statut: StatutValidation;
  factureId: string;
}

interface PatchResponse {
  ok: boolean;
  taux_rapprochement: number;
  statut_facture: string;
}

async function patchRapprochement(payload: PatchPayload): Promise<PatchResponse> {
  const res = await fetch('/api/rapprochements', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error('Erreur lors de la mise à jour');
  return res.json() as Promise<PatchResponse>;
}

export default function RapproPage() {
  const [page, setPage] = useState(1);
  const [filterStatut, setFilterStatut] = useState('all');
  const queryClient = useQueryClient();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // IMPORTANT : activer la Replication Supabase pour la table rapprochements dans
  // Database → Replication du dashboard Supabase (sinon les events ne sont pas émis).
  useEffect(() => {
    const channel = supabase
      .channel('rapprochements-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rapprochements' }, () => {
        clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => queryClient.invalidateQueries({ queryKey: ['rapprochements'] }), 200);
      })
      .subscribe();

    return () => {
      clearTimeout(debounceRef.current);
      void supabase.removeChannel(channel);
    };
  }, [queryClient]);

  const { data: rapsResult, isError } = useQuery<{ rapprochements: Rapprochement[]; total: number }>({
    queryKey: ['rapprochements', page, filterStatut],
    queryFn: async () => {
      let query = supabase
        .from('rapprochements')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false });

      if (filterStatut !== 'all') {
        query = query.eq('statut_validation', filterStatut);
      }

      query = query.range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);

      const { data, count } = await query;
      return { rapprochements: data ?? [], total: count ?? 0 };
    },
    staleTime: 30_000,
  });

  const raps = rapsResult?.rapprochements ?? [];
  const total = rapsResult?.total ?? 0;

  const { data: factures = [] } = useQuery<Pick<Facture, 'id' | 'numero_facture' | 'fournisseur'>[]>({
    queryKey: ['factures-slim'],
    queryFn: async () => {
      const { data } = await supabase.from('factures').select('id,numero_facture,fournisseur').limit(500);
      return (data ?? []) as Pick<Facture, 'id' | 'numero_facture' | 'fournisseur'>[];
    },
    staleTime: 30000,
  });

  const { data: bes = [] } = useQuery<Pick<BEReception, 'id' | 'numero_be'>[]>({
    queryKey: ['bes-slim'],
    queryFn: async () => {
      const { data } = await supabase.from('be_receptions').select('id,numero_be').limit(500);
      return (data ?? []) as Pick<BEReception, 'id' | 'numero_be'>[];
    },
    staleTime: 30000,
  });

  const { data: commandes = [] } = useQuery<Pick<Commande, 'id' | 'numero_commande_interne'>[]>({
    queryKey: ['commandes-slim'],
    queryFn: async () => {
      const { data } = await supabase.from('commandes').select('id,numero_commande_interne').limit(500);
      return (data ?? []) as Pick<Commande, 'id' | 'numero_commande_interne'>[];
    },
    staleTime: 30000,
  });

  const factureMap = useMemo(
    () => Object.fromEntries(factures.map(f => [f.id, f])) as Record<string, Pick<Facture, 'id' | 'numero_facture' | 'fournisseur'>>,
    [factures],
  );
  const beMap = useMemo(
    () => Object.fromEntries(bes.map(b => [b.id, b])) as Record<string, Pick<BEReception, 'id' | 'numero_be'>>,
    [bes],
  );
  const cmdMap = useMemo(
    () => Object.fromEntries(commandes.map(c => [c.id, c])) as Record<string, Pick<Commande, 'id' | 'numero_commande_interne'>>,
    [commandes],
  );

  const onSuccess = () => {
    void queryClient.invalidateQueries({ queryKey: ['rapprochements'] });
  };

  const validateMutation = useMutation<PatchResponse, Error, PatchPayload>({
    mutationFn: patchRapprochement,
    onSuccess: (data) => {
      onSuccess();
      toast.success(`Rapprochement validé — taux facture : ${data.taux_rapprochement}%`);
    },
    onError: () => toast.error('Impossible de valider le rapprochement'),
  });

  const rejectMutation = useMutation<PatchResponse, Error, PatchPayload>({
    mutationFn: patchRapprochement,
    onSuccess: () => {
      onSuccess();
      toast.success('Rapprochement rejeté');
    },
    onError: () => toast.error('Impossible de rejeter le rapprochement'),
  });

  const reviewMutation = useMutation<PatchResponse, Error, PatchPayload>({
    mutationFn: patchRapprochement,
    onSuccess: () => {
      onSuccess();
      toast.success('Rapprochement remis à revoir');
    },
    onError: () => toast.error('Impossible de remettre à revoir'),
  });

  const isMutating = validateMutation.isPending || rejectMutation.isPending || reviewMutation.isPending;

  function formatScore(score: number | null): string | null {
    if (score === null) return null;
    if (score >= 1) return `${score}%`;
    return `${(score * 100).toFixed(0)}%`;
  }

  function scoreColor(score: number | null): string {
    if (score === null) return '';
    const pct = score >= 1 ? score : score * 100;
    if (pct >= 80) return 'text-emerald-600';
    if (pct >= 50) return 'text-amber-600';
    return 'text-red-500';
  }

  return (
    <div>
      <PageHeader title="Rapprochements" subtitle={`${total} rapprochement${total > 1 ? 's' : ''}`} />

      {isError && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          Erreur lors du chargement des rapprochements.
        </div>
      )}

      <div className="flex gap-3 mb-4">
        {['all', 'proposé', 'validé', 'rejeté', 'à revoir'].map(s => (
          <button
            key={s}
            onClick={() => { setFilterStatut(s); setPage(1); }}
            className={cn(
              'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
              filterStatut === s ? 'bg-indigo-600 text-white' : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50',
            )}
          >
            {s === 'all' ? 'Tous' : s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>

      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50/50 border-b border-gray-100">
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Facture</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">BE</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Commande</th>
              <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Montant</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Mode</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Score</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Statut</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Date</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {raps.map(r => (
              <tr key={r.id} className="hover:bg-gray-50/30">
                <td className="px-4 py-3 text-xs">
                  {r.facture_id && factureMap[r.facture_id] && (
                    <>
                      <Link href={`/factures/${r.facture_id}`} className="text-indigo-600 hover:underline font-mono">
                        {factureMap[r.facture_id].numero_facture}
                      </Link>
                      {factureMap[r.facture_id].fournisseur && (
                        <div className="text-xs text-gray-400">{factureMap[r.facture_id].fournisseur}</div>
                      )}
                    </>
                  )}
                </td>
                <td className="px-4 py-3 text-xs">
                  {r.be_id && beMap[r.be_id] && (
                    <Link href={`/be-receptions/${r.be_id}`} className="text-indigo-600 hover:underline font-mono">
                      {beMap[r.be_id].numero_be}
                    </Link>
                  )}
                </td>
                <td className="px-4 py-3 text-xs">
                  {r.commande_id && cmdMap[r.commande_id] && (
                    <Link href={`/commandes/${r.commande_id}`} className="text-indigo-600 hover:underline font-mono">
                      {cmdMap[r.commande_id].numero_commande_interne}
                    </Link>
                  )}
                </td>
                <td className="px-4 py-3 text-right font-mono text-xs">{formatEur(r.montant_rapproche)}</td>
                <td className="px-4 py-3 text-xs text-gray-500">{r.mode_match?.replace('automatique_', 'auto ') ?? '—'}</td>
                <td className="px-4 py-3 text-xs font-mono">
                  {r.score_match !== null ? (
                    <span className={scoreColor(r.score_match)}>{formatScore(r.score_match)}</span>
                  ) : (
                    <span className="text-gray-300">—</span>
                  )}
                </td>
                <td className="px-4 py-3"><StatusBadge status={r.statut_validation} /></td>
                <td className="px-4 py-3 text-xs text-gray-500">{formatDate(r.created_at)}</td>
                <td className="px-4 py-3">
                  {r.statut_validation === 'proposé' && r.facture_id && (
                    <div className="flex items-center gap-1">
                      <button
                        disabled={isMutating}
                        onClick={() => validateMutation.mutate({ rapId: r.id, statut: 'validé', factureId: r.facture_id! })}
                        title="Valider"
                        className="p-1 rounded text-emerald-600 hover:bg-emerald-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        disabled={isMutating}
                        onClick={() => rejectMutation.mutate({ rapId: r.id, statut: 'rejeté', factureId: r.facture_id! })}
                        title="Rejeter"
                        className="p-1 rounded text-red-500 hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      >
                        <XCircle className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                  {r.statut_validation === 'validé' && r.facture_id && (
                    <button
                      disabled={isMutating}
                      onClick={() => reviewMutation.mutate({ rapId: r.id, statut: 'à revoir', factureId: r.facture_id! })}
                      title="Remettre à revoir"
                      className="p-1 rounded text-gray-400 hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      <RotateCcw className="w-3 h-3" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {total === 0 && !isError && <EmptyState icon={Link2} title="Aucun rapprochement" />}
        <Pagination page={page} pageSize={PAGE_SIZE} total={total} onChange={setPage} />
      </div>
    </div>
  );
}
