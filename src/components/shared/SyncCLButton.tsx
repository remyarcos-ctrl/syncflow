'use client';

import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, AlertTriangle } from 'lucide-react';

interface SyncRequest {
  id: number;
  type: 'manuel' | 'auto';
  statut: 'demandée' | 'en cours' | 'terminée' | 'erreur';
  demandee_a: string;
  demarree_a: string | null;
  terminee_a: string | null;
  resultat: string | null;
}

interface SyncState { active: SyncRequest | null; derniere: SyncRequest | null }

// « il y a 3 min », « il y a 2 h »… pour situer la fraîcheur des données CL d'un coup d'œil.
function ilYA(iso: string | null | undefined): string {
  if (!iso) return '—';
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (min < 1) return 'à l’instant';
  if (min < 60) return `il y a ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `il y a ${h} h`;
  return `il y a ${Math.round(h / 24)} j`;
}

// Bouton topbar « Rafraîchir CL » : dépose une demande de sync que le watcher du
// poste local exécute (scraper → détection). Poll rapide tant qu'une demande est
// active, lent sinon. Affiche la fraîcheur (dernière sync, manuelle OU auto 2 h).
export default function SyncCLButton() {
  const qc = useQueryClient();

  const { data } = useQuery<SyncState>({
    queryKey: ['sync-cl'],
    queryFn: async () => {
      const res = await fetch('/api/sync-cl');
      if (!res.ok) return { active: null, derniere: null };
      return res.json() as Promise<SyncState>;
    },
    // 5 s pendant une sync (suivre l'avancement), 2 min au repos (fraîcheur).
    refetchInterval: (q) => (q.state.data?.active ? 5_000 : 120_000),
  });

  const active = data?.active ?? null;
  const derniere = data?.derniere ?? null;

  // Une sync (qu'on suivait) vient de finir → recharger TOUTES les données affichées
  // (anomalies, saisies, commandes…) sans que l'utilisateur ait à recharger la page.
  const suivait = useRef<number | null>(null);
  useEffect(() => {
    if (active) { suivait.current = active.id; return; }
    if (suivait.current !== null) { suivait.current = null; void qc.invalidateQueries(); }
  }, [active, qc]);

  const demander = async () => {
    await fetch('/api/sync-cl', { method: 'POST' });
    void qc.invalidateQueries({ queryKey: ['sync-cl'] });
  };

  const enCours = !!active;
  const label = enCours
    ? active!.statut === 'en cours' ? 'Sync CL en cours…' : 'Sync CL en file…'
    : `CL ${ilYA(derniere?.terminee_a)}`;

  return (
    <button
      onClick={demander}
      disabled={enCours}
      title={
        enCours
          ? 'Le poste local exécute la synchronisation Centralink (commandes, saisies, bons) puis relance la détection.'
          : `Dernière synchronisation Centralink : ${ilYA(derniere?.terminee_a)}${derniere?.type === 'auto' ? ' (auto)' : ''}. Cliquer pour rafraîchir maintenant.`
      }
      className={`flex items-center gap-1.5 px-2.5 h-8 rounded-lg border text-xs font-medium transition-colors ${
        enCours
          ? 'bg-indigo-50 border-indigo-200 text-indigo-700 cursor-wait'
          : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50 hover:text-gray-900'
      }`}
    >
      <RefreshCw className={`w-3.5 h-3.5 ${enCours ? 'animate-spin' : ''}`} />
      <span className="hidden sm:inline whitespace-nowrap">{label}</span>
      {derniere?.statut === 'erreur' && !enCours && (
        <AlertTriangle className="w-3.5 h-3.5 text-amber-500" aria-label="La dernière sync a échoué" />
      )}
    </button>
  );
}
