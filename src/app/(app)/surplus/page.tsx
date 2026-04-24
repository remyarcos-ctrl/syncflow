'use client';

import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import Link from 'next/link';
import PageHeader from '@/components/shared/PageHeader';
import { formatDate, cn } from '@/utils';
import {
  PackageOpen, ChevronRight, AlertTriangle, RotateCcw,
  CheckCircle2, X, Mail,
} from 'lucide-react';
import { toast } from 'sonner';

interface LigneLibre {
  id: string;
  be_id: string;
  reference_article: string | null;
  designation: string | null;
  quantite_receptionnee: number;
  quantite_document_be: number | null;
  statut_retour: string | null;
  motif_retour: string | null;
}

interface BEInfo {
  id: string;
  numero_be: string;
  fournisseur: string | null;
  date_bl: string | null;
}

interface Contact {
  id: string;
  nom: string | null;
  email: string;
  role: string | null;
}

const STATUT_CFG: Record<string, {
  label: string; badge: string;
  nextStatut: string | null; nextLabel: string | null;
}> = {
  a_retourner:  { label: 'À retourner',    badge: 'bg-orange-50 border-orange-200 text-orange-700', nextStatut: 'retourne',      nextLabel: 'Marquer retourné' },
  retourne:     { label: 'Retourné',        badge: 'bg-blue-50 border-blue-200 text-blue-700',       nextStatut: 'avoir_demande', nextLabel: 'Demander l\'avoir' },
  avoir_demande:{ label: 'Avoir demandé',   badge: 'bg-violet-50 border-violet-200 text-violet-700', nextStatut: 'avoir_recu',   nextLabel: 'Avoir reçu' },
  avoir_recu:   { label: 'Avoir reçu ✓',   badge: 'bg-emerald-50 border-emerald-200 text-emerald-700', nextStatut: null,        nextLabel: null },
};

const MOTIFS = [
  'Marchandise non commandée',
  'Quantité excessive',
  'Erreur de livraison',
  'Marchandise endommagée',
  'Non-conformité',
  'Autre',
];

