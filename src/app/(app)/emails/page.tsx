'use client';

import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { formatDate, cn } from '@/utils';
import PageHeader from '@/components/shared/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Mail, RefreshCw, Unlink, CheckCircle, AlertCircle, Clock, ShoppingCart, Filter, X, Plus } from 'lucide-react';

// ── Types ─────────────────────────────────────────────────────────────────────

interface GmailStatus {
  connected: boolean;
  email?: string;
  last_sync_at?: string | null;
  processed_count?: number;
  filtres_fournisseurs?: string[];
}

interface SyncResult {
  commandes_importees: number;
  doublons_ignores: number;
  filtres_ignores: number;
  erreurs: string[];
  details: string[];
  interrompu?: boolean;
}

// ── Composant ─────────────────────────────────────────────────────────────────

export default function EmailsPage() {
  const qc = useQueryClient();
  const [lastResult, setLastResult] = useState<SyncResult | null>(null);
  const [scanCompletedAt, setScanCompletedAt] = useState<Date | null>(null);
  const [filtres, setFiltres] = useState<string[]>([]);
  const [newFiltre, setNewFiltre] = useState('');
  const [savingFiltres, setSavingFiltres] = useState(false);

  const saveFiltres = async (updated: string[]) => {
    setSavingFiltres(true);
    try {
      await fetch('/api/gmail/filtres', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filtres: updated }),
      });
      setFiltres(updated);
      qc.invalidateQueries({ queryKey: ['gmail-status'] });
    } finally {
      setSavingFiltres(false);
    }
  };

  const addFiltre = () => {
    const val = newFiltre.trim();
    if (!val || filtres.includes(val)) return;
    const updated = [...filtres, val];
    setNewFiltre('');
    void saveFiltres(updated);
  };

  const removeFiltre = (f: string) => {
    void saveFiltres(filtres.filter(x => x !== f));
  };

  // Lire paramètre URL (retour OAuth)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('connected') === '1') {
      toast.success('Gmail connecté avec succès !');
      window.history.replaceState({}, '', '/emails');
      qc.invalidateQueries({ queryKey: ['gmail-status'] });
    }
    if (params.get('error')) {
      const errMap: Record<string, string> = {
        no_code: 'Autorisation refusée par Google',
        invalid_state: 'Erreur de sécurité — réessayez',
        token_exchange: 'Impossible d\'obtenir les tokens Google',
        no_refresh_token: 'Token de rafraîchissement manquant — réessayez en révoquant l\'accès dans google.com/account/permissions',
        access_denied: 'Accès refusé',
      };
      toast.error(errMap[params.get('error')!] ?? `Erreur OAuth : ${params.get('error')}`);
      window.history.replaceState({}, '', '/emails');
    }
  }, [qc]);

  // Statut connexion
  const { data: status, isLoading: statusLoading } = useQuery<GmailStatus>({
    queryKey: ['gmail-status'],
    queryFn: () => fetch('/api/gmail/status').then((r) => r.json()),
    refetchInterval: 30_000,
  });

  // Synchroniser l'état local des filtres avec le statut chargé
  useEffect(() => {
    if (status?.filtres_fournisseurs) {
      setFiltres(status.filtres_fournisseurs);
    }
  }, [status?.filtres_fournisseurs]);

  // Connexion → redirection OAuth
  const connect = () => { window.location.href = '/api/gmail/auth'; };

  // Déconnexion
  const disconnectMutation = useMutation({
    mutationFn: () => fetch('/api/gmail/disconnect', { method: 'POST' }),
    onSuccess: () => {
      toast.success('Gmail déconnecté');
      qc.invalidateQueries({ queryKey: ['gmail-status'] });
      setLastResult(null);
    },
  });

  // Sync
  const syncMutation = useMutation({
    mutationFn: async (): Promise<SyncResult> => {
      const r = await fetch('/api/gmail/sync', { method: 'POST' });
      if (!r.ok) {
        const err = await r.json() as { error?: string };
        throw new Error(err.error ?? 'Erreur sync');
      }
      return r.json();
    },
    onSuccess: (data) => {
      setLastResult(data);
      setScanCompletedAt(new Date());
      qc.invalidateQueries({ queryKey: ['gmail-status'] });
      const total = data.commandes_importees;
      if (total === 0 && data.erreurs.length === 0) {
        toast.info('Aucun nouvel email à traiter');
      } else if (data.erreurs.length > 0 && total === 0) {
        toast.error(`Scan terminé avec ${data.erreurs.length} erreur(s)`);
      } else {
        toast.success(`Scan terminé : ${total} document(s) importé(s)`);
      }
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const isConnected = status?.connected === true;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Emails Gmail"
        subtitle="Import automatique des commandes et BEs depuis la boîte remy.arcos@orchidee-innovation.fr"
      />

      {/* ── Bloc connexion ────────────────────────────────────────────────── */}
      <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-4">
            {/* Icône état */}
            <div className={cn(
              'flex h-12 w-12 items-center justify-center rounded-full',
              isConnected ? 'bg-emerald-100' : 'bg-gray-100',
            )}>
              <Mail className={cn('h-6 w-6', isConnected ? 'text-emerald-600' : 'text-gray-400')} />
            </div>

            <div>
              {statusLoading ? (
                <p className="text-sm text-gray-400">Chargement…</p>
              ) : isConnected ? (
                <>
                  <div className="flex items-center gap-2">
                    <CheckCircle className="h-4 w-4 text-emerald-500" />
                    <p className="font-semibold text-gray-900">Connecté</p>
                  </div>
                  <p className="text-sm text-gray-500">{status.email}</p>
                  {status.last_sync_at && (
                    <p className="text-xs text-gray-400">
                      Dernier scan : {formatDate(status.last_sync_at)} · {status.processed_count} thread(s) traité(s)
                    </p>
                  )}
                </>
              ) : (
                <>
                  <div className="flex items-center gap-2">
                    <AlertCircle className="h-4 w-4 text-amber-500" />
                    <p className="font-semibold text-gray-700">Non connecté</p>
                  </div>
                  <p className="text-sm text-gray-400">
                    Autorisez SyncFlow à lire votre boîte Gmail pour importer automatiquement les commandes et BEs.
                  </p>
                </>
              )}
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 shrink-0">
            {isConnected ? (
              <>
                <Button
                  onClick={() => syncMutation.mutate()}
                  disabled={syncMutation.isPending}
                  className="gap-2"
                >
                  <RefreshCw className={cn('h-4 w-4', syncMutation.isPending && 'animate-spin')} />
                  {syncMutation.isPending ? 'Scan en cours…' : 'Scanner les emails'}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => disconnectMutation.mutate()}
                  disabled={disconnectMutation.isPending}
                  className="gap-2 text-red-600 border-red-200 hover:bg-red-50"
                >
                  <Unlink className="h-4 w-4" />
                  Déconnecter
                </Button>
              </>
            ) : (
              <Button onClick={connect} className="gap-2">
                <Mail className="h-4 w-4" />
                Connecter Gmail
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* ── Filtres fournisseurs ──────────────────────────────────────────── */}
      <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <div className="flex items-center gap-2 mb-4">
          <Filter className="h-4 w-4 text-gray-400" />
          <h3 className="font-semibold text-gray-800 text-sm">Filtres fournisseurs</h3>
          {filtres.length === 0 && (
            <span className="text-xs text-gray-400 ml-1">— tous les fournisseurs sont importés</span>
          )}
        </div>

        {filtres.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-4">
            {filtres.map(f => (
              <span key={f} className="inline-flex items-center gap-1.5 rounded-full bg-indigo-50 border border-indigo-200 px-3 py-1 text-sm text-indigo-700">
                {f}
                <button onClick={() => removeFiltre(f)} disabled={savingFiltres} className="hover:text-indigo-900 disabled:opacity-40">
                  <X className="h-3.5 w-3.5" />
                </button>
              </span>
            ))}
          </div>
        )}

        <form
          onSubmit={e => { e.preventDefault(); addFiltre(); }}
          className="flex gap-2"
        >
          <Input
            value={newFiltre}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewFiltre(e.target.value)}
            placeholder="Ex: Somafi, ACME, Dupont..."
            className="max-w-xs"
            disabled={savingFiltres}
          />
          <Button type="submit" variant="outline" size="sm" disabled={!newFiltre.trim() || savingFiltres}>
            <Plus className="h-4 w-4 mr-1" /> Ajouter
          </Button>
        </form>
        <p className="mt-2 text-xs text-gray-400">
          Si des filtres sont définis, seules les commandes dont le fournisseur contient l'un de ces termes seront importées. La recherche est insensible à la casse.
        </p>
      </div>

      {/* ── Prérequis Google Cloud (si non connecté) ──────────────────────── */}
      {!isConnected && !statusLoading && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-5">
          <h3 className="mb-3 font-semibold text-amber-800">Configuration requise avant de connecter</h3>
          <ol className="space-y-2 text-sm text-amber-700">
            <li className="flex gap-2">
              <span className="font-bold shrink-0">1.</span>
              <span>Créer un projet sur <strong>console.cloud.google.com</strong></span>
            </li>
            <li className="flex gap-2">
              <span className="font-bold shrink-0">2.</span>
              <span>Activer l'API <strong>Gmail API</strong> dans « APIs & Services »</span>
            </li>
            <li className="flex gap-2">
              <span className="font-bold shrink-0">3.</span>
              <span>Créer des identifiants <strong>OAuth 2.0 Client ID</strong> (type : Application Web)</span>
            </li>
            <li className="flex gap-2">
              <span className="font-bold shrink-0">4.</span>
              <span>
                Ajouter l'URI de redirection autorisée :{' '}
                <code className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-mono">
                  {typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000'}/api/gmail/callback
                </code>
              </span>
            </li>
            <li className="flex gap-2">
              <span className="font-bold shrink-0">5.</span>
              <span>
                Copier <strong>Client ID</strong> et <strong>Client Secret</strong> dans{' '}
                <code className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-mono">.env.local</code> :{' '}
                <code className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-mono">GOOGLE_CLIENT_ID</code>,{' '}
                <code className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-mono">GOOGLE_CLIENT_SECRET</code>
              </span>
            </li>
            <li className="flex gap-2">
              <span className="font-bold shrink-0">6.</span>
              <span>Ajouter <strong>remy.arcos@orchidee-innovation.fr</strong> comme utilisateur test (tant que l'app n'est pas en production vérifiée)</span>
            </li>
            <li className="flex gap-2">
              <span className="font-bold shrink-0">7.</span>
              <span>Redémarrer le serveur (<code className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-mono">npm run dev</code>), puis cliquer « Connecter Gmail »</span>
            </li>
          </ol>
        </div>
      )}

      {/* ── Résultats dernier scan ─────────────────────────────────────────── */}
      {lastResult && scanCompletedAt && (
        <div className="space-y-4">
          {/* En-tête scan terminé */}
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <CheckCircle className="h-4 w-4 text-emerald-500 shrink-0" />
            <span>
              Scan terminé à{' '}
              <strong className="text-gray-700">
                {scanCompletedAt.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </strong>
            </span>
          </div>

          {/* Bannière interrompu — relancer nécessaire */}
          {lastResult.interrompu && (
            <div className="flex items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 shadow-sm">
              <div className="flex items-center gap-3 text-sm text-amber-700">
                <RefreshCw className="h-4 w-4 shrink-0 text-amber-500" />
                <span>Il reste des emails à traiter — relancez le scan pour continuer.</span>
              </div>
              <button
                onClick={() => syncMutation.mutate()}
                disabled={syncMutation.isPending}
                className="shrink-0 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-600 disabled:opacity-50"
              >
                Continuer
              </button>
            </div>
          )}

          {/* Cas aucun résultat */}
          {lastResult.commandes_importees === 0 && lastResult.erreurs.length === 0 && !lastResult.interrompu && (
            <div className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm text-sm text-gray-500">
              <Clock className="h-5 w-5 shrink-0 text-gray-300" />
              Aucun nouvel email — tous les threads déjà traités.
            </div>
          )}

          {/* KPIs résultats */}
          {(lastResult.commandes_importees > 0 || lastResult.doublons_ignores > 0 || lastResult.filtres_ignores > 0) && (
          <div className="grid grid-cols-3 gap-3">
            {[
              { icon: ShoppingCart, label: 'Commandes importées', value: lastResult.commandes_importees, cls: 'text-blue-600', bg: 'bg-blue-50' },
              { icon: Clock, label: 'Doublons ignorés', value: lastResult.doublons_ignores, cls: 'text-gray-500', bg: 'bg-gray-50' },
              { icon: Filter, label: 'Hors filtre', value: lastResult.filtres_ignores ?? 0, cls: 'text-amber-600', bg: 'bg-amber-50' },
            ].map((k) => (
              <div key={k.label} className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm flex items-center gap-3">
                <div className={cn('flex h-10 w-10 items-center justify-center rounded-lg', k.bg)}>
                  <k.icon className={cn('h-5 w-5', k.cls)} />
                </div>
                <div>
                  <p className={cn('text-2xl font-bold', k.cls)}>{k.value}</p>
                  <p className="text-xs text-gray-400">{k.label}</p>
                </div>
              </div>
            ))}
          </div>
          )}

          {/* Détails */}
          {lastResult.details.length > 0 && (
            <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
              <h3 className="mb-3 text-sm font-semibold text-gray-700">Détail des imports</h3>
              <ul className="space-y-1">
                {lastResult.details.map((d, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-gray-600">
                    <CheckCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
                    {d}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Erreurs */}
          {lastResult.erreurs.length > 0 && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-4">
              <h3 className="mb-3 text-sm font-semibold text-red-700">Erreurs ({lastResult.erreurs.length})</h3>
              <ul className="space-y-1">
                {lastResult.erreurs.map((e, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-red-600">
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {e}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* ── État vide si connecté mais pas encore scanné ───────────────────── */}
      {isConnected && !lastResult && !syncMutation.isPending && (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-gray-300 bg-white py-16 text-center">
          <RefreshCw className="mb-4 h-10 w-10 text-gray-300" />
          <p className="text-sm font-medium text-gray-500">Cliquez sur « Scanner les emails » pour démarrer</p>
          <p className="mt-1 text-xs text-gray-400">
            SyncFlow va analyser les emails de <strong>no-reply@centralink.fr</strong> pour importer les commandes Centralink
          </p>
        </div>
      )}

      {/* ── Spinner scan en cours ──────────────────────────────────────────── */}
      {syncMutation.isPending && (
        <div className="flex flex-col items-center justify-center rounded-xl border border-indigo-100 bg-indigo-50 py-16 text-center">
          <RefreshCw className="mb-4 h-10 w-10 animate-spin text-indigo-400" />
          <p className="text-sm font-medium text-indigo-700">Scan Gmail en cours…</p>
          <p className="mt-1 text-xs text-indigo-400">
            Analyse des emails, extraction des données via Claude AI — cela peut prendre 30–60 secondes selon le nombre d'emails
          </p>
        </div>
      )}
    </div>
  );
}
