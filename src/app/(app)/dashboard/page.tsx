'use client';

import { useMemo, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import StatusBadge from '@/components/shared/StatusBadge';
import { formatEur, formatDate } from '@/utils';
import Link from 'next/link';
import {
  ShoppingCart, Package, FileText, AlertTriangle,
  CheckCircle2, ArrowRight, RefreshCw, ChevronRight,
  Clock, XCircle
} from 'lucide-react';
import type { Commande, BEReception, Facture, Exception, Rapprochement } from '@/types';

function PipelineStep({
  icon: Icon, label, total, ok, warning, error, linkWarn, linkErr, color, montant, showMontant, onToggle
}: {
  icon: React.ElementType; label: string; total: number;
  ok: number; warning: number; error: number;
  linkOk?: string; linkWarn?: string; linkErr?: string; color: string;
  montant?: number; showMontant?: boolean; onToggle?: () => void;
}) {
  const pct = total > 0 ? Math.round((ok / total) * 100) : 0;
  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-2 mb-2">
        <div className={`p-1.5 rounded-md bg-${color}-100`}>
          <Icon className={`w-4 h-4 text-${color}-600`} />
        </div>
        <span className="text-xs font-semibold text-gray-600 uppercase tracking-wide">{label}</span>
      </div>
      <div
        className={`mb-1 ${onToggle ? 'cursor-pointer select-none group' : ''}`}
        onClick={onToggle}
        title={onToggle ? (showMontant ? 'Voir le nombre' : 'Voir le montant HT') : undefined}
      >
        {showMontant && montant != null ? (
          <div className="text-xl font-bold text-indigo-700 group-hover:text-indigo-500 transition-colors">
            {montant.toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })} €
          </div>
        ) : (
          <div className="text-2xl font-bold text-gray-900 group-hover:text-indigo-600 transition-colors">
            {total}
            {onToggle && <span className="ml-1 text-xs font-normal text-gray-300 group-hover:text-indigo-400">HT →</span>}
          </div>
        )}
      </div>
      <div className="h-1.5 rounded-full bg-gray-100 mb-2 overflow-hidden">
        <div className="h-full rounded-full bg-emerald-400 transition-all" style={{ width: `${pct}%` }} />
      </div>
      <div className="space-y-1">
        {ok > 0 && <p className="text-xs text-emerald-600 flex items-center gap-1"><CheckCircle2 className="w-3 h-3" />{ok} OK</p>}
        {warning > 0 && (
          <div className="flex items-center justify-between text-xs">
            <span className="text-amber-600 flex items-center gap-1"><Clock className="w-3 h-3" />{warning} en attente</span>
            {linkWarn && <Link href={linkWarn} className="text-gray-400 hover:text-gray-600"><ChevronRight className="w-3 h-3" /></Link>}
          </div>
        )}
        {error > 0 && (
          <div className="flex items-center justify-between text-xs">
            <span className="text-red-600 flex items-center gap-1"><XCircle className="w-3 h-3" />{error} problème</span>
            {linkErr && <Link href={linkErr} className="text-gray-400 hover:text-gray-600"><ChevronRight className="w-3 h-3" /></Link>}
          </div>
        )}
      </div>
    </div>
  );
}

function ActionItem({ priorite, titre, detail, lien, labelLien }: {
  priorite: 'haute' | 'moyenne' | 'faible'; titre: string; detail: string; lien: string; labelLien: string;
}) {
  const styles = {
    haute:   { bar: 'bg-red-500',   bg: 'bg-red-50/60',   text: 'text-red-700',   btn: 'text-red-600 hover:text-red-800' },
    moyenne: { bar: 'bg-amber-400', bg: 'bg-amber-50/60', text: 'text-amber-700', btn: 'text-amber-600 hover:text-amber-800' },
    faible:  { bar: 'bg-blue-400',  bg: 'bg-blue-50/40',  text: 'text-blue-700',  btn: 'text-blue-600 hover:text-blue-800' },
  };
  const s = styles[priorite];
  return (
    <div className={`flex items-start gap-3 p-3 rounded-lg ${s.bg}`}>
      <div className={`w-1 self-stretch rounded-full shrink-0 ${s.bar}`} />
      <div className="flex-1 min-w-0">
        <p className={`text-xs font-semibold ${s.text}`}>{titre}</p>
        <p className="text-xs text-gray-600 mt-0.5 truncate">{detail}</p>
      </div>
      <Link href={lien} className={`text-xs font-medium shrink-0 flex items-center gap-0.5 ${s.btn}`}>
        {labelLien}<ArrowRight className="w-3 h-3" />
      </Link>
    </div>
  );
}

