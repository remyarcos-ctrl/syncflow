'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';

const CLASSEMENTS = ['à classer', 'pièce détachée', 'SAV / échange', 'sur-livraison Colombi', 'hors-commande Colombi', 'commandé autrement', 'surplus vu DH (gardé)', 'résolu'];
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/utils';
import { PackageCheck, ChevronRight } from 'lucide-react';
import {
  controlerReceptions, estAnomalieReception, verdictReceptionLabel, aliasKey,
  type LigneBeInput, type LigneCmdInput, type VerdictReception,
} from '@/lib/reception';

interface BeMeta { id: string; numero_be: string; fournisseur: string | null }

const badge: Record<VerdictReception, string> = {
  conforme: 'bg-emerald-100 text-emerald-800',
  sur_livraison: 'bg-orange-100 text-orange-800',
  hors_commande: 'bg-red-100 text-red-800',
};
const rowCls: Record<VerdictReception, string> = {
  conforme: '',
  sur_livraison: 'bg-orange-50',
  hors_commande: 'bg-red-50',
};

export default function ControleReceptionPage() {
  const [filtre, setFiltre] = useState<'anomalies' | 'tous'>('anomalies');
  const [feed, setFeed] = useState<{ loading: boolean; msg: string | null }>({ loading: false, msg: null });

  const remonter = async () => {
    setFeed({ loading: true, msg: null });
    try {
      const r = await fetch('/api/detect-anomalies', { method: 'POST' });
      const d = await r.json() as { inserees?: number; deja_presentes?: number; error?: string };
      setFeed({ loading: false, msg: d.error ? `Erreur : ${d.error}` : `${d.inserees} nouvelle(s) anomalie(s) envoyée(s) au centre · ${d.deja_presentes} déjà présentes.` });
    } catch {
      setFeed({ loading: false, msg: 'Erreur réseau' });
    }
  };

  const { data: bes = [] } = useQuery<BeMeta[]>({
    queryKey: ['cr_bes'],
    queryFn: async () => {
      const { data } = await supabase.from('be_receptions').select('id, numero_be, fournisseur');
      return data ?? [];
    },
    refetchInterval: 15000,
  });
  const { data: lignesBe = [] } = useQuery<(LigneBeInput & { hors_systeme: boolean | null })[]>({
    queryKey: ['cr_lignes_be'],
    queryFn: async () => {
      // PostgREST plafonne à 1000 lignes/requête → paginer, sinon un BE au-delà du
      // 1000ᵉ rang est invisible et fausse le contrôle.
      const all: (LigneBeInput & { hors_systeme: boolean | null })[] = [];
      for (let from = 0; ; from += 1000) {
        const { data } = await supabase.from('lignes_be')
          .select('be_id, reference_article, designation, quantite_receptionnee, hors_systeme')
          .range(from, from + 999);
        if (!data || !data.length) break;
        all.push(...(data as (LigneBeInput & { hors_systeme: boolean | null })[]));
        if (data.length < 1000) break;
      }
      return all;
    },
    refetchInterval: 15000,
  });
  const { data: lignesCmd = [] } = useQuery<LigneCmdInput[]>({
    queryKey: ['cr_lignes_cmd'],
    queryFn: async () => {
      // ⚠ lignes_commande dépasse 1000 lignes → SANS pagination, le select n'en
      // ramène que 1000 et toute réf commandée au-delà passe pour « hors commande ».
      const all: LigneCmdInput[] = [];
      for (let from = 0; ; from += 1000) {
        const { data } = await supabase.from('lignes_commande')
          .select('reference_article, quantite_commandee, quantite_receptionnee_reelle')
          .range(from, from + 999);
        if (!data || !data.length) break;
        all.push(...(data as LigneCmdInput[]));
        if (data.length < 1000) break;
      }
      return all;
    },
    refetchInterval: 15000,
  });

  const { data: resolutions = [] } = useQuery<{ be_id: string; reference_article: string; classement: string }[]>({
    queryKey: ['cr_resolutions'],
    queryFn: async () => {
      const { data, error } = await supabase.from('reception_resolution').select('be_id, reference_article, classement');
      if (error) return [];
      return data ?? [];
    },
    refetchInterval: 15000,
  });

  // Réfs de pièces détachées SAV : un « hors-commande » sur une réf SAV n'est PAS un
  // problème Colombi (pièce livrée hors commande, hors Centralink) → on l'affiche comme SAV.
  const { data: refsSav = [] } = useQuery<{ reference_article: string }[]>({
    queryKey: ['cr_refs_sav'],
    queryFn: async () => {
      const { data } = await supabase.from('refs_sav').select('reference_article');
      return data ?? [];
    },
    refetchInterval: 30000,
  });
  const savSet = useMemo(() => new Set(refsSav.map((r) => aliasKey(r.reference_article))), [refsSav]);
  const estSav = (ref: string) => savSet.has(aliasKey(ref));

  const qc = useQueryClient();
  const classer = useMutation({
    mutationFn: async (v: { be_id: string; reference_article: string; classement: string }) => {
      await fetch('/api/reception-resolution', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(v),
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cr_resolutions'] }),
  });

  const classementByKey = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of resolutions) m.set(`${r.be_id}|${r.reference_article}`, r.classement);
    return m;
  }, [resolutions]);

  const beById = useMemo(() => new Map(bes.map((b) => [b.id, b])), [bes]);

  const controles = useMemo(
    // on exclut le SAV (hors_systeme) et les lignes négatives (retours)
    () => controlerReceptions(lignesBe.filter((l) => !l.hors_systeme && l.quantite_receptionnee > 0), lignesCmd),
    [lignesBe, lignesCmd],
  );

  const kpis = useMemo(() => {
    const k = { lignes: controles.length, sur: 0, hors: 0, sav: 0, aClasser: 0 };
    for (const c of controles) {
      const sav = c.verdict === 'hors_commande' && estSav(c.ref);
      if (c.verdict === 'sur_livraison') k.sur++;
      else if (c.verdict === 'hors_commande') { if (sav) k.sav++; else k.hors++; }
      // SAV connu = déjà classé (pièce détachée), pas dans le backlog « à classer »
      if (estAnomalieReception(c.verdict) && !sav && (classementByKey.get(`${c.be_id}|${c.ref}`) ?? 'à classer') === 'à classer') k.aClasser++;
    }
    return k;
  }, [controles, classementByKey, savSet]);

  const lignes = useMemo(() => {
    const arr = filtre === 'anomalies' ? controles.filter((c) => estAnomalieReception(c.verdict)) : controles;
    const ordre: Record<VerdictReception, number> = { hors_commande: 0, sur_livraison: 1, conforme: 2 };
    return [...arr].sort((a, b) => ordre[a.verdict] - ordre[b.verdict] || (b.totalRecu ?? 0) - (a.totalRecu ?? 0));
  }, [controles, filtre]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900 flex items-center gap-2">
          <PackageCheck className="w-5 h-5 text-indigo-500" /> Contrôle réception (BE vs commande)
        </h1>
        <p className="text-sm text-gray-500 mt-0.5 max-w-3xl">
          Chaque ligne de BE (② reçu) confrontée aux <strong>commandes</strong> (①) — indépendant de la saisie log.
          Détecte si <strong>Colombi a sur-livré</strong> (reçu &gt; commandé) ou <strong>livré hors commande</strong>.
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Card><CardHeader className="pb-1"><CardTitle className="text-xs font-medium text-gray-500">Sur-livraisons</CardTitle></CardHeader><CardContent><p className="text-2xl font-semibold text-orange-600">{kpis.sur}</p></CardContent></Card>
        <Card><CardHeader className="pb-1"><CardTitle className="text-xs font-medium text-gray-500">Hors commande</CardTitle></CardHeader><CardContent><p className="text-2xl font-semibold text-red-600">{kpis.hors}{kpis.sav > 0 && <span className="text-xs font-medium text-gray-400"> +{kpis.sav} SAV</span>}</p></CardContent></Card>
        <Card><CardHeader className="pb-1"><CardTitle className="text-xs font-medium text-gray-500">À classer</CardTitle></CardHeader><CardContent><p className={cn('text-2xl font-semibold', kpis.aClasser ? 'text-indigo-600' : 'text-emerald-600')}>{kpis.aClasser}</p></CardContent></Card>
        <Card><CardHeader className="pb-1"><CardTitle className="text-xs font-medium text-gray-500">Lignes de BE</CardTitle></CardHeader><CardContent><p className="text-2xl font-semibold text-gray-900">{kpis.lignes}</p></CardContent></Card>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex rounded-lg border border-gray-200 bg-gray-50 p-0.5 w-fit">
          {(['anomalies', 'tous'] as const).map((f) => (
            <button key={f} onClick={() => setFiltre(f)}
              className={cn('rounded-md px-4 py-1.5 text-sm font-medium transition-all',
                filtre === f ? 'bg-white text-indigo-700 shadow-sm' : 'text-gray-500 hover:text-gray-700')}>
              {f === 'anomalies' ? 'Anomalies seulement' : 'Toutes les lignes'}
            </button>
          ))}
        </div>
        <button onClick={remonter} disabled={feed.loading}
          className="rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-sm font-medium text-indigo-700 hover:bg-indigo-100 disabled:opacity-50">
          {feed.loading ? 'Envoi…' : '↑ Remonter au centre d\'anomalies'}
        </button>
        {feed.msg && <span className="text-xs text-gray-500">{feed.msg}</span>}
      </div>

      <Card>
        <CardContent className="p-0">
          {lignesBe.length === 0 ? (
            <p className="text-sm text-gray-400 p-6 text-center">Aucun BE importé.</p>
          ) : lignes.length === 0 ? (
            <div className="p-8 text-center">
              <PackageCheck className="w-8 h-8 text-emerald-400 mx-auto mb-2" />
              <p className="text-sm font-medium text-gray-700">Aucune anomalie 🎉</p>
              <p className="text-xs text-gray-400 mt-1">Tout ce qui a été livré correspond à des commandes, sans sur-livraison.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 text-left text-xs text-gray-500">
                    <th className="px-3 py-2.5 font-medium">BE</th>
                    <th className="px-3 py-2.5 font-medium">Référence</th>
                    <th className="px-3 py-2.5 font-medium text-right bg-green-50/50">② Reçu (BE)</th>
                    <th className="px-3 py-2.5 font-medium text-right bg-blue-50/50">① Commandé</th>
                    <th className="px-3 py-2.5 font-medium text-right bg-green-50/50">③ Reçu total</th>
                    <th className="px-3 py-2.5 font-medium">Verdict</th>
                    <th className="px-3 py-2.5 font-medium">Classement</th>
                  </tr>
                </thead>
                <tbody>
                  {lignes.map((c, i) => {
                    const be = beById.get(c.be_id);
                    const sav = c.verdict === 'hors_commande' && estSav(c.ref);
                    return (
                      <tr key={c.be_id + '|' + c.ref + '|' + i} className={cn('border-b border-gray-50', sav ? 'bg-gray-50/40' : rowCls[c.verdict])}>
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          <Link href={`/be-receptions/${c.be_id}`} className="text-indigo-600 hover:underline font-medium">{be?.numero_be ?? '—'}</Link>
                        </td>
                        <td className="px-3 py-2.5 max-w-[240px]">
                          <div className="font-medium text-gray-900">{c.ref}</div>
                          <div className="text-xs text-gray-400 truncate">{c.designation ?? ''}</div>
                        </td>
                        <td className="px-3 py-2.5 text-right font-medium text-gray-900 bg-green-50/30">{c.qteBe}</td>
                        <td className="px-3 py-2.5 text-right text-gray-700 bg-blue-50/30">{c.totalCommande ?? '—'}</td>
                        <td className="px-3 py-2.5 text-right bg-green-50/30">
                          <span className={cn(c.verdict === 'sur_livraison' ? 'text-orange-700 font-semibold' : 'text-gray-700')}>
                            {c.totalRecu ?? '—'}
                          </span>
                        </td>
                        <td className="px-3 py-2.5">
                          <span className={cn('inline-block px-1.5 py-0.5 rounded text-xs font-medium', sav ? 'bg-gray-100 text-gray-600' : badge[c.verdict])}>
                            {sav ? 'Pièce SAV' : verdictReceptionLabel[c.verdict]}
                          </span>
                        </td>
                        <td className="px-3 py-2.5">
                          {(() => {
                            const k = `${c.be_id}|${c.ref}`;
                            const cur = classementByKey.get(k) ?? 'à classer';
                            return (
                              <select
                                value={cur}
                                onChange={(e) => classer.mutate({ be_id: c.be_id, reference_article: c.ref, classement: e.target.value })}
                                className={cn(
                                  'rounded border px-1.5 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-400',
                                  cur === 'à classer' ? 'border-gray-200 text-gray-400' : 'border-indigo-200 bg-indigo-50 text-indigo-700',
                                )}
                              >
                                {CLASSEMENTS.map((o) => <option key={o} value={o}>{o}</option>)}
                              </select>
                            );
                          })()}
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
        <strong>Sur-livraison</strong> : sur cet article, le reçu total Centralink dépasse le commandé total → Colombi a envoyé trop.
        <strong> Hors commande</strong> : article jamais commandé. Indépendant de la saisie log — utilisable dès l&apos;import du BE.
      </p>
    </div>
  );
}
