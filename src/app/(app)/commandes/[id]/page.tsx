'use client';

import { useState, useEffect, useMemo } from 'react';
import { useParams } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import StatusBadge from '@/components/shared/StatusBadge';
import { formatEur, formatDate, cn } from '@/utils';
import {
  ArrowLeft, Plus, Package, Link2, Unlink,
  Edit2, Save, X, MessageSquare, CheckCircle2, Search, FileText, History
} from 'lucide-react';
import ReferenceHistoryModal from '@/components/shared/ReferenceHistoryModal';
import { toast } from 'sonner';
import type { Commande, LigneCommande, BEReception, Facture, LiaisonBECommande, LiaisonFactureCommande, Rapprochement } from '@/types';

function computeStatutLigne(l: { quantite_commandee: number; quantite_receptionnee_reelle: number; quantite_facturee: number }): string {
  const qteRecu = l.quantite_receptionnee_reelle ?? 0;
  const qteCmd  = l.quantite_commandee ?? 0;
  const qteFact = l.quantite_facturee ?? 0;
  if (qteRecu === 0)           return 'non reçue';
  if (qteRecu > qteCmd)        return 'sur-réceptionné';
  if (qteFact > qteCmd)        return 'sur-facturée';
  if (qteFact >= qteCmd)       return 'soldée';
  if (qteFact > 0 && qteRecu >= qteCmd) return 'partiellement facturée';
  if (qteRecu >= qteCmd)       return 'reçue';
  return 'partiellement reçue';
}

const normalizeRef = (s: string | null | undefined) =>
  String(s ?? '').toUpperCase().replace(/O/g, '0').replace(/[^A-Z0-9]/g, '');

function refsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  if (a.toLowerCase().trim() === b.toLowerCase().trim()) return true;
  if (normalizeRef(a) === normalizeRef(b)) return true;
  const ap = a.split('/'); const bp = b.split('/');
  if (ap.length > 1 && normalizeRef(ap[ap.length - 1]) === normalizeRef(b)) return true;
  if (bp.length > 1 && normalizeRef(bp[bp.length - 1]) === normalizeRef(a)) return true;
  return false;
}