const isAvoir = (f: { total_ht: number | null; numero_facture: string }) =>
  (f.total_ht ?? 0) < 0 || /avoir|credit|cn[-_\s\d]/i.test(f.numero_facture);

export default function DashboardPage() {
  const STALE = { staleTime: 30_000 };
  const qc = useQueryClient();
  const debounceTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const [cmdShowMontant, setCmdShowMontant] = useState(false);
  const [factShowMontant, setFactShowMontant] = useState(false);

  // IMPORTANT : activer la Replication Supabase pour chaque table dans
  // Database → Replication du dashboard Supabase (sinon les events ne sont pas émis).
  useEffect(() => {
    const invalidate = (key: string, queryKey: unknown[]) => {
      const existing = debounceTimers.current.get(key);
      if (existing) clearTimeout(existing);
      debounceTimers.current.set(key, setTimeout(() => {
        void qc.invalidateQueries({ queryKey });
        debounceTimers.current.delete(key);
      }, 200));
    };

    const channel = supabase
      .channel('dashboard-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'factures' }, () => {
        invalidate('factures', ['factures']);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'be_receptions' }, () => {
        invalidate('bes', ['bes']);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'commandes' }, () => {
        invalidate('commandes', ['commandes']);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rapprochements' }, () => {
        invalidate('rapprochements', ['rapprochements']);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lignes_be' }, () => {
        invalidate('dashboard-retours', ['dashboard-retours']);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'exceptions' }, () => {
        invalidate('exceptions', ['exceptions']);
      })
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
      debounceTimers.current.forEach(t => clearTimeout(t));
    };
  }, [qc]);

  const { data: commandes = [] } = useQuery<Commande[]>({
    queryKey: ['commandes'],
    queryFn: async () => {
      // On ne suit que les commandes OUVERTES (en cours + partielles) : les commandes
      // entièrement réceptionnées sont soldées, plus d'intérêt pour le pilotage.
      const { data } = await supabase.from('commandes').select('id, statut_commande, montant_total_commande, created_at').in('statut_commande', ['ouverte', 'partiellement réceptionnée']).order('created_at', { ascending: false }).limit(500);
      return (data ?? []) as unknown as Commande[];
    },
    ...STALE,
  });

  const { data: bes = [] } = useQuery<BEReception[]>({
    queryKey: ['bes'],
    queryFn: async () => {
      const { data } = await supabase.from('be_receptions').select('id, numero_be, commande_id, statut_be, created_at').order('created_at', { ascending: false }).limit(500);
      return (data ?? []) as unknown as BEReception[];
    },
    ...STALE,
  });

  const { data: factures = [] } = useQuery<Facture[]>({
    queryKey: ['factures'],
    queryFn: async () => {
      const { data } = await supabase.from('factures').select('id, numero_facture, fournisseur, statut_facture, total_ht, taux_rapprochement, date_facture, created_at').order('created_at', { ascending: false }).limit(500);
      return (data ?? []) as unknown as Facture[];
    },
    ...STALE,
  });

  const { data: exceptions = [] } = useQuery<Exception[]>({
    queryKey: ['exceptions'],
    queryFn: async () => {
      const { data } = await supabase.from('exceptions').select('id, type_exception, statut_exception, niveau_priorite, motif').order('created_at', { ascending: false }).limit(100);
      return (data ?? []) as unknown as Exception[];
    },
    ...STALE,
  });

  const { data: rapprochements = [] } = useQuery<Rapprochement[]>({
    queryKey: ['rapprochements'],
    queryFn: async () => {
      const { data } = await supabase.from('rapprochements').select('*').order('created_at', { ascending: false }).limit(200);
      return data ?? [];
    },
    ...STALE,
  });

  const { data: retoursActifs = [] } = useQuery<{ id: string; statut_retour: string }[]>({
    queryKey: ['dashboard-retours'],
    queryFn: async () => {
      const { data } = await supabase
        .from('lignes_be')
        .select('id, statut_retour')
        .not('statut_retour', 'is', null)
        .neq('statut_retour', 'avoir_recu');
      return data ?? [];
    },
    ...STALE,
  });

  const pipeline = useMemo(() => {
    const cmdSoldees = commandes.filter(c => c.statut_commande === 'soldée').length;
    const cmdAnomalies = commandes.filter(c => c.statut_commande === 'en anomalie').length;
    const cmdEnCours = commandes.length - cmdSoldees - cmdAnomalies;
    const beLies = bes.filter(b => b.commande_id).length;
    const beNonLies = bes.filter(b => !b.commande_id).length;
    const factRapprochees = factures.filter(f => f.statut_facture === 'rapprochée').length;
    const factPartiel = factures.filter(f => ['partiellement rapprochée', 'en cours de rapprochement'].includes(f.statut_facture)).length;
    const factNon = factures.filter(f => f.statut_facture === 'importée' && !isAvoir(f)).length;
    const factAnomalie = factures.filter(f => f.statut_facture === 'en anomalie').length;
    const cmdMontantTotal = commandes.reduce((s, c) => s + (c.montant_total_commande ?? 0), 0);
    const montantTotal = factures.reduce((s, f) => s + (f.total_ht ?? 0), 0);
    const montantRap = rapprochements.filter(r => r.statut_validation === 'validé').reduce((s, r) => s + (r.montant_rapproche ?? 0), 0);
    const pctRap = montantTotal > 0 ? Math.round((montantRap / montantTotal) * 100) : 0;
    const excHaute = exceptions.filter(e => ['ouverte', 'en cours'].includes(e.statut_exception) && ['haute', 'critique'].includes(e.niveau_priorite)).length;
    const excMoyenne = exceptions.filter(e => ['ouverte', 'en cours'].includes(e.statut_exception) && e.niveau_priorite === 'moyenne').length;
    const excFaible = exceptions.filter(e => ['ouverte', 'en cours'].includes(e.statut_exception) && e.niveau_priorite === 'faible').length;
    return { cmdSoldees, cmdAnomalies, cmdEnCours, cmdMontantTotal, beLies, beNonLies, factRapprochees, factPartiel, factNon, factAnomalie, montantTotal, montantRap, pctRap, excHaute, excMoyenne, excFaible };
  }, [commandes, bes, factures, exceptions, rapprochements]);

  const actions = useMemo(() => {
    const list: { priorite: 'haute' | 'moyenne' | 'faible'; titre: string; detail: string; lien: string; labelLien: string }[] = [];
    const now = Date.now();

    // Exceptions haute priorité
    const excHautes = exceptions.filter(e => ['ouverte', 'en cours'].includes(e.statut_exception) && ['haute', 'critique'].includes(e.niveau_priorite));
    if (excHautes.length > 0) {
      const byType: Record<string, number> = {};
      excHautes.forEach(e => { byType[e.type_exception] = (byType[e.type_exception] ?? 0) + 1; });
      Object.entries(byType).slice(0, 3).forEach(([type, count]) => {
        list.push({ priorite: 'haute', titre: `${count} exception(s) — ${type}`, detail: excHautes.find(e => e.type_exception === type)?.motif ?? '', lien: '/exceptions', labelLien: 'Traiter' });
      });
    }

    // Retours fournisseur en attente
    if (retoursActifs.length > 0) {
      const aRetourner = retoursActifs.filter(r => r.statut_retour === 'a_retourner').length;
      const avoirDemande = retoursActifs.filter(r => r.statut_retour === 'avoir_demande').length;
      const detail = [aRetourner > 0 && `${aRetourner} à retourner`, avoirDemande > 0 && `${avoirDemande} avoir(s) attendu(s)`].filter(Boolean).join(' · ');
      list.push({ priorite: 'haute', titre: `${retoursActifs.length} retour(s) fournisseur en cours`, detail: detail || 'Retours à traiter', lien: '/surplus', labelLien: 'Traiter' });
    }

    // BEs non liés depuis plus de 7 jours
    const besNonLies = bes.filter(b => !b.commande_id);
    const besAnciensNonLies = besNonLies.filter(b => (now - new Date(b.created_at).getTime()) > 7 * 86400_000);
    if (besAnciensNonLies.length > 0) {
      list.push({ priorite: 'haute', titre: `${besAnciensNonLies.length} BE(s) sans commande depuis +7 jours`, detail: besAnciensNonLies.slice(0, 3).map(b => b.numero_be).join(', '), lien: '/be-receptions', labelLien: 'Vérifier' });
    } else if (besNonLies.length > 0) {
      list.push({ priorite: 'moyenne', titre: `${besNonLies.length} BE(s) non liés à une commande`, detail: besNonLies.slice(0, 3).map(b => b.numero_be).join(', '), lien: '/be-receptions', labelLien: 'Lier' });
    }

    // Factures non rapprochées depuis plus de 14 jours (hors avoirs)
    const factNon = factures.filter(f => f.statut_facture === 'importée' && !isAvoir(f));
    const factAnciennes = factNon.filter(f => (now - new Date(f.created_at).getTime()) > 14 * 86400_000);
    if (factAnciennes.length > 0) {
      list.push({ priorite: 'haute', titre: `${factAnciennes.length} facture(s) non rapprochée(s) depuis +14 jours`, detail: factAnciennes.slice(0, 3).map(f => f.numero_facture).join(', '), lien: '/factures', labelLien: 'Rapprocher' });
    } else if (factNon.length > 0) {
      list.push({ priorite: 'moyenne', titre: `${factNon.length} facture(s) à rapprocher`, detail: factNon.slice(0, 3).map(f => `${f.numero_facture} — ${formatEur(f.total_ht)}`).join(' | '), lien: '/factures', labelLien: 'Rapprocher' });
    }

    // Rapprochements proposés à valider
    const rapsPropose = rapprochements.filter(r => r.statut_validation === 'proposé');
    if (rapsPropose.length > 0) {
      list.push({ priorite: 'faible', titre: `${rapsPropose.length} rapprochement(s) automatique(s) à valider`, detail: 'Des correspondances ont été détectées automatiquement', lien: '/rapprochements', labelLien: 'Valider' });
    }

    return list;
  }, [exceptions, bes, factures, rapprochements, retoursActifs]);

  const recentFactures = useMemo(() => factures.slice(0, 8), [factures]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-gray-900">Bonjour Rémy 👋</h1>
        <p className="text-sm text-gray-500 mt-0.5">
          {new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
        </p>
      </div>

      {/* Pipeline */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <RefreshCw className="w-4 h-4 text-indigo-500" />
            Pipeline rapprochement
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-6 items-stretch">
            <PipelineStep icon={ShoppingCart} label="Commandes" color="indigo"
              total={commandes.length} ok={pipeline.cmdSoldees} warning={pipeline.cmdEnCours} error={pipeline.cmdAnomalies}
              linkWarn="/commandes" linkErr="/commandes"
              montant={pipeline.cmdMontantTotal} showMontant={cmdShowMontant} onToggle={() => setCmdShowMontant(v => !v)} />
            <div className="flex items-center text-gray-300"><ArrowRight className="w-5 h-5" /></div>
            <PipelineStep icon={Package} label="BE / Réceptions" color="amber"
              total={bes.length} ok={pipeline.beLies} warning={pipeline.beNonLies} error={0}
              linkWarn="/be-receptions" />
            <div className="flex items-center text-gray-300"><ArrowRight className="w-5 h-5" /></div>
            <PipelineStep icon={FileText} label="Factures" color="cyan"
              total={factures.length} ok={pipeline.factRapprochees} warning={pipeline.factNon + pipeline.factPartiel} error={pipeline.factAnomalie}
              linkWarn="/factures" linkErr="/factures"
              montant={pipeline.montantTotal} showMontant={factShowMontant} onToggle={() => setFactShowMontant(v => !v)} />
            <div className="flex items-center text-gray-300"><ArrowRight className="w-5 h-5" /></div>
            <PipelineStep icon={AlertTriangle} label="Exceptions" color="red"
              total={pipeline.excHaute + pipeline.excMoyenne + pipeline.excFaible}
              ok={0} warning={pipeline.excMoyenne + pipeline.excFaible} error={pipeline.excHaute}
              linkWarn="/exceptions" linkErr="/exceptions" />
          </div>

          {/* Barre globale */}
          <div className="mt-5 pt-4 border-t">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs text-gray-500">Taux de rapprochement global</span>
              <span className={`text-sm font-bold ${pipeline.pctRap >= 80 ? 'text-emerald-600' : pipeline.pctRap >= 50 ? 'text-amber-600' : 'text-red-600'}`}>
                {pipeline.pctRap}%
              </span>
            </div>
            <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
              <div className="h-full rounded-full bg-indigo-500 transition-all" style={{ width: `${pipeline.pctRap}%` }} />
            </div>
            <div className="flex justify-between mt-1 text-xs text-gray-400">
              <span>Rapproché : {formatEur(pipeline.montantRap)}</span>
              <span>Total : {formatEur(pipeline.montantTotal)}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid lg:grid-cols-2 gap-6">
        {/* Actions */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-500" />
              Actions requises
              {actions.length > 0 && (
                <span className="ml-auto text-xs bg-red-100 text-red-600 px-2 py-0.5 rounded-full font-medium">{actions.length}</span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {actions.length === 0 ? (
              <div className="text-center py-8">
                <CheckCircle2 className="w-8 h-8 text-emerald-400 mx-auto mb-2" />
                <p className="text-sm font-medium text-gray-600">Tout est à jour 🎉</p>
              </div>
            ) : (
              actions.map((a, i) => <ActionItem key={i} {...a} />)
            )}
          </CardContent>
        </Card>

        {/* Factures récentes */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-cyan-500" />
                Factures récentes
              </CardTitle>
              <Link href="/factures" className="text-xs text-indigo-600 hover:underline">Toutes →</Link>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y">
              {recentFactures.map(f => {
                const taux = f.taux_rapprochement ?? 0;
                const barColor = taux === 100 ? 'bg-emerald-400' : taux > 50 ? 'bg-amber-400' : taux > 0 ? 'bg-orange-400' : 'bg-gray-200';
                return (
                  <Link key={f.id} href={`/factures/${f.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors">
                    <div className="w-1 h-10 rounded-full bg-gray-100 overflow-hidden shrink-0">
                      <div className={`${barColor} w-full rounded-full transition-all`} style={{ height: `${taux}%`, marginTop: `${100 - taux}%` }} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium text-gray-900">{f.numero_facture}</p>
                        <StatusBadge status={f.statut_facture} />
                      </div>
                      <p className="text-xs text-gray-400 mt-0.5">{f.fournisseur} · {formatDate(f.date_facture)}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-semibold text-gray-900">{formatEur(f.total_ht)}</p>
                      <p className={`text-xs font-medium ${taux === 100 ? 'text-emerald-600' : taux > 0 ? 'text-amber-600' : 'text-gray-400'}`}>
                        {taux}% rapproché
                      </p>
                    </div>
                  </Link>
                );
              })}
              {recentFactures.length === 0 && (
                <p className="text-xs text-gray-400 text-center py-8">Aucune facture importée</p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
