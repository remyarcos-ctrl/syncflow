'use client';

import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { selectAll } from '@/lib/select-all';
import { formatEur, formatDate, cn } from '@/utils';
import PageHeader from '@/components/shared/PageHeader';
import StatusBadge from '@/components/shared/StatusBadge';
import type { Commande, BEReception, Facture, Fournisseur } from '@/types';

// ── Types ────────────────────────────────────────────────────────────────────

type SlimCommande = Pick<Commande, 'id' | 'numero_commande_interne' | 'fournisseur' | 'statut_commande' | 'montant_total_commande' | 'date_commande'>;
type SlimBE = Pick<BEReception, 'id' | 'numero_be' | 'fournisseur' | 'statut_be' | 'date_bl'>;
type SlimFacture = Pick<Facture, 'id' | 'numero_facture' | 'fournisseur' | 'statut_facture' | 'total_ht' | 'taux_rapprochement' | 'date_facture'>;

interface FournisseurGroup {
  nom: string;
  commandes: SlimCommande[];
  bes: SlimBE[];
  factures: SlimFacture[];
  totalCommandes: number;
  totalFactures: number;
  tauxMoyenRap: number;
  nbAnomalies: number;
}

// Distance de Levenshtein (1 ligne mémoire, optimisé)
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const dp: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = temp;
    }
  }
  return dp[b.length];
}

// ── Composant principal ──────────────────────────────────────────────────────

