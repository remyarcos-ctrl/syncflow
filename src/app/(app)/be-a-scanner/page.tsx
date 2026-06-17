'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDate, cn } from '@/utils';
import { ScanLine, ChevronRight, CheckCircle2, PackageX } from 'lucide-react';

interface Commande {
  id: string;
  numero_commande_interne: string;
  fournisseur: string | null;
  date_commande: string | null;
  statut_commande: string | null;
}
interface LigneRecu {
  commande_id: string;
  quantite_receptionnee_reelle: number | null;
}

const normNum = (s: string | null | undefined): string =>
  String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const statutBadge = (s: string | null): string => {
  switch (s) {
    case 'en anomalie': return 'bg-red-50 text-red-700';
    case 'réceptionnée': return 'bg-emerald-50 text-emerald-700';
    case 'partiellement réceptionnée': return 'bg-amber-50 text-amber-700';
    default: return 'bg-gray-100 text-gray-600';
  }
};

export default function BeAScannerPage() {
  const { data: commandes = [], isLoading: l1 } = useQuery<Commande[]>({
    queryKey: ['bas_commandes'],
    queryFn: async () => {
      const { data } = await supabase
        .from('commandes')
        .select('id, numero_commande_interne, fournisseur, date_commande, statut_commande');
      return data ?? [];
    },
    refetchInterval: 15000,
  });

  const { data: lignes = [], isLoading: l2 } = useQuery<LigneRecu[]>({
    queryKey: ['bas_lignes'],
    queryFn: async () => {
      const { data } = await supabase
        .from('lignes_commande')
        .select('commande_id, quantite_receptionnee_reelle');
      return (data as LigneRecu[]) ?? [];
    },
    refetchInterval: 15000,
  });

  const { data: saisies = [], isLoading: l3 } = useQuery<{ commande_ref: string | null }[]>({
    queryKey: ['bas_saisies'],
    queryFn: async () => {
      const { data } = await supabase.from('saisies_cl').select('commande_ref');
      return data ?? [];
    },
    refetchInterval: 15000,
  });

  const { aScanner, nbCouvert } = useMemo(() => {
    // Reçu total ③ par commande
    const recuByCmd = new Map<string, number>();
    for (const l of lignes) {
      recuByCmd.set(l.commande_id, (recuByCmd.get(l.commande_id) ?? 0) + (Number(l.quantite_receptionnee_reelle) || 0));
    }
    // Commandes ayant au moins un BE scanné (lien via commande_ref des saisies ②)
    const cmdAvecBE = new Set<string>();
    for (const s of saisies) if (s.commande_ref) cmdAvecBE.add(normNum(s.commande_ref));

    const enrichies = commandes.map((c) => ({
      ...c,
      recu: recuByCmd.get(c.id) ?? 0,
      aBE: cmdAvecBE.has(normNum(c.numero_commande_interne)),
    }));

    const aScanner = enrichies
      .filter((c) => c.recu > 0 && !c.aBE)
      .sort((a, b) => (b.date_commande ?? '').localeCompare(a.date_commande ?? ''));
    const nbCouvert = enrichies.filter((c) => c.recu > 0 && c.aBE).length;

    return { aScanner, nbCouvert };
  }, [commandes, lignes, saisies]);

  const isLoading = l1 || l2 || l3;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900 flex items-center gap-2">
          <ScanLine className="w-5 h-5 text-indigo-500" /> BE à scanner
        </h1>
        <p className="text-sm text-gray-500 mt-0.5 max-w-3xl">
          Commandes qui ont reçu de la marchandise (③ saisie Centralink) mais dont le <strong>BE papier (②) n&apos;a pas encore été importé</strong>.
          Scanne ces BE-là pour activer le pointage ②↔③. La liste se vide au fur et à mesure.
        </p>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <Card>
          <CardHeader className="pb-1"><CardTitle className="text-xs font-medium text-gray-500">BE à scanner</CardTitle></CardHeader>
          <CardContent><p className="text-2xl font-semibold text-gray-900">{aScanner.length}</p></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1"><CardTitle className="text-xs font-medium text-gray-500">Commandes déjà couvertes</CardTitle></CardHeader>
          <CardContent><p className="text-2xl font-semibold text-emerald-600">{nbCouvert}</p></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1"><CardTitle className="text-xs font-medium text-gray-500">Commandes (total)</CardTitle></CardHeader>
          <CardContent><p className="text-2xl font-semibold text-gray-900">{commandes.length}</p></CardContent>
        </Card>
      </div>

      {/* Liste */}
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <p className="text-sm text-gray-400 p-6 text-center">Chargement…</p>
          ) : aScanner.length === 0 ? (
            <div className="p-8 text-center">
              <CheckCircle2 className="w-8 h-8 text-emerald-400 mx-auto mb-2" />
              <p className="text-sm font-medium text-gray-700">Tout est couvert 🎉</p>
              <p className="text-xs text-gray-400 mt-1">Chaque commande ayant reçu de la marchandise a son BE scanné.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 text-left text-xs text-gray-500">
                    <th className="px-4 py-2.5 font-medium">Commande</th>
                    <th className="px-4 py-2.5 font-medium">Fournisseur</th>
                    <th className="px-4 py-2.5 font-medium">Date</th>
                    <th className="px-4 py-2.5 font-medium">Statut</th>
                    <th className="px-4 py-2.5 font-medium text-right">Reçu (unités)</th>
                    <th className="px-4 py-2.5"></th>
                  </tr>
                </thead>
                <tbody>
                  {aScanner.map((c) => (
                    <tr key={c.id} className="border-b border-gray-50 hover:bg-gray-50/50">
                      <td className="px-4 py-2.5 font-medium text-gray-900 flex items-center gap-1.5">
                        <PackageX className="w-3.5 h-3.5 text-amber-400 shrink-0" />{c.numero_commande_interne}
                      </td>
                      <td className="px-4 py-2.5 text-gray-600 max-w-[200px] truncate">{c.fournisseur ?? '—'}</td>
                      <td className="px-4 py-2.5 text-gray-500 whitespace-nowrap">{c.date_commande ? formatDate(c.date_commande) : '—'}</td>
                      <td className="px-4 py-2.5">
                        <span className={cn('inline-block px-1.5 py-0.5 rounded text-xs font-medium', statutBadge(c.statut_commande))}>
                          {c.statut_commande ?? '—'}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-right font-medium text-gray-900">{c.recu}</td>
                      <td className="px-4 py-2.5 text-right">
                        <Link href={`/commandes/${c.id}`} className="inline-flex items-center gap-0.5 text-xs text-indigo-600 hover:text-indigo-800">
                          Voir <ChevronRight className="w-3.5 h-3.5" />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-gray-400">
        Astuce : « Reçu (unités) » = total déjà réceptionné côté Centralink (③). Si une commande n&apos;apparaît plus ici après import,
        c&apos;est que son BE est bien rattaché. Les commandes sans aucun reçu ne sont pas listées (rien à scanner pour l&apos;instant).
      </p>
    </div>
  );
}
