'use client';

import { useState, useEffect, useMemo } from 'react';
import { useParams } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { selectAll } from '@/lib/select-all';
import { comparerPointage, aEcart, aliasRef } from '@/lib/pointage';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import StatusBadge from '@/components/shared/StatusBadge';
import { formatEur, formatDate, cn } from '@/utils';
import {
  ArrowLeft, ExternalLink, Edit2, Save, X, MessageSquare,
  Link2, Unlink, Plus, FileText, ShoppingCart, AlertTriangle,
  Mail, Trash2, UserPlus, Send, History, Ban, RotateCcw, RefreshCw, Sparkles, Scissors
} from 'lucide-react';
import PDFViewerPanel from '@/components/shared/PDFViewerPanel';
import { toast } from 'sonner';
import type {
  BEReception, LigneBE, Commande, LigneCommande, Facture,
  LiaisonBECommande, Rapprochement, ContactFournisseur, JournalActivite, SaisieCL
} from '@/types';

const normalizeRef = (s: string | null | undefined) =>
  String(s ?? '').toUpperCase().replace(/O/g, '0').replace(/[^A-Z0-9]/g, '');

function refsMatch(a: string | null | undefined, b: string | null | undefined) {
  if (!a || !b) return false;
  if (a.toLowerCase().trim() === b.toLowerCase().trim()) return true;
  if (normalizeRef(a) === normalizeRef(b)) return true;
  const ap = a.split('/'); const bp = b.split('/');
  if (ap.length > 1 && normalizeRef(ap[ap.length - 1]) === normalizeRef(b)) return true;
  if (bp.length > 1 && normalizeRef(bp[bp.length - 1]) === normalizeRef(a)) return true;
  return false;
}

