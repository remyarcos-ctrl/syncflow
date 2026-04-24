'use client';

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
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
  ArrowLeft, ExternalLink, Edit2, Save, X, MessageSquare,
  CheckCircle2, XCircle, AlertTriangle, TrendingUp, TrendingDown,
  Play, Link2, Unlink, Plus, Package, ShoppingCart, FileText, History
} from 'lucide-react';
import { toast } from 'sonner';
import PDFViewerPanel from '@/components/shared/PDFViewerPanel';
import type {
  Facture, LigneFacture, Commande, BEReception,
  LiaisonFactureCommande, Rapprochement, LigneCommande, LigneBE, JournalActivite
} from '@/types';

export default function FactureDetailPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();

  const [isMatching, setIsMatching] = useState(false);
  const [editingNotes, setEditingNotes] = useState(false);
  const [notes, setNotes] = useState('');
  const [editingLineNotes, setEditingLineNotes] = useState<{ id: string; value: string } | null>(null);
  const [showLinkCommande, setShowLinkCommande] = useState(false);
  const [showPDF, setShowPDF] = useState(false);
  const [selectedCommandeId, setSelectedCommandeId] = useState('');
  const [searchCmd, setSearchCmd] = useState('');

  // ── Rapprochement manuel ──────────────────────────────────────────────────
  const [manualTarget, setManualTarget] = useState<string | null>(null); // ligne_facture_id
  const [manualBeId, setManualBeId] = useState('');
  const [manualLigneBEId, setManualLigneBEId] = useState('');

  // ── Données ───────────────────────────────────────────────────────────────
  const { data: facture, isLoading: isLoadingFacture } = useQuery<Facture>({
    queryKey: ['facture', id],
    queryFn: async () => {
      const { data } = await supabase.from('factures').select('*').eq('id', id).single();
      return data!;
    },
    enabled: !!id, staleTime: 30_000,
  });

  const { data: lignesFacture = [] } = useQuery<LigneFacture[]>({
    queryKey: ['lignes_facture', id],
    queryFn: async () => {
      const { data } = await supabase.from('lignes_facture').select('*').eq('facture_id', id).order('ligne_no');
      return data ?? [];
    },
    enabled: !!id, staleTime: 30_000,
  });

  const { data: rapprochements = [], isLoading: isLoadingRaps } = useQuery<Rapprochement[]>({
    queryKey: ['raps_facture', id],
    queryFn: async () => {
      const { data } = await supabase.from('rapprochements').select('*').eq('facture_id', id);
      return data ?? [];
    },
    enabled: !!id, staleTime: 30_000,
  });

  const { data: liaisonsCmd = [] } = useQuery<LiaisonFactureCommande[]>({
    queryKey: ['liaisons_facture_cmd', id],
    queryFn: async () => {
      const { data } = await supabase.from('liaison_facture_commande').select('*').eq('facture_id', id);
      return data ?? [];
    },
    enabled: !!id, staleTime: 30_000,
  });

  const commandeIds = useMemo(() => liaisonsCmd.map(l => l.commande_id), [liaisonsCmd]);
  const beIds = useMemo(() => [...new Set(rapprochements.map(r => r.be_id).filter(Boolean))], [rapprochements]);

  const { data: commandes = [] } = useQuery<Commande[]>({
    queryKey: ['commandes_facture', id, commandeIds.join()],
    queryFn: async () => {
      if (!commandeIds.length) return [];
      const { data } = await supabase.from('commandes').select('*').in('id', commandeIds);
      return data ?? [];
    },
    enabled: commandeIds.length > 0, staleTime: 30_000,
  });

  const { data: bes = [] } = useQuery<BEReception[]>({
    queryKey: ['bes_facture', id, beIds.join()],
    queryFn: async () => {
      if (!beIds.length) return [];
      const { data } = await supabase.from('be_receptions').select('*').in('id', beIds as string[]);
      return data ?? [];
    },
    enabled: beIds.length > 0, staleTime: 30_000,
  });

  const { data: lignesCommande = [] } = useQuery<LigneCommande[]>({
    queryKey: ['lignes_cmd_facture', commandeIds.join()],
    queryFn: async () => {
      if (!commandeIds.length) return [];
      const { data } = await supabase.from('lignes_commande').select('*').in('commande_id', commandeIds);
      return data ?? [];
    },
    enabled: commandeIds.length > 0, staleTime: 10000,
  });

  const { data: lignesBE = [] } = useQuery<LigneBE[]>({
    queryKey: ['lignes_be_facture', beIds.join()],
    queryFn: async () => {
      if (!beIds.length) return [];
      const { data } = await supabase.from('lignes_be').select('*').in('be_id', beIds as string[]);
      return data ?? [];
    },
    enabled: beIds.length > 0, staleTime: 10000,
  });

  // BEs disponibles pour rapprochement manuel (même fournisseur)
  const { data: besDispo = [] } = useQuery<BEReception[]>({
    queryKey: ['bes_dispo_manual', facture?.fournisseur],
    queryFn: async () => {
      const prefix = (facture?.fournisseur ?? '').slice(0, 6);
      const { data } = await supabase
        .from('be_receptions')
        .select('*')
        .ilike('fournisseur', `${prefix}%`)
        .limit(50);
      return data ?? [];
    },
    enabled: manualTarget !== null && !!facture?.fournisseur,
  });

  // Lignes du BE sélectionné pour rapprochement manuel
  const { data: lignesBEDispo = [] } = useQuery<LigneBE[]>({
    queryKey: ['lignes_be_dispo_manual', manualBeId],
    queryFn: async () => {
      const { data } = await supabase
        .from('lignes_be')
        .select('*')
        .eq('be_id', manualBeId);
      return data ?? [];
    },
    enabled: manualBeId !== '',
  });

  // Commandes disponibles à lier
  const { data: commandesDisponibles = [] } = useQuery<Commande[]>({
    queryKey: ['commandes_dispo_facture', facture?.fournisseur, commandeIds.join()],
    queryFn: async () => {
      const { data } = await supabase.from('commandes').select('*').order('date_commande', { ascending: false }).limit(200);
      if (!data) return [];
      const normF = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6);
      const normFact = normF(facture?.fournisseur ?? '');
      return data.filter(c => {
        if (commandeIds.includes(c.id)) return false;
        const n = normF(c.fournisseur);
        return n === normFact || n.includes(normFact) || normFact.includes(n);
      });
    },
    enabled: showLinkCommande && !!facture,
  });

  useEffect(() => { if (facture) setNotes(facture.commentaire ?? ''); }, [facture]);

  // ── Debounced Realtime invalidation ──────────────────────────────────────
  const debounceTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const debouncedInvalidate = useCallback((key: string, queryKey: unknown[]) => {
    const existing = debounceTimers.current.get(key);
    if (existing) clearTimeout(existing);
    debounceTimers.current.set(key, setTimeout(() => {
      qc.invalidateQueries({ queryKey });
      debounceTimers.current.delete(key);
    }, 200));
  }, [qc]);

  // ── Realtime subscriptions ────────────────────────────────────────────────
  useEffect(() => {
    const channel = supabase
      .channel(`facture-detail-${id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'factures' }, () => {
        debouncedInvalidate('facture', ['facture', id]);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rapprochements' }, () => {
        debouncedInvalidate('raps_facture', ['raps_facture', id]);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lignes_facture' }, () => {
        debouncedInvalidate('lignes_facture', ['lignes_facture', id]);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lignes_be' }, () => {
        debouncedInvalidate('lignes_be_facture', ['lignes_be_facture', beIds.join()]);
      })
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
      debounceTimers.current.forEach(t => clearTimeout(t));
    };
  }, [id, qc, beIds, debouncedInvalidate]);

  // ── Retours fournisseur en attente ────────────────────────────────────────
  const { data: retoursEnAttente = [] } = useQuery<{ id: string; reference_article: string | null; quantite_receptionnee: number; statut_retour: string; motif_retour: string | null; be_id: string }[]>({
    queryKey: ['retours_facture_fournisseur', facture?.fournisseur],
    queryFn: async () => {
      // Étape 1 : BE ids de ce fournisseur
      const { data: beRows } = await supabase
        .from('be_receptions')
        .select('id')
        .eq('fournisseur', facture!.fournisseur ?? '');
      const beIdsF = (beRows ?? []).map(b => b.id);
      if (!beIdsF.length) return [];
      // Étape 2 : lignes en retour non soldées
      const { data } = await supabase
        .from('lignes_be')
        .select('id, reference_article, quantite_receptionnee, statut_retour, motif_retour, be_id')
        .in('be_id', beIdsF)
        .in('statut_retour', ['a_retourner', 'retourne', 'avoir_demande']);
      return data ?? [];
    },
    enabled: !!facture?.fournisseur,
    refetchInterval: 15000,
  });

  const { data: journal = [] } = useQuery<JournalActivite[]>({
    queryKey: ['journal_facture', id],
    queryFn: async () => {
      const { data } = await supabase
        .from('journal_activite')
        .select('*')
        .eq('entite_id', id)
        .order('created_at', { ascending: false })
        .limit(30);
      return data ?? [];
    },
    enabled: !!id,
  });

  // ── KPIs ──────────────────────────────────────────────────────────────────
  const { montantRap, qteRap, qteTotale } = useMemo(() => {
    const montantRap = rapprochements.filter(r => r.statut_validation === 'validé').reduce((s, r) => s + (r.montant_rapproche ?? 0), 0);
    const qteRap = rapprochements.filter(r => r.statut_validation === 'validé').reduce((s, r) => s + (r.quantite_rapprochee ?? 0), 0);
    const qteTotale = lignesFacture.reduce((s, l) => s + (l.quantite_facturee ?? 0), 0);
    return { montantRap, qteRap, qteTotale };
  }, [rapprochements, lignesFacture]);

  // ── Vue enrichie des lignes ────────────────────────────────────────────────
  const vue = useMemo(() => {
    return lignesFacture.map(lf => {
      const rapsLigne = rapprochements.filter(r => r.ligne_facture_id === lf.id);
      const bestRap = rapsLigne.find(r => r.statut_validation === 'validé') ?? rapsLigne[0];
      const ligneBE = bestRap?.ligne_be_id ? lignesBE.find(l => l.id === bestRap.ligne_be_id) : null;
      const ligneCmd = bestRap?.ligne_commande_id ? lignesCommande.find(l => l.id === bestRap.ligne_commande_id) : null;
      const be = bestRap?.be_id ? bes.find(b => b.id === bestRap.be_id) : null;

      const qFact = lf.quantite_facturee ?? 0;
      const puFact = lf.pu_facture ?? 0;
      const totalFact = lf.montant_ht ?? qFact * puFact;
      const qCmd = ligneCmd?.quantite_commandee ?? null;
      const puCmd = ligneCmd?.pu_commande ?? null;
      const qRecue = ligneBE?.quantite_receptionnee ?? null;

      const ecartQte = qCmd !== null ? qFact - qCmd : null;
      const ecartPrix = puCmd && puFact ? ((puFact - puCmd) / puCmd) * 100 : null;

      const issues: { niveau: string; label: string }[] = [];
      if (ecartQte !== null && ecartQte > 0) issues.push({ niveau: 'haute', label: `+${ecartQte} facturé(s) en trop` });
      else if (ecartQte !== null && ecartQte < 0) issues.push({ niveau: 'faible', label: `${Math.abs(ecartQte)} non encore facturé(s)` });
      if (ecartPrix !== null && Math.abs(ecartPrix) > 2) {
        const niv = Math.abs(ecartPrix) > 15 ? 'haute' : Math.abs(ecartPrix) > 5 ? 'moyenne' : 'faible';
        issues.push({ niveau: niv, label: `Écart prix ${ecartPrix > 0 ? '+' : ''}${ecartPrix.toFixed(1)}%` });
      }

      let etat: 'ok' | 'anomalie' | 'partiel' | 'non_rapproche' = 'non_rapproche';
      if (bestRap?.statut_validation === 'validé') {
        etat = issues.some(i => i.niveau === 'haute') ? 'anomalie' : issues.length > 0 ? 'partiel' : 'ok';
      } else if (bestRap) {
        etat = 'partiel';
      }

      return { lf, bestRap, ligneCmd, ligneBE, be, qFact, puFact, totalFact, qCmd, puCmd, qRecue, ecartQte, ecartPrix, issues, etat };
    });
  }, [lignesFacture, rapprochements, lignesCommande, lignesBE, bes]);

  // ── Mutations ─────────────────────────────────────────────────────────────
  const saveNotesMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from('factures').update({ commentaire: notes }).eq('id', id);
      if (error) throw error;
      await supabase.from('journal_activite').insert({
        type_action: 'note_modifiee',
        entite_type: 'facture',
        entite_id: id,
        details_action: JSON.stringify({ apercu: notes.slice(0, 80) }),
      });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['facture', id] }); setEditingNotes(false); toast.success('Note enregistrée'); },
    onError: (e: Error) => toast.error(e.message),
  });

  const saveLineNotesMutation = useMutation({
    mutationFn: async ({ lineId, comment }: { lineId: string; comment: string }) => {
      const { error } = await supabase.from('lignes_facture').update({ commentaire: comment }).eq('id', lineId);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['lignes_facture', id] }); setEditingLineNotes(null); },
    onError: (e: Error) => toast.error(e.message),
  });

  const validateRapMutation = useMutation({
    mutationFn: async (rapId: string) => {
      const res = await fetch('/api/rapprochements', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rapId, statut: 'validé', factureId: id }),
      });
      if (!res.ok) throw new Error((await res.json() as { error?: string }).error ?? 'Erreur');
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['raps_facture', id] });
      qc.invalidateQueries({ queryKey: ['facture', id] });
      toast.success('Rapprochement validé');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const validateAllMutation = useMutation({
    mutationFn: async () => {
      const proposes = rapprochements.filter(r => r.statut_validation === 'proposé');
      if (!proposes.length) return;
      await Promise.all(
        proposes.map(r =>
          fetch('/api/rapprochements', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rapId: r.id, statut: 'validé', factureId: id }),
          }),
        ),
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['raps_facture', id] });
      qc.invalidateQueries({ queryKey: ['facture', id] });
      toast.success('Tous les rapprochements validés');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rejectRapMutation = useMutation({
    mutationFn: async (rapId: string) => {
      const res = await fetch('/api/rapprochements', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rapId, statut: 'rejeté', factureId: id }),
      });
      if (!res.ok) throw new Error((await res.json() as { error?: string }).error ?? 'Erreur');
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['raps_facture', id] });
      qc.invalidateQueries({ queryKey: ['facture', id] });
      toast.success('Rapprochement rejeté');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const createManualRapMutation = useMutation({
    mutationFn: async ({
      ligneFacId,
      beId,
      ligneBEId,
      quantiteRapprochee,
      montantRapproche,
    }: {
      ligneFacId: string;
      beId: string;
      ligneBEId: string;
      quantiteRapprochee: number;
      montantRapproche: number | null;
    }) => {
      const res = await fetch('/api/rapprochements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ factureId: id, ligneFacId, beId, ligneBEId, quantiteRapprochee, montantRapproche }),
      });
      if (!res.ok) throw new Error((await res.json() as { error?: string }).error ?? 'Erreur');
    },
    onSuccess: () => {
      setManualTarget(null);
      setManualBeId('');
      setManualLigneBEId('');
      qc.invalidateQueries({ queryKey: ['raps_facture', id] });
      qc.invalidateQueries({ queryKey: ['facture', id] });
      toast.success('Rapprochement manuel créé');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const linkCommandeMutation = useMutation({
    mutationFn: async (commandeId: string) => {
      const { error } = await supabase.from('liaison_facture_commande').insert({ facture_id: id, commande_id: commandeId });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['liaisons_facture_cmd', id] });
      qc.invalidateQueries({ queryKey: ['commandes_facture', id] });
      setShowLinkCommande(false);
      setSelectedCommandeId('');
      toast.success('Commande liée');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const unlinkCommandeMutation = useMutation({
    mutationFn: async (liaison: LiaisonFactureCommande) => {
      const { error } = await supabase.from('liaison_facture_commande').delete().eq('id', liaison.id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['liaisons_facture_cmd', id] });
      qc.invalidateQueries({ queryKey: ['commandes_facture', id] });
      toast.success('Lien supprimé');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const handleMatching = async () => {
    setIsMatching(true);
    const toastId = toast.loading('Analyse en cours...');
    try {
      const res = await fetch('/api/matching', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ factureId: id }),
      });
      const json = await res.json() as { error?: string; rapprochements_crees?: number; exceptions_creees?: number };
      if (!res.ok) throw new Error(json.error ?? 'Erreur matching');
      toast.dismiss(toastId);
      const nbRaps = json.rapprochements_crees ?? 0;
      const nbExc = json.exceptions_creees ?? 0;
      if (nbRaps === 0 && nbExc === 0) {
        toast.info('Aucun rapprochement trouvé');
      } else {
        toast.success(`${nbRaps} rapprochement(s) créé(s)${nbExc > 0 ? `, ${nbExc} exception(s)` : ''}`);
      }
      qc.invalidateQueries({ queryKey: ['raps_facture', id] });
      qc.invalidateQueries({ queryKey: ['facture', id] });
    } catch (e) {
      toast.dismiss(toastId);
      toast.error((e as Error).message);
    } finally {
      setIsMatching(false);
    }
  };

  const cmdFiltered = useMemo(() =>
    commandesDisponibles.filter(c => !searchCmd || c.numero_commande_interne.toLowerCase().includes(searchCmd.toLowerCase())),
    [commandesDisponibles, searchCmd]
  );

  if (!facture) {
    return <div className="flex items-center justify-center h-64 text-gray-400 text-sm">Chargement…</div>;
  }

  const taux = facture.taux_rapprochement ?? 0;
  const tauxMontant = (facture?.total_ht ?? 0) > 0
    ? Math.round((montantRap / facture!.total_ht!) * 100)
    : 0;
  const proposes = rapprochements.filter(r => r.statut_validation === 'proposé').length;

  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="flex items-center gap-3 flex-wrap">
        <Link href="/factures">
          <Button variant="ghost" size="icon" className="h-8 w-8"><ArrowLeft className="w-4 h-4" /></Button>
        </Link>
        <div>
          <h1 className="text-xl font-bold text-gray-900">Facture {facture.numero_facture}</h1>
          <p className="text-sm text-gray-500">{facture.fournisseur} · {formatDate(facture.date_facture)}</p>
        </div>
        <StatusBadge status={facture.statut_facture} />
        <div className="ml-auto flex items-center gap-2">
          <Button onClick={handleMatching} disabled={isMatching} size="sm" className="bg-blue-600 hover:bg-blue-700">
            <Play className="w-3.5 h-3.5 mr-1.5" />
            {isMatching ? 'Analyse en cours...' : 'Lancer matching'}
          </Button>
          {proposes > 0 && (
            <Button onClick={() => validateAllMutation.mutate()} disabled={validateAllMutation.isPending} size="sm" variant="outline" className="text-emerald-600 border-emerald-200">
              <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" />
              Valider tout ({proposes})
            </Button>
          )}
          {facture.pdf_url && (
            <Button variant="outline" size="sm" onClick={() => setShowPDF(true)}>
              <FileText className="w-3.5 h-3.5 mr-1" /> Voir le PDF
            </Button>
          )}
        </div>
      </div>

      {/* Alerte retours en attente */}
      {retoursEnAttente.length > 0 && (
        <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3">
          <AlertTriangle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-red-800">
              ⚠ {retoursEnAttente.length} retour{retoursEnAttente.length > 1 ? 's' : ''} en attente chez ce fournisseur — ne pas valider avant réception de l'avoir
            </p>
            <ul className="mt-1 space-y-0.5">
              {retoursEnAttente.map(r => (
                <li key={r.id} className="text-xs text-red-700 font-mono">
                  Réf. {r.reference_article ?? '—'} · {r.quantite_receptionnee} u. · {r.motif_retour ?? ''}
                  {' '}→ <span className="font-semibold">{{
                    a_retourner: 'à retourner',
                    retourne: 'retourné — avoir à venir',
                    avoir_demande: 'avoir demandé',
                  }[r.statut_retour] ?? r.statut_retour}</span>
                </li>
              ))}
            </ul>
            <Link href="/surplus?tab=retours" className="inline-block mt-1.5 text-xs text-red-700 underline hover:text-red-900">
              Voir le suivi des retours →
            </Link>
          </div>
        </div>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="text-xs text-gray-400">Rapprochement</p>
            {isLoadingFacture ? (
              <div className="animate-pulse h-6 bg-gray-100 rounded w-16 mt-0.5" />
            ) : (
              <>
                <p className={cn('text-lg font-bold mt-0.5', taux === 100 ? 'text-emerald-600' : taux > 0 ? 'text-amber-600' : 'text-gray-400')}>
                  {taux}%
                  <span className="text-xs font-normal text-gray-400 ml-1">lignes</span>
                </p>
                <p className={cn('text-xs font-medium mt-0.5', tauxMontant === 100 ? 'text-emerald-500' : tauxMontant > 0 ? 'text-amber-500' : 'text-gray-300')}>
                  {tauxMontant}% montant
                </p>
                <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden mt-1.5">
                  <div className={cn('h-full rounded-full transition-all', taux === 100 ? 'bg-emerald-400' : taux > 50 ? 'bg-amber-400' : 'bg-red-300')} style={{ width: `${taux}%` }} />
                </div>
              </>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="text-xs text-gray-400">Total HT</p>
            <p className="text-lg font-bold text-gray-900 mt-0.5 font-mono">{formatEur(facture.total_ht)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="text-xs text-gray-400">Lignes</p>
            <p className="text-lg font-bold text-gray-900 mt-0.5">{lignesFacture.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="text-xs text-gray-400">Proposés</p>
            <p className={cn('text-lg font-bold mt-0.5', proposes > 0 ? 'text-indigo-600' : 'text-gray-400')}>{proposes}</p>
          </CardContent>
        </Card>
      </div>

      {/* Commandes et BEs liés */}
      <div className="grid lg:grid-cols-2 gap-4">
        {/* Commandes */}
        <Card className="border-indigo-100">
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide flex items-center gap-1.5">
                <ShoppingCart className="w-3.5 h-3.5 text-indigo-500" /> Commande(s) ({commandes.length})
              </p>
              <Button size="sm" variant="outline" className="h-6 text-xs" onClick={() => setShowLinkCommande(v => !v)}>
                <Plus className="w-3 h-3 mr-1" /> Lier
              </Button>
            </div>
            {commandes.map(c => {
              const liaison = liaisonsCmd.find(l => l.commande_id === c.id);
              return (
                <div key={c.id} className="flex items-center justify-between group px-2 py-1.5 rounded-lg hover:bg-indigo-50 transition-colors">
                  <Link href={`/commandes/${c.id}`} className="flex items-center gap-2 flex-1">
                    <span className="text-sm font-medium text-indigo-700 font-mono">#{c.numero_commande_interne}</span>
                    <StatusBadge status={c.statut_commande} />
                  </Link>
                  {liaison && (
                    <button onClick={() => unlinkCommandeMutation.mutate(liaison)} className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-red-50 text-gray-300 hover:text-red-500 transition-all">
                      <Unlink className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              );
            })}
            {commandes.length === 0 && <p className="text-xs text-amber-600 italic">Aucune commande liée</p>}

            {showLinkCommande && (
              <div className="mt-3 border-t pt-3">
                <Input placeholder="Rechercher…" value={searchCmd} onChange={e => setSearchCmd(e.target.value)} className="h-8 text-xs mb-2" />
                <div className="max-h-40 overflow-y-auto space-y-1">
                  {cmdFiltered.map(c => (
                    <div key={c.id} onClick={() => setSelectedCommandeId(c.id)}
                      className={cn('flex items-center justify-between px-2 py-1.5 rounded-lg cursor-pointer text-xs transition-colors',
                        selectedCommandeId === c.id ? 'bg-indigo-100 text-indigo-800' : 'hover:bg-gray-50')}>
                      <span className="font-mono font-medium">#{c.numero_commande_interne}</span>
                      <span className="text-gray-400">{c.fournisseur}</span>
                    </div>
                  ))}
                </div>
                <div className="flex justify-end gap-2 mt-2">
                  <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => { setShowLinkCommande(false); setSelectedCommandeId(''); setSearchCmd(''); }}>Annuler</Button>
                  <Button size="sm" className="h-7 text-xs" disabled={!selectedCommandeId || linkCommandeMutation.isPending} onClick={() => linkCommandeMutation.mutate(selectedCommandeId)}>
                    <Link2 className="w-3 h-3 mr-1" /> Lier
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* BEs */}
        <Card className="border-amber-100">
          <CardContent className="pt-4 pb-4">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide flex items-center gap-1.5 mb-3">
              <Package className="w-3.5 h-3.5 text-amber-500" /> BE liés ({bes.length})
            </p>
            {bes.map(be => (
              <Link key={be.id} href={`/be-receptions/${be.id}`} className="flex items-center justify-between px-2 py-1.5 rounded-lg hover:bg-amber-50 transition-colors">
                <span className="text-sm font-medium text-amber-700 font-mono">{be.numero_be}</span>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-400">{formatDate(be.date_bl)}</span>
                  <StatusBadge status={be.statut_be} />
                </div>
              </Link>
            ))}
            {bes.length === 0 && <p className="text-xs text-gray-400 italic">Aucun BE lié</p>}
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
              <textarea value={notes} onChange={e => setNotes(e.target.value)} className="w-full border border-gray-200 rounded-lg p-2 text-sm resize-none h-20 focus:outline-none focus:ring-2 focus:ring-indigo-500" placeholder="Note libre…" />
              <Button size="sm" onClick={() => saveNotesMutation.mutate()} disabled={saveNotesMutation.isPending}><Save className="w-3.5 h-3.5 mr-1" /> Enregistrer</Button>
            </div>
          ) : (
            <p className="text-sm text-gray-600 whitespace-pre-wrap min-h-5">{notes || <span className="text-gray-400 italic">Aucune note</span>}</p>
          )}
        </CardContent>
      </Card>

      {/* Historique */}
      {journal.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <History className="w-4 h-4 text-gray-400" /> Historique
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-gray-50 max-h-48 overflow-y-auto">
              {journal.map(j => {
                let detail = j.details_action ?? '';
                try { const p = JSON.parse(detail); detail = typeof p === 'object' ? Object.entries(p).map(([k, v]) => `${k}: ${v}`).join(' · ') : detail; } catch { /* keep raw */ }
                return (
                  <div key={j.id} className="flex items-start gap-3 px-4 py-2.5">
                    <div className="w-1.5 h-1.5 rounded-full bg-gray-300 mt-1.5 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-gray-700">{j.type_action}</p>
                      {detail && <p className="text-xs text-gray-400 truncate">{detail}</p>}
                    </div>
                    <span className="text-xs text-gray-300 shrink-0 tabular-nums">
                      {new Date(j.created_at).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Lignes avec analyse rapprochement */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Lignes facture & rapprochement ({lignesFacture.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-gray-50/50 border-y border-gray-100">
                  <th className="text-left px-3 py-2.5 font-semibold text-gray-500">Réf.</th>
                  <th className="text-left px-3 py-2.5 font-semibold text-gray-500">Désignation</th>
                  <th className="text-right px-3 py-2.5 font-semibold text-gray-500">Qté fact.</th>
                  <th className="text-right px-3 py-2.5 font-semibold text-gray-500">PU fact.</th>
                  <th className="text-right px-3 py-2.5 font-semibold text-gray-500">Total HT</th>
                  <th className="text-right px-3 py-2.5 font-semibold text-gray-500">Qté cmd.</th>
                  <th className="text-right px-3 py-2.5 font-semibold text-gray-500">PU cmd.</th>
                  <th className="text-right px-3 py-2.5 font-semibold text-gray-500">Qté reçue</th>
                  <th className="text-right px-3 py-2.5 font-semibold text-gray-500">Δ Qté</th>
                  <th className="text-right px-3 py-2.5 font-semibold text-gray-500">Δ Prix</th>
                  <th className="px-3 py-2.5 font-semibold text-gray-500">Statut</th>
                  <th className="px-3 py-2.5 font-semibold text-gray-500">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {isLoadingRaps ? (
                  <tr><td colSpan={12} className="py-8 text-center">
                    <div className="inline-block w-5 h-5 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
                  </td></tr>
                ) : vue.length === 0 ? (
                  <tr><td colSpan={12} className="py-8 text-center text-xs text-gray-400">Aucune ligne de facture</td></tr>
                ) : vue.map(({ lf, bestRap, qFact, puFact, totalFact, qCmd, puCmd, qRecue, ecartQte, ecartPrix, issues, etat }) => {
                  const rowBg = etat === 'anomalie' ? 'bg-red-50/30' : etat === 'ok' ? 'bg-emerald-50/20' : '';
                  return (
                    <tr key={lf.id} className={cn('hover:bg-gray-50/50', rowBg)}>
                      <td className="px-3 py-2.5 font-mono font-medium">{lf.reference_article}</td>
                      <td className="px-3 py-2.5 text-gray-600 max-w-[140px] truncate" title={lf.designation ?? ''}>{lf.designation}</td>
                      <td className="px-3 py-2.5 text-right font-mono">{qFact}</td>
                      <td className="px-3 py-2.5 text-right font-mono">{puFact > 0 ? puFact.toFixed(4) : '—'}</td>
                      <td className="px-3 py-2.5 text-right font-mono">{formatEur(totalFact)}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-gray-400">{qCmd ?? '—'}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-gray-400">{puCmd != null ? puCmd.toFixed(4) : '—'}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-gray-400">{qRecue ?? '—'}</td>
                      <td className="px-3 py-2.5 text-right font-mono">
                        {ecartQte !== null ? (
                          ecartQte === 0
                            ? <span className="text-emerald-500">✓</span>
                            : <span className={cn('font-bold', ecartQte > 0 ? 'text-red-600' : 'text-amber-600')}>{ecartQte > 0 ? `+${ecartQte}` : ecartQte}</span>
                        ) : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono">
                        {ecartPrix !== null ? (
                          Math.abs(ecartPrix) <= 2
                            ? <span className="text-emerald-500">✓</span>
                            : <span className={cn('font-bold flex items-center justify-end gap-0.5', ecartPrix > 0 ? 'text-red-600' : 'text-emerald-600')}>
                                {ecartPrix > 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                                {`${ecartPrix > 0 ? '+' : ''}${ecartPrix.toFixed(1)}%`}
                              </span>
                        ) : '—'}
                      </td>
                      <td className="px-3 py-2.5">
                        {issues.length > 0 ? (
                          <div className="flex flex-col gap-0.5">
                            {issues.map((iss, i) => (
                              <span key={i} className={cn('text-xs', iss.niveau === 'haute' ? 'text-red-600' : iss.niveau === 'moyenne' ? 'text-amber-600' : 'text-gray-400')}>
                                {iss.label}
                              </span>
                            ))}
                          </div>
                        ) : bestRap ? (
                          <StatusBadge status={bestRap.statut_validation} />
                        ) : (
                          <span className="text-gray-300 text-xs">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-1">
                          {bestRap?.statut_validation === 'proposé' && (
                            <>
                              <button onClick={() => validateRapMutation.mutate(bestRap.id)} disabled={validateRapMutation.isPending} className="p-1 rounded hover:bg-emerald-50 text-emerald-500" title="Valider">
                                <CheckCircle2 className="w-3.5 h-3.5" />
                              </button>
                              <button onClick={() => rejectRapMutation.mutate(bestRap.id)} disabled={rejectRapMutation.isPending} className="p-1 rounded hover:bg-red-50 text-red-400" title="Rejeter">
                                <XCircle className="w-3.5 h-3.5" />
                              </button>
                            </>
                          )}
                          {etat === 'non_rapproche' && (
                            <button onClick={() => setManualTarget(lf.id)} className="p-1 rounded text-gray-300 hover:bg-blue-50 hover:text-blue-500" title="Rapprochement manuel">
                              <Link2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                          {editingLineNotes?.id === lf.id ? (
                            <div className="flex items-center gap-1">
                              <Input value={editingLineNotes.value} onChange={e => setEditingLineNotes({ id: lf.id, value: e.target.value })} className="h-6 text-xs w-24" autoFocus />
                              <button onClick={() => saveLineNotesMutation.mutate({ lineId: lf.id, comment: editingLineNotes.value })} className="text-emerald-500"><Save className="w-3 h-3" /></button>
                              <button onClick={() => setEditingLineNotes(null)} className="text-gray-400"><X className="w-3 h-3" /></button>
                            </div>
                          ) : (
                            <button onClick={() => setEditingLineNotes({ id: lf.id, value: lf.commentaire ?? '' })} className="p-1 rounded hover:bg-gray-100" title={lf.commentaire ?? ''}>
                              <MessageSquare className={cn('w-3.5 h-3.5', lf.commentaire ? 'text-indigo-500 fill-indigo-100' : 'text-gray-300')} />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Modal rapprochement manuel */}
      {manualTarget !== null && (
        <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center">
          <div className="bg-white rounded-xl shadow-2xl p-6 w-[480px] max-h-[80vh] overflow-y-auto">
            <h3 className="text-base font-semibold text-gray-900 mb-4">Rapprochement manuel</h3>

            {/* Sélecteur BE */}
            <div className="mb-4">
              <p className="text-xs font-semibold text-gray-500 mb-2 uppercase tracking-wide">Bon d'entrée</p>
              {besDispo.length === 0 ? (
                <p className="text-xs text-gray-400 italic">Aucun BE trouvé pour ce fournisseur</p>
              ) : (
                <div className="max-h-36 overflow-y-auto border border-gray-100 rounded-lg divide-y divide-gray-50">
                  {besDispo.map(be => (
                    <button
                      key={be.id}
                      onClick={() => { setManualBeId(be.id); setManualLigneBEId(''); }}
                      className={cn(
                        'w-full text-left px-3 py-2 text-xs transition-colors',
                        manualBeId === be.id ? 'bg-amber-100 text-amber-800 font-semibold' : 'hover:bg-gray-50 text-gray-700',
                      )}
                    >
                      <span className="font-mono font-medium">{be.numero_be}</span>
                      {be.date_bl && <span className="text-gray-400 ml-2">{formatDate(be.date_bl)}</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Lignes BE */}
            {manualBeId && (
              <div className="mb-4">
                <p className="text-xs font-semibold text-gray-500 mb-2 uppercase tracking-wide">Ligne BE</p>
                {lignesBEDispo.length === 0 ? (
                  <p className="text-xs text-gray-400 italic">Aucune ligne dans ce BE</p>
                ) : (
                  <div className="max-h-36 overflow-y-auto border border-gray-100 rounded-lg divide-y divide-gray-50">
                    {lignesBEDispo.map(lb => (
                      <button
                        key={lb.id}
                        onClick={() => setManualLigneBEId(lb.id)}
                        className={cn(
                          'w-full text-left px-3 py-2 text-xs transition-colors',
                          manualLigneBEId === lb.id ? 'bg-blue-100 text-blue-800 font-semibold' : 'hover:bg-gray-50 text-gray-700',
                        )}
                      >
                        <span className="font-mono">{lb.reference_article ?? '—'}</span>
                        {lb.designation && <span className="text-gray-400 ml-2 truncate">{lb.designation}</span>}
                        <span className="ml-2 text-gray-500">× {lb.quantite_receptionnee}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {manualLigneBEId && (() => {
              const lb = lignesBEDispo.find(l => l.id === manualLigneBEId);
              const lf = manualTarget ? lignesFacture.find(l => l.id === manualTarget) : null;
              if (!lb || !lf) return null;
              const previewQty = Math.min(Number(lf.quantite_facturee ?? 0), Number(lb.quantite_receptionnee ?? 0));
              const previewMontant = lf.pu_facture != null ? previewQty * Number(lf.pu_facture) : null;
              return (
                <div className="mt-3 p-3 bg-indigo-50 rounded-lg border border-indigo-100 text-sm space-y-1">
                  <p className="font-medium text-indigo-800">Aperçu du rapprochement</p>
                  <p className="text-indigo-700">Quantité : <span className="font-mono font-semibold">{previewQty}</span></p>
                  {previewMontant != null && (
                    <p className="text-indigo-700">Montant estimé : <span className="font-mono font-semibold">{previewMontant.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' })}</span></p>
                  )}
                </div>
              );
            })()}

            <div className="flex justify-end gap-2 mt-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { setManualTarget(null); setManualBeId(''); setManualLigneBEId(''); }}
              >
                Annuler
              </Button>
              <Button
                size="sm"
                disabled={!manualLigneBEId || createManualRapMutation.isPending}
                onClick={() => {
                  const lb = lignesBEDispo.find(l => l.id === manualLigneBEId);
                  const lf = lignesFacture.find(l => l.id === manualTarget);
                  if (!lb || !lf) return;
                  const qte = Math.min(lf.quantite_facturee, lb.quantite_receptionnee);
                  const montant = lf.pu_facture != null ? qte * lf.pu_facture : null;
                  createManualRapMutation.mutate({
                    ligneFacId: manualTarget!,
                    beId: manualBeId,
                    ligneBEId: manualLigneBEId,
                    quantiteRapprochee: qte,
                    montantRapproche: montant,
                  });
                }}
              >
                <Link2 className="w-3.5 h-3.5 mr-1.5" />
                Confirmer
              </Button>
            </div>
          </div>
        </div>
      )}

      <PDFViewerPanel url={facture.pdf_url} open={showPDF} onClose={() => setShowPDF(false)} title={`Facture ${facture.numero_facture}`} />
    </div>
  );
}
