'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatEur, formatDate, cn } from '@/utils';
import { ShieldCheck, AlertTriangle } from 'lucide-react';
import {
  controlerLignesFacture, estEcart, verdictLabel,
  type LigneFactureInput, type LigneCommandeInput, type CommandeInput, type SaisieInput, type VerdictFact,
} from '@/lib/facturation';

interface FactureMeta { id: string; numero_facture: string; fournisseur: string | null; date_facture: string | null }

const rowClass: Record<VerdictFact, string> = {
  conforme: '',
  partiel: 'bg-blue-50/40',
  ecart_prix: 'bg-amber-50',
  sur_facturation: 'bg-red-50',
  hors_commande: 'bg-orange-50',
};
const badgeClass: Record<VerdictFact, string> = {
  conforme: 'bg-emerald-100 text-emerald-800',
  partiel: 'bg-blue-100 text-blue-700',
  ecart_prix: 'bg-amber-100 text-amber-800',
  sur_facturation: 'bg-red-100 text-red-800',
  hors_commande: 'bg-orange-100 text-orange-800',
};

export default function ControleFacturationPage() {
  const [filtre, setFiltre] = useState<'ecarts' | 'tous'>('ecarts');

  const { data: factures = [] } = useQuery<FactureMeta[]>({
    queryKey: ['cf_factures'],
    queryFn: async () => {
      const { data } = await supabase.from('factures').select('id, numero_facture, fournisseur, date_facture');
      return data ?? [];
    },
    refetchInterval: 15000,
  });
  const { data: lignesFact = [] } = useQuery<LigneFactureInput[]>({
    queryKey: ['cf_lignes_fact'],
    queryFn: async () => {
      const { data } = await supabase.from('lignes_facture')
        .select('id, facture_id, ligne_no, reference_article, designation, quantite_facturee, pu_facture, montant_ht, numero_be_detecte');
      return (data as LigneFactureInput[]) ?? [];
    },
    refetchInterval: 15000,
  });
  const { data: lignesCmd = [] } = useQuery<LigneCommandeInput[]>({
    queryKey: ['cf_lignes_cmd'],
    queryFn: async () => {
      // PostgREST plafonne à 1000 lignes ; lignes_commande dépasse → paginer, sinon
      // des réfs commandées au-delà du 1000ᵉ rang passent pour non commandées/non reçues.
      const all: LigneCommandeInput[] = [];
      for (let from = 0; ; from += 1000) {
        const { data } = await supabase.from('lignes_commande')
          .select('commande_id, reference_article, quantite_commandee, pu_commande, quantite_receptionnee_reelle')
          .range(from, from + 999);
        if (!data || !data.length) break;
        all.push(...(data as LigneCommandeInput[]));
        if (data.length < 1000) break;
      }
      return all;
    },
    refetchInterval: 15000,
  });
  const { data: commandes = [] } = useQuery<CommandeInput[]>({
    queryKey: ['cf_commandes'],
    queryFn: async () => {
      const { data } = await supabase.from('commandes').select('id, numero_commande_interne');
      return (data as CommandeInput[]) ?? [];
    },
    refetchInterval: 15000,
  });
  const { data: saisies = [] } = useQuery<SaisieInput[]>({
    queryKey: ['cf_saisies'],
    queryFn: async () => {
      // saisies_cl dépasse 1000 lignes → paginer (sinon liens BE↔commande incomplets).
      const all: SaisieInput[] = [];
      for (let from = 0; ; from += 1000) {
        const { data } = await supabase.from('saisies_cl').select('numero_be, commande_ref').range(from, from + 999);
        if (!data || !data.length) break;
        all.push(...(data as SaisieInput[]));
        if (data.length < 1000) break;
      }
      return all;
    },
    refetchInterval: 15000,
  });

  const factById = useMemo(() => new Map(factures.map((f) => [f.id, f])), [factures]);

  const controles = useMemo(
    () => controlerLignesFacture(lignesFact, lignesCmd, commandes, saisies),
    [lignesFact, lignesCmd, commandes, saisies],
  );

  const kpis = useMemo(() => {
    const k = { factures: new Set(lignesFact.map((l) => l.facture_id)).size, lignes: controles.length, surFact: 0, prix: 0, horsCmd: 0, conformes: 0 };
    for (const c of controles) {
      if (c.verdict === 'sur_facturation') k.surFact++;
      else if (c.verdict === 'ecart_prix') k.prix++;
      else if (c.verdict === 'hors_commande') k.horsCmd++;
      else if (c.verdict === 'conforme') k.conformes++;
    }
    return k;
  }, [controles, lignesFact]);

  const lignes = useMemo(() => {
    const arr = filtre === 'ecarts' ? controles.filter((c) => estEcart(c.verdict)) : controles;
    const ordre: Record<VerdictFact, number> = { sur_facturation: 0, ecart_prix: 1, hors_commande: 2, partiel: 3, conforme: 4 };
    return [...arr].sort((a, b) => ordre[a.verdict] - ordre[b.verdict]);
  }, [controles, filtre]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900 flex items-center gap-2">
          <ShieldCheck className="w-5 h-5 text-indigo-500" /> Contrôle facturation (3 voies)
        </h1>
        <p className="text-sm text-gray-500 mt-0.5 max-w-3xl">
          Chaque ligne de facture (④) est confrontée à la commande (① prix + qté) et au reçu (③ qté).
          Les écarts sont <strong>signalés pour décision</strong> — jamais corrigés automatiquement.
        </p>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <Card><CardHeader className="pb-1"><CardTitle className="text-xs font-medium text-gray-500">Factures</CardTitle></CardHeader><CardContent><p className="text-2xl font-semibold text-gray-900">{kpis.factures}</p></CardContent></Card>
        <Card><CardHeader className="pb-1"><CardTitle className="text-xs font-medium text-gray-500">Lignes contrôlées</CardTitle></CardHeader><CardContent><p className="text-2xl font-semibold text-gray-900">{kpis.lignes}</p></CardContent></Card>
        <Card><CardHeader className="pb-1"><CardTitle className="text-xs font-medium text-gray-500">Sur-facturations</CardTitle></CardHeader><CardContent><p className="text-2xl font-semibold text-red-600">{kpis.surFact}</p></CardContent></Card>
        <Card><CardHeader className="pb-1"><CardTitle className="text-xs font-medium text-gray-500">Écarts prix</CardTitle></CardHeader><CardContent><p className="text-2xl font-semibold text-amber-600">{kpis.prix}</p></CardContent></Card>
        <Card><CardHeader className="pb-1"><CardTitle className="text-xs font-medium text-gray-500">Hors commande</CardTitle></CardHeader><CardContent><p className="text-2xl font-semibold text-orange-600">{kpis.horsCmd}</p></CardContent></Card>
      </div>

      {/* Filtre */}
      <div className="flex rounded-lg border border-gray-200 bg-gray-50 p-0.5 w-fit">
        {(['ecarts', 'tous'] as const).map((f) => (
          <button key={f} onClick={() => setFiltre(f)}
            className={cn('rounded-md px-4 py-1.5 text-sm font-medium transition-all',
              filtre === f ? 'bg-white text-indigo-700 shadow-sm' : 'text-gray-500 hover:text-gray-700')}>
            {f === 'ecarts' ? 'Écarts seulement' : 'Toutes les lignes'}
          </button>
        ))}
      </div>

      {/* Tableau */}
      <Card>
        <CardContent className="p-0">
          {lignesFact.length === 0 ? (
            <div className="p-8 text-center">
              <ShieldCheck className="w-8 h-8 text-gray-300 mx-auto mb-2" />
              <p className="text-sm font-medium text-gray-700">Aucune facture importée</p>
              <p className="text-xs text-gray-400 mt-1">Importe une facture Colombi — le contrôle se lance automatiquement.</p>
            </div>
          ) : lignes.length === 0 ? (
            <div className="p-8 text-center">
              <ShieldCheck className="w-8 h-8 text-emerald-400 mx-auto mb-2" />
              <p className="text-sm font-medium text-gray-700">Aucun écart 🎉</p>
              <p className="text-xs text-gray-400 mt-1">Toutes les lignes facturées correspondent à la commande et au reçu.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 text-left text-xs text-gray-500">
                    <th className="px-3 py-2.5 font-medium">Facture</th>
                    <th className="px-3 py-2.5 font-medium">Référence</th>
                    <th className="px-3 py-2.5 font-medium text-right bg-blue-50/50">① Cmd</th>
                    <th className="px-3 py-2.5 font-medium text-right bg-blue-50/50">PU cmd</th>
                    <th className="px-3 py-2.5 font-medium text-right bg-green-50/50">③ Reçu</th>
                    <th className="px-3 py-2.5 font-medium text-right bg-amber-50/50">④ Facturé</th>
                    <th className="px-3 py-2.5 font-medium text-right bg-amber-50/50">PU fact.</th>
                    <th className="px-3 py-2.5 font-medium text-right">Δ prix</th>
                    <th className="px-3 py-2.5 font-medium text-right">Δ qté</th>
                    <th className="px-3 py-2.5 font-medium">Verdict</th>
                  </tr>
                </thead>
                <tbody>
                  {lignes.map((c) => {
                    const f = factById.get(c.lf.facture_id);
                    return (
                      <tr key={c.lf.id} className={cn('border-b border-gray-50', rowClass[c.verdict])}>
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          <div className="font-medium text-gray-800">{f?.numero_facture ?? '—'}</div>
                          {f?.date_facture && <div className="text-xs text-gray-400">{formatDate(f.date_facture)}</div>}
                        </td>
                        <td className="px-3 py-2.5 max-w-[220px]">
                          <div className="font-medium text-gray-900">{c.lf.reference_article ?? '—'}</div>
                          <div className="text-xs text-gray-400 truncate">{c.lf.designation ?? ''}</div>
                          {c.commandesRattachees.length > 0 && (
                            <div className="text-[11px] text-indigo-500 mt-0.5">{c.commandesRattachees.join(', ')}</div>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-right text-gray-700 bg-blue-50/30">{c.qteCommandee ?? '—'}</td>
                        <td className="px-3 py-2.5 text-right text-gray-700 bg-blue-50/30">{c.puCommande != null ? formatEur(c.puCommande) : '—'}</td>
                        <td className="px-3 py-2.5 text-right text-gray-700 bg-green-50/30">{c.qteRecue ?? '—'}</td>
                        <td className="px-3 py-2.5 text-right font-medium text-gray-900 bg-amber-50/30">{c.lf.quantite_facturee}</td>
                        <td className="px-3 py-2.5 text-right text-gray-700 bg-amber-50/30">{c.lf.pu_facture != null ? formatEur(c.lf.pu_facture) : '—'}</td>
                        <td className="px-3 py-2.5 text-right">
                          {c.ecartPrixPct == null ? <span className="text-gray-300">—</span> : (
                            <span className={cn('font-medium', Math.abs(c.ecartPrixPct) <= 1 ? 'text-emerald-600' : 'text-red-600')}>
                              {c.ecartPrixPct > 0 ? '+' : ''}{c.ecartPrixPct.toFixed(1)}%
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          {c.ecartQteRecu == null ? <span className="text-gray-300">—</span> : (
                            <span className={cn('font-medium', c.ecartQteRecu > 0.01 ? 'text-red-600' : c.ecartQteRecu < -0.01 ? 'text-blue-600' : 'text-emerald-600')}>
                              {c.ecartQteRecu > 0 ? '+' : ''}{Number.isInteger(c.ecartQteRecu) ? c.ecartQteRecu : c.ecartQteRecu.toFixed(2)}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2.5">
                          <span className={cn('inline-block px-1.5 py-0.5 rounded text-xs font-medium', badgeClass[c.verdict])}>
                            {verdictLabel[c.verdict]}
                          </span>
                          {c.problemes.length > 0 && (
                            <div className="text-[11px] text-gray-500 mt-0.5 flex items-start gap-1">
                              <AlertTriangle className="w-3 h-3 text-amber-400 mt-0.5 shrink-0" />
                              <span>{c.problemes.join(' · ')}</span>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-gray-400 max-w-3xl">
        <strong>Sur-facturation</strong> = facturé &gt; reçu (on paie plus que livré). <strong>Écart prix</strong> = PU facturé ≠ PU commandé (&gt; 1 %).
        <strong> Hors commande</strong> = référence absente des commandes. <strong>Partiel</strong> = facturé &lt; reçu (le reste viendra). Rattachement via le n° de BE de la facture, sinon par la référence.
      </p>
    </div>
  );
}