export default function SurplusPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'libres' | 'retours'>('libres');

  // Modal retour (initier)
  const [retourModal, setRetourModal] = useState<{ ligne: LigneLibre; be: BEInfo } | null>(null);
  const [motif, setMotif] = useState('');
  const [sendEmailFlag, setSendEmailFlag] = useState(true);
  const [emailTo, setEmailTo] = useState('');
  const [emailSubject, setEmailSubject] = useState('');
  const [emailBody, setEmailBody] = useState('');

  // Modal avoir reçu
  const [avoirModal, setAvoirModal] = useState<{ ligneBeId: string; be: BEInfo } | null>(null);
  const [avoirFactureId, setAvoirFactureId] = useState('');

  // ── Données ───────────────────────────────────────────────────────────────
  const { data: lignesLibres = [] } = useQuery<LigneLibre[]>({
    queryKey: ['lignes_libres'],
    queryFn: async () => {
      const { data } = await supabase
        .from('lignes_be')
        .select('id, be_id, reference_article, designation, quantite_receptionnee, quantite_document_be, statut_retour, motif_retour')
        .is('ligne_commande_id', null)
        .gt('quantite_receptionnee', 0);
      return data ?? [];
    },
    refetchInterval: 10000,
  });

  const beIds = useMemo(() => [...new Set(lignesLibres.map(l => l.be_id))], [lignesLibres]);

  const { data: bes = [] } = useQuery<BEInfo[]>({
    queryKey: ['bes_surplus', beIds.join()],
    queryFn: async () => {
      if (!beIds.length) return [];
      const { data } = await supabase
        .from('be_receptions')
        .select('id, numero_be, fournisseur, date_bl')
        .in('id', beIds)
        .not('numero_be', 'like', 'INIT-%');
      return data ?? [];
    },
    enabled: beIds.length > 0,
  });

  // BE ids ayant au moins une liaison commande → surplus confirmé
  const { data: besLiesIds = [] } = useQuery<string[]>({
    queryKey: ['bes_lies_ids', beIds.join()],
    queryFn: async () => {
      if (!beIds.length) return [];
      const { data } = await supabase
        .from('liaison_be_commande')
        .select('be_id')
        .in('be_id', beIds);
      return [...new Set((data ?? []).map(r => r.be_id))];
    },
    enabled: beIds.length > 0,
    refetchInterval: 10000,
  });

  const { data: contacts = [] } = useQuery<Contact[]>({
    queryKey: ['contacts_retour', retourModal?.be.fournisseur],
    queryFn: async () => {
      const r = await fetch(`/api/contacts-fournisseurs?fournisseur=${encodeURIComponent(retourModal!.be.fournisseur ?? '')}`);
      const json = await r.json();
      return Array.isArray(json) ? json : [];
    },
    enabled: !!retourModal,
  });

  const { data: facturesAvoir = [] } = useQuery<{ id: string; numero_facture: string; date_facture: string | null; total_ht: number | null }[]>({
    queryKey: ['factures_avoir', avoirModal?.be.fournisseur],
    queryFn: async () => {
      const { data } = await supabase
        .from('factures')
        .select('id, numero_facture, date_facture, total_ht')
        .eq('fournisseur', avoirModal!.be.fournisseur ?? '')
        .order('date_facture', { ascending: false })
        .limit(50);
      return data ?? [];
    },
    enabled: !!avoirModal,
  });

  // ── Computed ──────────────────────────────────────────────────────────────
  const besLiesSet = useMemo(() => new Set(besLiesIds), [besLiesIds]);

  // Lignes de BEs liés à une commande (surplus confirmé)
  const lignesConfirmees = useMemo(() => lignesLibres.filter(l => besLiesSet.has(l.be_id)), [lignesLibres, besLiesSet]);
  // BEs sans aucune liaison commande (potentiel oubli d'import)
  const besNonLies = useMemo(() => bes.filter(be => !besLiesSet.has(be.id)), [bes, besLiesSet]);

  const lignesSansAction = useMemo(() => lignesConfirmees.filter(l => !l.statut_retour), [lignesConfirmees]);
  const lignesEnRetour   = useMemo(() => lignesConfirmees.filter(l => !!l.statut_retour), [lignesConfirmees]);
  const retoursEnAttente = useMemo(() => lignesEnRetour.filter(l => l.statut_retour !== 'avoir_recu').length, [lignesEnRetour]);

  const groupesSansAction = useMemo(() => bes
    .filter(be => besLiesSet.has(be.id))
    .map(be => {
      const lignes = lignesSansAction.filter(l => l.be_id === be.id);
      const total = lignes.reduce((s, l) => s + l.quantite_receptionnee, 0);
      return { be, lignes, total };
    })
    .filter(g => g.lignes.length > 0)
    .sort((a, b) => (b.be.date_bl ?? '').localeCompare(a.be.date_bl ?? '')),
    [bes, besLiesSet, lignesSansAction]);

  const groupesRetours = useMemo(() => bes
    .filter(be => besLiesSet.has(be.id))
    .map(be => ({ be, lignes: lignesEnRetour.filter(l => l.be_id === be.id) }))
    .filter(g => g.lignes.length > 0)
    .sort((a, b) => (b.be.date_bl ?? '').localeCompare(a.be.date_bl ?? '')),
    [bes, besLiesSet, lignesEnRetour]);

  const groupesNonLies = useMemo(() => besNonLies
    .map(be => {
      const lignes = lignesLibres.filter(l => l.be_id === be.id);
      const total = lignes.reduce((s, l) => s + l.quantite_receptionnee, 0);
      return { be, lignes, total };
    })
    .filter(g => g.lignes.length > 0)
    .sort((a, b) => (b.be.date_bl ?? '').localeCompare(a.be.date_bl ?? '')),
    [besNonLies, lignesLibres]);

  // ── Ouverture modal ────────────────────────────────────────────────────────
  const openRetourModal = (ligne: LigneLibre, be: BEInfo) => {
    const subject = `Retour marchandise — BE ${be.numero_be}`;
    const body = [
      'Madame, Monsieur,',
      '',
      `Nous vous informons que nous retournons les marchandises suivantes reçues avec le bon d'entrée N°${be.numero_be} du ${formatDate(be.date_bl)} :`,
      '',
      `  - Réf. ${ligne.reference_article ?? '—'} (${ligne.designation ?? ''}) : ${ligne.quantite_receptionnee} unité(s)`,
      '',
      'Ces articles n\'étaient pas commandés / ont été livrés en excès.',
      'Nous vous remercions de bien vouloir établir un avoir correspondant dans les meilleurs délais.',
      '',
      'Cordialement',
    ].join('\n');

    setMotif('');
    setSendEmailFlag(true);
    setEmailTo('');
    setEmailSubject(subject);
    setEmailBody(body);
    setRetourModal({ ligne, be });
  };

  // ── Mutations ─────────────────────────────────────────────────────────────
  const initRetourMutation = useMutation({
    mutationFn: async () => {
      const r = await fetch('/api/retour-fournisseur', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ligneBeId: retourModal!.ligne.id,
          motif,
          sendEmailFlag: sendEmailFlag && !!emailTo,
          emailTo,
          emailSubject,
          emailBody,
        }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? 'Erreur');
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['lignes_libres'] });
      setRetourModal(null);
      toast.success('Retour initié' + (sendEmailFlag && emailTo ? ' — email envoyé au fournisseur' : ''));
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const progressMutation = useMutation({
    mutationFn: async ({ ligneBeId, statut, avoirFactureId }: { ligneBeId: string; statut: string; avoirFactureId?: string }) => {
      const r = await fetch('/api/retour-fournisseur', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ligneBeId, statut, avoirFactureId: avoirFactureId || null }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? 'Erreur');
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['lignes_libres'] });
      setAvoirModal(null);
      setAvoirFactureId('');
      toast.success('Statut mis à jour');
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const totalLibres = groupesSansAction.reduce((s, g) => s + g.lignes.length, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Surplus — Lignes non attribuées"
        subtitle={`${totalLibres} surplus confirmé${totalLibres !== 1 ? 's' : ''} · ${retoursEnAttente} retour${retoursEnAttente !== 1 ? 's' : ''} en attente · ${groupesNonLies.length} BE${groupesNonLies.length !== 1 ? 's' : ''} à vérifier`}
      />

      {/* ── Alerte BEs sans commande ────────────────────────────────────────── */}
      {groupesNonLies.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 space-y-3">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
            <p className="text-sm font-semibold text-amber-800">
              {groupesNonLies.length} BE{groupesNonLies.length > 1 ? 's' : ''} avec des lignes libres mais sans commande liée — commande manquante ou à importer ?
            </p>
          </div>
          <div className="space-y-2">
            {groupesNonLies.map(({ be, lignes, total }) => (
              <div key={be.id} className="flex items-center justify-between bg-white rounded-lg border border-amber-100 px-3 py-2">
                <div className="flex items-center gap-3">
                  <span className="font-mono font-semibold text-sm text-gray-900">{be.numero_be}</span>
                  <span className="text-sm text-gray-500">{be.fournisseur ?? '—'}</span>
                  <span className="text-xs text-gray-400">{formatDate(be.date_bl)}</span>
                  <span className="text-xs text-amber-600 font-medium">{lignes.length} ligne{lignes.length > 1 ? 's' : ''} · {total} u.</span>
                </div>
                <Link
                  href={`/be-receptions/${be.id}`}
                  className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 hover:text-amber-900 transition-colors"
                >
                  Ouvrir le BE <ChevronRight className="w-3.5 h-3.5" />
                </Link>
              </div>
            ))}
          </div>
          <p className="text-xs text-amber-600">
            Ces BEs ne font pas partie du surplus ci-dessous tant qu'une commande n'est pas liée. Si aucune commande ne correspond, liez le BE à une commande ou initiez un retour depuis le BE.
          </p>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-0 border-b border-gray-200">
        <button
          onClick={() => setTab('libres')}
          className={cn(
            'px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors',
            tab === 'libres'
              ? 'border-indigo-600 text-indigo-700'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          )}
        >
          Libres sans action
          {totalLibres > 0 && (
            <span className="ml-2 text-xs font-semibold bg-gray-100 text-gray-600 rounded-full px-1.5 py-0.5">
              {totalLibres}
            </span>
          )}
        </button>
        <button
          onClick={() => setTab('retours')}
          className={cn(
            'px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors',
            tab === 'retours'
              ? 'border-orange-500 text-orange-700'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          )}
        >
          Retours en cours
          {retoursEnAttente > 0 && (
            <span className="ml-2 text-xs font-semibold bg-orange-100 text-orange-700 rounded-full px-1.5 py-0.5">
              {retoursEnAttente}
            </span>
          )}
        </button>
      </div>

      {/* ── Onglet Libres ─────────────────────────────────────────────────────── */}
      {tab === 'libres' && (
        groupesSansAction.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-gray-400 gap-3">
            <PackageOpen className="w-10 h-10" />
            <p className="text-sm">Aucun surplus confirmé — tout est lié à une commande.</p>
            {groupesNonLies.length > 0 && (
              <p className="text-xs text-amber-600">{groupesNonLies.length} BE(s) sans commande liée à vérifier ci-dessus.</p>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {groupesSansAction.map(({ be, lignes, total }) => (
              <div key={be.id} className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
                <div className="flex items-center justify-between px-4 py-3 bg-gray-50/60 border-b border-gray-100">
                  <div className="flex items-center gap-3">
                    <span className="font-mono font-semibold text-sm text-gray-900">{be.numero_be}</span>
                    <span className="text-sm text-gray-500">{be.fournisseur ?? '—'}</span>
                    <span className="text-xs text-gray-400">{formatDate(be.date_bl)}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs font-semibold text-orange-600 bg-orange-50 border border-orange-100 rounded-full px-2.5 py-0.5">
                      {total} unité{total > 1 ? 's' : ''} libre{total > 1 ? 's' : ''}
                    </span>
                    <Link href={`/be-receptions/${be.id}`} className="p-1.5 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600">
                      <ChevronRight className="w-4 h-4" />
                    </Link>
                  </div>
                </div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-50">
                      <th className="text-left px-4 py-2 text-xs font-semibold text-gray-400">Réf.</th>
                      <th className="text-left px-4 py-2 text-xs font-semibold text-gray-400">Désignation</th>
                      <th className="text-right px-4 py-2 text-xs font-semibold text-gray-400">Qté</th>
                      <th className="text-left px-4 py-2 text-xs font-semibold text-gray-400">Écart doc</th>
                      <th className="px-4 py-2 text-xs font-semibold text-gray-400">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {lignes.map(l => {
                      const hasEcart = l.quantite_document_be != null && l.quantite_document_be !== l.quantite_receptionnee;
                      return (
                        <tr key={l.id} className="hover:bg-gray-50/50">
                          <td className="px-4 py-2.5 font-mono text-xs font-medium text-gray-800">{l.reference_article ?? '—'}</td>
                          <td className="px-4 py-2.5 text-xs text-gray-500 max-w-xs truncate">{l.designation ?? '—'}</td>
                          <td className="px-4 py-2.5 text-right font-mono text-xs font-semibold text-orange-600">{l.quantite_receptionnee}</td>
                          <td className="px-4 py-2.5">
                            {hasEcart && (
                              <span className="inline-flex items-center gap-1 text-xs font-mono text-orange-700 bg-orange-50 border border-orange-200 rounded-full px-1.5 py-0.5">
                                <AlertTriangle className="w-3 h-3" /> doc={l.quantite_document_be}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-2.5">
                            <button
                              onClick={() => openRetourModal(l, be)}
                              className="inline-flex items-center gap-1.5 text-xs font-medium text-orange-700 bg-orange-50 border border-orange-200 rounded-lg px-2.5 py-1 hover:bg-orange-100 transition-colors"
                            >
                              <RotateCcw className="w-3 h-3" /> Retourner
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        )
      )}

      {/* ── Onglet Retours ────────────────────────────────────────────────────── */}
      {tab === 'retours' && (
        groupesRetours.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-gray-400 gap-3">
            <CheckCircle2 className="w-10 h-10" />
            <p className="text-sm">Aucun retour en cours.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {groupesRetours.map(({ be, lignes }) => (
              <div key={be.id} className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
                <div className="flex items-center justify-between px-4 py-3 bg-gray-50/60 border-b border-gray-100">
                  <div className="flex items-center gap-3">
                    <span className="font-mono font-semibold text-sm text-gray-900">{be.numero_be}</span>
                    <span className="text-sm text-gray-500">{be.fournisseur ?? '—'}</span>
                    <span className="text-xs text-gray-400">{formatDate(be.date_bl)}</span>
                  </div>
                  <Link href={`/be-receptions/${be.id}`} className="p-1.5 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600">
                    <ChevronRight className="w-4 h-4" />
                  </Link>
                </div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-50">
                      <th className="text-left px-4 py-2 text-xs font-semibold text-gray-400">Réf.</th>
                      <th className="text-left px-4 py-2 text-xs font-semibold text-gray-400">Désignation</th>
                      <th className="text-right px-4 py-2 text-xs font-semibold text-gray-400">Qté</th>
                      <th className="text-left px-4 py-2 text-xs font-semibold text-gray-400">Motif</th>
                      <th className="text-left px-4 py-2 text-xs font-semibold text-gray-400">Statut</th>
                      <th className="px-4 py-2 text-xs font-semibold text-gray-400">Prochaine étape</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {lignes.map(l => {
                      const cfg = l.statut_retour ? STATUT_CFG[l.statut_retour] : null;
                      return (
                        <tr key={l.id} className="hover:bg-gray-50/50">
                          <td className="px-4 py-2.5 font-mono text-xs font-medium text-gray-800">{l.reference_article ?? '—'}</td>
                          <td className="px-4 py-2.5 text-xs text-gray-500 max-w-[180px] truncate">{l.designation ?? '—'}</td>
                          <td className="px-4 py-2.5 text-right font-mono text-xs font-semibold">{l.quantite_receptionnee}</td>
                          <td className="px-4 py-2.5 text-xs text-gray-500 max-w-[150px] truncate" title={l.motif_retour ?? ''}>{l.motif_retour ?? '—'}</td>
                          <td className="px-4 py-2.5">
                            {cfg && (
                              <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium', cfg.badge)}>
                                {cfg.label}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-2.5">
                            {cfg?.nextStatut && (
                              <button
                                onClick={() => {
                                  if (cfg.nextStatut === 'avoir_recu') {
                                    setAvoirFactureId('');
                                    setAvoirModal({ ligneBeId: l.id, be });
                                  } else {
                                    progressMutation.mutate({ ligneBeId: l.id, statut: cfg.nextStatut! });
                                  }
                                }}
                                disabled={progressMutation.isPending}
                                className="inline-flex items-center gap-1 text-xs font-medium text-gray-700 bg-white border border-gray-200 rounded-lg px-2.5 py-1 hover:bg-gray-50 transition-colors disabled:opacity-50"
                              >
                                <CheckCircle2 className="w-3 h-3 text-gray-400" /> {cfg.nextLabel}
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        )
      )}

      {/* ── Modal : initier retour ─────────────────────────────────────────────── */}
      {retourModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg flex flex-col gap-4 p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
                <RotateCcw className="w-4 h-4 text-orange-500" />
                Retour — {retourModal.ligne.reference_article ?? 'Article'} · {retourModal.ligne.quantite_receptionnee} u.
              </h2>
              <button onClick={() => setRetourModal(null)} className="p-1.5 rounded hover:bg-gray-100 text-gray-400">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3">
              {/* Motif */}
              <div>
                <label className="text-xs font-medium text-gray-500 mb-1 block">Motif du retour *</label>
                <select
                  value={motif}
                  onChange={e => setMotif(e.target.value)}
                  className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-orange-500"
                >
                  <option value="">— Sélectionner —</option>
                  {MOTIFS.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>

              {/* Email */}
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={sendEmailFlag}
                  onChange={e => setSendEmailFlag(e.target.checked)}
                  className="rounded border-gray-300"
                />
                <span className="text-xs font-medium text-gray-700 flex items-center gap-1">
                  <Mail className="w-3.5 h-3.5 text-gray-400" /> Envoyer un email au fournisseur
                </span>
              </label>

              {sendEmailFlag && (
                <>
                  <div>
                    <label className="text-xs font-medium text-gray-500 mb-1 block">Destinataire</label>
                    <div className="space-y-1.5">
                      {contacts.length > 0 && (
                        <select
                          value={emailTo}
                          onChange={e => setEmailTo(e.target.value)}
                          className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-orange-500"
                        >
                          <option value="">— Choisir un contact —</option>
                          {contacts.map(c => (
                            <option key={c.id} value={c.email}>
                              {c.nom ? `${c.nom} <${c.email}>` : c.email}{c.role ? ` (${c.role})` : ''}
                            </option>
                          ))}
                        </select>
                      )}
                      <input
                        placeholder={contacts.length ? 'ou email libre' : 'Email destinataire'}
                        value={contacts.some(c => c.email === emailTo) ? '' : emailTo}
                        onChange={e => setEmailTo(e.target.value)}
                        className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-orange-500"
                      />
                    </div>
                    {emailTo && <p className="text-xs text-gray-400 mt-1">→ {emailTo}</p>}
                  </div>

                  <div>
                    <label className="text-xs font-medium text-gray-500 mb-1 block">Objet</label>
                    <input
                      value={emailSubject}
                      onChange={e => setEmailSubject(e.target.value)}
                      className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-orange-500"
                    />
                  </div>

                  <div>
                    <label className="text-xs font-medium text-gray-500 mb-1 block">Corps du message</label>
                    <textarea
                      value={emailBody}
                      onChange={e => setEmailBody(e.target.value)}
                      rows={9}
                      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-xs font-mono resize-none focus:outline-none focus:ring-2 focus:ring-orange-500"
                    />
                  </div>
                </>
              )}
            </div>

            <div className="flex justify-end gap-2 border-t pt-3">
              <button
                onClick={() => setRetourModal(null)}
                className="px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 rounded-lg transition-colors"
              >
                Annuler
              </button>
              <button
                disabled={!motif || (sendEmailFlag && !emailTo) || initRetourMutation.isPending}
                onClick={() => initRetourMutation.mutate()}
                className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold text-white bg-orange-600 hover:bg-orange-700 rounded-lg disabled:opacity-50 transition-colors"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                {initRetourMutation.isPending ? 'En cours…' : 'Initier le retour'}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* ── Modal : avoir reçu ───────────────────────────────────────────────────── */}
      {avoirModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md flex flex-col gap-4 p-6">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-gray-900 flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                Avoir reçu — {avoirModal.be.numero_be}
              </h2>
              <button onClick={() => setAvoirModal(null)} className="p-1.5 rounded hover:bg-gray-100 text-gray-400">
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-gray-500">
              Optionnel : liez cet avoir à la facture d&apos;avoir reçue du fournisseur pour une traçabilité complète.
            </p>

            <div>
              <label className="text-xs font-medium text-gray-500 mb-1 block">Facture d&apos;avoir (optionnel)</label>
              <select
                value={avoirFactureId}
                onChange={e => setAvoirFactureId(e.target.value)}
                className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-emerald-500"
              >
                <option value="">— Aucune sélection —</option>
                {facturesAvoir.map(f => (
                  <option key={f.id} value={f.id}>
                    {f.numero_facture}{f.date_facture ? ` · ${f.date_facture}` : ''}{f.total_ht != null ? ` · ${f.total_ht.toFixed(2)} €` : ''}
                  </option>
                ))}
              </select>
              {facturesAvoir.length === 0 && (
                <p className="text-xs text-gray-400 mt-1">Aucune facture trouvée pour ce fournisseur.</p>
              )}
            </div>

            <div className="flex justify-end gap-2 border-t pt-3">
              <button onClick={() => setAvoirModal(null)} className="px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 rounded-lg">
                Annuler
              </button>
              <button
                disabled={progressMutation.isPending}
                onClick={() => progressMutation.mutate({ ligneBeId: avoirModal.ligneBeId, statut: 'avoir_recu', avoirFactureId: avoirFactureId || undefined })}
                className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg disabled:opacity-50"
              >
                <CheckCircle2 className="w-3.5 h-3.5" />
                {progressMutation.isPending ? 'En cours…' : 'Confirmer avoir reçu'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
