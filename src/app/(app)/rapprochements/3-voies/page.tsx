'use client';

import { useState, useRef, useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { formatEur, formatDate, cn } from '@/utils';
import PageHeader from '@/components/shared/PageHeader';
import StatusBadge from '@/components/shared/StatusBadge';
import { Badge } from '@/components/ui/badge';
import type {
  Commande,
  Facture,
  LigneCommande,
  LigneFacture,
  LigneBE,
  BEReception,
  Rapprochement,
} from '@/types';

// ── Types internes ──────────────────────────────────────────────────────────

type Mode = 'commande' | 'facture';

interface ReconciliationRowCommande {
  ligneCmd: LigneCommande;
  matchingBELines: { lbe: LigneBE; be: BEReception }[];
  matchingRaps: Rapprochement[];
  invoiceLines: { lf: LigneFacture; facture: Facture }[];
  ecartQte: number | null;   // recu - commande
  ecartFact: number | null;  // facture - commande
  etat: 'ok' | 'partiel' | 'anomalie' | 'non_rapproche';
}

interface ReconciliationRowFacture {
  lf: LigneFacture;
  matchingRaps: Rapprochement[];
  beLines: { lbe: LigneBE; be: BEReception }[];
  cmdLines: { lc: LigneCommande; cmd: Commande }[];
  ecartQte: number | null;   // facture - recu
  ecartPrix: number | null;  // % (pFact - pCmd) / pCmd
  etat: 'ok' | 'partiel' | 'anomalie' | 'non_rapproche';
}

// ── SearchableSelect ────────────────────────────────────────────────────────

interface SearchableSelectProps<T> {
  items: T[];
  value: string | null;
  onSelect: (id: string) => void;
  getLabel: (item: T) => string;
  getSublabel?: (item: T) => string;
  getId: (item: T) => string;
  placeholder: string;
}

function SearchableSelect<T>({
  items,
  value,
  onSelect,
  getLabel,
  getSublabel,
  getId,
  placeholder,
}: SearchableSelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  const selected = items.find((i) => getId(i) === value);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return items.filter((i) => getLabel(i).toLowerCase().includes(q));
  }, [items, search, getLabel]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => { setOpen((o) => !o); setSearch(''); }}
        className="w-full flex items-center justify-between rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500"
      >
        <span className={selected ? 'text-gray-900' : 'text-gray-400'}>
          {selected ? getLabel(selected) : placeholder}
        </span>
        <svg className="h-4 w-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-lg border border-gray-200 bg-white shadow-lg">
          <div className="p-2">
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Rechercher…"
              className="w-full rounded border border-gray-200 px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400"
            />
          </div>
          <ul className="max-h-60 overflow-y-auto">
            {filtered.length === 0 && (
              <li className="px-3 py-2 text-sm text-gray-400">Aucun résultat</li>
            )}
            {filtered.map((item) => (
              <li key={getId(item)}>
                <button
                  type="button"
                  onClick={() => { onSelect(getId(item)); setOpen(false); }}
                  className={cn(
                    'w-full text-left px-3 py-2 text-sm hover:bg-indigo-50',
                    getId(item) === value && 'bg-indigo-50 font-medium text-indigo-700',
                  )}
                >
                  {getLabel(item)}
                  {getSublabel && (
                    <span className="ml-2 text-xs text-gray-400">{getSublabel(item)}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ── Page principale ─────────────────────────────────────────────────────────

export default function Rapprochements3VoiesPage() {
  const [mode, setMode] = useState<Mode>('commande');
  const [selectedCommandeId, setSelectedCommandeId] = useState<string | null>(null);
  const [selectedFactureId, setSelectedFactureId] = useState<string | null>(null);

  // Listes de sélection
  const { data: commandes = [] } = useQuery({
    queryKey: ['commandes-list'],
    queryFn: async () => {
      const { data } = await supabase
        .from('commandes')
        .select('id,numero_commande_interne,fournisseur,statut_commande')
        .order('created_at', { ascending: false });
      return (data ?? []) as Pick<Commande, 'id' | 'numero_commande_interne' | 'fournisseur' | 'statut_commande'>[];
    },
  });

  const { data: factures = [] } = useQuery({
    queryKey: ['factures-list'],
    queryFn: async () => {
      const { data } = await supabase
        .from('factures')
        .select('id,numero_facture,fournisseur,statut_facture,taux_rapprochement,total_ht,date_facture')
        .order('created_at', { ascending: false });
      return (data ?? []) as Pick<
        Facture,
        'id' | 'numero_facture' | 'fournisseur' | 'statut_facture' | 'taux_rapprochement' | 'total_ht' | 'date_facture'
      >[];
    },
  });

  // ── Mode Commande ──────────────────────────────────────────────────────────

  const { data: cmdDetail } = useQuery({
    queryKey: ['3v-cmd', selectedCommandeId],
    enabled: mode === 'commande' && !!selectedCommandeId,
    queryFn: async () => {
      const [lcRes, liaisonRes, rapsRes] = await Promise.all([
        supabase.from('lignes_commande').select('*').eq('commande_id', selectedCommandeId!).order('ligne_no'),
        supabase.from('liaison_be_commande').select('be_id').eq('commande_id', selectedCommandeId!),
        supabase.from('rapprochements').select('*').eq('commande_id', selectedCommandeId!),
      ]);
      const lignesCmd = (lcRes.data ?? []) as LigneCommande[];
      const beIds = (liaisonRes.data ?? []).map((l: { be_id: string }) => l.be_id);
      const raps = (rapsRes.data ?? []) as Rapprochement[];

      let bes: BEReception[] = [];
      let lignesBE: LigneBE[] = [];
      if (beIds.length > 0) {
        const [beRes, lbeRes] = await Promise.all([
          supabase.from('be_receptions').select('*').in('id', beIds),
          supabase.from('lignes_be').select('*').in('be_id', beIds),
        ]);
        bes = (beRes.data ?? []) as BEReception[];
        lignesBE = (lbeRes.data ?? []) as LigneBE[];
      }

      const factureIds = [...new Set(raps.map((r) => r.facture_id).filter(Boolean) as string[])];
      let facturesList: Facture[] = [];
      let lignesFacture: LigneFacture[] = [];
      if (factureIds.length > 0) {
        const [fRes, lfRes] = await Promise.all([
          supabase.from('factures').select('*').in('id', factureIds),
          supabase.from('lignes_facture').select('*').in('facture_id', factureIds),
        ]);
        facturesList = (fRes.data ?? []) as Facture[];
        lignesFacture = (lfRes.data ?? []) as LigneFacture[];
      }

      return { lignesCmd, bes, lignesBE, raps, facturesList, lignesFacture };
    },
  });

  const reconciliationCommande = useMemo((): ReconciliationRowCommande[] => {
    if (!cmdDetail) return [];
    const { lignesCmd, bes, lignesBE, raps, facturesList, lignesFacture } = cmdDetail;
    const beMap = Object.fromEntries(bes.map((b) => [b.id, b]));
    const factureMap = Object.fromEntries(facturesList.map((f) => [f.id, f]));

    return lignesCmd.map((lc) => {
      const myRaps = raps.filter((r) => r.ligne_commande_id === lc.id);
      const lbeIds = myRaps.map((r) => r.ligne_be_id).filter(Boolean) as string[];
      const lfIds = myRaps.map((r) => r.ligne_facture_id).filter(Boolean) as string[];

      const matchingBELines = lignesBE
        .filter((lb) => lbeIds.includes(lb.id))
        .map((lb) => ({ lbe: lb, be: beMap[lb.be_id] }))
        .filter((x) => x.be);

      const invoiceLines = lignesFacture
        .filter((lf) => lfIds.includes(lf.id))
        .map((lf) => ({ lf, facture: factureMap[lf.facture_id] }))
        .filter((x) => x.facture);

      const totalRecu = matchingBELines.reduce((s, x) => s + (x.lbe.quantite_receptionnee ?? 0), 0);
      const totalFact = invoiceLines.reduce((s, x) => s + (x.lf.quantite_facturee ?? 0), 0);
      const ecartQte = matchingBELines.length > 0 ? totalRecu - lc.quantite_commandee : null;
      const ecartFact = invoiceLines.length > 0 ? totalFact - lc.quantite_commandee : null;

      let etat: ReconciliationRowCommande['etat'] = 'non_rapproche';
      if (myRaps.length > 0) {
        if (ecartQte !== null && Math.abs(ecartQte) > 0.01) etat = 'anomalie';
        else if (ecartFact !== null && Math.abs(ecartFact) > 0.01) etat = 'partiel';
        else etat = 'ok';
      }

      return { ligneCmd: lc, matchingBELines, matchingRaps: myRaps, invoiceLines, ecartQte, ecartFact, etat };
    });
  }, [cmdDetail]);

  // ── Mode Facture ────────────────────────────────────────────────────────────

  const { data: factDetail } = useQuery({
    queryKey: ['3v-fact', selectedFactureId],
    enabled: mode === 'facture' && !!selectedFactureId,
    queryFn: async () => {
      const [lfRes, rapsRes, liaisonsRes] = await Promise.all([
        supabase.from('lignes_facture').select('*').eq('facture_id', selectedFactureId!).order('ligne_no'),
        supabase.from('rapprochements').select('*').eq('facture_id', selectedFactureId!),
        supabase.from('liaison_facture_commande').select('commande_id').eq('facture_id', selectedFactureId!),
      ]);
      const lignesFacture = (lfRes.data ?? []) as LigneFacture[];
      const raps = (rapsRes.data ?? []) as Rapprochement[];
      const commandeIds = (liaisonsRes.data ?? []).map((l: { commande_id: string }) => l.commande_id);

      const beIds = [...new Set(raps.map((r) => r.be_id).filter(Boolean) as string[])];
      let bes: BEReception[] = [];
      let lignesBE: LigneBE[] = [];
      if (beIds.length > 0) {
        const [beRes, lbeRes] = await Promise.all([
          supabase.from('be_receptions').select('*').in('id', beIds),
          supabase.from('lignes_be').select('*').in('be_id', beIds),
        ]);
        bes = (beRes.data ?? []) as BEReception[];
        lignesBE = (lbeRes.data ?? []) as LigneBE[];
      }

      let cmdList: Commande[] = [];
      let lignesCmd: LigneCommande[] = [];
      if (commandeIds.length > 0) {
        const [cRes, lcRes] = await Promise.all([
          supabase.from('commandes').select('*').in('id', commandeIds),
          supabase.from('lignes_commande').select('*').in('commande_id', commandeIds),
        ]);
        cmdList = (cRes.data ?? []) as Commande[];
        lignesCmd = (lcRes.data ?? []) as LigneCommande[];
      }

      return { lignesFacture, raps, bes, lignesBE, cmdList, lignesCmd };
    },
  });

  const reconciliationFacture = useMemo((): ReconciliationRowFacture[] => {
    if (!factDetail) return [];
    const { lignesFacture, raps, bes, lignesBE, cmdList, lignesCmd } = factDetail;
    const beMap = Object.fromEntries(bes.map((b) => [b.id, b]));
    const cmdMap = Object.fromEntries(cmdList.map((c) => [c.id, c]));

    return lignesFacture.map((lf) => {
      const myRaps = raps.filter((r) => r.ligne_facture_id === lf.id);
      const lbeIds = myRaps.map((r) => r.ligne_be_id).filter(Boolean) as string[];
      const lcIds = myRaps.map((r) => r.ligne_commande_id).filter(Boolean) as string[];

      const beLines = lignesBE
        .filter((lb) => lbeIds.includes(lb.id))
        .map((lb) => ({ lbe: lb, be: beMap[lb.be_id] }))
        .filter((x) => x.be);

      const cmdLines = lignesCmd
        .filter((lc) => lcIds.includes(lc.id))
        .map((lc) => ({ lc, cmd: cmdMap[lc.commande_id] }))
        .filter((x) => x.cmd);

      const totalRecu = beLines.reduce((s, x) => s + (x.lbe.quantite_receptionnee ?? 0), 0);
      const ecartQte = beLines.length > 0 ? (lf.quantite_facturee ?? 0) - totalRecu : null;

      const puCmd = cmdLines[0]?.lc.pu_commande ?? null;
      const ecartPrix =
        puCmd && lf.pu_facture
          ? ((lf.pu_facture - puCmd) / puCmd) * 100
          : null;

      let etat: ReconciliationRowFacture['etat'] = 'non_rapproche';
      if (myRaps.length > 0) {
        if ((ecartQte !== null && Math.abs(ecartQte) > 0.01) || (ecartPrix !== null && Math.abs(ecartPrix) > 2))
          etat = 'anomalie';
        else etat = 'ok';
      }

      return { lf, matchingRaps: myRaps, beLines, cmdLines, ecartQte, ecartPrix, etat };
    });
  }, [factDetail]);

  // ── Helpers UI ──────────────────────────────────────────────────────────────

  const etatClasses: Record<string, string> = {
    ok: 'bg-emerald-50 border-l-4 border-emerald-400',
    partiel: 'bg-amber-50 border-l-4 border-amber-400',
    anomalie: 'bg-red-50 border-l-4 border-red-400',
    non_rapproche: 'bg-gray-50',
  };

  const etatLabel: Record<string, string> = {
    ok: 'OK',
    partiel: 'Partiel',
    anomalie: 'Anomalie',
    non_rapproche: 'Non rapproché',
  };

  const etatBadge: Record<string, string> = {
    ok: 'bg-emerald-100 text-emerald-800',
    partiel: 'bg-amber-100 text-amber-800',
    anomalie: 'bg-red-100 text-red-800',
    non_rapproche: 'bg-gray-100 text-gray-600',
  };

  const selectedCommande = commandes.find((c) => c.id === selectedCommandeId);
  const selectedFacture = factures.find((f) => f.id === selectedFactureId);

  // KPIs commande mode
  const cmdKpis = useMemo(() => {
    const total = reconciliationCommande.length;
    const ok = reconciliationCommande.filter((r) => r.etat === 'ok').length;
    const anomalie = reconciliationCommande.filter((r) => r.etat === 'anomalie').length;
    const nonRap = reconciliationCommande.filter((r) => r.etat === 'non_rapproche').length;
    return { total, ok, anomalie, nonRap };
  }, [reconciliationCommande]);

  const factKpis = useMemo(() => {
    const total = reconciliationFacture.length;
    const ok = reconciliationFacture.filter((r) => r.etat === 'ok').length;
    const anomalie = reconciliationFacture.filter((r) => r.etat === 'anomalie').length;
    const nonRap = reconciliationFacture.filter((r) => r.etat === 'non_rapproche').length;
    return { total, ok, anomalie, nonRap };
  }, [reconciliationFacture]);

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      <PageHeader
        title="Vue 3 voies"
        subtitle="Rapprochement Commande ↔ BE ↔ Facture"
      />

      {/* Sélecteur de mode + entité */}
      <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
          {/* Toggle mode */}
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500">Pivoter sur</label>
            <div className="flex rounded-lg border border-gray-200 bg-gray-50 p-0.5">
              {(['commande', 'facture'] as Mode[]).map((m) => (
                <button
                  key={m}
                  onClick={() => { setMode(m); setSelectedCommandeId(null); setSelectedFactureId(null); }}
                  className={cn(
                    'flex-1 rounded-md px-4 py-1.5 text-sm font-medium transition-all',
                    mode === m
                      ? 'bg-white text-indigo-700 shadow-sm'
                      : 'text-gray-500 hover:text-gray-700',
                  )}
                >
                  {m === 'commande' ? 'Commande' : 'Facture'}
                </button>
              ))}
            </div>
          </div>

          {/* Sélection entité */}
          <div className="flex-1">
            <label className="mb-1 block text-xs font-medium text-gray-500">
              {mode === 'commande' ? 'Commande' : 'Facture'}
            </label>
            {mode === 'commande' ? (
              <SearchableSelect
                items={commandes}
                value={selectedCommandeId}
                onSelect={setSelectedCommandeId}
                getId={(c) => c.id}
                getLabel={(c) => c.numero_commande_interne}
                getSublabel={(c) => c.fournisseur}
                placeholder="Sélectionner une commande…"
              />
            ) : (
              <SearchableSelect
                items={factures}
                value={selectedFactureId}
                onSelect={setSelectedFactureId}
                getId={(f) => f.id}
                getLabel={(f) => f.numero_facture}
                getSublabel={(f) => f.fournisseur ?? ''}
                placeholder="Sélectionner une facture…"
              />
            )}
          </div>
        </div>
      </div>

      {/* État vide */}
      {!selectedCommandeId && !selectedFactureId && (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-gray-300 bg-white py-20 text-center">
          <svg className="mb-4 h-12 w-12 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" />
          </svg>
          <p className="text-sm font-medium text-gray-500">
            Sélectionnez une {mode === 'commande' ? 'commande' : 'facture'} pour afficher le rapprochement 3 voies
          </p>
        </div>
      )}

      {/* ── Vue Commande ─────────────────────────────────────────────────────── */}
      {mode === 'commande' && selectedCommande && cmdDetail && (
        <div className="space-y-4">
          {/* En-tête commande */}
          <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
            <div className="flex flex-wrap items-center gap-4">
              <div>
                <p className="text-xs text-gray-400">Commande</p>
                <p className="font-semibold text-gray-900">{selectedCommande.numero_commande_interne}</p>
              </div>
              <div>
                <p className="text-xs text-gray-400">Fournisseur</p>
                <p className="text-sm text-gray-700">{selectedCommande.fournisseur}</p>
              </div>
              <div className="ml-auto">
                <StatusBadge status={selectedCommande.statut_commande} />
              </div>
            </div>

            {/* KPIs */}
            <div className="mt-3 grid grid-cols-4 gap-3 border-t border-gray-100 pt-3">
              {[
                { label: 'Lignes', value: cmdKpis.total, cls: 'text-gray-700' },
                { label: 'OK', value: cmdKpis.ok, cls: 'text-emerald-600' },
                { label: 'Anomalies', value: cmdKpis.anomalie, cls: 'text-red-600' },
                { label: 'Non rapprochées', value: cmdKpis.nonRap, cls: 'text-gray-400' },
              ].map((k) => (
                <div key={k.label} className="text-center">
                  <p className={cn('text-xl font-bold', k.cls)}>{k.value}</p>
                  <p className="text-xs text-gray-400">{k.label}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Grille réconciliation */}
          <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium">L.</th>
                    <th className="px-4 py-3 text-left font-medium">Référence / Désignation</th>
                    <th className="px-4 py-3 text-right font-medium bg-blue-50">Qté cmd</th>
                    <th className="px-4 py-3 text-right font-medium bg-green-50">Qté reçue</th>
                    <th className="px-4 py-3 text-right font-medium bg-green-50">BE(s)</th>
                    <th className="px-4 py-3 text-right font-medium bg-amber-50">Qté fact.</th>
                    <th className="px-4 py-3 text-right font-medium bg-amber-50">Facture(s)</th>
                    <th className="px-4 py-3 text-right font-medium">Δ Réception</th>
                    <th className="px-4 py-3 text-right font-medium">Δ Facturation</th>
                    <th className="px-4 py-3 text-center font-medium">État</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {reconciliationCommande.map((row) => {
                    const totalRecu = row.matchingBELines.reduce((s, x) => s + x.lbe.quantite_receptionnee, 0);
                    const totalFact = row.invoiceLines.reduce((s, x) => s + x.lf.quantite_facturee, 0);
                    return (
                      <tr key={row.ligneCmd.id} className={etatClasses[row.etat]}>
                        <td className="px-4 py-3 text-gray-400">{row.ligneCmd.ligne_no}</td>
                        <td className="px-4 py-3">
                          <p className="font-medium text-gray-900">{row.ligneCmd.reference_article ?? '—'}</p>
                          <p className="text-xs text-gray-500 line-clamp-1">{row.ligneCmd.designation ?? ''}</p>
                        </td>
                        <td className="px-4 py-3 text-right font-medium text-blue-700">
                          {row.ligneCmd.quantite_commandee}
                        </td>
                        <td className="px-4 py-3 text-right text-green-700">
                          {row.matchingBELines.length > 0 ? totalRecu : '—'}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex flex-col gap-0.5 items-end">
                            {row.matchingBELines.map(({ be }) => (
                              <span key={be.id} className="text-xs text-gray-500">{be.numero_be}</span>
                            ))}
                            {row.matchingBELines.length === 0 && <span className="text-xs text-gray-300">—</span>}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right text-amber-700">
                          {row.invoiceLines.length > 0 ? totalFact : '—'}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex flex-col gap-0.5 items-end">
                            {row.invoiceLines.map(({ facture }) => (
                              <span key={facture.id} className="text-xs text-gray-500">{facture.numero_facture}</span>
                            ))}
                            {row.invoiceLines.length === 0 && <span className="text-xs text-gray-300">—</span>}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right">
                          {row.ecartQte === null ? (
                            <span className="text-gray-300">—</span>
                          ) : (
                            <span className={cn('font-medium', Math.abs(row.ecartQte) < 0.01 ? 'text-emerald-600' : 'text-red-600')}>
                              {row.ecartQte > 0 ? '+' : ''}{row.ecartQte}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {row.ecartFact === null ? (
                            <span className="text-gray-300">—</span>
                          ) : (
                            <span className={cn('font-medium', Math.abs(row.ecartFact) < 0.01 ? 'text-emerald-600' : 'text-amber-600')}>
                              {row.ecartFact > 0 ? '+' : ''}{row.ecartFact}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-center">
                          <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', etatBadge[row.etat])}>
                            {etatLabel[row.etat]}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* BEs liés */}
          {cmdDetail.bes.length > 0 && (
            <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
              <h3 className="mb-3 text-sm font-semibold text-gray-700">BEs liés ({cmdDetail.bes.length})</h3>
              <div className="flex flex-wrap gap-2">
                {cmdDetail.bes.map((be) => (
                  <div key={be.id} className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2">
                    <span className="text-sm font-medium text-gray-800">{be.numero_be}</span>
                    <StatusBadge status={be.statut_be} />
                    {be.date_bl && <span className="text-xs text-gray-400">{formatDate(be.date_bl)}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Vue Facture ──────────────────────────────────────────────────────── */}
      {mode === 'facture' && selectedFacture && factDetail && (
        <div className="space-y-4">
          {/* En-tête facture */}
          <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
            <div className="flex flex-wrap items-center gap-4">
              <div>
                <p className="text-xs text-gray-400">Facture</p>
                <p className="font-semibold text-gray-900">{selectedFacture.numero_facture}</p>
              </div>
              <div>
                <p className="text-xs text-gray-400">Fournisseur</p>
                <p className="text-sm text-gray-700">{selectedFacture.fournisseur ?? '—'}</p>
              </div>
              {selectedFacture.total_ht != null && (
                <div>
                  <p className="text-xs text-gray-400">Total HT</p>
                  <p className="text-sm font-medium text-gray-800">{formatEur(selectedFacture.total_ht)}</p>
                </div>
              )}
              <div className="ml-auto flex items-center gap-3">
                <StatusBadge status={selectedFacture.statut_facture} />
                <div className="flex items-center gap-2">
                  <div className="h-2 w-24 rounded-full bg-gray-200 overflow-hidden">
                    <div
                      className="h-full bg-indigo-500 rounded-full"
                      style={{ width: `${selectedFacture.taux_rapprochement ?? 0}%` }}
                    />
                  </div>
                  <span className="text-xs font-medium text-indigo-600">
                    {selectedFacture.taux_rapprochement ?? 0}%
                  </span>
                </div>
              </div>
            </div>

            {/* KPIs */}
            <div className="mt-3 grid grid-cols-4 gap-3 border-t border-gray-100 pt-3">
              {[
                { label: 'Lignes', value: factKpis.total, cls: 'text-gray-700' },
                { label: 'OK', value: factKpis.ok, cls: 'text-emerald-600' },
                { label: 'Anomalies', value: factKpis.anomalie, cls: 'text-red-600' },
                { label: 'Non rapprochées', value: factKpis.nonRap, cls: 'text-gray-400' },
              ].map((k) => (
                <div key={k.label} className="text-center">
                  <p className={cn('text-xl font-bold', k.cls)}>{k.value}</p>
                  <p className="text-xs text-gray-400">{k.label}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Grille réconciliation */}
          <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium">L.</th>
                    <th className="px-4 py-3 text-left font-medium">Référence / Désignation</th>
                    <th className="px-4 py-3 text-right font-medium bg-amber-50">Qté fact.</th>
                    <th className="px-4 py-3 text-right font-medium bg-amber-50">PU fact.</th>
                    <th className="px-4 py-3 text-right font-medium bg-green-50">Qté reçue</th>
                    <th className="px-4 py-3 text-right font-medium bg-green-50">BE(s)</th>
                    <th className="px-4 py-3 text-right font-medium bg-blue-50">PU cmd</th>
                    <th className="px-4 py-3 text-right font-medium bg-blue-50">Commande(s)</th>
                    <th className="px-4 py-3 text-right font-medium">Δ Qté</th>
                    <th className="px-4 py-3 text-right font-medium">Δ Prix</th>
                    <th className="px-4 py-3 text-center font-medium">État</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {reconciliationFacture.map((row) => {
                    const totalRecu = row.beLines.reduce((s, x) => s + x.lbe.quantite_receptionnee, 0);
                    const puCmd = row.cmdLines[0]?.lc.pu_commande ?? null;
                    return (
                      <tr key={row.lf.id} className={etatClasses[row.etat]}>
                        <td className="px-4 py-3 text-gray-400">{row.lf.ligne_no}</td>
                        <td className="px-4 py-3">
                          <p className="font-medium text-gray-900">{row.lf.reference_article ?? '—'}</p>
                          <p className="text-xs text-gray-500 line-clamp-1">{row.lf.designation ?? ''}</p>
                        </td>
                        <td className="px-4 py-3 text-right font-medium text-amber-700">
                          {row.lf.quantite_facturee}
                        </td>
                        <td className="px-4 py-3 text-right text-amber-700">
                          {row.lf.pu_facture != null ? formatEur(row.lf.pu_facture) : '—'}
                        </td>
                        <td className="px-4 py-3 text-right text-green-700">
                          {row.beLines.length > 0 ? totalRecu : '—'}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex flex-col gap-0.5 items-end">
                            {row.beLines.map(({ be }) => (
                              <span key={be.id} className="text-xs text-gray-500">{be.numero_be}</span>
                            ))}
                            {row.beLines.length === 0 && <span className="text-xs text-gray-300">—</span>}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right text-blue-700">
                          {puCmd != null ? formatEur(puCmd) : '—'}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex flex-col gap-0.5 items-end">
                            {row.cmdLines.map(({ cmd }) => (
                              <span key={cmd.id} className="text-xs text-gray-500">{cmd.numero_commande_interne}</span>
                            ))}
                            {row.cmdLines.length === 0 && <span className="text-xs text-gray-300">—</span>}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right">
                          {row.ecartQte === null ? (
                            <span className="text-gray-300">—</span>
                          ) : (
                            <span className={cn('font-medium', Math.abs(row.ecartQte) < 0.01 ? 'text-emerald-600' : 'text-red-600')}>
                              {row.ecartQte > 0 ? '+' : ''}{row.ecartQte}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {row.ecartPrix === null ? (
                            <span className="text-gray-300">—</span>
                          ) : (
                            <span className={cn('font-medium', Math.abs(row.ecartPrix) <= 2 ? 'text-emerald-600' : 'text-red-600')}>
                              {row.ecartPrix > 0 ? '+' : ''}{row.ecartPrix.toFixed(1)}%
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-center">
                          <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', etatBadge[row.etat])}>
                            {etatLabel[row.etat]}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Commandes liées */}
          {factDetail.cmdList.length > 0 && (
            <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
              <h3 className="mb-3 text-sm font-semibold text-gray-700">Commandes liées ({factDetail.cmdList.length})</h3>
              <div className="flex flex-wrap gap-2">
                {factDetail.cmdList.map((cmd) => (
                  <div key={cmd.id} className="flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2">
                    <span className="text-sm font-medium text-gray-800">{cmd.numero_commande_interne}</span>
                    <StatusBadge status={cmd.statut_commande} />
                    <span className="text-xs text-gray-400">{cmd.fournisseur}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Légende */}
      {(selectedCommandeId || selectedFactureId) && (
        <div className="flex flex-wrap gap-3 text-xs text-gray-500">
          <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded border-l-4 border-emerald-400 bg-emerald-50" />OK — écarts &lt; 0.01</span>
          <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded border-l-4 border-amber-400 bg-amber-50" />Partiel — facturation incomplète</span>
          <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded border-l-4 border-red-400 bg-red-50" />Anomalie — écart significatif</span>
          <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded bg-gray-50" />Non rapproché</span>
        </div>
      )}
    </div>
  );
}