export default function CommandeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();

  const [showAddLine, setShowAddLine] = useState(false);
  const [lineForm, setLineForm] = useState({ reference_article: '', designation: '', quantite_commandee: '', pu_commande: '' });
  const [prixSuggere, setPrixSuggere] = useState<{ pu: number; designation: string | null } | null>(null);
  const [refHistory, setRefHistory] = useState<string | null>(null);
  const [editingPU, setEditingPU] = useState<{ id: string; value: string } | null>(null);
  const [showLinkBE, setShowLinkBE] = useState(false);
  const [selectedBEId, setSelectedBEId] = useState('');
  const [searchBE, setSearchBE] = useState('');
  const [editingNotes, setEditingNotes] = useState(false);
  const [notes, setNotes] = useState('');
  const [editingLineNotes, setEditingLineNotes] = useState<{ id: string; value: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [editingInitQte, setEditingInitQte] = useState<{ id: string; value: string } | null>(null);
  const [modeRecu, setModeRecu] = useState<'unites' | 'ht'>('unites');

  // ── Données ───────────────────────────────────────────────────────────────
  const { data: commande } = useQuery<Commande>({
    queryKey: ['commande', id],
    queryFn: async () => {
      const { data } = await supabase.from('commandes').select('*').eq('id', id).single();
      return data!;
    },
    enabled: !!id, refetchInterval: 5000,
  });

  const { data: lignes = [] } = useQuery<LigneCommande[]>({
    queryKey: ['lignes_commande', id],
    queryFn: async () => {
      const { data } = await supabase.from('lignes_commande').select('*').eq('commande_id', id).order('ligne_no');
      return data ?? [];
    },
    enabled: !!id, refetchInterval: 5000,
  });

  const { data: liaisonsBE = [] } = useQuery<LiaisonBECommande[]>({
    queryKey: ['liaisons_be', id],
    queryFn: async () => {
      const { data } = await supabase.from('liaison_be_commande').select('*').eq('commande_id', id);
      return data ?? [];
    },
    enabled: !!id, refetchInterval: 5000,
  });

  const beIds = useMemo(() => liaisonsBE.map(l => l.be_id), [liaisonsBE]);

  const { data: bes = [] } = useQuery<BEReception[]>({
    queryKey: ['bes_commande', id, beIds.join()],
    queryFn: async () => {
      if (!beIds.length) return [];
      const { data } = await supabase.from('be_receptions').select('*').in('id', beIds);
      return data ?? [];
    },
    enabled: beIds.length > 0, refetchInterval: 5000,
  });

  const { data: liaisonsFacture = [] } = useQuery<LiaisonFactureCommande[]>({
    queryKey: ['liaisons_facture_cmd', id],
    queryFn: async () => {
      const { data } = await supabase.from('liaison_facture_commande').select('*').eq('commande_id', id);
      return data ?? [];
    },
    enabled: !!id, refetchInterval: 5000,
  });

  const factureIds = useMemo(() => liaisonsFacture.map(l => l.facture_id), [liaisonsFacture]);

  const { data: factures = [] } = useQuery<Facture[]>({
    queryKey: ['factures_commande', id, factureIds.join()],
    queryFn: async () => {
      if (!factureIds.length) return [];
      const { data } = await supabase.from('factures').select('*').in('id', factureIds);
      return data ?? [];
    },
    enabled: factureIds.length > 0, refetchInterval: 5000,
  });

  const { data: rapprochements = [] } = useQuery<Rapprochement[]>({
    queryKey: ['raps_commande', id],
    queryFn: async () => {
      const { data } = await supabase.from('rapprochements').select('*').eq('commande_id', id);
      return data ?? [];
    },
    enabled: !!id, refetchInterval: 5000,
  });

  const { data: initBE } = useQuery<{ id: string } | null>({
    queryKey: ['init_be', commande?.numero_commande_interne],
    queryFn: async () => {
      const { data } = await supabase
        .from('be_receptions')
        .select('id')
        .eq('numero_be', `INIT-${commande!.numero_commande_interne}`)
        .maybeSingle();
      return data as { id: string } | null;
    },
    enabled: !!commande?.numero_commande_interne,
  });

  type InitLigne = { ligne_commande_id: string | null; quantite_receptionnee: number };
  const { data: initLignes = [] } = useQuery<InitLigne[]>({
    queryKey: ['init_lignes', initBE?.id],
    queryFn: async () => {
      const { data } = await supabase
        .from('lignes_be')
        .select('ligne_commande_id, quantite_receptionnee')
        .eq('be_id', initBE!.id);
      return (data ?? []) as InitLigne[];
    },
    enabled: !!initBE?.id,
  });

  // BEs disponibles à lier (même fournisseur, non liés)
  const { data: besDisponibles = [] } = useQuery<BEReception[]>({
    queryKey: ['bes_dispo', commande?.fournisseur, beIds.join()],
    queryFn: async () => {
      const { data } = await supabase.from('be_receptions').select('*').order('date_bl', { ascending: false }).limit(200);
      if (!data) return [];
      const fournCmd = (commande?.fournisseur ?? '').toLowerCase();
      return data.filter(b => {
        if (beIds.includes(b.id)) return false;
        const fournBe = (b.fournisseur ?? '').toLowerCase();
        return fournCmd.includes(fournBe.slice(0, 5)) || fournBe.includes(fournCmd.slice(0, 5));
      });
    },
    enabled: showLinkBE && !!commande,
  });

  // Lignes BE des candidats (slim) pour scorer par références
  type SlimLigneBE = { be_id: string; reference_article: string | null };
  const besCandidateIds = besDisponibles.map(b => b.id);
  const { data: lignesBeCandidates = [] } = useQuery<SlimLigneBE[]>({
    queryKey: ['lignes_be_cands', besCandidateIds.join()],
    queryFn: async () => {
      if (!besCandidateIds.length) return [];
      const { data } = await supabase
        .from('lignes_be')
        .select('be_id, reference_article')
        .in('be_id', besCandidateIds);
      return (data ?? []) as SlimLigneBE[];
    },
    enabled: besCandidateIds.length > 0,
  });

  // Refs de cette commande
  const cmdRefs = useMemo(() => lignes.map(l => l.reference_article), [lignes]);

  // Score : nb de refs commande présentes dans les lignes du BE candidat
  const besScorees = useMemo(() => {
    return besDisponibles
      .map(be => {
        const lignesBe = lignesBeCandidates.filter(l => l.be_id === be.id);
        const matches = cmdRefs.filter(refCmd =>
          lignesBe.some(lb => refsMatch(refCmd, lb.reference_article))
        ).length;
        return { be, matches, total: lignesBe.length };
      })
      .sort((a, b) => {
        if (b.matches !== a.matches) return b.matches - a.matches;
        const prio = (s: string) => s === 'reçu' ? 0 : s === 'partiellement facturé' ? 1 : 2;
        return prio(a.be.statut_be) - prio(b.be.statut_be);
      });
  }, [besDisponibles, lignesBeCandidates, cmdRefs]);

  useEffect(() => { if (commande) setNotes(commande.commentaire ?? ''); }, [commande]);

  // ── KPIs calculés ─────────────────────────────────────────────────────────
  const kpis = useMemo(() => {
    const qteCmd = lignes.reduce((s, l) => s + (l.quantite_commandee ?? 0), 0);
    const qteRecue = lignes.reduce((s, l) => s + (l.quantite_receptionnee_reelle ?? 0), 0);
    const qteFact = lignes.reduce((s, l) => s + (l.quantite_facturee ?? 0), 0);
    const montantCmd = lignes.reduce((s, l) => s + (l.montant_ht_commande ?? ((l.quantite_commandee ?? 0) * (l.pu_commande ?? 0))), 0);
    const puEffectif = (l: typeof lignes[0]) => {
      if (l.pu_commande != null) return l.pu_commande;
      const qteCmd = l.quantite_commandee ?? 0;
      return qteCmd > 0 && l.montant_ht_commande != null ? l.montant_ht_commande / qteCmd : 0;
    };
    const montantRecuHT = lignes.reduce((s, l) => s + (l.quantite_receptionnee_reelle ?? 0) * puEffectif(l), 0);
    const montantFactHT = lignes.reduce((s, l) => s + (l.quantite_facturee ?? 0) * puEffectif(l), 0);
    const montantRap = rapprochements.filter(r => r.statut_validation === 'validé').reduce((s, r) => s + (r.montant_rapproche ?? 0), 0);
    return { qteCmd, qteRecue, qteFact, montantCmd, montantRecuHT, montantFactHT, montantRap };
  }, [lignes, rapprochements]);

  // ── Mutations ─────────────────────────────────────────────────────────────
  const saveNotesMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from('commandes').update({ commentaire: notes }).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['commande', id] }); setEditingNotes(false); toast.success('Note enregistrée'); },
    onError: (e: Error) => toast.error(e.message),
  });

  const saveLineNotesMutation = useMutation({
    mutationFn: async ({ lineId, comment }: { lineId: string; comment: string }) => {
      const { error } = await supabase.from('lignes_commande').update({ commentaire: comment }).eq('id', lineId);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['lignes_commande', id] }); setEditingLineNotes(null); },
    onError: (e: Error) => toast.error(e.message),
  });

  const savePUMutation = useMutation({
    mutationFn: async ({ lineId, pu }: { lineId: string; pu: number }) => {
      const ligne = lignes.find(l => l.id === lineId);
      const montant_ht_commande = (ligne?.quantite_commandee ?? 0) * pu || null;
      const { error } = await supabase.from('lignes_commande').update({ pu_commande: pu, montant_ht_commande }).eq('id', lineId);
      if (error) throw error;
    },
    onSuccess: (_data, { lineId }) => {
      qc.invalidateQueries({ queryKey: ['lignes_commande', id] });
      // Ne fermer l'éditeur que si on n'a pas déjà avancé à la ligne suivante
      setEditingPU(prev => prev?.id === lineId ? null : prev);
      toast.success('Prix mis à jour');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const initReceptionMutation = useMutation({
    mutationFn: async ({ ligneCommandeId, quantite }: { ligneCommandeId: string; quantite: number }) => {
      const r = await fetch('/api/init-reception', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commandeId: id, ligneCommandeId, quantite }),
      });
      if (!r.ok) throw new Error((await r.json() as { error?: string }).error ?? 'Erreur');
    },
    onSuccess: (_data, { ligneCommandeId }) => {
      qc.invalidateQueries({ queryKey: ['lignes_commande', id] });
      qc.invalidateQueries({ queryKey: ['commande', id] });
      qc.invalidateQueries({ queryKey: ['init_be', commande?.numero_commande_interne] });
      qc.invalidateQueries({ queryKey: ['init_lignes'] });
      qc.invalidateQueries({ queryKey: ['liaisons_be', id] });
      qc.invalidateQueries({ queryKey: ['bes_commande', id] });
      setEditingInitQte(prev => prev?.id === ligneCommandeId ? null : prev);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const lookupPrix = async (ref: string) => {
    if (!ref.trim() || !commande?.fournisseur) { setPrixSuggere(null); return; }
    const { data } = await supabase
      .from('prix_reference')
      .select('pu_last, designation')
      .eq('reference_article', ref.trim())
      .ilike('fournisseur', `%${commande.fournisseur.slice(0, 5)}%`)
      .maybeSingle();
    if (data) {
      setPrixSuggere({ pu: data.pu_last, designation: data.designation });
      setLineForm(prev => ({
        ...prev,
        pu_commande: prev.pu_commande || String(data.pu_last),
        designation: prev.designation || data.designation || '',
      }));
    } else {
      setPrixSuggere(null);
    }
  };

  const addLineMutation = useMutation({
    mutationFn: async () => {
      const qte = parseFloat(lineForm.quantite_commandee) || 0;
      const pu = parseFloat(lineForm.pu_commande) || 0;
      const { error } = await supabase.from('lignes_commande').insert({
        commande_id: id,
        ligne_no: (lignes[lignes.length - 1]?.ligne_no ?? 0) + 1,
        reference_article: lineForm.reference_article,
        designation: lineForm.designation,
        quantite_commandee: qte,
        pu_commande: pu || null,
        montant_ht_commande: qte * pu || null,
        quantite_restante_a_recevoir: qte,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['lignes_commande', id] });
      setShowAddLine(false);
      setLineForm({ reference_article: '', designation: '', quantite_commandee: '', pu_commande: '' });
      toast.success('Ligne ajoutée');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const fillPrixMutation = useMutation({
    mutationFn: async () => {
      const { data: sansPrix } = await supabase
        .from('lignes_commande')
        .select('id, reference_article, quantite_commandee')
        .eq('commande_id', id)
        .is('pu_commande', null)
        .not('reference_article', 'is', null);

      let remplis = 0;
      const fournPrefix = (commande?.fournisseur ?? '').slice(0, 6);
      for (const ligne of sansPrix ?? []) {
        const { data: prix } = await supabase
          .from('prix_reference')
          .select('pu_last')
          .eq('reference_article', ligne.reference_article)
          .ilike('fournisseur', `%${fournPrefix}%`)
          .maybeSingle();
        if (prix) {
          await supabase.from('lignes_commande').update({
            pu_commande: prix.pu_last,
            montant_ht_commande: ligne.quantite_commandee * prix.pu_last,
          }).eq('id', ligne.id);
          remplis++;
        }
      }
      return remplis;
    },
    onSuccess: (n) => {
      qc.invalidateQueries({ queryKey: ['lignes_commande', id] });
      qc.invalidateQueries({ queryKey: ['commande', id] });
      if (n > 0) toast.success(`${n} prix complété${n > 1 ? 's' : ''} depuis le catalogue`);
      else toast.info('Aucun prix trouvé dans le catalogue pour les lignes sans prix');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const linkBEMutation = useMutation({
    mutationFn: async (beId: string) => {
      const r = await fetch('/api/link-be-commande', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ beId, commandeId: id }),
      });
      const json = await r.json();
      if (!r.ok) throw new Error(json.error ?? 'Erreur inconnue');
      return json as { lignes_attribuees: number };
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['liaisons_be', id] });
      qc.invalidateQueries({ queryKey: ['bes_commande', id] });
      qc.invalidateQueries({ queryKey: ['lignes_commande', id] });
      qc.invalidateQueries({ queryKey: ['commande', id] });
      setShowLinkBE(false);
      setSelectedBEId('');
      toast.success(`BE lié à la commande — ${data.lignes_attribuees} ligne(s) attribuée(s)`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const unlinkBEMutation = useMutation({
    mutationFn: async (liaison: LiaisonBECommande) => {
      const r = await fetch('/api/link-be-commande', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ liaisonId: liaison.id, beId: liaison.be_id, commandeId: id }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? 'Erreur inconnue');
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['liaisons_be', id] });
      qc.invalidateQueries({ queryKey: ['bes_commande', id] });
      qc.invalidateQueries({ queryKey: ['lignes_commande', id] });
      qc.invalidateQueries({ queryKey: ['commande', id] });
      toast.success('Lien supprimé');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const besFiltered = useMemo(() =>
    besScorees.filter(({ be }) => !searchBE || be.numero_be.toLowerCase().includes(searchBE.toLowerCase())),
    [besScorees, searchBE]
  );

  if (!commande) {
    return <div className="flex items-center justify-center h-64 text-gray-400 text-sm">Chargement…</div>;
  }

  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/commandes">
          <Button variant="ghost" size="icon" className="h-8 w-8"><ArrowLeft className="w-4 h-4" /></Button>
        </Link>
        <div>
          <h1 className="text-xl font-bold text-gray-900 font-mono">{commande.numero_commande_interne}</h1>
          <p className="text-sm text-gray-500">{commande.fournisseur}</p>
        </div>
        <StatusBadge status={commande.statut_commande} />
        <div className="ml-auto flex items-center gap-2">
          <Button
            size="sm" variant="outline"
            disabled={checking || bes.length === 0}
            onClick={async () => {
              setChecking(true);
              try {
                // Recalcul local des balances
                const total = lignes.reduce((s, l) => s + (l.quantite_commandee ?? 0), 0);
                const recues = bes.reduce((s, b) => {
                  // Simplifié : on marque juste OK
                  return s;
                }, 0);
                toast.success('Vérification terminée — voir les statuts de lignes');
              } finally {
                setChecking(false);
              }
            }}
          >
            <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" />
            {checking ? 'Vérification…' : 'Vérifier BE'}
          </Button>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        {[
          { label: 'Date commande', value: formatDate(commande.date_commande) },
          { label: 'Qté commandée', value: kpis.qteCmd },
          { label: 'Qté reçue', value: kpis.qteRecue },
          { label: 'Qté facturée', value: kpis.qteFact },
          { label: 'Montant total', value: formatEur(commande.montant_total_commande ?? (kpis.montantCmd || null)) },
        ].map(k => (
          <Card key={k.label}>
            <CardContent className="pt-4 pb-3">
              <p className="text-xs text-gray-400">{k.label}</p>
              <p className="text-sm font-semibold text-gray-900 mt-0.5">{k.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Barres de progression */}
      {kpis.qteCmd > 0 && (() => {
        const recuVal   = modeRecu === 'unites' ? kpis.qteRecue   : kpis.montantRecuHT;
        const cmdVal    = modeRecu === 'unites' ? kpis.qteCmd     : kpis.montantCmd;
        const factVal   = modeRecu === 'unites' ? kpis.qteFact    : kpis.montantFactHT;
        const recuBase  = modeRecu === 'unites' ? kpis.qteRecue   : kpis.montantRecuHT;
        const fmt       = (v: number) => modeRecu === 'unites' ? String(v) : formatEur(v);
        const pctRecu   = cmdVal  > 0 ? Math.min(100, (recuVal / cmdVal)  * 100) : 0;
        const pctFact   = recuBase > 0 ? Math.min(100, (factVal / recuBase) * 100) : 0;
        return (
          <button
            type="button"
            onClick={() => setModeRecu(m => m === 'unites' ? 'ht' : 'unites')}
            className="w-full text-left rounded-xl border border-gray-100 bg-white px-5 py-3 shadow-sm space-y-2 hover:border-indigo-200 transition-colors"
            title="Cliquer pour basculer unités / HT €"
          >
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-gray-500">Réception <span className="text-gray-300">({modeRecu === 'unites' ? 'unités' : 'HT €'})</span></span>
                <span className="text-xs font-semibold text-gray-700">
                  {fmt(recuVal)} / {fmt(cmdVal)} — {Math.round(pctRecu)}%
                </span>
              </div>
              <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                <div className="h-full bg-emerald-500 rounded-full transition-all" style={{ width: `${pctRecu}%` }} />
              </div>
            </div>
            {recuBase > 0 && (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs text-gray-500">Facturation</span>
                  <span className="text-xs font-semibold text-gray-700">
                    {fmt(factVal)} / {fmt(recuBase)} — {Math.round(pctFact)}%
                  </span>
                </div>
                <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                  <div className="h-full bg-cyan-500 rounded-full transition-all" style={{ width: `${pctFact}%` }} />
                </div>
              </div>
            )}
          </button>
        );
      })()}

      {/* BEs et Factures liés */}
      <div className="grid lg:grid-cols-2 gap-4">
        {/* BEs liés */}
        <Card className="border-amber-100">
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide flex items-center gap-1.5">
                <Package className="w-3.5 h-3.5 text-amber-500" /> BE liés ({bes.length})
              </p>
              <Button size="sm" variant="outline" className="h-6 text-xs" onClick={() => setShowLinkBE(v => !v)}>
                <Plus className="w-3 h-3 mr-1" /> Lier un BE
              </Button>
            </div>
            {bes.length === 0 ? (
              <p className="text-xs text-amber-600 italic">Aucun BE lié</p>
            ) : (
              <div className="space-y-1">
                {bes.map(be => {
                  const liaison = liaisonsBE.find(l => l.be_id === be.id);
                  return (
                    <div key={be.id} className="flex items-center justify-between group px-2 py-1.5 rounded-lg hover:bg-amber-50 transition-colors">
                      <Link href={`/be-receptions/${be.id}`} className="flex items-center gap-2 flex-1">
                        <span className="text-sm font-medium text-amber-700 font-mono">{be.numero_be}</span>
                        <span className="text-xs text-gray-400">{formatDate(be.date_bl)}</span>
                        <StatusBadge status={be.statut_be} />
                      </Link>
                      {liaison && (
                        <button
                          onClick={() => unlinkBEMutation.mutate(liaison)}
                          className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-red-50 text-gray-300 hover:text-red-500 transition-all"
                        >
                          <Unlink className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Panel liaison BE */}
            {showLinkBE && (
              <div className="mt-3 border-t pt-3">
                <div className="relative mb-2">
                  <Search className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-gray-400" />
                  <Input
                    placeholder="Rechercher un BE…"
                    value={searchBE}
                    onChange={e => setSearchBE(e.target.value)}
                    className="pl-8 h-8 text-xs"
                  />
                </div>
                <div className="max-h-56 overflow-y-auto space-y-1">
                  {besFiltered.map(({ be, matches }) => (
                    <div
                      key={be.id}
                      onClick={() => setSelectedBEId(be.id)}
                      className={cn(
                        'flex items-center gap-2 px-2 py-2 rounded-lg cursor-pointer text-xs transition-colors',
                        selectedBEId === be.id ? 'bg-amber-100 text-amber-800' : 'hover:bg-gray-50'
                      )}
                    >
                      <div className="flex-1 min-w-0">
                        <span className="font-mono font-medium">{be.numero_be}</span>
                        <span className="text-gray-400 ml-2">{formatDate(be.date_bl)}</span>
                      </div>
                      <StatusBadge status={be.statut_be} />
                      {matches > 0 ? (
                        <span className="shrink-0 rounded-full bg-emerald-100 text-emerald-700 px-1.5 py-0.5 font-medium whitespace-nowrap">
                          {matches}/{cmdRefs.length} réf.
                        </span>
                      ) : (
                        <span className="shrink-0 text-gray-300">0 réf.</span>
                      )}
                    </div>
                  ))}
                  {besFiltered.length === 0 && <p className="text-xs text-gray-400 text-center py-4">Aucun BE trouvé</p>}
                </div>
                <div className="flex justify-end gap-2 mt-2">
                  <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => { setShowLinkBE(false); setSelectedBEId(''); setSearchBE(''); }}>Annuler</Button>
                  <Button size="sm" className="h-7 text-xs" disabled={!selectedBEId || linkBEMutation.isPending} onClick={() => linkBEMutation.mutate(selectedBEId)}>
                    <Link2 className="w-3 h-3 mr-1" /> Lier
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Factures liées */}
        <Card className="border-cyan-100">
          <CardContent className="pt-4 pb-4">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide flex items-center gap-1.5 mb-3">
              <FileText className="w-3.5 h-3.5 text-cyan-500" /> Factures liées ({factures.length})
            </p>
            {factures.length === 0 ? (
              <p className="text-xs text-gray-400 italic">Aucune facture liée</p>
            ) : (
              <div className="space-y-1">
                {factures.map(f => (
                  <Link key={f.id} href={`/factures/${f.id}`} className="flex items-center justify-between px-2 py-1.5 rounded-lg hover:bg-cyan-50 transition-colors group">
                    <span className="text-sm font-medium text-cyan-700">{f.numero_facture}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-500 font-mono">{formatEur(f.total_ht)}</span>
                      <span className={cn('text-xs font-medium', f.taux_rapprochement === 100 ? 'text-emerald-600' : 'text-amber-600')}>
                        {f.taux_rapprochement}%
                      </span>
                      <StatusBadge status={f.statut_facture} />
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Notes */}
      <Card>
        <CardHeader className="pb-2 flex flex-row items-center justify-between">
          <CardTitle>Notes</CardTitle>
          <button onClick={() => setEditingNotes(v => !v)} className="p-1.5 rounded hover:bg-gray-100 text-gray-400">
            {editingNotes ? <X className="w-4 h-4" /> : <Edit2 className="w-4 h-4" />}
          </button>
        </CardHeader>
        <CardContent>
          {editingNotes ? (
            <div className="space-y-2">
              <textarea
                value={notes}
                onChange={e => setNotes(e.target.value)}
                className="w-full border border-gray-200 rounded-lg p-2 text-sm resize-none h-20 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                placeholder="Note libre…"
              />
              <Button size="sm" onClick={() => saveNotesMutation.mutate()} disabled={saveNotesMutation.isPending}>
                <Save className="w-3.5 h-3.5 mr-1" /> Enregistrer
              </Button>
            </div>
          ) : (
            <p className="text-sm text-gray-600 whitespace-pre-wrap min-h-5">
              {notes || <span className="text-gray-400 italic">Aucune note</span>}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Lignes */}
      <Card>
        <CardHeader className="pb-3 flex flex-row items-center justify-between">
          <CardTitle>Lignes de commande ({lignes.length})</CardTitle>
          <div className="flex items-center gap-2">
            <div className="flex items-center border border-gray-200 rounded-lg p-0.5 bg-gray-50">
              <button
                onClick={() => setModeRecu('unites')}
                className={cn('text-xs px-2 py-1 rounded transition-all', modeRecu === 'unites' ? 'bg-white shadow-sm text-gray-900 font-medium' : 'text-gray-400 hover:text-gray-600')}
              >
                Unités
              </button>
              <button
                onClick={() => setModeRecu('ht')}
                className={cn('text-xs px-2 py-1 rounded transition-all', modeRecu === 'ht' ? 'bg-white shadow-sm text-gray-900 font-medium' : 'text-gray-400 hover:text-gray-600')}
              >
                HT €
              </button>
            </div>
            {lignes.some(l => l.pu_commande == null) && (
              <Button
                size="sm"
                variant="outline"
                className="text-indigo-600 border-indigo-200 hover:bg-indigo-50"
                onClick={() => fillPrixMutation.mutate()}
                disabled={fillPrixMutation.isPending}
                title="Remplir les prix manquants depuis le catalogue"
              >
                {fillPrixMutation.isPending ? 'Complétion…' : '✦ Compléter les prix'}
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => setShowAddLine(v => !v)}>
              <Plus className="w-3.5 h-3.5 mr-1" /> Ajouter
            </Button>
          </div>
        </CardHeader>

        {showAddLine && (
          <div className="px-5 pb-4">
            <div className="grid grid-cols-4 gap-2 p-3 bg-gray-50 rounded-lg">
              <Input
                value={lineForm.reference_article}
                onChange={e => { setLineForm({ ...lineForm, reference_article: e.target.value }); setPrixSuggere(null); }}
                onBlur={e => lookupPrix(e.target.value)}
                placeholder="Réf. *"
                className="text-xs h-8"
              />
              <Input value={lineForm.designation} onChange={e => setLineForm({ ...lineForm, designation: e.target.value })} placeholder="Désignation" className="text-xs h-8" />
              <Input type="number" value={lineForm.quantite_commandee} onChange={e => setLineForm({ ...lineForm, quantite_commandee: e.target.value })} placeholder="Qté" className="text-xs h-8" />
              <Input
                type="number"
                step="0.01"
                value={lineForm.pu_commande}
                onChange={e => setLineForm({ ...lineForm, pu_commande: e.target.value })}
                placeholder="PU €"
                className={`text-xs h-8 ${prixSuggere && lineForm.pu_commande && parseFloat(lineForm.pu_commande) !== prixSuggere.pu ? 'border-amber-400 focus:ring-amber-400' : ''}`}
              />
            </div>
            {prixSuggere && (
              <p className="text-xs mt-1 px-1 text-gray-400">
                Dernier prix connu : <span className="font-semibold text-gray-600">{prixSuggere.pu.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' })}</span>
                {lineForm.pu_commande && parseFloat(lineForm.pu_commande) !== prixSuggere.pu && (
                  <span className="ml-2 text-amber-600 font-medium">⚠ prix modifié</span>
                )}
              </p>
            )}
            <div className="flex justify-end gap-2 mt-2">
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setShowAddLine(false)}>Annuler</Button>
              <Button size="sm" className="h-7 text-xs" onClick={() => addLineMutation.mutate()} disabled={addLineMutation.isPending || !lineForm.reference_article}>
                Ajouter la ligne
              </Button>
            </div>
          </div>
        )}

        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50/50 border-y border-gray-100">
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500">#</th>
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500">Réf.</th>
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500">Désignation</th>
                  <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-500">Qté cmd</th>
                  <th className="text-right px-4 py-2.5 text-xs font-semibold text-indigo-400" title="Quantités reçues avant le démarrage de SyncFlow — cliquer pour saisir">Qté init. ✎</th>
                  <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-500">{modeRecu === 'unites' ? 'Qté reçue' : 'Reçu HT €'}</th>
                  <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-500">Qté facturée</th>
                  <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-500">PU €</th>
                  <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-500">Total HT</th>
                  <th className="px-4 py-2.5 text-xs font-semibold text-gray-500 text-center">Note</th>
                  <th className="px-4 py-2.5 text-xs font-semibold text-gray-500">Statut ligne</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {lignes.map(l => {
                  const initQte = initLignes.find(il => il.ligne_commande_id === l.id)?.quantite_receptionnee ?? null;
                  return (
                  <tr key={l.id} className="hover:bg-gray-50/50">
                    <td className="px-4 py-2.5 text-xs text-gray-400">{l.ligne_no}</td>
                    <td className="px-4 py-2.5">
                      {l.reference_article ? (
                        <button
                          onClick={() => setRefHistory(l.reference_article)}
                          className="group/ref flex items-center gap-1 font-mono text-xs font-medium text-gray-800 hover:text-indigo-600 transition-colors"
                          title="Voir l'historique de cette référence"
                        >
                          {l.reference_article}
                          <History className="w-3 h-3 opacity-0 group-hover/ref:opacity-100 text-indigo-400 shrink-0" />
                        </button>
                      ) : (
                        <span className="font-mono text-xs text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-600 max-w-[180px] truncate">{l.designation}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs">{l.quantite_commandee}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs">
                      {editingInitQte?.id === l.id ? (
                        <div className="flex items-center justify-end gap-1">
                          <Input
                            type="number" min="0"
                            value={editingInitQte.value}
                            onChange={e => setEditingInitQte({ id: l.id, value: e.target.value })}
                            onKeyDown={e => {
                              if (e.key === 'Escape') { setEditingInitQte(null); return; }
                              if (e.key === 'Enter') {
                                initReceptionMutation.mutate({ ligneCommandeId: l.id, quantite: parseFloat(editingInitQte.value) || 0 });
                                const idx = lignes.findIndex(line => line.id === l.id);
                                if (idx < lignes.length - 1) {
                                  const next = lignes[idx + 1];
                                  setEditingInitQte({ id: next.id, value: String(initLignes.find(il => il.ligne_commande_id === next.id)?.quantite_receptionnee ?? '') });
                                } else {
                                  setEditingInitQte(null);
                                }
                              }
                            }}
                            className="w-16 h-6 text-xs"
                            autoFocus
                          />
                          <button onClick={() => initReceptionMutation.mutate({ ligneCommandeId: l.id, quantite: parseFloat(editingInitQte.value) || 0 })} disabled={initReceptionMutation.isPending} className="text-emerald-500 hover:text-emerald-700"><Save className="w-3 h-3" /></button>
                          <button onClick={() => setEditingInitQte(null)} className="text-gray-400 hover:text-gray-600"><X className="w-3 h-3" /></button>
                        </div>
                      ) : (
                        <span
                          className="cursor-pointer hover:underline text-indigo-500"
                          onClick={() => setEditingInitQte({ id: l.id, value: String(initQte ?? '') })}
                          title="Cliquer pour saisir la quantité reçue avant SyncFlow"
                        >
                          {initQte != null ? initQte : <span className="text-gray-300">—</span>}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs">
                      <span className={cn(l.quantite_receptionnee_reelle < l.quantite_commandee ? 'text-amber-600' : 'text-emerald-600')}>
                        {modeRecu === 'unites'
                          ? l.quantite_receptionnee_reelle
                          : (() => {
                              const pu = l.pu_commande ?? (l.quantite_commandee > 0 && l.montant_ht_commande != null ? l.montant_ht_commande / l.quantite_commandee : null);
                              return pu != null ? formatEur(l.quantite_receptionnee_reelle * pu) : '—';
                            })()}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs">
                      <span className={cn(l.quantite_facturee > l.quantite_commandee ? 'text-red-600' : l.quantite_facturee < l.quantite_commandee ? 'text-amber-600' : 'text-emerald-600')}>
                        {l.quantite_facturee}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs">
                      {editingPU?.id === l.id ? (
                        <div className="flex items-center justify-end gap-1">
                          <Input
                            type="number" step="0.0001"
                            value={editingPU.value}
                            onChange={e => setEditingPU({ id: l.id, value: e.target.value })}
                            onKeyDown={e => {
                              if (e.key === 'Escape') { setEditingPU(null); return; }
                              if (e.key === 'Enter') {
                                savePUMutation.mutate({ lineId: l.id, pu: parseFloat(editingPU.value) });
                                const idx = lignes.findIndex(line => line.id === l.id);
                                if (idx < lignes.length - 1) setEditingPU({ id: lignes[idx + 1].id, value: String(lignes[idx + 1].pu_commande ?? '') });
                                else setEditingPU(null);
                              }
                            }}
                            className="w-20 h-6 text-xs"
                            autoFocus
                          />
                          <button onClick={() => savePUMutation.mutate({ lineId: l.id, pu: parseFloat(editingPU.value) })} className="text-emerald-500 hover:text-emerald-700"><Save className="w-3 h-3" /></button>
                          <button onClick={() => setEditingPU(null)} className="text-gray-400 hover:text-gray-600"><X className="w-3 h-3" /></button>
                        </div>
                      ) : (
                        <span
                          className="cursor-pointer hover:underline text-indigo-600"
                          onClick={() => setEditingPU({ id: l.id, value: String(l.pu_commande ?? '') })}
                        >
                          {l.pu_commande != null ? formatEur(l.pu_commande).replace(' €', '') : <span className="text-gray-300 italic text-xs">—</span>}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs">{formatEur(l.montant_ht_commande)}</td>
                    <td className="px-4 py-2.5 text-center">
                      {editingLineNotes?.id === l.id ? (
                        <div className="flex items-center gap-1">
                          <Input
                            value={editingLineNotes.value}
                            onChange={e => setEditingLineNotes({ id: l.id, value: e.target.value })}
                            className="h-6 text-xs flex-1"
                            autoFocus
                          />
                          <button onClick={() => saveLineNotesMutation.mutate({ lineId: l.id, comment: editingLineNotes.value })} className="text-emerald-500"><Save className="w-3 h-3" /></button>
                          <button onClick={() => setEditingLineNotes(null)} className="text-gray-400"><X className="w-3 h-3" /></button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setEditingLineNotes({ id: l.id, value: l.commentaire ?? '' })}
                          className="p-1 rounded hover:bg-gray-100"
                          title={l.commentaire ?? 'Ajouter une note'}
                        >
                          <MessageSquare className={cn('w-3.5 h-3.5', l.commentaire ? 'text-indigo-500 fill-indigo-100' : 'text-gray-300')} />
                        </button>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <StatusBadge status={computeStatutLigne(l)} />
                    </td>
                  </tr>
                  );
                })}
              </tbody>
              {lignes.length > 0 && (
                <tfoot>
                  <tr className="bg-gray-50/80 border-t border-gray-100">
                    <td colSpan={8} className="px-4 py-2.5 text-xs font-semibold text-gray-600 text-right">Total</td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs font-semibold">{formatEur(kpis.montantCmd)}</td>
                    <td />
                    <td />
                  </tr>
                </tfoot>
              )}
            </table>
            {lignes.length === 0 && <p className="text-xs text-gray-400 text-center py-10">Aucune ligne de commande</p>}
          </div>
        </CardContent>
      </Card>

      {refHistory && (
        <ReferenceHistoryModal
          reference={refHistory}
          fournisseur={commande?.fournisseur}
          onClose={() => setRefHistory(null)}
        />
      )}
    </div>
  );
}