export default function BEDetailPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();

  const [editingNotes, setEditingNotes] = useState(false);
  const [notes, setNotes] = useState('');
  const [editingLineNotes, setEditingLineNotes] = useState<{ id: string; value: string } | null>(null);
  const [editingQteRecu, setEditingQteRecu] = useState<{ id: string; value: string } | null>(null);
  const [showLinkCommande, setShowLinkCommande] = useState(false);
  const [showPDF, setShowPDF] = useState(false);
  const [showAddContact, setShowAddContact] = useState(false);
  const [newContact, setNewContact] = useState({ nom: '', email: '', role: '' });
  const [showEmailModal, setShowEmailModal] = useState(false);
  const [emailDraft, setEmailDraft] = useState({ to: '', subject: '', body: '' });
  const [selectedCommandeId, setSelectedCommandeId] = useState('');
  const [searchCmd, setSearchCmd] = useState('');
  const [splitSavModal, setSplitSavModal] = useState<{ ligneId: string; ref: string | null; qteActuelle: number; qteSav: string } | null>(null);
  const [retourModal, setRetourModal] = useState<{ ligneId: string; ref: string | null; qte: number; motif: string } | null>(null);

  // ── Données ───────────────────────────────────────────────────────────────
  const { data: be } = useQuery<BEReception>({
    queryKey: ['be', id],
    queryFn: async () => {
      const { data } = await supabase.from('be_receptions').select('*').eq('id', id).single();
      return data!;
    },
    enabled: !!id, refetchInterval: 5000,
  });

  const { data: lignes = [] } = useQuery<LigneBE[]>({
    queryKey: ['lignes_be', id],
    queryFn: async () => {
      const { data } = await supabase.from('lignes_be').select('*').eq('be_id', id).order('ligne_no');
      return data ?? [];
    },
    enabled: !!id, refetchInterval: 5000,
  });

  const { data: liaisons = [] } = useQuery<LiaisonBECommande[]>({
    queryKey: ['liaisons_be_commande', id],
    queryFn: async () => {
      const { data } = await supabase.from('liaison_be_commande').select('*').eq('be_id', id);
      return data ?? [];
    },
    enabled: !!id, refetchInterval: 5000,
  });

  const commandeIds = useMemo(() => liaisons.map(l => l.commande_id), [liaisons]);

  const { data: commandes = [] } = useQuery<Commande[]>({
    queryKey: ['commandes_be', id, commandeIds.join()],
    queryFn: async () => {
      if (!commandeIds.length) return [];
      const { data } = await supabase.from('commandes').select('*').in('id', commandeIds);
      return data ?? [];
    },
    enabled: commandeIds.length > 0, refetchInterval: 5000,
  });

  const { data: rapprochements = [] } = useQuery<Rapprochement[]>({
    queryKey: ['raps_be', id],
    queryFn: async () => {
      const { data } = await supabase.from('rapprochements').select('*').eq('be_id', id);
      return data ?? [];
    },
    enabled: !!id, refetchInterval: 5000,
  });

  const factureIds = useMemo(() => [...new Set(rapprochements.map(r => r.facture_id).filter(Boolean))], [rapprochements]);

  const { data: factures = [] } = useQuery<Facture[]>({
    queryKey: ['factures_be', id, factureIds.join()],
    queryFn: async () => {
      if (!factureIds.length) return [];
      const { data } = await supabase.from('factures').select('*').in('id', factureIds as string[]);
      return data ?? [];
    },
    enabled: factureIds.length > 0, refetchInterval: 5000,
  });

  // ── Saisies de réception Centralink (③) pour ce BE ─────────────────────────
  const { data: saisiesCl = [] } = useQuery<SaisieCL[]>({
    queryKey: ['saisies_cl', be?.numero_be],
    queryFn: async () => {
      if (!be?.numero_be) return [];
      const { data } = await supabase.from('saisies_cl').select('*').eq('numero_be', be.numero_be);
      return data ?? [];
    },
    enabled: !!be?.numero_be, refetchInterval: 5000,
  });

  // Commandes servies par ce BE — dérivées de Centralink (saisies log), lecture seule.
  const commandeRefsServies = useMemo(
    () => [...new Set(saisiesCl.map(s => s.commande_ref).filter(Boolean))] as string[],
    [saisiesCl],
  );
  const { data: commandesServiesData = [] } = useQuery<Commande[]>({
    queryKey: ['commandes_servies_be', commandeRefsServies.join()],
    queryFn: async () => {
      if (!commandeRefsServies.length) return [];
      const { data } = await supabase.from('commandes').select('*').in('numero_commande_interne', commandeRefsServies);
      return data ?? [];
    },
    enabled: commandeRefsServies.length > 0, refetchInterval: 10000,
  });
  const commandesServies = useMemo(() => {
    const byRef = new Map<string, { qte: number; refs: Set<string> }>();
    for (const s of saisiesCl) {
      if (!s.commande_ref) continue;
      const cur = byRef.get(s.commande_ref) ?? { qte: 0, refs: new Set<string>() };
      cur.qte += s.quantite_recue ?? 0;
      if (s.reference_article) cur.refs.add(s.reference_article);
      byRef.set(s.commande_ref, cur);
    }
    return [...byRef.entries()].map(([ref, v]) => {
      const cmd = commandesServiesData.find(c => c.numero_commande_interne === ref);
      return { ref, cmdId: cmd?.id ?? null, statut: cmd?.statut_commande ?? null, fournisseur: cmd?.fournisseur ?? null, qte: v.qte, nbRefs: v.refs.size };
    }).sort((a, b) => a.ref.localeCompare(b.ref));
  }, [saisiesCl, commandesServiesData]);

  // Décisions de résolution des écarts de pointage
  const { data: pointageResolutions = [] } = useQuery<{ reference_article: string; statut: string; note: string | null }[]>({
    queryKey: ['pointage_resolution', be?.numero_be],
    queryFn: async () => {
      if (!be?.numero_be) return [];
      const { data, error } = await supabase.from('pointage_resolution')
        .select('reference_article, statut, note').eq('numero_be', be.numero_be);
      if (error) return [];
      return data ?? [];
    },
    enabled: !!be?.numero_be, refetchInterval: 5000,
  });

  // Contexte commandes GLOBAL (⚠ paginé : .limit(9999) est écrêté à 1000 par PostgREST) :
  // réfs reçues quelque part (→ « saisi sous un autre BE »), réfs en VRAIE sur-réception
  // (reçu > commandé → seule base pour accuser une sur-saisie, cf audit 01/07), Livré par réf.
  const { data: ctxCmd = { refsRecues: new Set<string>(), refsSurRecues: new Set<string>(), recuTotalByRef: new Map<string, number>() } } = useQuery({
    queryKey: ['refs-recues-ctx'],
    queryFn: async () => {
      const rows = await selectAll<{ reference_article: string | null; quantite_receptionnee_reelle: number | null; quantite_commandee: number | null }>(
        () => supabase.from('lignes_commande').select('reference_article, quantite_receptionnee_reelle, quantite_commandee'));
      const refsRecues = new Set<string>();
      const refsSurRecues = new Set<string>();
      const recuTotalByRef = new Map<string, number>();
      for (const l of rows) {
        const k = aliasRef(l.reference_article);
        if (!k) continue;
        const recu = Number(l.quantite_receptionnee_reelle) || 0;
        const cmd = Number(l.quantite_commandee) || 0;
        if (recu > 0) { refsRecues.add(k); recuTotalByRef.set(k, (recuTotalByRef.get(k) ?? 0) + recu); }
        if (cmd > 0 && recu > cmd + 0.001) refsSurRecues.add(k);
      }
      return { refsRecues, refsSurRecues, recuTotalByRef };
    },
    staleTime: 30000,
  });
  // Où chaque réf de CE BE est-elle saisie AILLEURS (sous d'autres n° de BE) dans Centralink ?
  // → révèle le mauvais dispatching. Meilleur signal que la quantité brute : le BE candidat
  // est-il SUR-SAISI pour cette réf (saisi > son propre papier) ? Si oui = marchandise mal
  // numérotée atterrie là (🎯 coupable). Si saisi = papier = livraison légitime distincte.
  const refsDuBe = useMemo(() => [...new Set(lignes.map(l => l.reference_article).filter((x): x is string => !!x))], [lignes]);
  const { data: saisiesRefs = [] } = useQuery<{ numero_be: string; reference_article: string | null; quantite_recue: number | null }[]>({
    queryKey: ['saisies-refs', refsDuBe.join()],
    queryFn: async () => {
      if (!refsDuBe.length) return [];
      const { data } = await supabase.from('saisies_cl').select('numero_be, reference_article, quantite_recue').in('reference_article', refsDuBe);
      return data ?? [];
    },
    enabled: refsDuBe.length > 0, staleTime: 30000,
  });
  const { data: papierRefs = [] } = useQuery<{ quantite_receptionnee: number | null; reference_article: string | null; hors_systeme: boolean | null; be_receptions: { numero_be: string } | { numero_be: string }[] | null }[]>({
    queryKey: ['papier-refs', refsDuBe.join()],
    queryFn: async () => {
      if (!refsDuBe.length) return [];
      const { data } = await supabase.from('lignes_be').select('quantite_receptionnee, reference_article, hors_systeme, be_receptions(numero_be)').in('reference_article', refsDuBe);
      return (data ?? []) as never;
    },
    enabled: refsDuBe.length > 0, staleTime: 30000,
  });
  const { data: beNumsScannes = new Set<string>() } = useQuery<Set<string>>({
    queryKey: ['be-nums-scannes'],
    queryFn: async () => {
      const { data } = await supabase.from('be_receptions').select('numero_be').limit(1000);
      return new Set((data ?? []).map(b => b.numero_be));
    },
    staleTime: 60000,
  });

  // Régularisations & avoirs par réf (GLOBAL Centralink). Une sur-livraison gardée est
  // régularisée par une commande « Surplus … » (régule) ; un retour donne un avoir (reçu
  // négatif). Le pointage par-BE ne les voit pas (autre commande) → on les rapatrie pour
  // qualifier un écart « ② > ③ » comme DÉJÀ régularisé plutôt que « oubli à investiguer ».
  type RegulLigne = {
    reference_article: string | null; quantite_receptionnee_reelle: number | null;
    commandes: { numero_commande_interne: string | null; bls_centralink: string | null }
      | { numero_commande_interne: string | null; bls_centralink: string | null }[] | null;
  };
  const { data: regulRows = [] } = useQuery<RegulLigne[]>({
    queryKey: ['regul-refs', refsDuBe.join()],
    queryFn: async () => {
      if (!refsDuBe.length) return [];
      const { data } = await supabase.from('lignes_commande')
        .select('reference_article, quantite_receptionnee_reelle, commandes(numero_commande_interne, bls_centralink)')
        .in('reference_article', refsDuBe);
      return (data ?? []) as never;
    },
    enabled: refsDuBe.length > 0, staleTime: 30000,
  });
  const regulByRef = useMemo(() => {
    const m = new Map<string, { regule: number; avoir: number; numeros: string[] }>();
    for (const l of regulRows) {
      const k = normalizeRef(l.reference_article);
      if (!k) continue;
      const cmd = Array.isArray(l.commandes) ? l.commandes[0] : l.commandes;
      const r = Number(l.quantite_receptionnee_reelle) || 0;
      const cur = m.get(k) ?? { regule: 0, avoir: 0, numeros: [] };
      if (r < 0) cur.avoir += -r;                                   // retour → avoir
      else if (cmd && /surplus/i.test(cmd.bls_centralink ?? '')) {  // commande « Surplus … » → régule
        cur.regule += r;
        if (cmd.numero_commande_interne && !cur.numeros.includes(cmd.numero_commande_interne)) cur.numeros.push(cmd.numero_commande_interne);
      }
      m.set(k, cur);
    }
    return m;
  }, [regulRows]);

  // Par réf : les BE (≠ celui-ci) où elle est saisie, avec sur-saisi (saisi − papier) si scanné.
  const dispatchByRef = useMemo(() => {
    const numBeOf = (l: typeof papierRefs[number]) => Array.isArray(l.be_receptions) ? l.be_receptions[0]?.numero_be : l.be_receptions?.numero_be;
    const pap = new Map<string, number>(); // numBe|ref → papier
    for (const l of papierRefs) {
      if (l.hors_systeme) continue;
      const nb = numBeOf(l); if (!nb) continue;
      pap.set(nb + '|' + normalizeRef(l.reference_article ?? null), (pap.get(nb + '|' + normalizeRef(l.reference_article ?? null)) ?? 0) + (l.quantite_receptionnee ?? 0));
    }
    const byRefBe = new Map<string, Map<string, number>>(); // ref → numBe → saisi
    for (const s of saisiesRefs) {
      if (!s.numero_be || s.numero_be === be?.numero_be) continue;
      const k = normalizeRef(s.reference_article);
      if (!byRefBe.has(k)) byRefBe.set(k, new Map());
      const bm = byRefBe.get(k)!;
      bm.set(s.numero_be, (bm.get(s.numero_be) ?? 0) + (s.quantite_recue ?? 0));
    }
    const out = new Map<string, { numBe: string; saisie: number; scanned: boolean; papier: number | null; over: number | null }[]>();
    for (const [k, bm] of byRefBe) {
      const arr = [...bm.entries()].map(([numBe, saisie]) => {
        const scanned = beNumsScannes.has(numBe);
        const papier = scanned ? (pap.get(numBe + '|' + k) ?? 0) : null;
        const over = papier != null ? saisie - papier : null;
        return { numBe, saisie, scanned, papier, over };
      }).sort((a, b) => (b.over ?? -1e9) - (a.over ?? -1e9) || b.saisie - a.saisie);
      out.set(k, arr);
    }
    return out;
  }, [saisiesRefs, papierRefs, beNumsScannes, be?.numero_be]);

  // Détail des saisies ③ par référence → commande(s), pour distinguer doublon vs mauvais dispatching.
  const saisieCmdByRef = useMemo(() => {
    const m = new Map<string, Map<string, number>>();
    for (const s of saisiesCl) {
      const k = normalizeRef(s.reference_article);
      if (!m.has(k)) m.set(k, new Map());
      const cm = m.get(k)!;
      const cref = s.commande_ref ?? '?';
      cm.set(cref, (cm.get(cref) ?? 0) + (s.quantite_recue ?? 0));
    }
    return m;
  }, [saisiesCl]);

  // Rapprochement ② BE papier ↔ ③ saisie CL (logique partagée @/lib/pointage)
  const rappCl = useMemo(() => {
    const rows = comparerPointage(lignes, saisiesCl, pointageResolutions,
      { refsRecues: ctxCmd.refsRecues, refsSurRecues: ctxCmd.refsSurRecues, recuTotalByRef: ctxCmd.recuTotalByRef });
    return { rows, nbEcarts: rows.filter(aEcart).length, hasCl: saisiesCl.length > 0 };
  }, [lignes, saisiesCl, pointageResolutions, ctxCmd]);

  const saveResolution = useMutation({
    mutationFn: async (p: { reference_article: string; statut?: string; note?: string | null }) => {
      const res = await fetch('/api/pointage-resolution', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ numero_be: be?.numero_be, ...p }),
      });
      if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? 'Erreur');
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pointage_resolution', be?.numero_be] }),
    onError: (e: Error) => toast.error(e.message),
  });

  // Commandes candidates : même fournisseur, non encore liées
  const { data: commandesCandidates = [] } = useQuery<Commande[]>({
    queryKey: ['commandes_dispo_be', be?.fournisseur, commandeIds.join()],
    queryFn: async () => {
      const { data } = await supabase
        .from('commandes')
        .select('*')
        .order('date_commande', { ascending: true })
        .limit(300);
      if (!data) return [];
      const fournBe = (be?.fournisseur ?? '').toLowerCase();
      return data.filter(c => {
        if (commandeIds.includes(c.id)) return false;
        const fournCmd = (c.fournisseur ?? '').toLowerCase();
        return fournCmd.includes(fournBe.slice(0, 5)) || fournBe.includes(fournCmd.slice(0, 5));
      });
    },
    enabled: showLinkCommande && !!be,
  });

  // Lignes commande des candidates pour scorer par références
  const candidateIds = commandesCandidates.map(c => c.id);
  type SlimLigne = { commande_id: string; reference_article: string | null; quantite_commandee: number; quantite_receptionnee_reelle: number };
  const { data: lignesCandidates = [] } = useQuery<SlimLigne[]>({
    queryKey: ['lignes_cmd_candidates', candidateIds.join()],
    queryFn: async () => {
      if (!candidateIds.length) return [];
      const { data } = await supabase
        .from('lignes_commande')
        .select('commande_id, reference_article, quantite_commandee, quantite_receptionnee_reelle')
        .in('commande_id', candidateIds);
      return (data ?? []) as SlimLigne[];
    },
    enabled: candidateIds.length > 0,
  });

  // Score : nb de refs BE présentes dans les lignes commande
  const beRefs = useMemo(() => lignes.map(l => l.reference_article), [lignes]);

  const commandesScorees = useMemo(() => {
    return commandesCandidates
      .map(c => {
        const lignesCmd = lignesCandidates.filter(l => l.commande_id === c.id);
        const matchedLines = (() => {
          const byRef = new Map<string, { ref: string | null; qteBe: number; resteCmd: number }>();
          for (const lb of lignes) {
            const lc = lignesCmd.find(l => refsMatch(lb.reference_article, l.reference_article));
            if (!lc) continue;
            const key = normalizeRef(lb.reference_article);
            if (byRef.has(key)) {
              byRef.get(key)!.qteBe += lb.quantite_receptionnee ?? 0;
            } else {
              const resteCmd = Math.max(0, (lc.quantite_commandee ?? 0) - (lc.quantite_receptionnee_reelle ?? 0));
              byRef.set(key, { ref: lb.reference_article, qteBe: lb.quantite_receptionnee ?? 0, resteCmd });
            }
          }
          return [...byRef.values()];
        })();
        const matches = matchedLines.length;
        return { commande: c, matches, total: lignesCmd.length, matchedLines };
      })
      .sort((a, b) => {
        if (b.matches !== a.matches) return b.matches - a.matches;
        const statutPrio = (s: string) =>
          s === 'ouverte' ? 0 : s === 'partiellement réceptionnée' ? 1 : 2;
        if (statutPrio(a.commande.statut_commande) !== statutPrio(b.commande.statut_commande))
          return statutPrio(a.commande.statut_commande) - statutPrio(b.commande.statut_commande);
        // FIFO : commande la plus ancienne en premier
        return new Date(a.commande.date_commande ?? a.commande.created_at).getTime() -
               new Date(b.commande.date_commande ?? b.commande.created_at).getTime();
      });
  }, [commandesCandidates, lignesCandidates, beRefs]);

  // Suggestion FIFO : calcule automatiquement la combinaison optimale de commandes à lier
  const fifoSuggestion = useMemo(() => {
    if (!commandesScorees.length) return [];
    const lignesLibres = lignes.filter(l => !l.ligne_commande_id);
    if (!lignesLibres.length) return [];
    const remainingBe = new Map<string, number>();
    for (const lb of lignesLibres) {
      const key = normalizeRef(lb.reference_article);
      remainingBe.set(key, (remainingBe.get(key) ?? 0) + (lb.quantite_receptionnee ?? 0));
    }
    const suggested: string[] = [];
    for (const { commande, matchedLines } of commandesScorees) {
      if ([...remainingBe.values()].every(v => v <= 0)) break;
      let absorbs = false;
      for (const ml of matchedLines) {
        const key = normalizeRef(ml.ref);
        const remaining = remainingBe.get(key) ?? 0;
        if (remaining > 0 && ml.resteCmd > 0) {
          absorbs = true;
          remainingBe.set(key, Math.max(0, remaining - ml.resteCmd));
        }
      }
      if (absorbs) suggested.push(commande.id);
    }
    return suggested;
  }, [commandesScorees, lignes]);

  // Alerte si la commande sélectionnée absorberait tout alors qu'une autre en a besoin
  const absorptionWarning = useMemo(() => {
    if (!selectedCommandeId) return null;
    const sel = commandesScorees.find(s => s.commande.id === selectedCommandeId);
    if (!sel) return null;
    const warnRefs: string[] = [];
    for (const ml of sel.matchedLines) {
      if (ml.resteCmd < ml.qteBe) continue;
      const otherNeeds = commandesScorees
        .filter(s => s.commande.id !== selectedCommandeId)
        .some(s => s.matchedLines.some(oml =>
          normalizeRef(oml.ref) === normalizeRef(ml.ref) && oml.resteCmd > 0
        ));
      if (otherNeeds) warnRefs.push(ml.ref ?? '?');
    }
    return warnRefs.length > 0 ? warnRefs : null;
  }, [selectedCommandeId, commandesScorees]);

  const { data: contacts = [] } = useQuery<ContactFournisseur[]>({
    queryKey: ['contacts_fournisseurs', be?.fournisseur],
    queryFn: async () => {
      const r = await fetch(`/api/contacts-fournisseurs?fournisseur=${encodeURIComponent(be!.fournisseur ?? '')}`);
      const json = await r.json();
      return Array.isArray(json) ? json : [];
    },
    enabled: !!be?.fournisseur,
  });

  const { data: journal = [] } = useQuery<JournalActivite[]>({
    queryKey: ['journal_be', id],
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

  useEffect(() => { if (be) setNotes(be.commentaire ?? ''); }, [be]);

  // Re-scanner le BL : re-parse le PDF stocké avec le parser à jour et corrige les quantités.
  const rescanMutation = useMutation({
    mutationFn: async () => {
      const r = await fetch('/api/rescan-be', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ beId: id }) });
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error ?? 'Erreur');
      return j as { corrigees: number };
    },
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ['lignes_be', id] });
      toast.success(d.corrigees > 0 ? `${d.corrigees} quantité(s) corrigée(s) d'après le PDF` : 'Scan déjà conforme au PDF');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // ── KPIs ──────────────────────────────────────────────────────────────────
  const kpis = useMemo(() => {
    // Excluent hors_systeme (SAV) ET statut_retour (en cours de retour fournisseur)
    const lignesActives = lignes.filter(l => !l.hors_systeme && !l.statut_retour);
    const qteRecue = lignesActives.reduce((s, l) => s + (l.quantite_receptionnee ?? 0), 0);
    const qteFact = lignesActives.reduce((s, l) => s + (l.quantite_facturee ?? 0), 0);
    const qteReste = lignesActives.reduce((s, l) => s + (l.quantite_restante_a_facturer ?? 0), 0);
    return { qteRecue, qteFact, qteReste };
  }, [lignes]);

  // « À arbitrer » retiré : l'attribution manuelle BE→commande est supprimée (le reçu vient
  // de Centralink). Le surplus/hors-commande réel est désormais traité dans le Centre d'anomalies.
  const lignesAArbitrer = useMemo<LigneBE[]>(() => [], []);

  const lignesEnEcart = useMemo(() => {
    // Grouper par référence pour avoir la vraie qté totale (attribuée + libre).
    // Lignes exclues : hors_systeme (SAV) et statut_retour (retour fournisseur) — déjà gérées séparément.
    const groupes = new Map<string, { ref: string | null; designation: string | null; qteTotale: number; qteDoc: number | null }>();
    for (const l of lignes) {
      if (l.hors_systeme || l.statut_retour) continue;
      const key = l.reference_article ?? `__${l.id}`;
      const g = groupes.get(key);
      if (g) {
        g.qteTotale += l.quantite_receptionnee ?? 0;
        if (l.quantite_document_be != null) g.qteDoc = (g.qteDoc ?? 0) + l.quantite_document_be;
      } else {
        groupes.set(key, {
          ref: l.reference_article,
          designation: l.designation,
          qteTotale: l.quantite_receptionnee ?? 0,
          qteDoc: l.quantite_document_be ?? null,
        });
      }
    }
    return Array.from(groupes.values()).filter(g => g.qteDoc != null && g.qteDoc !== g.qteTotale);
  }, [lignes]);

  // ── Mutations ─────────────────────────────────────────────────────────────
  const addContactMutation = useMutation({
    mutationFn: async () => {
      const r = await fetch('/api/contacts-fournisseurs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fournisseur: be!.fournisseur, ...newContact }),
      });
      const json = await r.json();
      if (!r.ok) throw new Error(json.error);
      return json;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contacts_fournisseurs', be?.fournisseur] });
      setNewContact({ nom: '', email: '', role: '' });
      setShowAddContact(false);
      toast.success('Contact ajouté');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteContactMutation = useMutation({
    mutationFn: async (contactId: string) => {
      const r = await fetch(`/api/contacts-fournisseurs?id=${contactId}`, { method: 'DELETE' });
      if (!r.ok) throw new Error((await r.json()).error);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contacts_fournisseurs', be?.fournisseur] });
      toast.success('Contact supprimé');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const sendEmailMutation = useMutation({
    mutationFn: async () => {
      const r = await fetch('/api/send-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: emailDraft.to, subject: emailDraft.subject, body: emailDraft.body, beId: id }),
      });
      const json = await r.json();
      if (!r.ok) {
        if (json.code === 'SCOPE_MISSING') throw new Error('SCOPE_MISSING');
        throw new Error(json.error);
      }
    },
    onSuccess: () => {
      setShowEmailModal(false);
      toast.success('Email envoyé au fournisseur');
    },
    onError: (e: Error) => {
      if (e.message === 'SCOPE_MISSING') {
        toast.error('Reconnectez votre Gmail pour autoriser l\'envoi', {
          action: { label: 'Reconnecter', onClick: () => window.location.href = '/api/gmail/auth' },
          duration: 10000,
        });
      } else {
        toast.error(e.message);
      }
    },
  });

  const openEmailModal = () => {
    const firstContact = contacts[0];
    const lignesDetail = lignesEnEcart.map(g => {
      const ecart = (g.qteDoc ?? 0) - g.qteTotale;
      return `  - Réf. ${g.ref ?? '—'} (${g.designation ?? ''})\n    Qté document : ${g.qteDoc} / Qté reçue : ${g.qteTotale} / Écart : ${ecart > 0 ? `-${ecart}` : `+${Math.abs(ecart)}`}`;
    }).join('\n');

    setEmailDraft({
      to: firstContact?.email ?? '',
      subject: `Demande d'avoir — BE ${be?.numero_be ?? ''}`,
      body: `Madame, Monsieur,\n\nNous avons réceptionné le bon de livraison N°${be?.numero_be ?? ''} du ${be?.date_bl ?? ''} avec les écarts suivants :\n\n${lignesDetail}\n\nNous vous remercions de bien vouloir établir un avoir correspondant à ces écarts dans les meilleurs délais.\n\nCordialement`,
    });
    setShowEmailModal(true);
  };

  const saveNotesMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from('be_receptions').update({ commentaire: notes }).eq('id', id);
      if (error) throw error;
      await supabase.from('journal_activite').insert({
        type_action: 'note_modifiee',
        entite_type: 'be_reception',
        entite_id: id,
        details_action: JSON.stringify({ apercu: notes.slice(0, 80) }),
      });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['be', id] }); setEditingNotes(false); toast.success('Note enregistrée'); },
    onError: (e: Error) => toast.error(e.message),
  });

  const saveQteRecuMutation = useMutation({
    mutationFn: async ({ ligneBeId, quantiteReceptionnee }: { ligneBeId: string; quantiteReceptionnee: number }) => {
      const r = await fetch('/api/update-ligne-be', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ligneBeId, quantiteReceptionnee }),
      });
      const json = await r.json();
      if (!r.ok) throw new Error(json.error ?? 'Erreur inconnue');
      return json as { ecart: number; quantiteDocument: number };
    },
    onSuccess: (data, vars) => {
      qc.invalidateQueries({ queryKey: ['lignes_be', id] });
      qc.invalidateQueries({ queryKey: ['be', id] });
      setEditingQteRecu(prev => prev?.id === vars.ligneBeId ? null : prev);
      if (data.ecart !== 0) {
        const msg = data.ecart > 0
          ? `Écart de ${data.ecart} unité(s) manquante(s) — avoir à réclamer au fournisseur`
          : `Écart de ${Math.abs(data.ecart)} unité(s) en surplus — à régulariser avec le fournisseur`;
        toast.warning(msg, { duration: 6000 });
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const saveLineNotesMutation = useMutation({
    mutationFn: async ({ lineId, comment }: { lineId: string; comment: string }) => {
      const { error } = await supabase.from('lignes_be').update({ commentaire: comment }).eq('id', lineId);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['lignes_be', id] }); setEditingLineNotes(null); },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggleHorsSystemeMutation = useMutation({
    mutationFn: async ({ ligneId, value }: { ligneId: string; value: boolean }) => {
      const { error } = await supabase.from('lignes_be').update({ hors_systeme: value }).eq('id', ligneId);
      if (error) throw error;
    },
    onSuccess: (_d, { value }) => {
      qc.invalidateQueries({ queryKey: ['lignes_be', id] });
      toast.success(value ? 'Ligne marquée hors système' : 'Ligne réintégrée');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteLigneMutation = useMutation({
    mutationFn: async (ligneId: string) => {
      const r = await fetch('/api/delete-ligne-be', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ligneBeId: ligneId }),
      });
      const json = await r.json();
      if (!r.ok) throw new Error(json.error ?? 'Erreur suppression');
      return json;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['lignes_be', id] });
      qc.invalidateQueries({ queryKey: ['be', id] });
      qc.invalidateQueries({ queryKey: ['commandes_be', id] });
      toast.success('Ligne supprimée — balances de la commande recalculées');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const marquerRetourMutation = useMutation({
    mutationFn: async ({ ligneId, motif }: { ligneId: string; motif: string }) => {
      const { error } = await supabase.from('lignes_be').update({
        statut_retour: 'a_retourner',
        motif_retour: motif || null,
      }).eq('id', ligneId);
      if (error) throw error;
      await supabase.from('journal_activite').insert({
        type_action: 'marquage_retour',
        entite_type: 'ligne_be',
        entite_id: ligneId,
        details_action: JSON.stringify({ motif }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['lignes_be', id] });
      setRetourModal(null);
      toast.success('Ligne marquée à retourner — visible dans la page Surplus');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const creerCmdComplementMutation = useMutation({
    mutationFn: async (ligneId: string) => {
      const r = await fetch('/api/creer-commande-complement', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ligneBeId: ligneId }),
      });
      const json = await r.json();
      if (!r.ok) throw new Error(json.error ?? 'Erreur création commande complément');
      return json as { commande_id: string; numero_commande: string };
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['lignes_be', id] });
      qc.invalidateQueries({ queryKey: ['liaisons_be_commande', id] });
      qc.invalidateQueries({ queryKey: ['commandes_be', id] });
      toast.success(`Commande complément créée : ${data.numero_commande}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const alignDocMutation = useMutation({
    mutationFn: async (ref: string | null) => {
      // Aligne quantite_document_be sur quantite_receptionnee pour toutes les lignes de cette référence sur ce BE.
      // Utile quand l'écart vient d'une correction de parsing (Claude s'est trompé), pas d'une vraie sous/sur-réception.
      const cibles = lignes.filter(l => (l.reference_article ?? null) === ref);
      for (const lb of cibles) {
        await supabase.from('lignes_be').update({
          quantite_document_be: lb.quantite_receptionnee,
        }).eq('id', lb.id);
      }
      await supabase.from('journal_activite').insert({
        type_action: 'alignement_doc_be',
        entite_type: 'be_reception',
        entite_id: id,
        details_action: JSON.stringify({ reference: ref, lignes: cibles.length }),
      });
    },
    onSuccess: (_d, ref) => {
      qc.invalidateQueries({ queryKey: ['lignes_be', id] });
      toast.success(`Écart effacé pour ${ref ?? 'la référence'} — doc aligné sur la qté reçue`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const splitSavMutation = useMutation({
    mutationFn: async ({ ligneId, qteSav }: { ligneId: string; qteSav: number }) => {
      const ligne = lignes.find(l => l.id === ligneId);
      if (!ligne) throw new Error('Ligne introuvable');
      const qteActuelle = ligne.quantite_receptionnee ?? 0;
      if (qteSav <= 0 || qteSav >= qteActuelle)
        throw new Error(`La quantité SAV doit être entre 1 et ${qteActuelle - 1}`);
      const nouvelleQte = qteActuelle - qteSav;
      const qteFact = ligne.quantite_facturee ?? 0;
      const qteResteFact = Math.max(0, nouvelleQte - qteFact);
      const maxLigneNo = Math.max(...lignes.map(l => l.ligne_no ?? 0));
      // Scission = opération structurelle : on redistribue qte_document_be sur les deux lignes
      // résultantes (nouvelleQte + qteSav = qteActuelle, donc le total déclaré reste préservé au
      // niveau du groupe-référence).
      const { error: e1 } = await supabase.from('lignes_be').update({
        quantite_receptionnee: nouvelleQte,
        quantite_document_be: nouvelleQte,
        quantite_restante_a_facturer: qteResteFact,
      }).eq('id', ligneId);
      if (e1) throw e1;
      const { error: e2 } = await supabase.from('lignes_be').insert({
        be_id: id,
        ligne_no: maxLigneNo + 1,
        reference_article: ligne.reference_article,
        designation: ligne.designation,
        quantite_receptionnee: qteSav,
        quantite_document_be: qteSav,
        quantite_facturee: 0,
        quantite_restante_a_facturer: 0,
        hors_systeme: true,
        commentaire: 'SAV',
      });
      if (e2) throw e2;
      await supabase.from('journal_activite').insert({
        type_action: 'scission_sav',
        entite_type: 'ligne_be',
        entite_id: ligneId,
        details_action: JSON.stringify({
          reference: ligne.reference_article,
          qte_originale: qteActuelle,
          qte_normale: nouvelleQte,
          qte_sav: qteSav,
        }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['lignes_be', id] });
      setSplitSavModal(null);
      toast.success('Ligne scindée — portion SAV créée');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const linkCommandeMutation = useMutation({
    mutationFn: async (commandeId: string) => {
      const r = await fetch('/api/link-be-commande', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ beId: id, commandeId }),
      });
      const json = await r.json();
      if (!r.ok) throw new Error(json.error ?? 'Erreur inconnue');
      return json as { lignes_attribuees: number };
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['liaisons_be_commande', id] });
      qc.invalidateQueries({ queryKey: ['commandes_be', id] });
      qc.invalidateQueries({ queryKey: ['lignes_be', id] });
      qc.invalidateQueries({ queryKey: ['be', id] });
      setShowLinkCommande(false);
      supabase.from('journal_activite').insert({
        type_action: 'liaison_commande',
        entite_type: 'be_reception',
        entite_id: id,
        details_action: JSON.stringify({ commande_id: selectedCommandeId, lignes_attribuees: data.lignes_attribuees }),
      }).then(() => {}); // fire and forget
      setSelectedCommandeId('');
      if (data.lignes_attribuees === 0) {
        console.warn('[link-be-commande] 0 ligne attribuée — diagnostic:', JSON.stringify((data as Record<string, unknown>).diag, null, 2));
        toast.warning(`Commande liée mais 0 ligne attribuée — vérifiez la console (F12) pour le détail des références`);
      } else {
        toast.success(`Commande liée — ${data.lignes_attribuees} ligne(s) attribuée(s)`);
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const unlinkCommandeMutation = useMutation({
    mutationFn: async (liaison: LiaisonBECommande) => {
      const r = await fetch('/api/link-be-commande', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ liaisonId: liaison.id, beId: id, commandeId: liaison.commande_id }),
      });
      if (!r.ok) throw new Error((await r.json()).error);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['liaisons_be_commande', id] });
      qc.invalidateQueries({ queryKey: ['commandes_be', id] });
      qc.invalidateQueries({ queryKey: ['lignes_be', id] });
      toast.success('Lien supprimé');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const scanGmailMutation = useMutation({
    mutationFn: async () => {
      const r = await fetch('/api/gmail/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fournisseur: be?.fournisseur }),
      });
      const json = await r.json();
      if (!r.ok) throw new Error(json.error ?? 'Erreur scan Gmail');
      return json as { commandes_importees: number; doublons_ignores: number };
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['commandes_dispo_be'] });
      qc.invalidateQueries({ queryKey: ['commandes'] });
      const msg = data.commandes_importees > 0
        ? `${data.commandes_importees} commande(s) importée(s) depuis Gmail`
        : `Aucune nouvelle commande trouvée (${data.doublons_ignores} doublon(s) ignoré(s))`;
      toast.success(msg);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const cmdFiltered = useMemo(() =>
    commandesScorees.filter(({ commande: c }) =>
      !searchCmd || c.numero_commande_interne.toLowerCase().includes(searchCmd.toLowerCase())
    ),
    [commandesScorees, searchCmd]
  );

  if (!be) {
    return <div className="flex items-center justify-center h-64 text-gray-400 text-sm">Chargement…</div>;
  }

  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/be-receptions">
          <Button variant="ghost" size="icon" className="h-8 w-8"><ArrowLeft className="w-4 h-4" /></Button>
        </Link>
        <div>
          <h1 className="text-xl font-bold text-gray-900 font-mono">BE {be.numero_be}</h1>
          <p className="text-sm text-gray-500">{be.fournisseur}</p>
        </div>
        <StatusBadge status={be.statut_be} />
        {lignesAArbitrer.length > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 border border-amber-200 px-2 py-0.5 text-xs font-medium text-amber-700">
            <AlertTriangle className="w-3 h-3" /> {lignesAArbitrer.length} à arbitrer
          </span>
        )}
      </div>

      {/* Bannière écarts */}
      {lignesEnEcart.length > 0 && (() => {
        const lignesManque = lignesEnEcart.filter(g => (g.qteDoc ?? 0) > g.qteTotale);
        const lignesSurplus = lignesEnEcart.filter(g => (g.qteDoc ?? 0) < g.qteTotale);
        const hasManque = lignesManque.length > 0;
        return (
          <div className="flex items-start gap-3 rounded-xl border border-orange-200 bg-orange-50 px-4 py-3">
            <AlertTriangle className="w-4 h-4 text-orange-500 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <p className="text-sm font-semibold text-orange-800">
                  {lignesEnEcart.length} ligne{lignesEnEcart.length > 1 ? 's' : ''} en écart —{' '}
                  {hasManque && lignesSurplus.length > 0
                    ? 'manque + surplus à régulariser'
                    : hasManque
                    ? 'avoir à réclamer au fournisseur'
                    : 'surplus reçu, à régulariser avec le fournisseur'}
                </p>
                {hasManque && (
                  <button
                    onClick={openEmailModal}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-orange-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-orange-700 transition-colors shrink-0"
                  >
                    <Mail className="w-3.5 h-3.5" /> Demander l'avoir par email
                  </button>
                )}
              </div>
              <ul className="mt-1 space-y-0.5">
                {lignesEnEcart.map(g => {
                  const ecart = (g.qteDoc ?? 0) - g.qteTotale;
                  return (
                    <li key={g.ref ?? '_'} className="text-xs text-orange-700 font-mono flex items-center gap-2 flex-wrap">
                      <span>
                        Réf. {g.ref ?? '—'} : doc={g.qteDoc} / reçu={g.qteTotale}
                        {' '}→ {ecart > 0 ? `−${ecart} (manque)` : `+${Math.abs(ecart)} (surplus)`}
                      </span>
                      <button
                        onClick={() => alignDocMutation.mutate(g.ref)}
                        disabled={alignDocMutation.isPending}
                        className="inline-flex items-center gap-1 rounded-md border border-orange-300 bg-white px-1.5 py-0.5 text-[10px] font-sans font-medium text-orange-700 hover:bg-orange-100 disabled:opacity-50"
                        title="Si l'écart vient d'une mauvaise lecture du PDF (Claude s'est trompé), aligner doc sur la qté actuelle pour effacer la fausse alerte"
                      >
                        Aligner doc
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        );
      })()}

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: 'Date BL', value: formatDate(be.date_bl) },
          { label: 'Qté reçue', value: kpis.qteRecue },
          { label: 'Qté facturée', value: kpis.qteFact },
          { label: 'Reste à facturer', value: kpis.qteReste },
        ].map(k => (
          <Card key={k.label}>
            <CardContent className="pt-4 pb-3">
              <p className="text-xs text-gray-400">{k.label}</p>
              <p className="text-sm font-semibold text-gray-900 mt-0.5">{k.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>
      {be.pdf_url && (
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setShowPDF(true)}>
            <FileText className="w-3.5 h-3.5 mr-1.5" /> Voir le PDF
          </Button>
          <Button variant="outline" size="sm" disabled={rescanMutation.isPending} onClick={() => rescanMutation.mutate()}
            title="Re-lit le PDF avec le parser à jour et corrige les quantités (sans toucher aux SAV/retours)">
            <RefreshCw className={cn('w-3.5 h-3.5 mr-1.5', rescanMutation.isPending && 'animate-spin')} /> {rescanMutation.isPending ? 'Re-scan…' : 'Re-scanner le BL'}
          </Button>
        </div>
      )}

      {/* Commandes, Factures et Contacts */}
      <div className="grid lg:grid-cols-2 gap-4">
        {/* Commandes liées */}
        <Card className="border-indigo-100">
          <CardContent className="pt-4 pb-4">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide flex items-center gap-1.5 mb-3">
              <ShoppingCart className="w-3.5 h-3.5 text-indigo-500" /> Commande(s) servie(s) ({commandesServies.length})
              <span className="text-[10px] text-gray-300 normal-case font-normal ml-1">depuis Centralink</span>
            </p>
            {commandesServies.length === 0 ? (
              <p className="text-xs text-amber-600 italic">Aucune réception saisie dans Centralink pour ce BE</p>
            ) : (
              <div className="space-y-1">
                {commandesServies.map(c => (
                  <div key={c.ref} className="flex items-center justify-between px-2 py-1.5 rounded-lg hover:bg-indigo-50 transition-colors">
                    {c.cmdId ? (
                      <Link href={`/commandes/${c.cmdId}`} className="flex items-center gap-2 flex-1">
                        <span className="text-sm font-medium text-indigo-700 font-mono">{c.ref}</span>
                        {c.fournisseur && <span className="text-xs text-gray-400">{c.fournisseur}</span>}
                        {c.statut && <StatusBadge status={c.statut} />}
                      </Link>
                    ) : (
                      <span className="text-sm font-mono text-gray-500 flex-1">{c.ref} <span className="text-[10px] text-gray-400">· commande absente de syncflow</span></span>
                    )}
                    <span className="text-xs text-gray-500 whitespace-nowrap">{c.nbRefs} réf · <span className="font-medium text-emerald-600">{c.qte} reçu</span></span>
                  </div>
                ))}
              </div>
            )}

            {showLinkCommande && (
              <div className="mt-3 border-t pt-3">

                {/* Suggestion FIFO */}
                {fifoSuggestion.length > 0 && (
                  <div className="mb-3 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2">
                    <p className="text-[10px] font-semibold text-indigo-700 flex items-center gap-1 mb-1">
                      <Sparkles className="w-3 h-3" /> Suggestion FIFO
                    </p>
                    <p className="text-[10px] text-indigo-600 mb-1.5">
                      Lier dans cet ordre : {fifoSuggestion.map(cid => {
                        const c = commandesCandidates.find(x => x.id === cid);
                        return c ? `#${c.numero_commande_interne}` : '';
                      }).filter(Boolean).join(' → ')}
                    </p>
                  </div>
                )}

                <div className="relative mb-2">
                  <Input placeholder="Rechercher…" value={searchCmd} onChange={e => setSearchCmd(e.target.value)} className="h-8 text-xs pl-3" />
                </div>

                <div className="max-h-72 overflow-y-auto space-y-1">
                  {cmdFiltered.map(({ commande: c, matches, matchedLines }) => {
                    const isSuggested = fifoSuggestion.includes(c.id);
                    const suggestionPos = fifoSuggestion.indexOf(c.id);
                    return (
                      <div key={c.id} onClick={() => setSelectedCommandeId(c.id)}
                        className={cn('px-2 py-2 rounded-lg cursor-pointer text-xs transition-colors',
                          selectedCommandeId === c.id ? 'bg-indigo-100 text-indigo-800' : 'hover:bg-gray-50',
                          isSuggested && selectedCommandeId !== c.id && 'ring-1 ring-indigo-200')}>
                        <div className="flex items-center gap-2">
                          <div className="flex-1 min-w-0">
                            {isSuggested && (
                              <span className="text-[9px] font-bold text-indigo-500 mr-1">{suggestionPos + 1}.</span>
                            )}
                            <span className="font-mono font-medium">#{c.numero_commande_interne}</span>
                            <span className="text-gray-400 ml-2">{formatDate(c.date_commande)}</span>
                          </div>
                          <StatusBadge status={c.statut_commande} />
                          {matches > 0 ? (
                            <span className="shrink-0 rounded-full bg-emerald-100 text-emerald-700 px-1.5 py-0.5 font-medium whitespace-nowrap">
                              {matches}/{beRefs.length} réf.
                            </span>
                          ) : (
                            <span className="shrink-0 text-gray-300">0 réf.</span>
                          )}
                        </div>
                        {matchedLines.length > 0 && (
                          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 pl-1">
                            {matchedLines.map(ml => (
                              <span key={ml.ref} className={cn(
                                'font-mono text-[10px]',
                                ml.qteBe > ml.resteCmd ? 'text-amber-600' : 'text-gray-500'
                              )}>
                                {ml.ref} : BE <b>{ml.qteBe}</b> / attend <b>{ml.resteCmd}</b>
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {cmdFiltered.length === 0 && <p className="text-xs text-gray-400 text-center py-4">Aucune commande trouvée</p>}
                </div>

                {/* Alerte absorption totale */}
                {absorptionWarning && (
                  <div className="mt-2 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />
                    <p className="text-[10px] text-amber-700">
                      <strong>Attention :</strong> cette commande absorberait tout le BE pour{' '}
                      {absorptionWarning.map(r => <span key={r} className="font-mono font-bold">{r}</span>).reduce((a, b) => <>{a}, {b}</>)}.
                      {' '}D'autres commandes attendent aussi ces références.
                    </p>
                  </div>
                )}

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

        {/* Factures liées */}
        <Card className="border-purple-100">
          <CardContent className="pt-4 pb-4">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide flex items-center gap-1.5 mb-3">
              <FileText className="w-3.5 h-3.5 text-purple-500" /> Facture(s) liée(s) ({factures.length})
            </p>
            {factures.length === 0 ? (
              <p className="text-xs text-gray-400 italic">Aucune facture liée</p>
            ) : (
              <div className="space-y-1">
                {factures.map(f => (
                  <Link key={f.id} href={`/factures/${f.id}`}
                    className="flex items-center justify-between px-2 py-1.5 rounded-lg hover:bg-purple-50 transition-colors">
                    <span className="text-sm font-medium text-purple-700">{f.numero_facture}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono text-gray-500">{formatEur(f.total_ht)}</span>
                      <span className={cn('text-xs font-medium', f.taux_rapprochement === 100 ? 'text-emerald-600' : 'text-amber-600')}>
                        {f.taux_rapprochement}%
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Contacts fournisseur */}
      <Card className="border-emerald-100">
        <CardContent className="pt-4 pb-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide flex items-center gap-1.5">
              <Mail className="w-3.5 h-3.5 text-emerald-500" /> Contacts fournisseur ({contacts.length})
            </p>
            <Button size="sm" variant="outline" className="h-6 text-xs" onClick={() => setShowAddContact(v => !v)}>
              <UserPlus className="w-3 h-3 mr-1" /> Ajouter
            </Button>
          </div>

          {contacts.length === 0 && !showAddContact && (
            <p className="text-xs text-gray-400 italic">Aucun contact enregistré</p>
          )}

          <div className="space-y-1">
            {contacts.map(c => (
              <div key={c.id} className="flex items-center justify-between group px-2 py-1.5 rounded-lg hover:bg-emerald-50 transition-colors">
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium text-gray-800">{c.nom ?? c.email}</span>
                  {c.nom && <span className="text-xs text-gray-400 ml-2">{c.email}</span>}
                  {c.role && <span className="ml-2 text-xs text-emerald-600 bg-emerald-50 border border-emerald-100 rounded-full px-1.5 py-0.5">{c.role}</span>}
                </div>
                <button
                  onClick={() => deleteContactMutation.mutate(c.id)}
                  className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-red-50 text-gray-300 hover:text-red-500 transition-all"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>

          {showAddContact && (
            <div className="mt-3 border-t pt-3 space-y-2">
              <input
                placeholder="Email *"
                value={newContact.email}
                onChange={e => setNewContact(v => ({ ...v, email: e.target.value }))}
                className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
              <input
                placeholder="Nom"
                value={newContact.nom}
                onChange={e => setNewContact(v => ({ ...v, nom: e.target.value }))}
                className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
              <input
                placeholder="Rôle (ex: comptabilité, commercial)"
                value={newContact.role}
                onChange={e => setNewContact(v => ({ ...v, role: e.target.value }))}
                className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setShowAddContact(false)}>Annuler</Button>
                <Button size="sm" className="h-7 text-xs bg-emerald-600 hover:bg-emerald-700"
                  disabled={!newContact.email || addContactMutation.isPending}
                  onClick={() => addContactMutation.mutate()}>
                  Enregistrer
                </Button>
              </div>
            </div>
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

      {/* Rapprochement ② BL papier ↔ ③ saisie Centralink (pointage log) */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <RefreshCw className="w-4 h-4 text-indigo-600" />
            Rapprochement saisie Centralink (③ pointage log)
            {rappCl.hasCl && (() => {
              const nbReg = rappCl.rows.filter(r => {
                const p = r.papier ?? 0, c = r.cl ?? 0;
                if (!(Math.abs(r.ecart) > 0.001) || p <= c) return false;
                const reg = regulByRef.get(normalizeRef(r.ref));
                return !!reg && (reg.regule + reg.avoir) >= (p - c) - 0.001;
              }).length;
              const aTraiter = rappCl.nbEcarts - nbReg;
              return (
                <span className={cn('ml-1 text-xs px-2 py-0.5 rounded-full font-medium',
                  aTraiter === 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700')}>
                  {rappCl.nbEcarts === 0 ? 'pointage conforme'
                    : aTraiter === 0 ? `${rappCl.nbEcarts} écart(s) — tous régularisés`
                    : `${aTraiter} écart(s) de pointage${nbReg > 0 ? ` · ${nbReg} régularisé(s)` : ''}`}
                </span>
              );
            })()}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {!rappCl.hasCl ? (
            <p className="px-4 py-3 text-sm text-gray-500">
              Aucune saisie Centralink en base pour ce BE ({be?.numero_be}). Lance le chargement des saisies CL pour activer le rapprochement.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50/50 border-y border-gray-100">
                    <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500">Réf.</th>
                    <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-500">② BL papier</th>
                    <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-500" title="Saisie de la log sous CE BE">③ saisie CL</th>
                    <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-500">Écart</th>
                    <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500">Verdict</th>
                    <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500">Suivi</th>
                  </tr>
                </thead>
                <tbody>
                  {rappCl.rows.map(r => {
                    const ko = Math.abs(r.ecart) > 0.001;
                    // Écart ② > ③ couvert par une régule « Surplus … » et/ou un avoir ?
                    const pp = r.papier ?? 0, cc = r.cl ?? 0;
                    const reg = ko && pp > cc ? regulByRef.get(normalizeRef(r.ref)) : undefined;
                    const couvert = reg ? reg.regule + reg.avoir : 0;
                    const regularise = !!reg && (pp - cc) > 0.001 && couvert >= (pp - cc) - 0.001;
                    return (
                      <tr key={r.ref} className={cn('border-b border-gray-50', ko && (regularise ? 'bg-emerald-50/40' : 'bg-amber-50/40'))}>
                        <td className="px-4 py-2 font-mono text-xs">{r.ref}</td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          {r.papier ?? '—'}
                          {r.facteur > 1 && r.papier != null && (
                            <span className="text-[11px] text-gray-400"> ×{r.facteur} = {r.papier * r.facteur}</span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">{r.cl ?? '—'}</td>
                        <td className={cn('px-4 py-2 text-right font-semibold tabular-nums', ko ? 'text-amber-700' : 'text-gray-300')}>
                          {ko ? (r.ecart > 0 ? `+${r.ecart}` : r.ecart) : '0'}
                        </td>
                        <td className="px-4 py-2 text-xs">
                          {(() => {
                            const p = r.papier ?? 0, c = r.cl ?? 0;
                            // Conforme (ou réconcilié par conditionnement / saisi ailleurs)
                            if (!ko) return r.saisiAilleurs
                              ? <span className="text-gray-500">✓ saisi sous un autre BE</span>
                              : <span className="text-emerald-600">✓ conforme</span>;
                            // ③ existe mais rien au BL papier
                            if (r.papier == null) return <span className="text-blue-600">🔵 saisi mais absent du BL papier</span>;
                            // ③ > ② : la log a saisi plus que ce BL n'a livré → doublon / sur-saisie
                            if (c > p) {
                              // Distingue : doublon (1 commande, ③ = ×N de ②) vs mauvais dispatching (plusieurs commandes empilées)
                              const cmds = saisieCmdByRef.get(normalizeRef(r.ref));
                              const liste = cmds ? [...cmds.keys()].filter(x => x !== '?') : [];
                              if (liste.length >= 2)
                                return <span className="text-red-600">🔴 Mauvais dispatching — {c - p} de trop <span className="text-red-400">(livraisons de {liste.join('/')} empilées ici ; BL {p}, saisi {c})</span></span>;
                              const doublon = p > 0 && Number.isInteger(c / p) && c / p >= 2;
                              return <span className="text-red-600">🔴 {doublon ? `Doublon (saisi ×${c / p})` : 'Sur-saisie log'} — {c - p} de trop <span className="text-red-400">(BL {p}, saisi {c})</span></span>;
                            }
                            // ② > ③ : la log a saisi moins que le BL papier → oubli sur CE BE.
                            // MAIS si ce manque est déjà régularisé ailleurs (commande « Surplus … » ou
                            // avoir), ce n'est pas un oubli à investiguer : le surplus a été gardé/rendu.
                            const manque = p - c;
                            if (regularise) {
                              const via = [
                                reg!.regule > 0 ? `régule${reg!.numeros.length ? ' ' + reg!.numeros.join('/') : ''}` : null,
                                reg!.avoir > 0 ? `avoir ${reg!.avoir}` : null,
                              ].filter(Boolean).join(' + ');
                              return <span className="text-emerald-600">✅ Régularisé — {manque} gardé(s)/rendu(s) via {via} <span className="text-emerald-500">(BL {p} / saisi {c} ; non saisi sous ce BE mais soldé ailleurs)</span></span>;
                            }
                            if (reg && couvert > 0.001) {
                              const reste = manque - couvert;
                              return <span className="text-amber-700">🟠 Partiellement régularisé — {couvert} via régule{reg.numeros.length ? ' ' + reg.numeros.join('/') : ''}/avoir, reste {reste.toFixed(0)} non saisi(s) <span className="text-amber-500">(BL {p} / saisi {c})</span></span>;
                            }
                            return <span className="text-amber-700">🟠 Oubli — {manque} non saisi(s) sur ce BE <span className="text-amber-500">(BL {p} / saisi {c})</span></span>;
                          })()}
                          {ko && (() => {
                            const cands = dispatchByRef.get(normalizeRef(r.ref)) ?? [];
                            if (!cands.length) return null;
                            const coupables = cands.filter(x => x.over != null && x.over > 0.001);
                            const autres = cands.filter(x => !(x.over != null && x.over > 0.001));
                            return (
                              <div className="mt-1 text-[11px] space-y-0.5">
                                {coupables.length > 0 && (() => {
                                  const moisDe = (s: string | null | undefined) => { const m = String(s ?? '').toUpperCase().match(/BE-?(\d{2})-?(\d{2})/); return m ? m[1] + m[2] : ''; };
                                  const ceMois = moisDe(be?.numero_be);
                                  return (
                                    <div className="text-amber-700">
                                      ⚠ Piste à vérifier — aussi sur-saisi (sans papier) sous{' '}
                                      {coupables.slice(0, 3).map((x, i) => {
                                        const meme = !!ceMois && moisDe(x.numBe) === ceMois;
                                        return <span key={x.numBe}>{i > 0 && ', '}<span className="font-mono">{x.numBe}</span> <span className="text-amber-400">(+{x.over}{meme ? ', même période ⇒ lien probable' : ''})</span></span>;
                                      })}
                                      <span className="text-gray-400"> — à confirmer (la log peut s&apos;être trompée de n° de BE)</span>
                                    </div>
                                  );
                                })()}
                                {autres.length > 0 && (
                                  <div className="text-gray-400">
                                    aussi sous{' '}
                                    {autres.slice(0, 3).map((x, i) => (
                                      <span key={x.numBe}>{i > 0 && ', '}<span className="font-mono">{x.numBe}</span> ({x.saisie}{x.scanned ? ' = son papier' : ' · non scanné'})</span>
                                    ))}
                                    {autres.length > 3 && <span> +{autres.length - 3}</span>}
                                  </div>
                                )}
                              </div>
                            );
                          })()}
                        </td>
                        <td className="px-4 py-2">
                          {ko && (
                            <div className="flex items-center gap-1.5">
                              <select
                                value={r.statut}
                                onChange={e => saveResolution.mutate({ reference_article: r.ref, statut: e.target.value })}
                                className={cn('text-xs border rounded px-1.5 py-1 bg-white',
                                  r.statut === 'à analyser' ? 'border-red-200 text-red-700' : 'border-emerald-200 text-emerald-700')}
                              >
                                {['à analyser', 'vérifié', 'corrigé', 'accepté', 'ignoré'].map(s => <option key={s} value={s}>{s}</option>)}
                              </select>
                              <input
                                defaultValue={r.note ?? ''}
                                placeholder="note…"
                                onBlur={e => { const v = e.target.value || null; if (v !== (r.note ?? null)) saveResolution.mutate({ reference_article: r.ref, note: v }); }}
                                className="text-xs border border-gray-200 rounded px-1.5 py-1 w-28"
                              />
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="px-4 py-2.5 text-xs text-gray-400 border-t border-gray-100">
                ② = ce que tu as scanné (BL papier Colombi). ③ = ce que la log a saisi dans Centralink. Un écart = erreur de pointage interne (à corriger côté Centralink), sans impact sur la facturation Colombi.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Lignes BE */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Lignes du BE ({lignes.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50/50 border-y border-gray-100">
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500">#</th>
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500">Réf.</th>
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500">Désignation</th>
                  <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-500">Qté reçue ✎</th>
                  <th className="text-left px-2 py-2.5 text-xs font-semibold text-gray-500">Écart</th>
                  <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-500">Qté facturée</th>
                  <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-500">Reste à facturer</th>
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500">Attribution</th>
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500">Statut</th>
                  <th className="px-4 py-2.5 text-center text-xs font-semibold text-gray-500">Note</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {[...lignes].sort((a, b) => (a.reference_article ?? '').localeCompare(b.reference_article ?? '')).map((l, idx, arr) => {
                  const isLibre = !l.ligne_commande_id && !l.hors_systeme;
                  const prevRef = idx > 0 ? arr[idx - 1].reference_article : null;
                  const isFirstOfRef = l.reference_article !== prevRef;
                  return (
                  <tr key={l.id} className={cn('hover:bg-gray-50/50', l.hors_systeme ? 'opacity-40' : isLibre ? 'opacity-60' : '', isFirstOfRef && idx > 0 ? 'border-t-2 border-gray-100' : '')}>
                    <td className="px-4 py-2.5 text-xs text-gray-400">{l.ligne_no}</td>
                    <td className="px-4 py-2.5 font-mono text-xs font-medium">{l.reference_article}</td>
                    <td className="px-4 py-2.5 text-xs text-gray-600 max-w-[200px] truncate">{l.designation}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs">
                      {editingQteRecu?.id === l.id ? (
                        <Input
                          type="number"
                          value={editingQteRecu.value}
                          onChange={e => setEditingQteRecu({ id: l.id, value: e.target.value })}
                          className="h-6 w-20 text-xs text-right font-mono ml-auto"
                          autoFocus
                          onKeyDown={e => {
                            if (e.key === 'Escape') { setEditingQteRecu(null); return; }
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              const qte = parseFloat(editingQteRecu.value);
                              if (!isNaN(qte) && qte >= 0) {
                                saveQteRecuMutation.mutate({ ligneBeId: l.id, quantiteReceptionnee: qte });
                                const idx = lignes.findIndex(x => x.id === l.id);
                                const next = lignes[idx + 1];
                                if (next) setEditingQteRecu({ id: next.id, value: String(next.quantite_receptionnee ?? 0) });
                              }
                            }
                          }}
                          onBlur={() => {
                            const qte = parseFloat(editingQteRecu.value);
                            if (!isNaN(qte) && qte >= 0) {
                              saveQteRecuMutation.mutate({ ligneBeId: l.id, quantiteReceptionnee: qte });
                            } else {
                              setEditingQteRecu(null);
                            }
                          }}
                        />
                      ) : (
                        <button
                          onClick={() => setEditingQteRecu({ id: l.id, value: String(l.quantite_receptionnee ?? 0) })}
                          className="group/qte flex items-center justify-end gap-1 w-full hover:text-indigo-600"
                        >
                          <span>{l.quantite_receptionnee}</span>
                          <Edit2 className="w-3 h-3 opacity-0 group-hover/qte:opacity-100 text-indigo-400 shrink-0" />
                        </button>
                      )}
                    </td>
                    <td className="px-2 py-2.5 text-left">
                      {l.quantite_document_be != null && l.quantite_document_be !== l.quantite_receptionnee && (
                        <span className="inline-flex items-center gap-0.5 rounded-full border border-orange-200 bg-orange-50 px-1.5 py-0.5 text-xs font-mono font-medium text-orange-700">
                          <AlertTriangle className="w-3 h-3 shrink-0" />
                          doc={l.quantite_document_be}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs">
                      <span className={cn(l.quantite_facturee > l.quantite_receptionnee ? 'text-red-600' : 'text-gray-700')}>
                        {l.quantite_facturee}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs">
                      <span className={cn(l.quantite_restante_a_facturer > 0 ? 'text-amber-600' : 'text-emerald-600')}>
                        {l.quantite_restante_a_facturer}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      {l.ligne_commande_id ? (
                        <span className="inline-flex items-center rounded-full bg-indigo-50 border border-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-700">
                          Attribué
                        </span>
                      ) : l.statut_retour ? (
                        <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium', {
                          'bg-orange-50 border-orange-200 text-orange-700': l.statut_retour === 'a_retourner',
                          'bg-blue-50 border-blue-200 text-blue-700':       l.statut_retour === 'retourne',
                          'bg-violet-50 border-violet-200 text-violet-700': l.statut_retour === 'avoir_demande',
                          'bg-emerald-50 border-emerald-200 text-emerald-700': l.statut_retour === 'avoir_recu',
                        })}>
                          {{ a_retourner: 'À retourner', retourne: 'Retourné', avoir_demande: 'Avoir demandé', avoir_recu: 'Avoir reçu ✓' }[l.statut_retour]}
                        </span>
                      ) : l.hors_systeme ? (
                        <div className="flex items-center gap-1 group/hs">
                          <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 border border-gray-200 px-2 py-0.5 text-xs font-medium text-gray-400">
                            <Ban className="w-3 h-3" /> Hors système
                          </span>
                          <button
                            onClick={() => toggleHorsSystemeMutation.mutate({ ligneId: l.id, value: false })}
                            className="opacity-0 group-hover/hs:opacity-100 p-0.5 rounded hover:bg-gray-100 text-gray-300 hover:text-gray-600 transition-all"
                            title="Réintégrer dans le suivi"
                          >
                            <RotateCcw className="w-3 h-3" />
                          </button>
                        </div>
                      ) : splitSavModal?.ligneId === l.id ? (
                        <div className="flex items-center gap-1">
                          <span className="text-xs text-gray-500 mr-1">SAV qté</span>
                          <Input
                            type="number"
                            value={splitSavModal.qteSav}
                            onChange={e => setSplitSavModal({ ...splitSavModal, qteSav: e.target.value })}
                            className="h-6 w-16 text-xs text-right font-mono"
                            autoFocus
                            onKeyDown={e => {
                              if (e.key === 'Escape') { setSplitSavModal(null); return; }
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                const qte = parseInt(splitSavModal.qteSav, 10);
                                if (!isNaN(qte) && qte > 0) splitSavMutation.mutate({ ligneId: l.id, qteSav: qte });
                              }
                            }}
                          />
                          <button
                            onClick={() => {
                              const qte = parseInt(splitSavModal.qteSav, 10);
                              if (!isNaN(qte) && qte > 0) splitSavMutation.mutate({ ligneId: l.id, qteSav: qte });
                            }}
                            className="text-emerald-500 hover:text-emerald-700"
                            title="Valider"
                          ><Save className="w-3 h-3" /></button>
                          <button
                            onClick={() => setSplitSavModal(null)}
                            className="text-gray-400 hover:text-gray-600"
                            title="Annuler"
                          ><X className="w-3 h-3" /></button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1 group/libre">
                          <span className="inline-flex items-center rounded-full bg-gray-50 border border-gray-200 px-2 py-0.5 text-xs font-medium text-gray-400">
                            Libre
                          </span>
                          <button
                            onClick={() => setSplitSavModal({ ligneId: l.id, ref: l.reference_article, qteActuelle: l.quantite_receptionnee ?? 0, qteSav: '' })}
                            className="opacity-0 group-hover/libre:opacity-100 p-0.5 rounded hover:bg-violet-50 text-gray-300 hover:text-violet-600 transition-all"
                            title="Scinder une partie en SAV (hors système)"
                          >
                            <Scissors className="w-3 h-3" />
                          </button>
                          <button
                            onClick={() => toggleHorsSystemeMutation.mutate({ ligneId: l.id, value: true })}
                            className="opacity-0 group-hover/libre:opacity-100 p-0.5 rounded hover:bg-amber-50 text-gray-300 hover:text-amber-600 transition-all"
                            title="Marquer toute la ligne comme reçue hors système"
                          >
                            <Ban className="w-3 h-3" />
                          </button>
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2.5"><StatusBadge status={l.statut_ligne_be} /></td>
                    <td className="px-4 py-2.5 text-center">
                      <div className="flex items-center justify-center gap-1 group/note">
                        {editingLineNotes?.id === l.id ? (
                          <>
                            <Input value={editingLineNotes.value} onChange={e => setEditingLineNotes({ id: l.id, value: e.target.value })} className="h-6 text-xs" autoFocus />
                            <button onClick={() => saveLineNotesMutation.mutate({ lineId: l.id, comment: editingLineNotes.value })} className="text-emerald-500"><Save className="w-3 h-3" /></button>
                            <button onClick={() => setEditingLineNotes(null)} className="text-gray-400"><X className="w-3 h-3" /></button>
                          </>
                        ) : (
                          <>
                            <button onClick={() => setEditingLineNotes({ id: l.id, value: l.commentaire ?? '' })} className="p-1 rounded hover:bg-gray-100" title={l.commentaire ?? ''}>
                              <MessageSquare className={cn('w-3.5 h-3.5', l.commentaire ? 'text-indigo-500 fill-indigo-100' : 'text-gray-300')} />
                            </button>
                            <button
                              onClick={() => {
                                if (confirm(`Supprimer la ligne ${l.reference_article} (${l.quantite_receptionnee} u.) ?\nLes balances de la commande liée seront recalculées.`)) {
                                  deleteLigneMutation.mutate(l.id);
                                }
                              }}
                              disabled={deleteLigneMutation.isPending}
                              className="opacity-0 group-hover/note:opacity-100 p-1 rounded hover:bg-red-50 text-gray-300 hover:text-red-500 transition-all disabled:opacity-50"
                              title="Supprimer cette ligne (ligne fantôme, doublon, etc.)"
                            >
                              <Trash2 className="w-3 h-3" />
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
            {lignes.length === 0 && <p className="text-xs text-gray-400 text-center py-10">Aucune ligne</p>}
          </div>
        </CardContent>
      </Card>

      {/* Panneau d'arbitrage du surplus */}
      {lignesAArbitrer.length > 0 && (
        <Card className="border-amber-200 bg-amber-50/30">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2 text-amber-800">
              <AlertTriangle className="w-4 h-4" />
              {lignesAArbitrer.length} ligne{lignesAArbitrer.length > 1 ? 's' : ''} à arbitrer
              <span className="text-xs font-normal text-amber-700">— surplus reçu sans commande associée</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-1">
            <p className="text-xs text-amber-700 mb-2">
              Pour chaque ligne : <strong>retourner au fournisseur</strong>, <strong>créer une commande complément</strong> (pour garder), ou marquer <strong>hors système</strong> (SAV).
            </p>
            <div className="space-y-2">
              {lignesAArbitrer.map(l => (
                <div key={l.id} className="flex items-center gap-2 rounded-lg border border-amber-200 bg-white p-2.5 flex-wrap">
                  <div className="flex-1 min-w-[200px]">
                    <p className="text-xs font-mono font-semibold text-gray-800">{l.reference_article}</p>
                    <p className="text-xs text-gray-500 truncate">{l.designation}</p>
                  </div>
                  <span className="text-sm font-mono font-bold text-amber-700 px-2 py-0.5 rounded bg-amber-100">
                    {l.quantite_receptionnee} u.
                  </span>
                  <button
                    onClick={() => setRetourModal({ ligneId: l.id, ref: l.reference_article, qte: l.quantite_receptionnee ?? 0, motif: 'Quantité excessive' })}
                    className="inline-flex items-center gap-1 rounded-md border border-orange-300 bg-white px-2 py-1 text-xs font-medium text-orange-700 hover:bg-orange-50"
                  >
                    <Send className="w-3 h-3" /> À retourner
                  </button>
                  <button
                    onClick={() => creerCmdComplementMutation.mutate(l.id)}
                    disabled={creerCmdComplementMutation.isPending}
                    className="inline-flex items-center gap-1 rounded-md border border-indigo-300 bg-white px-2 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-50 disabled:opacity-50"
                  >
                    <Plus className="w-3 h-3" /> Créer commande
                  </button>
                  <button
                    onClick={() => toggleHorsSystemeMutation.mutate({ ligneId: l.id, value: true })}
                    className="inline-flex items-center gap-1 rounded-md border border-gray-300 bg-white px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50"
                  >
                    <Ban className="w-3 h-3" /> Hors système
                  </button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Modal "À retourner" */}
      {retourModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md flex flex-col gap-4 p-6">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
                <Send className="w-4 h-4 text-orange-500" /> Marquer à retourner
              </h2>
              <button onClick={() => setRetourModal(null)} className="p-1.5 rounded hover:bg-gray-100 text-gray-400">
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs text-gray-500">
              Réf. <span className="font-mono font-semibold text-gray-800">{retourModal.ref}</span> — <span className="font-semibold">{retourModal.qte} u.</span>
            </p>
            <div>
              <label className="text-xs font-medium text-gray-500 mb-1 block">Motif</label>
              <select
                value={retourModal.motif}
                onChange={e => setRetourModal({ ...retourModal, motif: e.target.value })}
                className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-orange-400"
              >
                <option>Quantité excessive</option>
                <option>Marchandise non commandée</option>
                <option>Erreur de livraison</option>
                <option>Marchandise endommagée</option>
                <option>Non-conformité</option>
                <option>Autre</option>
              </select>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => setRetourModal(null)}
                className="px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100 rounded-lg"
              >
                Annuler
              </button>
              <button
                onClick={() => marquerRetourMutation.mutate({ ligneId: retourModal.ligneId, motif: retourModal.motif })}
                disabled={marquerRetourMutation.isPending}
                className="inline-flex items-center gap-1.5 rounded-lg bg-orange-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-orange-700 disabled:opacity-50"
              >
                <Send className="w-3.5 h-3.5" /> Marquer à retourner
              </button>
            </div>
          </div>
        </div>
      )}

      <PDFViewerPanel url={be.pdf_url} open={showPDF} onClose={() => setShowPDF(false)} title={`BE ${be.numero_be}`} />

      {/* Modal envoi email avoir */}
      {showEmailModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg flex flex-col gap-4 p-6">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
                <Mail className="w-4 h-4 text-orange-500" /> Demande d'avoir — {be.numero_be}
              </h2>
              <button onClick={() => setShowEmailModal(false)} className="p-1.5 rounded hover:bg-gray-100 text-gray-400">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="text-xs font-medium text-gray-500 mb-1 block">Destinataire</label>
                <div className="flex gap-2">
                  <select
                    value={emailDraft.to}
                    onChange={e => setEmailDraft(v => ({ ...v, to: e.target.value }))}
                    className="flex-1 border border-gray-200 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-orange-500"
                  >
                    <option value="">— Sélectionner un contact —</option>
                    {contacts.map(c => (
                      <option key={c.id} value={c.email}>{c.nom ? `${c.nom} <${c.email}>` : c.email}{c.role ? ` (${c.role})` : ''}</option>
                    ))}
                  </select>
                  <input
                    placeholder="ou email libre"
                    value={contacts.some(c => c.email === emailDraft.to) ? '' : emailDraft.to}
                    onChange={e => setEmailDraft(v => ({ ...v, to: e.target.value }))}
                    className="flex-1 border border-gray-200 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-orange-500"
                  />
                </div>
                {emailDraft.to && <p className="text-xs text-gray-400 mt-1">→ {emailDraft.to}</p>}
              </div>

              <div>
                <label className="text-xs font-medium text-gray-500 mb-1 block">Objet</label>
                <input
                  value={emailDraft.subject}
                  onChange={e => setEmailDraft(v => ({ ...v, subject: e.target.value }))}
                  className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-orange-500"
                />
              </div>

              <div>
                <label className="text-xs font-medium text-gray-500 mb-1 block">Corps du message</label>
                <textarea
                  value={emailDraft.body}
                  onChange={e => setEmailDraft(v => ({ ...v, body: e.target.value }))}
                  rows={10}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-xs font-mono resize-none focus:outline-none focus:ring-2 focus:ring-orange-500"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 border-t pt-3">
              <Button variant="ghost" size="sm" onClick={() => setShowEmailModal(false)}>Annuler</Button>
              <Button
                size="sm"
                className="bg-orange-600 hover:bg-orange-700"
                disabled={!emailDraft.to || !emailDraft.subject || sendEmailMutation.isPending}
                onClick={() => sendEmailMutation.mutate()}
              >
                <Send className="w-3.5 h-3.5 mr-1.5" />
                {sendEmailMutation.isPending ? 'Envoi…' : 'Envoyer'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
