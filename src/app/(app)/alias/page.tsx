'use client';

import { useQuery } from '@tanstack/react-query';
import PageHeader from '@/components/shared/PageHeader';
import EmptyState from '@/components/shared/EmptyState';
import { Button } from '@/components/ui/button';
import { Link2, Copy, CheckCircle2, HelpCircle } from 'lucide-react';
import { toast } from 'sonner';

type Cand = {
  saisieCode: string; papierCode: string;
  occurrences: number; qteTotale: number;
  bons: { be: string; qte: number }[];
  papierDesignation: string | null; saisieTitre: string | null;
  motsCommuns: string[];
  mappingLine: string;
};

export default function AliasPage() {
  const { data, isLoading, refetch, isFetching } = useQuery<{ confirmes: Cand[]; aVerifier: Cand[] }>({
    queryKey: ['alias-candidates'],
    queryFn: async () => {
      const r = await fetch('/api/alias-candidates');
      if (!r.ok) throw new Error((await r.json()).error ?? 'erreur');
      return r.json();
    },
    staleTime: 60000,
  });

  const confirmes = data?.confirmes ?? [];
  const aVerifier = data?.aVerifier ?? [];

  const copierLignes = (cands: Cand[]) => {
    navigator.clipboard.writeText(cands.map((c) => c.mappingLine).join('\n'));
    toast.success(`${cands.length} ligne(s) copiée(s) — à coller dans src/lib/ref-alias.ts`);
  };

  const Carte = ({ c, kind }: { c: Cand; kind: 'ok' | 'check' }) => (
    <div className={`rounded-lg border p-3 ${kind === 'ok' ? 'border-emerald-200 bg-emerald-50/40' : 'border-amber-200 bg-amber-50/40'}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <code className="px-1.5 py-0.5 rounded bg-slate-100 text-sm font-semibold">{c.saisieCode}</code>
        <span className="text-slate-400">→</span>
        <code className="px-1.5 py-0.5 rounded bg-slate-100 text-sm font-semibold">{c.papierCode}</code>
        <span className="text-[11px] text-slate-500">
          {c.occurrences} bon{c.occurrences > 1 ? 's' : ''} · {c.qteTotale} pc cumulées
        </span>
        {c.motsCommuns.length > 0 && (
          <span className="text-[11px] text-emerald-700">mot(s) commun(s) : {c.motsCommuns.join(', ')}</span>
        )}
      </div>
      <div className="mt-1.5 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-0.5 text-[12px]">
        <div><span className="text-slate-400">② papier :</span> {c.papierDesignation ?? <em className="text-slate-400">—</em>}</div>
        <div><span className="text-slate-400">③ saisie CL :</span> {c.saisieTitre ?? <em className="text-amber-600">titre CL inconnu</em>}</div>
      </div>
      <div className="mt-1 text-[11px] text-slate-400">
        bons : {c.bons.slice(0, 6).map((b) => `${b.be} (${b.qte})`).join(' · ')}{c.bons.length > 6 ? ' …' : ''}
      </div>
    </div>
  );

  return (
    <div>
      <PageHeader
        title="Candidats alias"
        subtitle="Réfs probablement identiques sous deux codes (renommage / double codification) — l'appli les repère, tu valides."
      />

      <div className="flex items-center gap-2 mb-4">
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
          {isFetching ? 'Analyse…' : 'Réanalyser'}
        </Button>
        <p className="text-[12px] text-slate-500">
          Signal : même bon · même quantité · un code papier seul ↔ un code saisie seul · désignation concordante.
          Appliquer = ajouter la ligne dans <code>src/lib/ref-alias.ts</code> (déploiement).
        </p>
      </div>

      {isLoading ? (
        <p className="text-sm text-slate-500">Analyse des bons…</p>
      ) : confirmes.length === 0 && aVerifier.length === 0 ? (
        <EmptyState icon={Link2} title="Aucun candidat alias" description="Aucune réf à double code détectée. Tout est rapproché." />
      ) : (
        <div className="space-y-6">
          {confirmes.length > 0 && (
            <section>
              <div className="flex items-center justify-between mb-2">
                <h2 className="flex items-center gap-1.5 text-sm font-semibold text-emerald-700">
                  <CheckCircle2 className="w-4 h-4" /> Confirmés ({confirmes.length}) — désignations concordantes
                </h2>
                <Button variant="outline" size="sm" onClick={() => copierLignes(confirmes)}>
                  <Copy className="w-3.5 h-3.5 mr-1" /> Copier les {confirmes.length} lignes
                </Button>
              </div>
              <div className="space-y-2">{confirmes.map((c, i) => <Carte key={i} c={c} kind="ok" />)}</div>
            </section>
          )}

          {aVerifier.length > 0 && (
            <section>
              <h2 className="flex items-center gap-1.5 text-sm font-semibold text-amber-700 mb-2">
                <HelpCircle className="w-4 h-4" /> À vérifier ({aVerifier.length}) — titre CL inconnu, à trancher à la main
              </h2>
              <div className="space-y-2">{aVerifier.map((c, i) => <Carte key={i} c={c} kind="check" />)}</div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
