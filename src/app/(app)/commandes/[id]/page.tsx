'use client';

import { useState, useEffect, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import StatusBadge from '@/components/shared/StatusBadge';
import { formatEur, formatDate, cn } from '@/utils';
import {
  ArrowLeft, Plus, Package,
  Edit2, Save, X, MessageSquare, FileText, History
} from 'lucide-react';
import ReferenceHistoryModal from '@/components/shared/ReferenceHistoryModal';
import { toast } from 'sonner';
import type { Commande, LigneCommande, Facture, LiaisonFactureCommande, Rapprochement } from '@/types';

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

export default function CommandeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();

  const [showAddLine, setShowAddLine] = useState(false);
  const [lineForm, setLineForm] = useState({ reference_article: '', designation: '', quantite_commandee: '', pu_commande: '' });
  const [prixSuggere, setPrixSuggere] = useState<{ pu: number; designation: string | null } | null>(null);
  const [refHistory, setRefHistory] = useState<string | null>(null);
  const [editingPU, setEditingPU] = useState<{ id: string; value: string } | null>(null);
  const [editingNotes, setEditingNotes] = useState(false);
  const [notes, setNotes] = useState('');
  const [editingDate, setEditingDate] = useState(false);
  const [dateValue, setDateValue] = useState('');
  const [editingLineNotes, setEditingLineNotes] = useState<{ id: string; value: string } | null>(null);
  const [editingQteCmd, setEditingQteCmd] = useState<{ id: string; value: string } | null>(null);
  const [editingDesig, setEditingDesig] = useState<{ id: string; value: string } | null>(null);
  const [editingStatut, setEditingStatut] = useState(false);
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

  // BE / réceptions rattachés à cette commande — dérivés de Centralink (saisies log),
  // PAS d'attribution manuelle. Source de vérité : saisies_cl (numero_be ↔ commande_ref).
  const { data: saisiesCmd = [] } = useQuery<{ numero_be: string; reference_article: string | null; quantite_recue: number | null }[]>({
    queryKey: ['saisies_cl_cmd', commande?.numero_commande_interne],
    queryFn: async () => {
      const { data } = await supabase
        .from('saisies_cl')
        .select('numero_be, reference_article, quantite_recue')
        .eq('commande_ref', commande!.numero_commande_interne);
      return data ?? [];
    },
    enabled: !!commande, refetchInterval: 10000,
  });

  // Tous les BE importés (pour rendre cliquables ceux qu'on a déjà scannés)
  const { data: beImportes = [] } = useQuery<{ id: string; numero_be: string }[]>({
    queryKey: ['be_importes_all'],
    queryFn: async () => {
      const { data } = await supabase.from('be_receptions').select('id, numero_be').limit(1000);
      return data ?? [];
    },
    staleTime: 30000,
  });

  const besRecus = useMemo(() => {
    const normBe = (s: string | null) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const beIdByNum = new Map(beImportes.map(b => [normBe(b.numero_be), b.id]));
    const byBe = new Map<string, { numero_be: string; qte: number; refs: Set<string> }>();
    for (const s of saisiesCmd) {
      if (!s.numero_be) continue;
      const k = normBe(s.numero_be);
      const cur = byBe.get(k) ?? { numero_be: s.numero_be, qte: 0, refs: new Set<string>() };
      cur.qte += s.quantite_recue ?? 0;
      if (s.reference_article) cur.refs.add(s.reference_article);
      byBe.set(k, cur);
    }
    return [...byBe.entries()]
      .map(([k, v]) => ({ numero_be: v.numero_be, qte: v.qte, nbRefs: v.refs.size, beId: beIdByNum.get(k) ?? null }))
      .sort((a, b) => a.numero_be.localeCompare(b.numero_be));
  }, [saisiesCmd, beImportes]);

  // ② BE papier scopé à CETTE commande : le papier des BE qui ont livré cette réf POUR
  // cette commande (lien BE↔commande via saisies_cl). On ne ramasse PAS le papier d'une
  // autre commande quand un BE est partagé (ex. BE-1209 sert 8 commandes).
  const servingBeIds = useMemo(() => besRecus.map(b => b.beId).filter((x): x is string => !!x), [besRecus]);
  const servingBeNums = useMemo(() => besRecus.map(b => b.numero_be), [besRecus]);
  const { data: lignesBeServing = [] } = useQuery<{ be_id: string; reference_article: string | null; quantite_receptionnee: number | null; hors_systeme: boolean | null }[]>({
    queryKey: ['lignes-be-serving', servingBeIds.join()],
    queryFn: async () => {
      const { data } = await supabase.from('lignes_be').select('be_id, reference_article, quantite_receptionnee, hors_systeme').in('be_id', servingBeIds);
      return data ?? [];
    },
    enabled: servingBeIds.length > 0, staleTime: 30000,
  });
  // Saisies de TOUTES les commandes sur les BE servant cette commande → pour répartir le
  // papier au prorata quand un même (BE, réf) est partagé entre plusieurs commandes (M2M).
  const { data: saisiesServing = [] } = useQuery<{ numero_be: string; reference_article: string | null; quantite_recue: number | null; commande_ref: string | null }[]>({
    queryKey: ['saisies-serving', servingBeNums.join()],
    queryFn: async () => {
      const { data } = await supabase.from('saisies_cl').select('numero_be, reference_article, quantite_recue, commande_ref').in('numero_be', servingBeNums);
      return data ?? [];
    },
    enabled: servingBeNums.length > 0, staleTime: 30000,
  });

  const { papierParRef, refsPartagees, saisieScanParRef, saisieHorsScanParRef } = useMemo(() => {
    const normRef = (s: string | null) => String(s ?? '').toUpperCase().replace(/O/g, '0').replace(/[^A-Z0-9]/g, '');
    const normBe = (s: string | null) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const numByBeId = new Map(beImportes.map(b => [b.id, b.numero_be]));
    const myNum = commande?.numero_commande_interne;
    // Bons de cette commande DÉJÀ scannés (M2M + outil lancé en cours de route : une commande
    // peut être servie en partie par un bon historique jamais scanné → le papier ② ne peut
    // être comparé qu'à la saisie DES BONS SCANNÉS, sinon faux ⚠ mécanique).
    const scannedNums = new Set(besRecus.filter(b => b.beId).map(b => normBe(b.numero_be)));
    // Par (BE, réf) : saisie TOTALE (toutes commandes) et part de CETTE commande.
    const totalPair = new Map<string, number>();
    const thisPair = new Map<string, number>();
    // Saisie de CETTE commande, par réf, séparée bons scannés / non scannés (même périmètre que ②).
    const scanParRef = new Map<string, number>();
    const horsScanParRef = new Map<string, number>();
    for (const s of saisiesServing) {
      if (!s.numero_be || !s.reference_article) continue;
      const nb = normBe(s.numero_be);
      const pk = nb + '|' + normRef(s.reference_article);
      totalPair.set(pk, (totalPair.get(pk) ?? 0) + (s.quantite_recue ?? 0));
      if (s.commande_ref === myNum) {
        thisPair.set(pk, (thisPair.get(pk) ?? 0) + (s.quantite_recue ?? 0));
        const rk = normRef(s.reference_article);
        const cible = scannedNums.has(nb) ? scanParRef : horsScanParRef;
        cible.set(rk, (cible.get(rk) ?? 0) + (s.quantite_recue ?? 0));
      }
    }
    const m = new Map<string, number>();
    const partagees = new Set<string>();
    for (const l of lignesBeServing) {
      if (l.hors_systeme) continue;
      const pk = normBe(numByBeId.get(l.be_id) ?? null) + '|' + normRef(l.reference_article);
      const mine = thisPair.get(pk);
      if (!mine) continue; // (BE, réf) pas reçu pour cette commande
      const tot = totalPair.get(pk) ?? mine;
      const part = tot > 0 ? mine / tot : 1;            // part de cette commande (prorata saisie)
      const rk = normRef(l.reference_article);
      m.set(rk, (m.get(rk) ?? 0) + (l.quantite_receptionnee ?? 0) * part);
      if (part < 0.999) partagees.add(rk);              // (BE, réf) partagé avec une autre commande
    }
    for (const [k, v] of m) m.set(k, Math.round(v));
    return { papierParRef: m, refsPartagees: partagees, saisieScanParRef: scanParRef, saisieHorsScanParRef: horsScanParRef };
  }, [lignesBeServing, saisiesServing, beImportes, commande, besRecus]);

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


  useEffect(() => {
    if (commande) {
      setNotes(commande.commentaire ?? '');
      if (!editingDate) setDateValue(commande.date_commande?.slice(0, 10) ?? '');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commande]);

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

  const causeAnomalie = useMemo(() => {
    if (commande?.statut_commande !== 'en anomalie') return null;
    const surRecus = lignes.filter(l => computeStatutLigne(l) === 'sur-réceptionné').length;
    const surFact  = lignes.filter(l => computeStatutLigne(l) === 'sur-facturée').length;
    const parts: string[] = [];
    if (surRecus > 0) parts.push(`${surRecus} sur-réceptionné${surRecus > 1 ? 'es' : 'e'}`);
    if (surFact  > 0) parts.push(`${surFact} sur-facturé${surFact > 1 ? 'es' : 'e'}`);
    return parts.join(' · ') || null;
  }, [commande?.statut_commande, lignes]);

  // ── Mutations ─────────────────────────────────────────────────────────────
  const saveNotesMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from('commandes').update({ commentaire: notes }).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['commande', id] }); setEditingNotes(false); toast.success('Note enregistrée'); },
    onError: (e: Error) => toast.error(e.message),
  });

  const saveDateMutation = useMutation({
    mutationFn: async (date: string) => {
      const { error } = await supabase.from('commandes').update({ date_commande: date || null }).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['commande', id] }); setEditingDate(false); toast.success('Date mise à jour'); },
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
      setEditingPU(prev => prev?.id === lineId ? null : prev);
      toast.success('Prix mis à jour');
      void recalcMontantTotal();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const saveQteCmdMutation = useMutation({
    mutationFn: async ({ lineId, qte }: { lineId: string; qte: number }) => {
      const ligne = lignes.find(l => l.id === lineId);
      const montant_ht_commande = ligne?.pu_commande != null ? qte * ligne.pu_commande : null;
      const quantite_restante_a_recevoir = Math.max(0, qte - (ligne?.quantite_receptionnee_reelle ?? 0));
      const { error } = await supabase.from('lignes_commande').update({
        quantite_commandee: qte,
        montant_ht_commande,
        quantite_restante_a_recevoir,
      }).eq('id', lineId);
      if (error) throw error;
    },
    onSuccess: (_data, { lineId }) => {
      qc.invalidateQueries({ queryKey: ['lignes_commande', id] });
      setEditingQteCmd(prev => prev?.id === lineId ? null : prev);
      toast.success('Quantité mise à jour');
      void recalcMontantTotal();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const recalcMontantTotal = async () => {
    const { data: allLignes } = await supabase
      .from('lignes_commande').select('montant_ht_commande, pu_commande, quantite_commandee').eq('commande_id', id);
    const total = (allLignes ?? []).reduce((s, l) => {
      const montant = l.montant_ht_commande ?? ((l.quantite_commandee ?? 0) * (l.pu_commande ?? 0));
      return s + montant;
    }, 0);
    await supabase.from('commandes').update({ montant_total_commande: total || null }).eq('id', id);
    qc.invalidateQueries({ queryKey: ['commande', id] });
  };

  // Auto-recalcul si montant_total_commande est null mais les lignes ont des prix
  useEffect(() => {
    if (commande && commande.montant_total_commande == null && kpis.montantCmd > 0) {
      void recalcMontantTotal();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commande?.id, kpis.montantCmd]);

  const saveDesigMutation = useMutation({
    mutationFn: async ({ lineId, designation }: { lineId: string; designation: string }) => {
      const { error } = await supabase.from('lignes_commande').update({ designation }).eq('id', lineId);
      if (error) throw error;
    },
    onSuccess: (_data, { lineId }) => {
      qc.invalidateQueries({ queryKey: ['lignes_commande', id] });
      setEditingDesig(prev => prev?.id === lineId ? null : prev);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const changeStatutMutation = useMutation({
    mutationFn: async (statut: string) => {
      const { error } = await supabase.from('commandes').update({ statut_commande: statut }).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['commande', id] });
      setEditingStatut(false);
      toast.success('Statut mis à jour');
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
      for (const ligne of sansPrix ?? []) {
        const { data: prix } = await supabase
          .from('prix_reference')
          .select('pu_last')
          .eq('reference_article', ligne.reference_article)
          .order('updated_at', { ascending: false })
          .limit(1)
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

  if (!commande) {
    return <div className="flex items-center justify-center h-64 text-gray-400 text-sm">Chargement…</div>;
  }

  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" className="h-8 w-8" title="Retour à la liste"
          onClick={() => { if (window.history.length > 1) router.back(); else router.push('/commandes'); }}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div>
          <h1 className="text-xl font-bold text-gray-900 font-mono">{commande.numero_commande_interne}</h1>
          <p className="text-sm text-gray-500">{commande.fournisseur}</p>
        </div>
        {editingStatut ? (
          <select
            value={commande.statut_commande}
            onChange={e => changeStatutMutation.mutate(e.target.value)}
            onBlur={() => setEditingStatut(false)}
            className="text-xs border border-indigo-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-indigo-400"
            autoFocus
          >
            {(['ouverte', 'partiellement réceptionnée', 'réceptionnée', 'partiellement facturée', 'soldée', 'en anomalie'] as const).map(s => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        ) : (
          <div className="flex items-center gap-2">
            <button onClick={() => setEditingStatut(true)} title="Cliquer pour changer le statut">
              <StatusBadge status={commande.statut_commande} />
            </button>
            {causeAnomalie && (
              <span className="text-xs font-medium text-red-600 bg-red-50 border border-red-200 rounded-full px-2.5 py-0.5 shrink-0">
                {causeAnomalie}
              </span>
            )}
          </div>
        )}
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        {/* Date — éditable au clic */}
        <Card className="cursor-pointer hover:border-indigo-200 transition-colors" onClick={() => !editingDate && setEditingDate(true)}>
          <CardContent className="pt-4 pb-3">
            <p className="text-xs text-gray-400 flex items-center gap-1">
              Date commande <Edit2 className="w-2.5 h-2.5 text-gray-300" />
            </p>
            {editingDate ? (
              <div className="flex items-center gap-1 mt-1" onClick={e => e.stopPropagation()}>
                <input
                  type="date"
                  value={dateValue}
                  onChange={e => setDateValue(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') saveDateMutation.mutate(dateValue);
                    if (e.key === 'Escape') { setEditingDate(false); setDateValue(commande.date_commande?.slice(0, 10) ?? ''); }
                  }}
                  className="text-xs border border-indigo-300 rounded px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-indigo-400 w-full"
                  autoFocus
                />
                <button onClick={() => saveDateMutation.mutate(dateValue)} className="text-emerald-500 hover:text-emerald-700 shrink-0">
                  <Save className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => { setEditingDate(false); setDateValue(commande.date_commande?.slice(0, 10) ?? ''); }} className="text-gray-400 hover:text-gray-600 shrink-0">
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <p className="text-sm font-semibold text-gray-900 mt-0.5">
                {formatDate(commande.date_commande) ?? <span className="text-gray-300 italic font-normal text-xs">— Cliquer pour saisir</span>}
              </p>
            )}
          </CardContent>
        </Card>

        {[
          { label: 'Qté commandée', value: kpis.qteCmd },
          { label: 'Reçu (saisie CL)', value: kpis.qteRecue },
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
        {/* BE / réceptions rattachés (depuis Centralink — lecture seule) */}
        <Card className="border-amber-100">
          <CardContent className="pt-4 pb-4">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide flex items-center gap-1.5 mb-3">
              <Package className="w-3.5 h-3.5 text-amber-500" /> BE / réceptions ({besRecus.length})
              <span className="text-[10px] text-gray-300 normal-case font-normal ml-1">depuis Centralink</span>
            </p>
            {besRecus.length === 0 ? (
              <p className="text-xs text-amber-600 italic">Aucune réception saisie dans Centralink pour cette commande</p>
            ) : (
              <div className="space-y-1">
                {besRecus.map(b => (
                  <div key={b.numero_be} className="flex items-center justify-between px-2 py-1.5 rounded-lg hover:bg-amber-50 transition-colors">
                    {b.beId ? (
                      <Link href={`/be-receptions/${b.beId}`} className="text-sm font-medium text-amber-700 font-mono hover:underline">
                        {b.numero_be}
                      </Link>
                    ) : (
                      <span className="text-sm font-mono text-gray-500" title="BE pas encore importé (scanné) dans syncflow">
                        {b.numero_be} <span className="text-[10px] text-gray-400">· non importé</span>
                      </span>
                    )}
                    <span className="text-xs text-gray-500 whitespace-nowrap">
                      {b.nbRefs} réf · <span className="font-medium text-emerald-600">{b.qte} reçu</span>
                    </span>
                  </div>
                ))}
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
                  <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-500" title="Cliquer sur une valeur pour la modifier">Qté cmd ✎</th>
                  <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-500" title="Quantité reçue d'après la saisie de la log dans Centralink (③)">{modeRecu === 'unites' ? 'Reçu (saisie CL)' : 'Reçu HT €'}</th>
                  <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-500" title="Quantité reçue d'après TON BL papier scanné (②), sur les BE qui ont livré cette réf POUR cette commande. Écart avec la saisie CL = la log n'a pas saisi conformément au papier.">② BE papier</th>
                  <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-500">Qté facturée</th>
                  <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-500">PU €</th>
                  <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-500">Total HT</th>
                  <th className="px-4 py-2.5 text-xs font-semibold text-gray-500 text-center">Note</th>
                  <th className="px-4 py-2.5 text-xs font-semibold text-gray-500">Statut ligne</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {lignes.map(l => {
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
                    <td className="px-4 py-2.5 text-xs max-w-[200px]">
                      {editingDesig?.id === l.id ? (
                        <div className="flex items-center gap-1">
                          <Input
                            value={editingDesig.value}
                            onChange={e => setEditingDesig({ id: l.id, value: e.target.value })}
                            onKeyDown={e => {
                              if (e.key === 'Escape') { setEditingDesig(null); return; }
                              if (e.key === 'Enter') saveDesigMutation.mutate({ lineId: l.id, designation: editingDesig.value });
                            }}
                            className="h-6 text-xs flex-1"
                            autoFocus
                          />
                          <button onClick={() => saveDesigMutation.mutate({ lineId: l.id, designation: editingDesig.value })} className="text-emerald-500 hover:text-emerald-700 shrink-0"><Save className="w-3 h-3" /></button>
                          <button onClick={() => setEditingDesig(null)} className="text-gray-400 hover:text-gray-600 shrink-0"><X className="w-3 h-3" /></button>
                        </div>
                      ) : (
                        <span
                          className="cursor-pointer text-gray-600 hover:text-gray-900 hover:underline truncate block"
                          onClick={() => setEditingDesig({ id: l.id, value: l.designation ?? '' })}
                          title={l.designation ?? 'Cliquer pour saisir la désignation'}
                        >
                          {l.designation || <span className="text-gray-300 italic">—</span>}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs">
                      {editingQteCmd?.id === l.id ? (
                        <div className="flex items-center justify-end gap-1">
                          <Input
                            type="number" min="0" step="1"
                            value={editingQteCmd.value}
                            onChange={e => setEditingQteCmd({ id: l.id, value: e.target.value })}
                            onKeyDown={e => {
                              if (e.key === 'Escape') { setEditingQteCmd(null); return; }
                              if (e.key === 'Enter') {
                                saveQteCmdMutation.mutate({ lineId: l.id, qte: parseFloat(editingQteCmd.value) || 0 });
                                const idx = lignes.findIndex(line => line.id === l.id);
                                if (idx < lignes.length - 1) setEditingQteCmd({ id: lignes[idx + 1].id, value: String(lignes[idx + 1].quantite_commandee ?? '') });
                                else setEditingQteCmd(null);
                              }
                            }}
                            className="w-16 h-6 text-xs"
                            autoFocus
                          />
                          <button onClick={() => saveQteCmdMutation.mutate({ lineId: l.id, qte: parseFloat(editingQteCmd.value) || 0 })} className="text-emerald-500 hover:text-emerald-700"><Save className="w-3 h-3" /></button>
                          <button onClick={() => setEditingQteCmd(null)} className="text-gray-400 hover:text-gray-600"><X className="w-3 h-3" /></button>
                        </div>
                      ) : (
                        <span
                          className="cursor-pointer hover:underline text-gray-800"
                          onClick={() => setEditingQteCmd({ id: l.id, value: String(l.quantite_commandee ?? '') })}
                          title="Cliquer pour modifier la quantité commandée"
                        >
                          {l.quantite_commandee}
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
                      {(() => {
                        const normRef = (s: string | null) => String(s ?? '').toUpperCase().replace(/O/g, '0').replace(/[^A-Z0-9]/g, '');
                        const rk = normRef(l.reference_article);
                        const pap = papierParRef.get(rk);
                        if (pap === undefined) return <span className="text-gray-300">—</span>;
                        // MÊME PÉRIMÈTRE : le papier ② (bons scannés) se compare à la saisie CL
                        // de cette commande SUR CES MÊMES BONS — pas au Livré total, qui peut
                        // inclure des bons jamais scannés (M2M + outil lancé en cours de route).
                        const saisieScan = saisieScanParRef.get(rk) ?? 0;
                        const horsScan = saisieHorsScanParRef.get(rk) ?? 0;
                        const diff = Math.abs(pap - saisieScan) > 0.001;
                        const partage = refsPartagees.has(rk);
                        return (
                          <span
                            className={cn(diff ? 'text-amber-600 font-semibold' : 'text-gray-400')}
                            title={
                              (partage ? `≈ BE partagé entre plusieurs commandes : papier réparti au prorata de la saisie. ` : '') +
                              (diff
                                ? `BL papier ${pap} ≠ saisie CL ${saisieScan} (sur les bons scannés) → la log n'a pas saisi conformément au papier sur cette commande`
                                : `BL papier ${pap} = saisie CL (sur les bons scannés)`) +
                              (horsScan > 0 ? ` · + ${horsScan} reçu(s) via bon(s) non scanné(s) — hors périmètre papier, pas un écart` : '')
                            }
                          >
                            {partage ? '≈' : ''}{pap}{diff ? ' ⚠' : ''}{horsScan > 0 ? <span className="text-gray-400 font-normal"> (+{horsScan}*)</span> : ''}
                          </span>
                        );
                      })()}
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
