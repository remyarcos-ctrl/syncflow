'use client';

import { useState, useMemo, useRef, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import Link from 'next/link';
import PageHeader from '@/components/shared/PageHeader';
import EmptyState from '@/components/shared/EmptyState';
import Pagination from '@/components/shared/Pagination';
import { Button } from '@/components/ui/button';
import { formatDate } from '@/utils';
import { AlertTriangle, TrendingUp, Package, FileText, CheckCircle2, Eye, XCircle, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import type { Exception, Facture, BEReception, Commande } from '@/types';
import { cn } from '@/utils';

const PAGE_SIZE = 50;

const TYPE_CONFIG: Record<string, { color: string; label: string }> = {
  'surfacturation quantité':  { color: 'text-red-600 bg-red-50',    label: 'Surfacturation Qté' },
  'réception incomplète':     { color: 'text-orange-600 bg-orange-50', label: 'Livraison partielle' },
  'écart prix':               { color: 'text-amber-600 bg-amber-50', label: 'Écart de prix' },
  'be introuvable':           { color: 'text-red-600 bg-red-50',    label: 'BE introuvable' },
  'ligne non rapprochée':     { color: 'text-gray-600 bg-gray-50',  label: 'Non rapprochée' },
  'prix commande manquant':   { color: 'text-blue-600 bg-blue-50',  label: 'Prix manquant' },
  'quantité incohérente':     { color: 'text-red-600 bg-red-50',    label: 'Qté incohérente' },
  'prix incohérent':          { color: 'text-amber-600 bg-amber-50',label: 'Prix incohérent' },
  'sur-livraison':            { color: 'text-orange-600 bg-orange-50', label: 'Sur-livraison' },
  'hors-commande':            { color: 'text-red-600 bg-red-50',    label: 'Hors-commande' },
  'oubli log':                { color: 'text-red-600 bg-red-50',    label: 'Oubli log' },
  'sur-saisie log':           { color: 'text-amber-600 bg-amber-50',label: 'Sur-saisie log' },
  'numéro BE invalide':       { color: 'text-purple-600 bg-purple-50', label: 'N° BE invalide' },
};

// Exception + champs du centre unifié (étape 1)
type Exc = Exception & {
  origine?: string | null;
  destinataire?: string | null;
  reference_article?: string | null;
  assigne_a?: string | null;
  echeance?: string | null;
  suggestion_action_ia?: string | null;
};

const DEST_CONFIG: Record<string, string> = {
  Colombi: 'bg-orange-100 text-orange-700',
  log: 'bg-blue-100 text-blue-700',
  SAV: 'bg-teal-100 text-teal-700',
  interne: 'bg-gray-100 text-gray-600',
  'à vérifier': 'bg-amber-100 text-amber-700',
};

// Lien direct vers la page de réception Centralink d'un BE (pour vérifier la saisie log)
const lienCentralinkBE = (numeroBe: string) =>
  `https://sd.centralink.fr/admin/order/delivery_note?q=${encodeURIComponent(numeroBe)}`;
// Lien direct vers la page d'une commande Centralink (section Bon de Livraison)
const lienCentralinkCmd = (numero: string) =>
  `https://sd.centralink.fr/admin/order/view/${String(numero).replace(/[^0-9]/g, '')}`;

const PRIORITE_CONFIG: Record<string, string> = {
  haute:    'bg-red-100 text-red-700 border-red-200',
  moyenne:  'bg-orange-100 text-orange-700 border-orange-200',
  faible:   'bg-blue-100 text-blue-700 border-blue-200',
  critique: 'bg-red-200 text-red-800 border-red-300',
};

// Libellés CONTEXTUELS des deux valeurs (attendu/obtenu) selon le type d'anomalie :
// « obtenu » ne veut pas dire la même chose pour un pointage (saisi ③) que pour une
// facturation (facturé) ou une réception (reçu). On nomme chaque colonne explicitement.
const valLabels = (e: { type_exception?: string; origine?: string | null }): { att: string; obt: string } => {
  const t = String(e.type_exception ?? '');
  const o = e.origine ?? '';
  if (t === 'sur-saisie log') return { att: 'BL papier ②', obt: 'saisi CL ③' };
  if (t === 'sur-livraison') return o === 'réception' ? { att: 'commandé ①', obt: 'reçu ③' } : { att: 'BL papier ②', obt: 'saisi CL ③' };
  if (t === 'hors-commande') return { att: '', obt: 'reçu' };
  if (t === 'surfacturation quantité') return { att: 'reçu ③', obt: 'facturé ④' };
  if (t === 'écart prix') return { att: 'prix commande', obt: 'prix facturé' };
  return { att: 'attendu', obt: 'obtenu' };
};

export default function ExceptionsPage() {
  const qc = useQueryClient();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [filterStatut, setFilterStatut] = useState('actives');
  const [filterType, setFilterType] = useState('all');
  const [filterPriorite, setFilterPriorite] = useState('all');
  const [filterOrigine, setFilterOrigine] = useState('all');
  const [filterDest, setFilterDest] = useState('all');
  const [filterBe, setFilterBe] = useState('all');
  const [filterRef, setFilterRef] = useState('');
  const [showDetail, setShowDetail] = useState<Exc | null>(null);
  const [comment, setComment] = useState('');
  const [assigne, setAssigne] = useState('');
  const [echeance, setEcheance] = useState('');
  const [updating, setUpdating] = useState<string | null>(null);

  const { data: exceptionsResult = { exceptions: [], total: 0 }, isError } = useQuery<{ exceptions: Exc[]; total: number }>({
    queryKey: ['exceptions', page, filterStatut, filterType, filterPriorite, filterOrigine, filterDest, filterBe, filterRef],
    queryFn: async () => {
      let query = supabase
        .from('exceptions')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false });

      if (filterStatut === 'actives') query = query.in('statut_exception', ['ouverte', 'en cours']);
      else if (filterStatut === 'à analyser') query = query.eq('statut_exception', 'ouverte').eq('destinataire', 'Colombi');
      else if (filterStatut === 'résolues') query = query.in('statut_exception', ['résolue', 'ignorée']);

      if (filterType !== 'all') query = query.eq('type_exception', filterType);
      if (filterPriorite !== 'all') query = query.eq('niveau_priorite', filterPriorite);
      if (filterOrigine !== 'all') query = query.eq('origine', filterOrigine);
      // « à analyser » impose déjà destinataire = Colombi → ne pas re-appliquer filterDest
      // (sinon « Colombi ET log » = requête impossible → 0 résultat).
      if (filterDest !== 'all' && filterStatut !== 'à analyser') query = query.eq('destinataire', filterDest);
      if (filterBe !== 'all') query = query.eq('be_id', filterBe);
      if (filterRef.trim()) query = query.ilike('reference_article', `%${filterRef.trim()}%`);

      query = query.range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);

      const { data, count } = await query;
      return { exceptions: (data ?? []) as Exc[], total: count ?? 0 };
    },
    staleTime: 30_000,
  });

  const { exceptions, total } = exceptionsResult;

  // Separate lightweight query for KPI counts (always active exceptions)
  const { data: kpiData = { total: 0, aAnalyser: 0, haute: 0, log: 0 } } = useQuery<{ total: number; aAnalyser: number; haute: number; log: number }>({
    queryKey: ['exceptions-kpis'],
    queryFn: async () => {
      const { data } = await supabase
        .from('exceptions')
        .select('type_exception, niveau_priorite, statut_exception, destinataire')
        .in('statut_exception', ['ouverte', 'en cours']);
      const rows = data ?? [];
      return {
        total: rows.length,
        aAnalyser: rows.filter(e => e.statut_exception === 'ouverte' && e.destinataire === 'Colombi').length,
        haute: rows.filter(e => ['haute', 'critique'].includes(e.niveau_priorite)).length,
        log: rows.filter(e => e.destinataire === 'log').length,
      };
    },
    staleTime: 30_000,
  });

  useEffect(() => {
    const channel = supabase
      .channel('exceptions-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'exceptions' }, () => {
        clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
          void qc.invalidateQueries({ queryKey: ['exceptions'] });
          void qc.invalidateQueries({ queryKey: ['exceptions-kpis'] });
        }, 200);
      })
      .subscribe();
    return () => {
      clearTimeout(debounceRef.current);
      void supabase.removeChannel(channel);
    };
  }, [qc]);

  const { data: factures = [] } = useQuery<Pick<Facture, 'id' | 'numero_facture'>[]>({
    queryKey: ['factures-slim'],
    queryFn: async () => { const { data } = await supabase.from('factures').select('id,numero_facture').limit(500); return (data ?? []) as Pick<Facture, 'id' | 'numero_facture'>[]; },
    staleTime: 30000,
  });

  const { data: bes = [] } = useQuery<Pick<BEReception, 'id' | 'numero_be' | 'date_bl'>[]>({
    queryKey: ['bes-slim'],
    queryFn: async () => { const { data } = await supabase.from('be_receptions').select('id,numero_be,date_bl').limit(500); return (data ?? []) as Pick<BEReception, 'id' | 'numero_be' | 'date_bl'>[]; },
    staleTime: 30000,
  });

  // BE qui ont des anomalies actives → options du filtre par BE (pour préparer un message par BL).
  const { data: beIdsAvecAnomalies = [] } = useQuery<string[]>({
    queryKey: ['bes-avec-anomalies', filterStatut],
    queryFn: async () => {
      const statuts = filterStatut === 'résolues' ? ['résolue', 'ignorée'] : ['ouverte', 'en cours'];
      const { data } = await supabase.from('exceptions').select('be_id').in('statut_exception', statuts).not('be_id', 'is', null);
      return [...new Set((data ?? []).map((e) => e.be_id))].filter(Boolean) as string[];
    },
    staleTime: 30000,
  });

  const { data: commandes = [] } = useQuery<Pick<Commande, 'id' | 'numero_commande_interne'>[]>({
    queryKey: ['commandes-slim'],
    queryFn: async () => { const { data } = await supabase.from('commandes').select('id,numero_commande_interne').limit(500); return (data ?? []) as Pick<Commande, 'id' | 'numero_commande_interne'>[]; },
    staleTime: 30000,
  });

  // Réfs dont une commande attend encore de la marchandise (reliquat > 0)
  // → la log n'a probablement pas fini de saisir : l'anomalie est « peut-être en cours ».
  const { data: refsAttente = new Set<string>() } = useQuery<Set<string>>({
    queryKey: ['refs-en-attente'],
    queryFn: async () => {
      const { data } = await supabase.from('lignes_commande').select('reference_article, quantite_restante_a_recevoir').limit(9999);
      const norm = (s: string | null) => String(s ?? '').toUpperCase().replace(/O/g, '0').replace(/[^A-Z0-9]/g, '');
      return new Set((data ?? []).filter(l => (l.quantite_restante_a_recevoir ?? 0) > 0.001).map(l => norm(l.reference_article)).filter(Boolean));
    },
    staleTime: 30000,
  });
  const enCours = (ref: string | null | undefined) =>
    refsAttente.has(String(ref ?? '').toUpperCase().replace(/O/g, '0').replace(/[^A-Z0-9]/g, ''));

  // Réfs connues comme pièces détachées SAV (hors Centralink).
  const { data: refsSav = new Set<string>() } = useQuery<Set<string>>({
    queryKey: ['refs-sav'],
    queryFn: async () => {
      const { data } = await supabase.from('refs_sav').select('reference_article');
      return new Set((data ?? []).map(r => String(r.reference_article ?? '')));
    },
    staleTime: 30000,
  });
  const estRefSav = (ref: string | null | undefined) =>
    refsSav.has(String(ref ?? '').toUpperCase().replace(/O/g, '0').replace(/[^A-Z0-9]/g, ''));

  const factureMap = useMemo(() => Object.fromEntries(factures.map(f => [f.id, f])) as Record<string, Pick<Facture, 'id' | 'numero_facture'>>, [factures]);
  const beMap = useMemo(() => Object.fromEntries(bes.map(b => [b.id, b])) as Record<string, Pick<BEReception, 'id' | 'numero_be' | 'date_bl'>>, [bes]);
  // La log saisit en ~1 semaine (2 max). Au-delà de 2 semaines après la date du BE,
  // un manque > ne peut plus être « en cours de saisie » → on n'affiche plus le badge.
  const beRecent = (beId?: string | null) => {
    const d = beId ? beMap[beId]?.date_bl : null;
    if (!d) return false;
    return (Date.now() - new Date(d).getTime()) < 14 * 24 * 3600 * 1000;
  };
  const beOptions = useMemo(() => beIdsAvecAnomalies
    .map(id => ({ id, numero: beMap[id]?.numero_be ?? '' }))
    .filter(o => o.numero)
    .sort((a, b) => (a.numero < b.numero ? 1 : -1)), [beIdsAvecAnomalies, beMap]);
  const cmdMap = useMemo(() => Object.fromEntries(commandes.map(c => [c.id, c])) as Record<string, Pick<Commande, 'id' | 'numero_commande_interne'>>, [commandes]);

  // Diagnostic « où la réf est saisie ailleurs » pour l'anomalie ouverte (mauvais dispatching).
  // Sur-saisi (saisi > papier de ce BE) = marchandise mal numérotée atterrie là (🎯 coupable).
  const normRefEx = (s: string | null | undefined) => String(s ?? '').toUpperCase().replace(/O/g, '0').replace(/[^A-Z0-9]/g, '');
  const detailBeNum = showDetail?.be_id ? beMap[showDetail.be_id]?.numero_be : undefined;
  const { data: dispatchDetail = [] } = useQuery<{ numBe: string; saisie: number; scanned: boolean; papier: number | null; over: number | null }[]>({
    queryKey: ['dispatch-detail', showDetail?.id],
    queryFn: async () => {
      const ref = showDetail?.reference_article;
      if (!ref || !showDetail?.be_id || !detailBeNum) return [];
      const { data: myL } = await supabase.from('lignes_be').select('reference_article').eq('be_id', showDetail.be_id);
      const rawRef = (myL ?? []).map(l => l.reference_article).find(r => normRefEx(r) === normRefEx(ref)) ?? ref;
      const [sais, paps, scannedRows] = await Promise.all([
        supabase.from('saisies_cl').select('numero_be, quantite_recue').eq('reference_article', rawRef),
        supabase.from('lignes_be').select('quantite_receptionnee, hors_systeme, be_receptions(numero_be)').eq('reference_article', rawRef),
        supabase.from('be_receptions').select('numero_be').limit(1000),
      ]);
      const scanned = new Set((scannedRows.data ?? []).map(b => b.numero_be));
      const pap = new Map<string, number>();
      for (const l of (paps.data ?? []) as { quantite_receptionnee: number | null; hors_systeme: boolean | null; be_receptions: { numero_be: string } | { numero_be: string }[] | null }[]) {
        if (l.hors_systeme) continue;
        const nb = Array.isArray(l.be_receptions) ? l.be_receptions[0]?.numero_be : l.be_receptions?.numero_be;
        if (!nb) continue;
        pap.set(nb, (pap.get(nb) ?? 0) + (l.quantite_receptionnee ?? 0));
      }
      const bm = new Map<string, number>();
      for (const s of sais.data ?? []) { if (!s.numero_be || s.numero_be === detailBeNum) continue; bm.set(s.numero_be, (bm.get(s.numero_be) ?? 0) + (s.quantite_recue ?? 0)); }
      return [...bm.entries()].map(([numBe, saisie]) => {
        const sc = scanned.has(numBe);
        const papier = sc ? (pap.get(numBe) ?? 0) : null;
        return { numBe, saisie, scanned: sc, papier, over: papier != null ? saisie - papier : null };
      }).sort((a, b) => (b.over ?? -1e9) - (a.over ?? -1e9) || b.saisie - a.saisie);
    },
    enabled: !!showDetail?.reference_article && !!detailBeNum,
    staleTime: 30000,
  });

  const updateStatut = async (exc: Exc, statut: Exc['statut_exception']) => {
    setUpdating(exc.id);
    try {
      const { error } = await supabase.from('exceptions').update({
        statut_exception: statut,
        commentaire: comment || exc.commentaire,
      }).eq('id', exc.id);
      if (error) throw error;
      qc.invalidateQueries({ queryKey: ['exceptions'] });
      qc.invalidateQueries({ queryKey: ['exceptions-kpis'] });
      setShowDetail(null);
      setComment('');
      toast.success(`Exception ${statut}`);
    } catch (e) {
      console.error(e);
      toast.error('Erreur lors de la mise à jour');
    } finally {
      setUpdating(null);
    }
  };

  // Sauvegarde assignation / échéance / commentaire (sans changer le statut)
  const saveDetail = async (exc: Exc) => {
    setUpdating(exc.id);
    try {
      const { error } = await supabase.from('exceptions').update({
        commentaire: comment || null,
        assigne_a: assigne || null,
        echeance: echeance || null,
        statut_exception: exc.statut_exception === 'ouverte' && assigne ? 'en cours' : exc.statut_exception,
      }).eq('id', exc.id);
      if (error) throw error;
      qc.invalidateQueries({ queryKey: ['exceptions'] });
      setShowDetail(null);
      toast.success('Enregistré');
    } catch (e) {
      console.error(e);
      toast.error('Erreur');
    } finally {
      setUpdating(null);
    }
  };

  // Classe / déclasse une réf en pièce détachée SAV (hors Centralink).
  const classerSav = async (exc: Exc, retirer: boolean) => {
    if (!exc.reference_article) return;
    setUpdating(exc.id);
    try {
      const r = await fetch('/api/classer-sav', {
        method: retirer ? 'DELETE' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reference_article: exc.reference_article, exception_id: exc.id }),
      });
      const d = await r.json() as { ok?: boolean; error?: string };
      if (d.error) { toast.error(d.error); return; }
      qc.invalidateQueries({ queryKey: ['exceptions'] });
      qc.invalidateQueries({ queryKey: ['exceptions-kpis'] });
      qc.invalidateQueries({ queryKey: ['refs-sav'] });
      setShowDetail(null);
      toast.success(retirer ? `${exc.reference_article} retirée du SAV` : `${exc.reference_article} classée pièce SAV`);
    } catch {
      toast.error('Erreur');
    } finally {
      setUpdating(null);
    }
  };

  // Disposition d'une sur-livraison Colombi : on garde (régularisé) ou on retourne (avoir attendu).
  const disposerSurLiv = async (exc: Exc, mode: 'garde' | 'retour') => {
    setUpdating(exc.id);
    try {
      const base = (comment || exc.commentaire || '').trim();
      const patch = mode === 'garde'
        ? { statut_exception: 'résolue', commentaire: `Gardé — régularisé par nouvelle commande.${base ? ' ' + base : ''}` }
        : { statut_exception: 'en cours', commentaire: `Retour — avoir attendu.${base ? ' ' + base : ''}` };
      const { error } = await supabase.from('exceptions').update(patch).eq('id', exc.id);
      if (error) throw error;
      qc.invalidateQueries({ queryKey: ['exceptions'] });
      qc.invalidateQueries({ queryKey: ['exceptions-kpis'] });
      setShowDetail(null);
      setComment('');
      toast.success(mode === 'garde' ? 'Sur-livraison gardée (régularisée)' : 'Retour enregistré — avoir attendu');
    } catch (e) {
      console.error(e);
      toast.error('Erreur');
    } finally {
      setUpdating(null);
    }
  };

  // Sur-livraison qui est en fait une erreur/manipulation de saisie (Attendu négatif :
  // Livré gonflé, vrai reçu = commandé) → vers la log pour correction, pas Colombi.
  const routerVersLog = async (exc: Exc) => {
    setUpdating(exc.id);
    try {
      const base = (comment || exc.commentaire || '').trim();
      const { error } = await supabase.from('exceptions').update({
        destinataire: 'log',
        statut_exception: 'en cours',
        niveau_priorite: 'moyenne',
        commentaire: `Erreur de saisie (Attendu négatif) — Livré gonflé, vrai reçu = commandé. À corriger dans Centralink.${base ? ' ' + base : ''}`,
      }).eq('id', exc.id);
      if (error) throw error;
      qc.invalidateQueries({ queryKey: ['exceptions'] });
      qc.invalidateQueries({ queryKey: ['exceptions-kpis'] });
      setShowDetail(null);
      setComment('');
      toast.success('Routé vers la log (erreur de saisie)');
    } catch (e) {
      console.error(e);
      toast.error('Erreur');
    } finally {
      setUpdating(null);
    }
  };

  // Hors-commande gardé en stock sans commande (ancien fonctionnement) → résolu + trace.
  const garderEnStock = async (exc: Exc) => {
    setUpdating(exc.id);
    try {
      const base = (comment || exc.commentaire || '').trim();
      const { error } = await supabase.from('exceptions').update({
        statut_exception: 'résolue',
        commentaire: `Gardé en stock sans commande (ancien fonctionnement).${base ? ' ' + base : ''}`,
      }).eq('id', exc.id);
      if (error) throw error;
      qc.invalidateQueries({ queryKey: ['exceptions'] });
      qc.invalidateQueries({ queryKey: ['exceptions-kpis'] });
      setShowDetail(null);
      setComment('');
      toast.success('Classé : gardé en stock (ancien fonctionnement)');
    } catch (e) {
      console.error(e);
      toast.error('Erreur');
    } finally {
      setUpdating(null);
    }
  };

  // Classer une anomalie de RÉCEPTION directement depuis le Centre (écrit le classement
  // sur la fiche réception ET résout l'anomalie si le classement est « disposé »).
  const CLASSEMENTS_RECEPTION = ['pièce détachée', 'SAV / échange', 'commandé autrement', 'surplus vu DH (gardé)', 'sur-livraison Colombi', 'hors-commande Colombi', 'résolu'];
  const DISPOSE_CLASSEMENTS = new Set(['pièce détachée', 'SAV / échange', 'commandé autrement', 'surplus vu DH (gardé)', 'résolu']);
  const classerReception = async (exc: Exc, classement: string) => {
    if (!exc.be_id || !exc.reference_article) return;
    setUpdating(exc.id);
    try {
      const r = await fetch('/api/reception-resolution', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ be_id: exc.be_id, reference_article: exc.reference_article, classement }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? 'Erreur');
      // Classement « disposé » → on résout l'anomalie ; « … Colombi » → reste à traiter.
      if (DISPOSE_CLASSEMENTS.has(classement)) {
        await supabase.from('exceptions').update({
          statut_exception: 'résolue',
          commentaire: `Classé « ${classement} » (fiche Contrôle réception)${comment ? ' — ' + comment : ''}`,
        }).eq('id', exc.id);
      } else {
        await supabase.from('exceptions').update({ commentaire: `Classé « ${classement} »${comment ? ' — ' + comment : ''}` }).eq('id', exc.id);
      }
      qc.invalidateQueries({ queryKey: ['exceptions'] });
      qc.invalidateQueries({ queryKey: ['exceptions-kpis'] });
      qc.invalidateQueries({ queryKey: ['refs-sav'] });
      setShowDetail(null); setComment('');
      toast.success(`Classé « ${classement} »${DISPOSE_CLASSEMENTS.has(classement) ? ' — résolu' : ''}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Erreur');
    } finally {
      setUpdating(null);
    }
  };

  const ouvrirDetail = (exc: Exc) => {
    setShowDetail(exc);
    setComment(exc.commentaire ?? '');
    setAssigne(exc.assigne_a ?? '');
    setEcheance(exc.echeance ?? '');
  };

  // ── Actions ────────────────────────────────────────────────────────────────
  const telecharger = (contenu: string, nom: string, mime = 'text/plain') => {
    const blob = new Blob(['﻿' + contenu], { type: `${mime};charset=utf-8;` });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = nom;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // Récupère les anomalies actives (optionnellement par destinataire)
  // Récupère les anomalies actives, en respectant les filtres en cours (type / priorité /
  // origine) → la liste générée correspond à ce qu'on voit à l'écran (ciblable).
  const fetchActives = async (dest?: string): Promise<Exc[]> => {
    let q = supabase.from('exceptions').select('*')
      .in('statut_exception', ['ouverte', 'en cours']).order('type_exception');
    if (dest) q = q.eq('destinataire', dest);
    if (filterType !== 'all') q = q.eq('type_exception', filterType);
    if (filterPriorite !== 'all') q = q.eq('niveau_priorite', filterPriorite);
    if (filterOrigine !== 'all') q = q.eq('origine', filterOrigine);
    if (filterBe !== 'all') q = q.eq('be_id', filterBe);
    const { data } = await q;
    return (data ?? []) as Exc[];
  };

  // Ouvre une page imprimable d'un texte (liste de corrections / réclamation).
  const imprimerListe = (titre: string, texte: string) => {
    const w = window.open('', '_blank');
    if (!w) return;
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(titre)}</title><style>body{font-family:system-ui,Arial,sans-serif;margin:24px;font-size:13px;line-height:1.55}h1{font-size:16px;margin:0 0 12px}pre{white-space:pre-wrap;font-family:inherit;margin:0}@media print{body{margin:0}}</style></head><body><h1>${esc(titre)}</h1><pre>${esc(texte)}</pre></body></html>`);
    w.document.close(); w.focus();
    setTimeout(() => w.print(), 250);
  };

  const exportCsv = async () => {
    const rows = await fetchActives(filterDest !== 'all' ? filterDest : undefined);
    if (!rows.length) { toast.info('Aucune anomalie active à exporter'); return; }
    const head = ['Type', 'Source', 'Destinataire', 'Référence', 'Motif', 'Attendu', 'Obtenu', 'Écart', 'Statut', 'Assigné', 'Échéance'];
    const csv = [head, ...rows.map(e => [
      e.type_exception, e.origine ?? '', e.destinataire ?? '', e.reference_article ?? '', e.motif ?? '',
      e.valeur_attendue ?? '', e.valeur_obtenue ?? '', e.ecart ?? '', e.statut_exception, e.assigne_a ?? '', e.echeance ?? '',
    ])].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\r\n');
    telecharger(csv, `anomalies${filterDest !== 'all' ? '-' + filterDest : ''}.csv`, 'text/csv');
  };

  // Récupère TOUT ce qui correspond aux filtres affichés (statut + type + priorité +
  // origine + destinataire + BE), sans pagination → l'export = ce que l'utilisateur voit.
  const fetchVisibles = async (): Promise<Exc[]> => {
    let q = supabase.from('exceptions').select('*').order('type_exception');
    if (filterStatut === 'actives') q = q.in('statut_exception', ['ouverte', 'en cours']);
    else if (filterStatut === 'à analyser') q = q.eq('statut_exception', 'ouverte').eq('destinataire', 'Colombi');
    else if (filterStatut === 'résolues') q = q.in('statut_exception', ['résolue', 'ignorée']);
    if (filterType !== 'all') q = q.eq('type_exception', filterType);
    if (filterPriorite !== 'all') q = q.eq('niveau_priorite', filterPriorite);
    if (filterOrigine !== 'all') q = q.eq('origine', filterOrigine);
    if (filterDest !== 'all' && filterStatut !== 'à analyser') q = q.eq('destinataire', filterDest);
    if (filterBe !== 'all') q = q.eq('be_id', filterBe);
    const { data } = await q.limit(2000);
    return (data ?? []) as Exc[];
  };

  // Export PDF : ouvre une page imprimable (→ « Enregistrer en PDF ») reprenant
  // exactement la liste filtrée à l'écran, quantités mises en avant.
  const exportPdf = async () => {
    const rows = await fetchVisibles();
    if (!rows.length) { toast.info('Aucune anomalie à exporter'); return; }
    const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const labelType = (e: Exc) => {
      let l = TYPE_CONFIG[e.type_exception]?.label ?? (e.type_exception as string);
      if ((e.type_exception as string) === 'sur-saisie log') {
        const m = e.motif ?? '';
        if (/SAV/i.test(m)) l = 'SAV saisi sous commande';
        else if (/n° de BE|hors papier|INVALIDE/i.test(m)) l = 'Mauvais n° de BE';
        else if (/conditionnement/i.test(m)) l = 'À vérifier (unité)';
        else l = 'Sur-saisie (doublon)';
      }
      return l;
    };
    const filtres = [
      `Statut : ${filterStatut}`,
      filterType !== 'all' ? `Type : ${filterType}` : null,
      filterDest !== 'all' ? `Destinataire : ${filterDest}` : null,
      filterBe !== 'all' ? `BE : ${beMap[filterBe]?.numero_be ?? filterBe}` : null,
      filterPriorite !== 'all' ? `Priorité : ${filterPriorite}` : null,
      filterOrigine !== 'all' ? `Origine : ${filterOrigine}` : null,
    ].filter(Boolean).join(' · ');
    const trs = rows.map(e => {
      const be = e.be_id ? (beMap[e.be_id]?.numero_be ?? '') : (e.commande_id ? (cmdMap[e.commande_id]?.numero_commande_interne ?? '') : '');
      const ec = e.ecart != null && Number(e.ecart) !== 0 ? `${Number(e.ecart) > 0 ? '+' : ''}${e.ecart}` : '';
      return `<tr><td>${esc(labelType(e))}</td><td class="ref">${esc(e.reference_article)}</td>`
        + `<td class="num">${e.valeur_attendue ?? ''}</td><td class="num">${e.valeur_obtenue ?? ''}</td>`
        + `<td class="num ecart">${esc(ec)}</td><td>${esc(e.motif)}</td><td>${esc(be)}</td>`
        + `<td>${esc(e.destinataire)}</td><td>${esc(e.statut_exception)}</td></tr>`;
    }).join('');
    const today = new Date().toLocaleDateString('fr-FR');
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Anomalies syncflow</title>`
      + `<style>body{font-family:system-ui,Arial,sans-serif;margin:20px;color:#111}`
      + `h1{font-size:18px;margin:0 0 4px}.meta{font-size:12px;color:#555;margin:0 0 14px}`
      + `table{border-collapse:collapse;width:100%;font-size:11px}`
      + `th,td{border:1px solid #ddd;padding:5px 7px;text-align:left;vertical-align:top}`
      + `th{background:#f3f4f6;font-size:10px;text-transform:uppercase;letter-spacing:.03em;color:#444}`
      + `.ref{font-family:ui-monospace,Menlo,monospace;font-weight:700;white-space:nowrap}`
      + `.num{text-align:right;font-weight:700;white-space:nowrap}.ecart{color:#b91c1c}`
      + `tr:nth-child(even) td{background:#fafafa}`
      + `@media print{body{margin:0}th{-webkit-print-color-adjust:exact;print-color-adjust:exact}}</style>`
      + `</head><body><h1>Anomalies syncflow — ${rows.length}</h1>`
      + `<p class="meta">${esc(filtres)} — édité le ${today}</p>`
      + `<table><thead><tr><th>Type</th><th>Référence</th><th>Attendu</th><th>Obtenu</th><th>Écart</th>`
      + `<th>Motif</th><th>BE / Cmd</th><th>Destinataire</th><th>Statut</th></tr></thead><tbody>${trs}</tbody></table>`
      + `</body></html>`;
    const w = window.open('', '_blank');
    if (!w) { toast.error('Pop-up bloquée — autorise les fenêtres pour exporter en PDF'); return; }
    w.document.write(html); w.document.close(); w.focus();
    setTimeout(() => w.print(), 300);
  };

  const [listeModal, setListeModal] = useState<{ titre: string; texte: string; mailto?: string } | null>(null);
  const [detecting, setDetecting] = useState(false);

  const detecter = async (refresh = false) => {
    setDetecting(true);
    try {
      const r = await fetch(`/api/detect-anomalies${refresh ? '?refresh=1' : ''}`, { method: 'POST' });
      const d = await r.json() as { inserees?: number; purgees?: number; detail?: Record<string, number>; error?: string };
      if (d.error) { toast.error(d.error); return; }
      toast.success(refresh
        ? `Rafraîchi : ${d.purgees ?? 0} corrigée(s) clôturée(s) · ${d.inserees ?? 0} nouvelle(s)`
        : `${d.inserees} nouvelle(s) · réception ${d.detail?.réception ?? 0}, pointage ${d.detail?.pointage ?? 0}, facturation ${d.detail?.facturation ?? 0}`);
      qc.invalidateQueries({ queryKey: ['exceptions'] });
      qc.invalidateQueries({ queryKey: ['exceptions-kpis'] });
    } catch {
      toast.error('Erreur de détection');
    } finally {
      setDetecting(false);
    }
  };

  const genererListe = async (dest: 'Colombi' | 'log') => {
    const rows = await fetchActives(dest);
    if (!rows.length) { toast.info(`Aucune anomalie active pour ${dest}`); return; }
    // Pour la log, on envoie le TEXTE D'ACTION (re-dispatcher / corriger / compléter)
    // généré automatiquement — c'est l'instruction concrète, pas juste le constat.
    const lignes = rows.map(e => `- ${e.reference_article ? e.reference_article + ' : ' : ''}${dest === 'log' ? (e.suggestion_action_ia || e.motif) : e.motif}`).join('\n');
    const texte = dest === 'Colombi'
      ? `Bonjour,\n\nEn rapprochant vos livraisons et factures avec nos commandes, nous constatons les écarts suivants :\n\n${lignes}\n\nMerci de bien vouloir régulariser (avoir / reprise / correction selon le cas).\n\nCordialement,`
      : `Corrections à apporter dans Centralink (${rows.length}) :\n\n${lignes}\n\nMerci de vérifier et corriger.`;
    setListeModal({
      titre: dest === 'Colombi' ? `Réclamation Colombi (${rows.length})` : `Corrections log (${rows.length})`,
      texte,
      mailto: `mailto:?subject=${encodeURIComponent(dest === 'Colombi' ? 'Écarts livraisons / factures' : 'Corrections à apporter dans Centralink')}&body=${encodeURIComponent(texte)}`,
    });
  };

  return (
    <div>
      <PageHeader
        title="Anomalies / Exceptions"
        subtitle={`${kpiData.total} exception${kpiData.total > 1 ? 's' : ''} active${kpiData.total > 1 ? 's' : ''}`}
      />

      {isError && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          Erreur lors du chargement des exceptions.
        </div>
      )}

      {/* Bandeau « à analyser » : les décisions qui t'attendent */}
      {kpiData.aAnalyser > 0 && filterStatut !== 'à analyser' && (
        <button
          onClick={() => { setFilterStatut('à analyser'); setFilterDest('all'); setPage(1); }}
          className="w-full mb-4 flex items-center gap-3 rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3 text-left hover:bg-indigo-100 transition-colors"
        >
          <span className="text-lg">🆕</span>
          <span className="text-sm font-medium text-indigo-800">
            {kpiData.aAnalyser} anomalie{kpiData.aAnalyser > 1 ? 's' : ''} à analyser
          </span>
          <span className="text-xs text-indigo-500 ml-1">— décision{kpiData.aAnalyser > 1 ? 's' : ''} en attente</span>
          <span className="ml-auto text-xs text-indigo-600 font-medium">Voir →</span>
        </button>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-4 gap-4 mb-5">
        {[
          { label: '🆕 À analyser', value: kpiData.aAnalyser, color: 'text-indigo-600', onClick: () => { setFilterStatut('à analyser'); setFilterDest('all'); setPage(1); } },
          { label: 'Actives', value: kpiData.total, color: 'text-gray-900', onClick: () => { setFilterStatut('actives'); setPage(1); } },
          { label: 'Haute priorité', value: kpiData.haute, color: 'text-red-600' },
          { label: 'À corriger (log)', value: kpiData.log, color: 'text-blue-600', onClick: () => { setFilterStatut('actives'); setFilterDest('log'); setPage(1); } },
        ].map(k => (
          <div key={k.label} onClick={k.onClick}
            className={cn('bg-white rounded-xl border border-gray-100 shadow-sm p-4', k.onClick && 'cursor-pointer hover:border-indigo-200 hover:shadow')}>
            <p className="text-xs text-gray-500">{k.label}</p>
            <p className={`text-2xl font-bold mt-1 ${k.color}`}>{k.value}</p>
          </div>
        ))}
      </div>

      {/* Filtres */}
      <div className="flex gap-3 mb-4 flex-wrap items-center">
        {['à analyser', 'actives', 'résolues', 'toutes'].map(s => (
          <button key={s} onClick={() => { setFilterStatut(s); setPage(1); }}
            className={cn('px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
              filterStatut === s ? 'bg-indigo-600 text-white' : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50')}>
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
        <select value={filterType} onChange={e => { setFilterType(e.target.value); setPage(1); }}
          className="h-9 rounded-lg border border-gray-200 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
          <option value="all">Tous les types</option>
          {Object.keys(TYPE_CONFIG).map(t => <option key={t} value={t}>{TYPE_CONFIG[t].label}</option>)}
        </select>
        <select value={filterPriorite} onChange={e => { setFilterPriorite(e.target.value); setPage(1); }}
          className="h-9 rounded-lg border border-gray-200 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
          <option value="all">Toutes priorités</option>
          {['faible', 'moyenne', 'haute', 'critique'].map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <select value={filterOrigine} onChange={e => { setFilterOrigine(e.target.value); setPage(1); }}
          className="h-9 rounded-lg border border-gray-200 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
          <option value="all">Toutes sources</option>
          {['réception', 'pointage', 'facturation'].map(o => <option key={o} value={o}>{o}</option>)}
        </select>
        <select value={filterDest} onChange={e => { setFilterDest(e.target.value); setPage(1); }}
          className="h-9 rounded-lg border border-gray-200 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
          <option value="all">Tous destinataires</option>
          {['Colombi', 'log', 'à vérifier', 'SAV', 'interne'].map(d => <option key={d} value={d}>{d}</option>)}
        </select>
        <select value={filterBe} onChange={e => { setFilterBe(e.target.value); setPage(1); }}
          className="h-9 rounded-lg border border-gray-200 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono"
          title="Filtrer sur un BE → prépare un message de correction par BL">
          <option value="all">Tous les BE</option>
          {beOptions.map(o => <option key={o.id} value={o.id}>{o.numero}</option>)}
        </select>
        <div className="relative">
          <input value={filterRef} onChange={e => { setFilterRef(e.target.value); setPage(1); }}
            placeholder="Réf. (ex. REM003)…"
            className="h-9 w-44 rounded-lg border border-gray-200 bg-white pl-8 pr-3 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500" />
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 text-sm">🔍</span>
          {filterRef && (
            <button onClick={() => { setFilterRef(''); setPage(1); }}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-xs">✕</button>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex flex-wrap gap-2 mb-4">
        <Button size="sm" disabled={detecting} onClick={() => detecter(true)}
          title="Clôt les anomalies corrigées à la source (qui ne se reproduisent plus) et redétecte sur les données fraîches. Les anomalies travaillées (commentées/assignées) sont préservées.">
          {detecting ? 'En cours…' : '♻️ Rafraîchir (clore les corrigées)'}
        </Button>
        <Button variant="outline" size="sm" disabled={detecting} onClick={() => detecter(false)}
          title="Ajoute les nouvelles anomalies sans rien clôturer.">
          {detecting ? '…' : '🔄 Détecter (ajout seul)'}
        </Button>
        <Button variant="outline" size="sm" onClick={() => genererListe('Colombi')}>📩 Réclamer à Colombi</Button>
        <Button variant="outline" size="sm" onClick={() => genererListe('log')}>🛠 Demander correction à la log</Button>
        <Button variant="outline" size="sm" onClick={exportCsv}>⬇ Exporter (CSV{filterDest !== 'all' ? ` · ${filterDest}` : ''})</Button>
        <Button variant="outline" size="sm" onClick={exportPdf}>🖨 Exporter (PDF)</Button>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50/50 border-b border-gray-100">
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Type</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Source</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Référence / Motif</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Destinataire</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Facture</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">BE</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Statut</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {exceptions.map(exc => {
              let tc = TYPE_CONFIG[exc.type_exception] ?? { color: 'text-gray-600 bg-gray-50', label: exc.type_exception };
              // « sur-saisie log » recouvre 3 réalités très différentes → on précise le badge
              // selon le motif (le type en base reste « sur-saisie log », contrainte fermée).
              if ((exc.type_exception as string) === 'sur-saisie log') {
                const m = exc.motif ?? '';
                if (/SAV/i.test(m)) tc = { color: 'text-teal-700 bg-teal-50', label: 'SAV saisi sous commande' };
                else if (/n° de BE|hors papier|INVALIDE/i.test(m)) tc = { color: 'text-orange-700 bg-orange-50', label: 'Mauvais n° de BE' };
                else if (/conditionnement/i.test(m)) tc = { color: 'text-gray-600 bg-gray-50', label: 'À vérifier (unité)' };
                else tc = { color: 'text-purple-700 bg-purple-50', label: 'Sur-saisie (doublon)' };
              }
              // « sur-livraison » + destinataire « à vérifier » = écart déclaration vs comptage
              // (coupable inconnu) → badge distinct du vrai surplus Colombi.
              if ((exc.type_exception as string) === 'sur-livraison' && exc.destinataire === 'à vérifier') {
                tc = { color: 'text-amber-700 bg-amber-50', label: 'Écart papier/saisi à vérifier' };
              }
              return (
                <tr key={exc.id} className={cn('even:bg-gray-50/60 hover:bg-indigo-50/40 transition-colors', ['haute', 'critique'].includes(exc.niveau_priorite) ? 'border-l-4 border-l-red-400' : exc.niveau_priorite === 'moyenne' ? 'border-l-4 border-l-orange-300' : 'border-l-4 border-l-transparent')}>
                  <td className="px-4 py-3">
                    <span className={cn('text-xs font-medium px-2 py-0.5 rounded-full', tc.color)}>{tc.label}</span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-xs text-gray-600">{exc.origine ?? '—'}</span>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-700 max-w-[360px]">
                    {exc.reference_article && <div className="font-mono font-bold text-sm text-gray-900 mb-0.5">{exc.reference_article}</div>}
                    {(exc.valeur_attendue != null || exc.valeur_obtenue != null) && (
                      <div className="mb-1 flex flex-wrap items-center gap-1">
                        {exc.valeur_attendue != null && valLabels(exc).att && (
                          <span className="px-1.5 py-0.5 rounded bg-gray-100 text-xs text-gray-600">{valLabels(exc).att} <span className="font-bold text-sm text-gray-900">{exc.valeur_attendue}</span></span>
                        )}
                        {exc.valeur_obtenue != null && (
                          <span className="px-1.5 py-0.5 rounded bg-gray-100 text-xs text-gray-600">{valLabels(exc).obt} <span className="font-bold text-sm text-gray-900">{exc.valeur_obtenue}</span></span>
                        )}
                        {exc.ecart != null && Number(exc.ecart) !== 0 && (
                          <span className={cn('px-1.5 py-0.5 rounded text-xs font-semibold', Number(exc.ecart) > 0 ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-700')}>écart <span className="font-bold text-sm">{Number(exc.ecart) > 0 ? '+' : ''}{exc.ecart}</span></span>
                        )}
                      </div>
                    )}
                    <div className="whitespace-normal text-gray-600">{exc.motif}</div>
                    {exc.suggestion_action_ia && (
                      <div className="mt-1 text-xs text-blue-900 bg-blue-50 border-l-4 border-blue-500 rounded-r px-2 py-1.5 whitespace-normal leading-snug">
                        <span className="font-semibold">🛠 Action :</span> {exc.suggestion_action_ia}
                      </div>
                    )}
                    {enCours(exc.reference_article) && beRecent(exc.be_id) && (
                      <span className="inline-block mt-0.5 text-[11px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-600" title="BE de moins de 2 semaines et commande encore en attente côté Centralink — la log n'a peut-être pas fini de saisir">
                        ⏳ saisie peut-être en cours
                      </span>
                    )}
                    {estRefSav(exc.reference_article) && exc.destinataire !== 'SAV' && (exc.type_exception as string) === 'sur-livraison' && (
                      <span className="inline-block mt-0.5 ml-1 text-[11px] px-1.5 py-0.5 rounded bg-teal-50 text-teal-600" title="Cette référence est aussi une pièce détachée SAV — vérifie si le surplus est un envoi SAV avant de réclamer à Colombi">
                        ⚠ réf aussi SAV
                      </span>
                    )}
                    {exc.explication_ia && (
                      <p className="text-xs text-gray-500 mt-0.5 whitespace-normal">{exc.explication_ia}</p>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {exc.destinataire && <span className={cn('text-xs px-2 py-0.5 rounded-full', DEST_CONFIG[exc.destinataire] ?? 'bg-gray-100 text-gray-600')}>{exc.destinataire}</span>}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {exc.facture_id && factureMap[exc.facture_id] && (
                      <Link href={`/factures/${exc.facture_id}`} className="text-indigo-600 hover:underline">{factureMap[exc.facture_id].numero_facture}</Link>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {exc.be_id && beMap[exc.be_id] && (
                      <div className="flex items-center gap-1.5">
                        <Link href={`/be-receptions/${exc.be_id}`} className="text-indigo-600 hover:underline">{beMap[exc.be_id].numero_be}</Link>
                        <a href={lienCentralinkBE(beMap[exc.be_id].numero_be)} target="_blank" rel="noreferrer"
                          title="Vérifier la saisie dans Centralink" className="text-gray-400 hover:text-indigo-600">↗</a>
                      </div>
                    )}
                    {!exc.be_id && exc.commande_id && cmdMap[exc.commande_id] && (
                      <div className="flex items-center gap-1.5">
                        <Link href={`/commandes/${exc.commande_id}`} className="text-indigo-600 hover:underline">{cmdMap[exc.commande_id].numero_commande_interne}</Link>
                        <a href={lienCentralinkCmd(cmdMap[exc.commande_id].numero_commande_interne)} target="_blank" rel="noreferrer"
                          title="Ouvrir la commande dans Centralink (corriger le n° de BL)" className="text-gray-400 hover:text-indigo-600">↗</a>
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className={cn('text-xs px-1.5 py-0.5 rounded',
                      exc.statut_exception === 'résolue' ? 'bg-emerald-100 text-emerald-700' :
                      exc.statut_exception === 'en cours' ? 'bg-blue-100 text-blue-700' :
                      exc.statut_exception === 'ignorée' ? 'bg-gray-100 text-gray-500' :
                      'bg-red-50 text-red-600')}>
                      {exc.statut_exception}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      {['ouverte', 'en cours'].includes(exc.statut_exception) ? (
                        <>
                          <button
                            title="Résoudre"
                            disabled={updating === exc.id}
                            onClick={() => updateStatut(exc, 'résolue')}
                            className={cn(
                              'p-1.5 rounded text-emerald-600 hover:bg-emerald-50 transition-colors',
                              updating === exc.id && 'opacity-40 cursor-not-allowed',
                            )}
                          >
                            <CheckCircle2 className="w-3.5 h-3.5" />
                          </button>
                          <button
                            title="Ignorer"
                            disabled={updating === exc.id}
                            onClick={() => updateStatut(exc, 'ignorée')}
                            className={cn(
                              'p-1.5 rounded text-gray-400 hover:bg-gray-100 transition-colors',
                              updating === exc.id && 'opacity-40 cursor-not-allowed',
                            )}
                          >
                            <XCircle className="w-3.5 h-3.5" />
                          </button>
                          <button
                            title="Détail"
                            disabled={updating === exc.id}
                            onClick={() => ouvrirDetail(exc)}
                            className={cn(
                              'p-1.5 rounded text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors',
                              updating === exc.id && 'opacity-40 cursor-not-allowed',
                            )}
                          >
                            <Eye className="w-3.5 h-3.5" />
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            title="Rouvrir"
                            disabled={updating === exc.id}
                            onClick={() => updateStatut(exc, 'ouverte')}
                            className={cn(
                              'p-1.5 rounded text-gray-400 hover:bg-gray-100 transition-colors',
                              updating === exc.id && 'opacity-40 cursor-not-allowed',
                            )}
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                          </button>
                          <button
                            title="Détail"
                            disabled={updating === exc.id}
                            onClick={() => ouvrirDetail(exc)}
                            className={cn(
                              'p-1.5 rounded text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors',
                              updating === exc.id && 'opacity-40 cursor-not-allowed',
                            )}
                          >
                            <Eye className="w-3.5 h-3.5" />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {exceptions.length === 0 && <EmptyState icon={AlertTriangle} title="Aucune exception" description="Aucune anomalie détectée" />}
        <Pagination page={page} pageSize={PAGE_SIZE} total={total} onChange={setPage} />
      </div>

      {/* Modale détail */}
      {showDetail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col overflow-hidden">
            {/* En-tête */}
            <div className={cn('flex items-start gap-3 px-5 py-4 border-b',
              showDetail.destinataire === 'log' ? 'bg-blue-50/60 border-blue-100' :
              showDetail.destinataire === 'Colombi' ? 'bg-orange-50/60 border-orange-100' :
              showDetail.destinataire === 'SAV' ? 'bg-teal-50/60 border-teal-100' :
              'bg-gray-50 border-gray-100')}>
              <div className="w-9 h-9 rounded-lg bg-white border border-gray-200 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-5 h-5 text-amber-500" />
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="text-base font-semibold text-gray-900 leading-tight">{TYPE_CONFIG[showDetail.type_exception]?.label ?? showDetail.type_exception}</h2>
                <div className="flex flex-wrap items-center gap-1.5 mt-1">
                  {showDetail.origine && <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-white/70 border border-gray-200 text-gray-500">source : {showDetail.origine}</span>}
                  {showDetail.destinataire && <span className={cn('text-[11px] px-1.5 py-0.5 rounded-full', DEST_CONFIG[showDetail.destinataire] ?? 'bg-gray-100 text-gray-600')}>{showDetail.destinataire}</span>}
                  <span className={cn('text-[11px] px-1.5 py-0.5 rounded-full border', PRIORITE_CONFIG[showDetail.niveau_priorite] ?? '')}>{showDetail.niveau_priorite}</span>
                </div>
              </div>
              <button onClick={() => setShowDetail(null)} className="shrink-0 p-1 rounded-lg text-gray-400 hover:bg-white hover:text-gray-600 transition-colors">
                <XCircle className="w-5 h-5" />
              </button>
            </div>

            {/* Hero : référence + quantités en évidence */}
            {(showDetail.reference_article || showDetail.valeur_attendue != null || showDetail.valeur_obtenue != null) && (
              <div className="px-5 py-3 border-b border-gray-100">
                {showDetail.reference_article && <div className="font-mono font-bold text-lg text-gray-900">{showDetail.reference_article}</div>}
                {(showDetail.valeur_attendue != null || showDetail.valeur_obtenue != null) && (
                  <div className="flex flex-wrap items-center gap-2 mt-1.5">
                    {showDetail.valeur_attendue != null && valLabels(showDetail).att && (
                      <div className="px-2.5 py-1 rounded-lg bg-gray-100 text-center min-w-[64px]">
                        <div className="text-[10px] uppercase tracking-wide text-gray-400 leading-none">{valLabels(showDetail).att}</div>
                        <div className="font-bold text-base text-gray-900 leading-tight">{showDetail.valeur_attendue}</div>
                      </div>
                    )}
                    {showDetail.valeur_obtenue != null && (
                      <div className="px-2.5 py-1 rounded-lg bg-gray-100 text-center min-w-[64px]">
                        <div className="text-[10px] uppercase tracking-wide text-gray-400 leading-none">{valLabels(showDetail).obt}</div>
                        <div className="font-bold text-base text-gray-900 leading-tight">{showDetail.valeur_obtenue}</div>
                      </div>
                    )}
                    {showDetail.ecart != null && Number(showDetail.ecart) !== 0 && (
                      <div className={cn('px-2.5 py-1 rounded-lg text-center min-w-[64px]', Number(showDetail.ecart) > 0 ? 'bg-red-50' : 'bg-amber-50')}>
                        <div className={cn('text-[10px] uppercase tracking-wide leading-none', Number(showDetail.ecart) > 0 ? 'text-red-400' : 'text-amber-500')}>Écart</div>
                        <div className={cn('font-bold text-base leading-tight', Number(showDetail.ecart) > 0 ? 'text-red-700' : 'text-amber-700')}>{Number(showDetail.ecart) > 0 ? '+' : ''}{showDetail.ecart}</div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Corps défilant */}
            <div className="px-5 py-4 overflow-y-auto space-y-3">
            <p className="text-sm text-gray-700">{showDetail.motif}</p>
            {showDetail.suggestion_action_ia && (
              <div className={cn('mb-3 p-3 rounded-lg border',
                showDetail.destinataire === 'log' ? 'bg-blue-50 border-blue-100' :
                showDetail.destinataire === 'Colombi' ? 'bg-orange-50 border-orange-100' :
                'bg-gray-50 border-gray-100')}>
                <p className={cn('text-xs font-semibold mb-1',
                  showDetail.destinataire === 'log' ? 'text-blue-700' :
                  showDetail.destinataire === 'Colombi' ? 'text-orange-700' : 'text-gray-600')}>
                  🛠 Action à mener{showDetail.destinataire ? ` — ${showDetail.destinataire}` : ''}
                </p>
                <p className="text-sm text-gray-800">{showDetail.suggestion_action_ia}</p>
              </div>
            )}
            {detailBeNum && dispatchDetail.length > 0 && (() => {
              const coupables = dispatchDetail.filter(x => x.over != null && x.over > 0.001);
              const autres = dispatchDetail.filter(x => !(x.over != null && x.over > 0.001));
              return (
                <div className="mb-3 p-3 rounded-lg border border-gray-100 bg-gray-50 text-xs">
                  <p className="font-semibold text-gray-600 mb-1">📍 Où « {showDetail.reference_article} » est saisi ailleurs</p>
                  {coupables.length > 0 ? (() => {
                    const moisDe = (s: string | null | undefined) => { const m = String(s ?? '').toUpperCase().match(/BE-?(\d{2})-?(\d{2})/); return m ? m[1] + m[2] : ''; };
                    const ceMois = moisDe(detailBeNum);
                    return (
                      <p className="text-amber-700">⚠ Piste à vérifier — aussi sur-saisi (sans papier) sous {coupables.slice(0, 3).map((x, i) => {
                        const meme = !!ceMois && moisDe(x.numBe) === ceMois;
                        return <span key={x.numBe}>{i > 0 && ', '}<span className="font-mono">{x.numBe}</span> <span className="text-amber-400">(+{x.over}{meme ? ', même période ⇒ lien probable' : ''})</span></span>;
                      })} <span className="text-gray-400">— à confirmer (erreur de n° de BE possible)</span></p>
                    );
                  })() : (
                    <p className="text-gray-500">Aucun BE sur-saisi → probable vrai oubli (ou saisi sous un BE non scanné).</p>
                  )}
                  {autres.length > 0 && (
                    <p className="text-gray-400 mt-0.5">aussi sous {autres.slice(0, 4).map((x, i) => (
                      <span key={x.numBe}>{i > 0 && ', '}<span className="font-mono">{x.numBe}</span> ({x.saisie}{x.scanned ? ' = papier' : ' · non scanné'})</span>
                    ))}{autres.length > 4 && <span> +{autres.length - 4}</span>}</p>
                  )}
                </div>
              );
            })()}
            <div className="grid grid-cols-2 gap-3 text-xs text-gray-500 mb-4">
              {showDetail.facture_id && factureMap[showDetail.facture_id] && <div><p className="text-gray-400">Facture</p><Link href={`/factures/${showDetail.facture_id}`} className="text-indigo-600 hover:underline">{factureMap[showDetail.facture_id].numero_facture}</Link></div>}
              {showDetail.be_id && beMap[showDetail.be_id] && <div><p className="text-gray-400">BE</p><Link href={`/be-receptions/${showDetail.be_id}`} className="text-indigo-600 hover:underline">{beMap[showDetail.be_id].numero_be}</Link></div>}
              {showDetail.commande_id && cmdMap[showDetail.commande_id] && <div><p className="text-gray-400">Commande</p><Link href={`/commandes/${showDetail.commande_id}`} className="text-indigo-600 hover:underline">{cmdMap[showDetail.commande_id].numero_commande_interne}</Link></div>}
            </div>
            {showDetail.be_id && beMap[showDetail.be_id] && (
              <a href={lienCentralinkBE(beMap[showDetail.be_id].numero_be)} target="_blank" rel="noreferrer" className="block mb-3">
                <Button variant="outline" size="sm" className="w-full">↗ Vérifier ce BE dans Centralink</Button>
              </a>
            )}
            {!showDetail.be_id && showDetail.commande_id && cmdMap[showDetail.commande_id] && (
              <a href={lienCentralinkCmd(cmdMap[showDetail.commande_id].numero_commande_interne)} target="_blank" rel="noreferrer" className="block mb-3">
                <Button variant="outline" size="sm" className="w-full">↗ Ouvrir la commande {cmdMap[showDetail.commande_id].numero_commande_interne} dans Centralink</Button>
              </a>
            )}
            {showDetail.suggestion_ia && (
              <div className="mt-3 p-3 bg-indigo-50 border border-indigo-100 rounded-lg">
                <p className="text-xs font-medium text-indigo-700 mb-1">💡 Suggestion IA</p>
                <p className="text-sm text-indigo-800">{showDetail.suggestion_ia}</p>
              </div>
            )}
            {showDetail.origine === 'réception' && showDetail.be_id && ['ouverte', 'en cours'].includes(showDetail.statut_exception) && (
              <div className="mb-2 p-2.5 rounded-lg bg-indigo-50/60 border border-indigo-100">
                <p className="text-xs font-medium text-indigo-700 mb-1.5">📂 Classer cette réception</p>
                <select defaultValue="" disabled={updating === showDetail.id}
                  onChange={e => { if (e.target.value) classerReception(showDetail, e.target.value); }}
                  className="w-full border border-indigo-200 rounded-lg p-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500">
                  <option value="" disabled>— Choisir un classement —</option>
                  {CLASSEMENTS_RECEPTION.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                <p className="text-[11px] text-gray-500 mt-1">
                  SAV/échange · pièce détachée · commandé autrement · surplus gardé · résolu → <b>classe et résout</b> (quitte la liste).
                  « … Colombi » → reste à traiter (réclamation).
                </p>
              </div>
            )}
            {(showDetail.type_exception as string) === 'sur-livraison' && ['ouverte', 'en cours'].includes(showDetail.statut_exception) && (
              <div className="mb-2 p-2 rounded-lg bg-gray-50 border border-gray-100">
                <p className="text-xs text-gray-500 mb-1.5">Décision rapide sur le surplus :</p>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" className="flex-1 border-emerald-200 text-emerald-700 hover:bg-emerald-50"
                    disabled={updating === showDetail.id} onClick={() => disposerSurLiv(showDetail, 'garde')}>
                    ✅ Gardé (régularisé)
                  </Button>
                  <Button variant="outline" size="sm" className="flex-1 border-orange-200 text-orange-700 hover:bg-orange-50"
                    disabled={updating === showDetail.id} onClick={() => disposerSurLiv(showDetail, 'retour')}>
                    ↩ Retour / avoir attendu
                  </Button>
                </div>
                <Button variant="outline" size="sm" className="w-full mt-2 border-blue-200 text-blue-700 hover:bg-blue-50"
                  disabled={updating === showDetail.id} onClick={() => routerVersLog(showDetail)}>
                  🛠 Erreur de saisie (Attendu négatif) → log
                </Button>
                <p className="text-[11px] text-gray-400 mt-1">« Gardé » = commande de régul dans Centralink → résolue. « Retour » = avoir attendu. « Erreur de saisie » = Livré gonflé (vrai reçu = commandé) → la log corrige.</p>
              </div>
            )}
            {['hors-commande', 'sur-livraison'].includes(showDetail.type_exception as string) && (
              <>
                {estRefSav(showDetail.reference_article) && showDetail.destinataire !== 'SAV' && (
                  <div className="mb-2 p-2 rounded-lg bg-teal-50 border border-teal-100 text-xs text-teal-700">
                    ⚠ Réf aussi pièce SAV — vérifie si ce surplus est un envoi SAV avant de réclamer à Colombi.
                  </div>
                )}
                {showDetail.destinataire === 'SAV' ? (
                  <Button variant="outline" size="sm" className="w-full mb-2" disabled={updating === showDetail.id}
                    onClick={() => classerSav(showDetail, true)}>
                    ↩ Retirer du SAV (redevient réclamation Colombi)
                  </Button>
                ) : (
                  <Button variant="outline" size="sm" className="w-full mb-2 border-teal-200 text-teal-700 hover:bg-teal-50"
                    disabled={updating === showDetail.id} onClick={() => classerSav(showDetail, false)}>
                    📦 Classer : pièce détachée SAV (hors Centralink)
                  </Button>
                )}
                {(showDetail.type_exception as string) === 'hors-commande' && ['ouverte', 'en cours'].includes(showDetail.statut_exception) && (
                  <Button variant="outline" size="sm" className="w-full mb-2 border-gray-200 text-gray-600 hover:bg-gray-50"
                    disabled={updating === showDetail.id} onClick={() => garderEnStock(showDetail)}>
                    📥 Gardé en stock (sans commande — ancien fonctionnement)
                  </Button>
                )}
              </>
            )}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-xs text-gray-400">Assigné à</label>
                <input value={assigne} onChange={e => setAssigne(e.target.value)} placeholder="Colombi / log / nom…"
                  className="w-full border border-gray-200 rounded-lg p-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
              <div>
                <label className="text-xs text-gray-400">Échéance</label>
                <input type="date" value={echeance} onChange={e => setEcheance(e.target.value)}
                  className="w-full border border-gray-200 rounded-lg p-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </div>
            </div>
            <textarea
              value={comment}
              onChange={e => setComment(e.target.value)}
              placeholder="Commentaire / note de résolution..."
              className="w-full border border-gray-200 rounded-lg p-2 text-sm resize-none h-20 focus:outline-none focus:ring-2 focus:ring-indigo-500 mt-3"
            />
            <Button variant="outline" size="sm" className="w-full mt-2" disabled={updating === showDetail.id} onClick={() => saveDetail(showDetail)}>
              Enregistrer assignation / note
            </Button>
            </div>

            {/* Pied collant : actions de statut */}
            <div className="px-5 py-3 border-t border-gray-100 bg-gray-50/70 flex items-center gap-2">
              {['ouverte', 'en cours'].includes(showDetail.statut_exception) ? (
                <>
                  <Button size="sm" onClick={() => updateStatut(showDetail, 'résolue')} className="flex-1">
                    <CheckCircle2 className="w-4 h-4" /> Résoudre
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => updateStatut(showDetail, 'en cours')}>En cours</Button>
                  <Button variant="ghost" size="sm" onClick={() => updateStatut(showDetail, 'ignorée')}>Ignorer</Button>
                </>
              ) : (
                <span className="text-xs text-gray-500 flex-1">Anomalie {showDetail.statut_exception}</span>
              )}
              <Button variant="outline" size="sm" onClick={() => setShowDetail(null)}>Fermer</Button>
            </div>
          </div>
        </div>
      )}

      {/* Modale liste générée (réclamation / corrections) */}
      {listeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-lg">
            <h2 className="text-base font-semibold text-gray-900 mb-3">{listeModal.titre}</h2>
            <textarea
              readOnly
              value={listeModal.texte}
              className="w-full border border-gray-200 rounded-lg p-2 text-xs font-mono resize-none h-64 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <div className="flex flex-wrap gap-2 mt-3">
              <Button size="sm" onClick={() => { navigator.clipboard.writeText(listeModal.texte); toast.success('Copié'); }}>Copier</Button>
              <Button variant="outline" size="sm" onClick={() => telecharger(listeModal.texte, `${listeModal.titre}.txt`)}>Télécharger</Button>
              <Button variant="outline" size="sm" onClick={() => imprimerListe(listeModal.titre, listeModal.texte)}>Imprimer</Button>
              {listeModal.mailto && (
                <a href={listeModal.mailto}><Button variant="outline" size="sm">Ouvrir dans le mail</Button></a>
              )}
              <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setListeModal(null)}>Fermer</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