export default function RapprochementsParFournisseurPage() {
  const [search, setSearch] = useState('');
  const [expandedFournisseur, setExpandedFournisseur] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Record<string, 'commandes' | 'bes' | 'factures'>>({});

  const { data: commandes = [], isLoading: loadingCmd } = useQuery({
    queryKey: ['rp-commandes'],
    queryFn: async () => {
      const { data } = await supabase
        .from('commandes')
        .select('id,numero_commande_interne,fournisseur,statut_commande,montant_total_commande,date_commande')
        .order('fournisseur');
      return (data ?? []) as SlimCommande[];
    },
  });

  // Montants calculés depuis les lignes quand montant_total_commande est null
  const { data: lignesCmd = [] } = useQuery({
    queryKey: ['rp-lignes-commande'],
    queryFn: async () => {
      return await selectAll<{ commande_id: string; pu_commande: number | null; quantite_commandee: number | null }>(
        () => supabase.from('lignes_commande').select('commande_id,pu_commande,quantite_commandee'));
    },
    staleTime: 60_000,
  });

  // Map commande_id → montant calculé depuis les lignes
  const montantParCommande = useMemo(() => {
    const map = new Map<string, number>();
    for (const l of lignesCmd) {
      const m = (l.pu_commande ?? 0) * (l.quantite_commandee ?? 0);
      map.set(l.commande_id, (map.get(l.commande_id) ?? 0) + m);
    }
    return map;
  }, [lignesCmd]);

  const { data: bes = [], isLoading: loadingBE } = useQuery({
    queryKey: ['rp-bes'],
    queryFn: async () => {
      const { data } = await supabase
        .from('be_receptions')
        .select('id,numero_be,fournisseur,statut_be,date_bl')
        .order('fournisseur');
      return (data ?? []) as SlimBE[];
    },
  });

  const { data: factures = [], isLoading: loadingFact } = useQuery({
    queryKey: ['rp-factures'],
    queryFn: async () => {
      const { data } = await supabase
        .from('factures')
        .select('id,numero_facture,fournisseur,statut_facture,total_ht,taux_rapprochement,date_facture')
        .order('fournisseur');
      return (data ?? []) as SlimFacture[];
    },
  });

  const { data: fournisseurs = [] } = useQuery<Pick<Fournisseur, 'nom' | 'aliases'>[]>({
    queryKey: ['rp-fournisseurs'],
    queryFn: async () => {
      const { data } = await supabase.from('fournisseurs').select('nom, aliases').eq('actif', true);
      return data ?? [];
    },
    staleTime: 60_000,
  });

  // Regroupement par fournisseur
  const groups = useMemo((): FournisseurGroup[] => {
    // Normalise pour la clé de regroupement : majuscules, trim, espaces condensés, tirets/points supprimés
    const normalizeKey = (s: string | null | undefined): string => {
      if (!s) return 'SANS FOURNISSEUR';
      return s.toUpperCase().trim().replace(/[-.']/g, ' ').replace(/\s+/g, ' ');
    };

    // Construire un map alias → nom canonical depuis la table fournisseurs
    const aliasToCanonical = new Map<string, string>();
    for (const f of fournisseurs) {
      const normNom = normalizeKey(f.nom);
      aliasToCanonical.set(normNom, f.nom);
      if (f.aliases) {
        const aliasList = f.aliases.startsWith('[')
          ? (JSON.parse(f.aliases) as string[])
          : f.aliases.split(',').map(a => a.trim());
        for (const alias of aliasList) {
          if (alias) aliasToCanonical.set(normalizeKey(alias), f.nom);
        }
      }
    }

    // Résoudre le nom canonique (alias DB prioritaire, sinon normalisation simple)
    const resolveKey = (rawNom: string | null | undefined): { key: string; canonical: string | null } => {
      const norm = normalizeKey(rawNom);
      const canonical = aliasToCanonical.get(norm) ?? null;
      return { key: canonical ? normalizeKey(canonical) : norm, canonical };
    };

    // map key → { group, nameFreq }
    const map = new Map<string, { group: FournisseurGroup; nameFreq: Map<string, number> }>();

    const getOrCreate = (rawNom: string | null | undefined) => {
      let { key, canonical } = resolveKey(rawNom);
      const displayName = canonical ?? rawNom?.trim() ?? 'Sans fournisseur';

      // Fuzzy match sur le premier mot (seuil distance ≤ 1, min 5 chars)
      // Uniquement si aucun alias exact n'a résolu le nom
      if (!map.has(key) && !canonical) {
        const keyFirstWord = key.split(' ')[0];
        if (keyFirstWord.length >= 5) {
          for (const existingKey of map.keys()) {
            const existingFirstWord = existingKey.split(' ')[0];
            if (existingFirstWord.length >= 5 && levenshtein(keyFirstWord, existingFirstWord) <= 1) {
              key = existingKey;
              break;
            }
          }
        }
      }

      if (!map.has(key)) {
        map.set(key, {
          group: {
            nom: displayName,
            commandes: [],
            bes: [],
            factures: [],
            totalCommandes: 0,
            totalFactures: 0,
            tauxMoyenRap: 0,
            nbAnomalies: 0,
          },
          nameFreq: new Map(),
        });
      }
      const entry = map.get(key)!;
      // Suivre la fréquence de chaque variante de nom
      entry.nameFreq.set(displayName, (entry.nameFreq.get(displayName) ?? 0) + 1);
      return entry.group;
    };

    for (const c of commandes) {
      const g = getOrCreate(c.fournisseur);
      g.commandes.push(c);
      // Utilise montant_total_commande s'il est renseigné, sinon calcule depuis les lignes
      const montant = c.montant_total_commande ?? montantParCommande.get(c.id) ?? 0;
      g.totalCommandes += montant;
      if (c.statut_commande === 'en anomalie') g.nbAnomalies++;
    }

    for (const be of bes) {
      const g = getOrCreate(be.fournisseur);
      g.bes.push(be);
      if (be.statut_be === 'en anomalie') g.nbAnomalies++;
    }

    for (const f of factures) {
      const g = getOrCreate(f.fournisseur);
      g.factures.push(f);
      g.totalFactures += f.total_ht ?? 0;
      if (f.statut_facture === 'en anomalie') g.nbAnomalies++;
    }

    // Affecter le nom le plus fréquent à chaque groupe
    for (const { group, nameFreq } of map.values()) {
      if (nameFreq.size > 1) {
        let bestName = group.nom;
        let bestCount = 0;
        for (const [name, count] of nameFreq) {
          if (count > bestCount) { bestCount = count; bestName = name; }
        }
        group.nom = bestName;
      }
    }

    // Calculer taux moyen de rapprochement
    for (const { group: g } of map.values()) {
      if (g.factures.length > 0) {
        g.tauxMoyenRap = g.factures.reduce((s, f) => s + (f.taux_rapprochement ?? 0), 0) / g.factures.length;
      }
    }

    return Array.from(map.values()).map((e) => e.group).sort((a, b) => a.nom.localeCompare(b.nom));
  }, [commandes, bes, factures, fournisseurs, montantParCommande]);

  const filtered = useMemo(() => {
    if (!search) return groups;
    const q = search.toLowerCase();
    return groups.filter((g) => g.nom.toLowerCase().includes(q));
  }, [groups, search]);

  const isLoading = loadingCmd || loadingBE || loadingFact;


  // KPIs globaux
  const globalKpis = useMemo(() => ({
    fournisseurs: groups.length,
    commandes: commandes.length,
    bes: bes.length,
    factures: factures.length,
    montantTotal: commandes.reduce((s, c) => s + (c.montant_total_commande ?? montantParCommande.get(c.id) ?? 0), 0),
    tauxMoyen: factures.length > 0
      ? factures.reduce((s, f) => s + (f.taux_rapprochement ?? 0), 0) / factures.length
      : 0,
    anomalies: groups.reduce((s, g) => s + g.nbAnomalies, 0),
  }), [groups, commandes, bes, factures, montantParCommande]);

  const getTab = (nom: string) => activeTab[nom] ?? 'commandes';
  const setTab = (nom: string, tab: 'commandes' | 'bes' | 'factures') =>
    setActiveTab((prev) => ({ ...prev, [nom]: tab }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Par fournisseur"
        subtitle="Vue agrégée des commandes, BEs et factures par fournisseur"
      />

      {/* KPIs globaux */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        {[
          { label: 'Fournisseurs', value: globalKpis.fournisseurs, cls: 'text-indigo-600' },
          { label: 'Commandes', value: globalKpis.commandes, cls: 'text-blue-600' },
          { label: 'BEs', value: globalKpis.bes, cls: 'text-green-600' },
          { label: 'Factures', value: globalKpis.factures, cls: 'text-amber-600' },
          { label: 'Montant cmd', value: formatEur(globalKpis.montantTotal), cls: 'text-gray-700' },
          { label: 'Taux rap. moy.', value: `${globalKpis.tauxMoyen.toFixed(0)}%`, cls: 'text-indigo-600' },
          { label: 'Anomalies', value: globalKpis.anomalies, cls: globalKpis.anomalies > 0 ? 'text-red-600' : 'text-gray-400' },
        ].map((k) => (
          <div key={k.label} className="rounded-xl border border-gray-200 bg-white p-3 text-center shadow-sm">
            <p className={cn('text-lg font-bold', k.cls)}>{k.value}</p>
            <p className="text-xs text-gray-400">{k.label}</p>
          </div>
        ))}
      </div>

      {/* Recherche */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-xs">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filtrer par fournisseur…"
            className="w-full rounded-lg border border-gray-300 pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>
        <span className="text-sm text-gray-400">{filtered.length} fournisseur{filtered.length !== 1 ? 's' : ''}</span>
      </div>

      {/* Liste des groupes */}
      {isLoading ? (
        <div className="flex h-40 items-center justify-center">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-gray-300 bg-white py-16 text-center">
          <p className="text-sm text-gray-400">Aucun fournisseur trouvé</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((group) => {
            const expanded = expandedFournisseur === group.nom;
            const tab = getTab(group.nom);
            const cmdSolde = group.commandes.filter((c) => c.statut_commande === 'soldée').length;
            const factRap = group.factures.filter((f) => f.statut_facture === 'rapprochée').length;

            return (
              <div key={group.nom} className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
                {/* En-tête fournisseur */}
                <button
                  type="button"
                  onClick={() => setExpandedFournisseur(expanded ? null : group.nom)}
                  className="w-full px-5 py-4 flex items-center gap-4 hover:bg-gray-50 transition-colors text-left"
                >
                  {/* Icône */}
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-indigo-100 text-indigo-700 font-bold text-sm shrink-0">
                    {group.nom.slice(0, 2).toUpperCase()}
                  </div>

                  {/* Nom */}
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-gray-900 truncate">{group.nom}</p>
                    <p className="text-xs text-gray-400">
                      {group.commandes.length} commande{group.commandes.length !== 1 ? 's' : ''} ·{' '}
                      {group.bes.length} BE{group.bes.length !== 1 ? 's' : ''} ·{' '}
                      {group.factures.length} facture{group.factures.length !== 1 ? 's' : ''}
                    </p>
                  </div>

                  {/* Stats */}
                  <div className="hidden sm:flex items-center gap-6 text-right">
                    {group.totalCommandes > 0 && (
                      <div>
                        <p className="text-sm font-medium text-blue-700">{formatEur(group.totalCommandes)}</p>
                        <p className="text-xs text-gray-400">Commandes</p>
                      </div>
                    )}
                    {group.totalFactures > 0 && (
                      <div>
                        <p className="text-sm font-medium text-amber-700">{formatEur(group.totalFactures)}</p>
                        <p className="text-xs text-gray-400">Facturé HT</p>
                      </div>
                    )}
                    {group.factures.length > 0 && (
                      <div className="flex flex-col items-end gap-1">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-20 rounded-full bg-gray-200 overflow-hidden">
                            <div
                              className={cn(
                                'h-full rounded-full',
                                group.tauxMoyenRap >= 90 ? 'bg-emerald-500' : group.tauxMoyenRap >= 50 ? 'bg-amber-500' : 'bg-red-500'
                              )}
                              style={{ width: `${group.tauxMoyenRap}%` }}
                            />
                          </div>
                          <span className="text-xs font-medium text-gray-600">{group.tauxMoyenRap.toFixed(0)}%</span>
                        </div>
                        <p className="text-xs text-gray-400">Rap. moyen</p>
                      </div>
                    )}
                    {group.nbAnomalies > 0 && (
                      <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
                        {group.nbAnomalies} anomalie{group.nbAnomalies !== 1 ? 's' : ''}
                      </span>
                    )}
                  </div>

                  {/* Chevron */}
                  <svg
                    className={cn('h-4 w-4 text-gray-400 shrink-0 transition-transform', expanded && 'rotate-180')}
                    fill="none" viewBox="0 0 24 24" stroke="currentColor"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>

                {/* Contenu déplié */}
                {expanded && (
                  <div className="border-t border-gray-100">
                    {/* Tabs */}
                    <div className="flex border-b border-gray-100 bg-gray-50 px-4">
                      {(
                        [
                          { key: 'commandes', label: `Commandes (${group.commandes.length})` },
                          { key: 'bes', label: `BEs (${group.bes.length})` },
                          { key: 'factures', label: `Factures (${group.factures.length})` },
                        ] as { key: 'commandes' | 'bes' | 'factures'; label: string }[]
                      ).map((t) => (
                        <button
                          key={t.key}
                          onClick={() => setTab(group.nom, t.key)}
                          className={cn(
                            'px-4 py-2.5 text-sm font-medium border-b-2 transition-colors',
                            tab === t.key
                              ? 'border-indigo-500 text-indigo-600'
                              : 'border-transparent text-gray-500 hover:text-gray-700',
                          )}
                        >
                          {t.label}
                        </button>
                      ))}
                    </div>

                    {/* Tab: Commandes */}
                    {tab === 'commandes' && (
                      <div className="overflow-x-auto">
                        {group.commandes.length === 0 ? (
                          <p className="px-5 py-6 text-sm text-gray-400 text-center">Aucune commande</p>
                        ) : (
                          <table className="min-w-full text-sm">
                            <thead className="bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
                              <tr>
                                <th className="px-4 py-2.5 text-left font-medium">N° Commande</th>
                                <th className="px-4 py-2.5 text-left font-medium">Date</th>
                                <th className="px-4 py-2.5 text-right font-medium">Montant HT</th>
                                <th className="px-4 py-2.5 text-center font-medium">Statut</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-50">
                              {group.commandes.map((c) => (
                                <tr key={c.id} className="hover:bg-gray-50">
                                  <td className="px-4 py-2.5 font-medium text-gray-900">
                                    <a href={`/commandes/${c.id}`} className="hover:text-indigo-600 hover:underline">
                                      {c.numero_commande_interne}
                                    </a>
                                  </td>
                                  <td className="px-4 py-2.5 text-gray-500">
                                    {c.date_commande ? formatDate(c.date_commande) : '—'}
                                  </td>
                                  <td className="px-4 py-2.5 text-right text-gray-700">
                                    {formatEur(c.montant_total_commande ?? montantParCommande.get(c.id) ?? null)}
                                  </td>
                                  <td className="px-4 py-2.5 text-center">
                                    <StatusBadge status={c.statut_commande} />
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                            {group.commandes.length > 0 && (
                              <tfoot className="bg-gray-50 border-t border-gray-200 text-xs font-medium text-gray-500">
                                <tr>
                                  <td colSpan={2} className="px-4 py-2">
                                    {cmdSolde}/{group.commandes.length} soldées
                                  </td>
                                  <td className="px-4 py-2 text-right text-gray-700">
                                    {formatEur(group.totalCommandes)}
                                  </td>
                                  <td />
                                </tr>
                              </tfoot>
                            )}
                          </table>
                        )}
                      </div>
                    )}

                    {/* Tab: BEs */}
                    {tab === 'bes' && (
                      <div className="overflow-x-auto">
                        {group.bes.length === 0 ? (
                          <p className="px-5 py-6 text-sm text-gray-400 text-center">Aucun BE</p>
                        ) : (
                          <table className="min-w-full text-sm">
                            <thead className="bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
                              <tr>
                                <th className="px-4 py-2.5 text-left font-medium">N° BE</th>
                                <th className="px-4 py-2.5 text-left font-medium">Date BL</th>
                                <th className="px-4 py-2.5 text-center font-medium">Statut</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-50">
                              {group.bes.map((be) => (
                                <tr key={be.id} className="hover:bg-gray-50">
                                  <td className="px-4 py-2.5 font-medium text-gray-900">
                                    <a href={`/be-receptions/${be.id}`} className="hover:text-indigo-600 hover:underline">
                                      {be.numero_be}
                                    </a>
                                  </td>
                                  <td className="px-4 py-2.5 text-gray-500">
                                    {be.date_bl ? formatDate(be.date_bl) : '—'}
                                  </td>
                                  <td className="px-4 py-2.5 text-center">
                                    <StatusBadge status={be.statut_be} />
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </div>
                    )}

                    {/* Tab: Factures */}
                    {tab === 'factures' && (
                      <div className="overflow-x-auto">
                        {group.factures.length === 0 ? (
                          <p className="px-5 py-6 text-sm text-gray-400 text-center">Aucune facture</p>
                        ) : (
                          <table className="min-w-full text-sm">
                            <thead className="bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
                              <tr>
                                <th className="px-4 py-2.5 text-left font-medium">N° Facture</th>
                                <th className="px-4 py-2.5 text-left font-medium">Date</th>
                                <th className="px-4 py-2.5 text-right font-medium">Total HT</th>
                                <th className="px-4 py-2.5 text-right font-medium">Taux rap.</th>
                                <th className="px-4 py-2.5 text-center font-medium">Statut</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-50">
                              {group.factures.map((f) => (
                                <tr key={f.id} className="hover:bg-gray-50">
                                  <td className="px-4 py-2.5 font-medium text-gray-900">
                                    <a href={`/factures/${f.id}`} className="hover:text-indigo-600 hover:underline">
                                      {f.numero_facture}
                                    </a>
                                  </td>
                                  <td className="px-4 py-2.5 text-gray-500">
                                    {f.date_facture ? formatDate(f.date_facture) : '—'}
                                  </td>
                                  <td className="px-4 py-2.5 text-right text-gray-700">
                                    {f.total_ht != null ? formatEur(f.total_ht) : '—'}
                                  </td>
                                  <td className="px-4 py-2.5 text-right">
                                    <div className="flex items-center justify-end gap-2">
                                      <div className="h-1.5 w-16 rounded-full bg-gray-200 overflow-hidden">
                                        <div
                                          className={cn(
                                            'h-full rounded-full',
                                            (f.taux_rapprochement ?? 0) >= 90 ? 'bg-emerald-500'
                                              : (f.taux_rapprochement ?? 0) >= 50 ? 'bg-amber-500'
                                              : 'bg-red-500'
                                          )}
                                          style={{ width: `${f.taux_rapprochement ?? 0}%` }}
                                        />
                                      </div>
                                      <span className="text-xs font-medium text-gray-600 w-8 text-right">
                                        {f.taux_rapprochement ?? 0}%
                                      </span>
                                    </div>
                                  </td>
                                  <td className="px-4 py-2.5 text-center">
                                    <StatusBadge status={f.statut_facture} />
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                            {group.factures.length > 0 && (
                              <tfoot className="bg-gray-50 border-t border-gray-200 text-xs font-medium text-gray-500">
                                <tr>
                                  <td colSpan={2} className="px-4 py-2">
                                    {factRap}/{group.factures.length} rapprochées
                                  </td>
                                  <td className="px-4 py-2 text-right text-gray-700">
                                    {formatEur(group.totalFactures)}
                                  </td>
                                  <td className="px-4 py-2 text-right text-indigo-600">
                                    {group.tauxMoyenRap.toFixed(0)}% moy.
                                  </td>
                                  <td />
                                </tr>
                              </tfoot>
                            )}
                          </table>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
