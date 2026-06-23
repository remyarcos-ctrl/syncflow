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

export default function ExceptionsPage() {
  const qc = useQueryClient();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [filterStatut, setFilterStatut] = useState('actives');
  const [filterType, setFilterType] = useState('all');
  const [filterPriorite, setFilterPriorite] = useState('all');
  const [filterOrigine, setFilterOrigine] = useState('all');
  const [filterDest, setFilterDest] = useState('all');
  const [showDetail, setShowDetail] = useState<Exc | null>(null);
  const [comment, setComment] = useState('');
  const [assigne, setAssigne] = useState('');
  const [echeance, setEcheance] = useState('');
  const [updating, setUpdating] = useState<string | null>(null);

  const { data: exceptionsResult = { exceptions: [], total: 0 }, isError } = useQuery<{ exceptions: Exc[]; total: number }>({
    queryKey: ['exceptions', page, filterStatut, filterType, filterPriorite, filterOrigine, filterDest],
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
      if (filterDest !== 'all') query = query.eq('destinataire', filterDest);

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

  const { data: bes = [] } = useQuery<Pick<BEReception, 'id' | 'numero_be'>[]>({
    queryKey: ['bes-slim'],
    queryFn: async () => { const { data } = await supabase.from('be_receptions').select('id,numero_be').limit(500); return (data ?? []) as Pick<BEReception, 'id' | 'numero_be'>[]; },
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
  const beMap = useMemo(() => Object.fromEntries(bes.map(b => [b.id, b])) as Record<string, Pick<BEReception, 'id' | 'numero_be'>>, [bes]);
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

  const [listeModal, setListeModal] = useState<{ titre: string; texte: string; mailto?: string } | null>(null);
  const [detecting, setDetecting] = useState(false);

  const detecter = async () => {
    setDetecting(true);
    try {
      const r = await fetch('/api/detect-anomalies', { method: 'POST' });
      const d = await r.json() as { inserees?: number; detail?: Record<string, number>; error?: string };
      if (d.error) { toast.error(d.error); return; }
      toast.success(`${d.inserees} nouvelle(s) · réception ${d.detail?.réception ?? 0}, pointage ${d.detail?.pointage ?? 0}, facturation ${d.detail?.facturation ?? 0}`);
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
          onClick={() => { setFilterStatut('à analyser'); setPage(1); }}
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
          { label: '🆕 À analyser', value: kpiData.aAnalyser, color: 'text-indigo-600', onClick: () => { setFilterStatut('à analyser'); setPage(1); } },
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
          {['Colombi', 'log', 'SAV', 'interne'].map(d => <option key={d} value={d}>{d}</option>)}
        </select>
      </div>

      {/* Actions */}
      <div className="flex flex-wrap gap-2 mb-4">
        <Button size="sm" disabled={detecting} onClick={detecter}>{detecting ? 'Détection…' : '🔄 Détecter les anomalies'}</Button>
        <Button variant="outline" size="sm" onClick={() => genererListe('Colombi')}>📩 Réclamer à Colombi</Button>
        <Button variant="outline" size="sm" onClick={() => genererListe('log')}>🛠 Demander correction à la log</Button>
        <Button variant="outline" size="sm" onClick={exportCsv}>⬇ Exporter (CSV{filterDest !== 'all' ? ` · ${filterDest}` : ''})</Button>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50/50 border-b border-gray-100">
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Type</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Source</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Motif</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Destinataire</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Facture</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">BE</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Statut</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {exceptions.map(exc => {
              const tc = TYPE_CONFIG[exc.type_exception] ?? { color: 'text-gray-600 bg-gray-50', label: exc.type_exception };
              return (
                <tr key={exc.id} className={cn('hover:bg-gray-50/50', ['haute', 'critique'].includes(exc.niveau_priorite) ? 'border-l-2 border-l-red-400' : exc.niveau_priorite === 'moyenne' ? 'border-l-2 border-l-orange-300' : '')}>
                  <td className="px-4 py-3">
                    <span className={cn('text-xs font-medium px-2 py-0.5 rounded-full', tc.color)}>{tc.label}</span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-xs text-gray-600">{exc.origine ?? '—'}</span>
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-700 max-w-[220px]">
                    <div className="truncate">{exc.motif}</div>
                    {exc.reference_article && <div className="text-[11px] text-gray-400 font-mono">{exc.reference_article}</div>}
                    {exc.suggestion_action_ia && (
                      <div className="mt-0.5 text-[11px] text-blue-600 truncate" title={exc.suggestion_action_ia}>🛠 {exc.suggestion_action_ia}</div>
                    )}
                    {enCours(exc.reference_article) && (
                      <span className="inline-block mt-0.5 text-[11px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-600" title="La commande attend encore de la marchandise côté Centralink — la log n'a peut-être pas fini de saisir">
                        ⏳ saisie peut-être en cours
                      </span>
                    )}
                    {estRefSav(exc.reference_article) && exc.destinataire !== 'SAV' && (exc.type_exception as string) === 'sur-livraison' && (
                      <span className="inline-block mt-0.5 ml-1 text-[11px] px-1.5 py-0.5 rounded bg-teal-50 text-teal-600" title="Cette référence est aussi une pièce détachée SAV — vérifie si le surplus est un envoi SAV avant de réclamer à Colombi">
                        ⚠ réf aussi SAV
                      </span>
                    )}
                    {exc.explication_ia && (
                      <p className="text-xs text-gray-500 mt-0.5 max-w-xs truncate">{exc.explication_ia}</p>
                    )}
                    {!exc.explication_ia && !exc.suggestion_ia && (
                      <button
                        onClick={async (e) => {
                          e.stopPropagation();
                          await fetch('/api/exception-ia', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ exceptionId: exc.id }) });
                          qc.invalidateQueries({ queryKey: ['exceptions'] });
                        }}
                        className="text-xs text-indigo-500 hover:text-indigo-700 underline"
                      >
                        Analyser avec IA
                      </button>
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-md">
            <div className="flex items-center gap-2 mb-3">
              <AlertTriangle className="w-4 h-4 text-amber-500" />
              <h2 className="text-base font-semibold text-gray-900">{TYPE_CONFIG[showDetail.type_exception]?.label ?? showDetail.type_exception}</h2>
              <span className={cn('text-xs px-2 py-0.5 rounded-full border ml-auto', PRIORITE_CONFIG[showDetail.niveau_priorite] ?? '')}>{showDetail.niveau_priorite}</span>
            </div>
            <p className="text-sm text-gray-700 mb-3">{showDetail.motif}</p>
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
            {(showDetail.origine || showDetail.destinataire) && (
              <div className="flex gap-2 mb-2 text-xs">
                {showDetail.origine && <span className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">source : {showDetail.origine}</span>}
                {showDetail.destinataire && <span className={cn('px-2 py-0.5 rounded-full', DEST_CONFIG[showDetail.destinataire] ?? 'bg-gray-100 text-gray-600')}>{showDetail.destinataire}</span>}
              </div>
            )}
            {(showDetail.type_exception as string) === 'sur-livraison' && ['ouverte', 'en cours'].includes(showDetail.statut_exception) && (
              <div className="mb-2 p-2 rounded-lg bg-gray-50 border border-gray-100">
                <p className="text-xs text-gray-500 mb-1.5">Décision sur le surplus :</p>
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
            {['ouverte', 'en cours'].includes(showDetail.statut_exception) && (
              <div className="flex gap-2 mt-3">
                <Button size="sm" onClick={() => updateStatut(showDetail, 'résolue')} className="flex-1">
                  <CheckCircle2 className="w-4 h-4" /> Résoudre
                </Button>
                <Button variant="outline" size="sm" onClick={() => updateStatut(showDetail, 'en cours')}>En cours</Button>
                <Button variant="ghost" size="sm" onClick={() => updateStatut(showDetail, 'ignorée')}>Ignorer</Button>
              </div>
            )}
            <Button variant="outline" className="w-full mt-2" size="sm" onClick={() => setShowDetail(null)}>Fermer</Button>
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
