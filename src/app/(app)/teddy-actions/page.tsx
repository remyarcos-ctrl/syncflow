'use client';

import { useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import PageHeader from '@/components/shared/PageHeader';
import { Bot, RefreshCw, CheckCheck, X, Zap, AlertTriangle, Tag, Clock, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { formatDate } from '@/utils';

interface TeddyAction {
  id: string;
  type_action: string;
  description: string;
  entite_type: string | null;
  entite_id: string | null;
  statut: 'proposée' | 'approuvée' | 'rejetée' | 'annulée';
  risque: 'low' | 'medium' | 'high';
  resultat: string | null;
  created_at: string;
  executed_at: string | null;
}

const TYPE_META: Record<string, { label: string; icon: React.ElementType; color: string; bg: string }> = {
  resoudre_exception:    { label: 'Résolution anomalie',    icon: CheckCheck,    color: '#15803d', bg: '#dcfce7' },
  valider_rapprochement: { label: 'Validation rapprochement', icon: Zap,         color: '#1d4ed8', bg: '#dbeafe' },
  corriger_prix:         { label: 'Correction de prix',     icon: Tag,           color: '#6d28d9', bg: '#ede9fe' },
  relance_be:            { label: 'Relance fournisseur',    icon: Clock,         color: '#b45309', bg: '#fef3c7' },
};

const RISQUE_COLORS: Record<string, { color: string; label: string }> = {
  low:    { color: '#15803d', label: 'Risque faible' },
  medium: { color: '#d97706', label: 'Risque moyen' },
  high:   { color: '#dc2626', label: 'Risque élevé' },
};

function CronTriggerButton({ path }: { path: string }) {
  const [status, setStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');

  const trigger = async () => {
    setStatus('loading');
    try {
      const res = await fetch(path, { headers: { Authorization: 'Bearer dev-cron-secret' } });
      setStatus(res.ok ? 'ok' : 'error');
      setTimeout(() => setStatus('idle'), 3000);
    } catch {
      setStatus('error');
      setTimeout(() => setStatus('idle'), 3000);
    }
  };

  return (
    <button
      onClick={() => void trigger()}
      disabled={status === 'loading'}
      className="w-full text-[10px] px-2 py-1.5 rounded-lg border font-medium transition-all disabled:opacity-40"
      style={{
        backgroundColor: status === 'ok' ? '#dcfce7' : status === 'error' ? '#fee2e2' : '#eef2ff',
        color: status === 'ok' ? '#15803d' : status === 'error' ? '#dc2626' : '#4338ca',
        borderColor: status === 'ok' ? '#86efac' : status === 'error' ? '#fca5a5' : '#c7d2fe',
      }}
    >
      {status === 'loading' ? 'Exécution...' : status === 'ok' ? '✓ Exécuté' : status === 'error' ? '✗ Erreur' : 'Déclencher maintenant'}
    </button>
  );
}

function ActionCard({ action, onApprove, onReject, loading }: {
  action: TeddyAction;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  loading: boolean;
}) {
  const meta = TYPE_META[action.type_action] ?? { label: action.type_action, icon: Bot, color: '#6b7280', bg: '#f3f4f6' };
  const Icon = meta.icon;
  const risque = RISQUE_COLORS[action.risque] ?? RISQUE_COLORS.low;
  const isPending = action.statut === 'proposée';

  return (
    <div className={`bg-white rounded-xl border shadow-sm p-4 transition-all ${!isPending ? 'opacity-60' : ''}`}
      style={{ borderColor: isPending ? '#e5e7eb' : '#f3f4f6' }}>
      <div className="flex items-start gap-3">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5" style={{ backgroundColor: meta.bg }}>
          <Icon className="w-4 h-4" style={{ color: meta.color }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded" style={{ backgroundColor: meta.bg, color: meta.color }}>
              {meta.label}
            </span>
            <span className="text-[10px]" style={{ color: risque.color }}>{risque.label}</span>
            <span className="text-[10px] text-gray-400 ml-auto">{formatDate(action.created_at)}</span>
          </div>
          <p className="text-xs text-gray-800 leading-relaxed"
            dangerouslySetInnerHTML={{ __html: action.description
              .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
              .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>') }} />
          {action.resultat && (
            <p className="text-[10px] text-gray-500 mt-1 italic">{action.resultat}</p>
          )}
        </div>
        {isPending && (
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={() => onApprove(action.id)}
              disabled={loading}
              title="Approuver"
              className="flex items-center gap-1 text-[10px] px-2.5 py-1.5 rounded-lg font-medium transition-all disabled:opacity-40"
              style={{ backgroundColor: '#dcfce7', color: '#15803d' }}
            >
              <CheckCheck className="w-3 h-3" /> Approuver
            </button>
            <button
              onClick={() => onReject(action.id)}
              disabled={loading}
              title="Rejeter"
              className="p-1.5 rounded-lg transition-all disabled:opacity-40 hover:bg-red-50"
              style={{ color: '#dc2626' }}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
        {!isPending && (
          <span className="text-[10px] px-2 py-1 rounded shrink-0" style={{
            backgroundColor: action.statut === 'approuvée' ? '#dcfce7' : '#fee2e2',
            color: action.statut === 'approuvée' ? '#15803d' : '#dc2626',
          }}>
            {action.statut === 'approuvée' ? '✓ Exécutée' : '✗ Rejetée'}
          </span>
        )}
      </div>
    </div>
  );
}

export default function TeddyActionsPage() {
  const qc = useQueryClient();
  const [loading, setLoading] = useState(false);
  const [showDone, setShowDone] = useState(false);

  const { data: actionsProp = [], isFetching: fetchingProp } = useQuery<TeddyAction[]>({
    queryKey: ['teddy-actions', 'proposée'],
    queryFn: async () => {
      const res = await fetch('/api/teddy/actions?statut=proposi%C3%A9e');
      const json = await res.json() as { actions: TeddyAction[] };
      return json.actions ?? [];
    },
    staleTime: 30_000,
  });

  const { data: actionsDone = [], isFetching: fetchingDone } = useQuery<TeddyAction[]>({
    queryKey: ['teddy-actions', 'done'],
    queryFn: async () => {
      const [r1, r2] = await Promise.all([
        fetch('/api/teddy/actions?statut=approuv%C3%A9e').then(r => r.json()) as Promise<{ actions: TeddyAction[] }>,
        fetch('/api/teddy/actions?statut=rejet%C3%A9e').then(r => r.json()) as Promise<{ actions: TeddyAction[] }>,
      ]);
      return [...(r1.actions ?? []), ...(r2.actions ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at));
    },
    staleTime: 30_000,
    enabled: showDone,
  });

  const analyse = useCallback(async () => {
    setLoading(true);
    const res = await fetch('/api/teddy/analyse', { method: 'POST' });
    const json = await res.json() as { total: number; nouvelles_creees: number };
    void qc.invalidateQueries({ queryKey: ['teddy-actions'] });
    toast.success(`Analyse terminée — ${json.nouvelles_creees} nouvelle(s) action(s) proposée(s)`);
    setLoading(false);
  }, [qc]);

  const approve = useCallback(async (ids: string[], tous = false) => {
    setLoading(true);
    await fetch('/api/teddy/actions', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, tous, action: 'approuver' }),
    });
    void qc.invalidateQueries({ queryKey: ['teddy-actions'] });
    toast.success(tous ? 'Toutes les actions exécutées' : 'Action exécutée');
    setLoading(false);
  }, [qc]);

  const reject = useCallback(async (ids: string[], tous = false) => {
    setLoading(true);
    await fetch('/api/teddy/actions', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, tous, action: 'rejeter' }),
    });
    void qc.invalidateQueries({ queryKey: ['teddy-actions'] });
    toast.success('Action(s) rejetée(s)');
    setLoading(false);
  }, [qc]);

  const cleanup = useCallback(async () => {
    await fetch('/api/teddy/actions', { method: 'DELETE' });
    void qc.invalidateQueries({ queryKey: ['teddy-actions'] });
    toast.success('Historique nettoyé');
  }, [qc]);

  const byType = actionsProp.reduce<Record<string, TeddyAction[]>>((acc, a) => {
    (acc[a.type_action] ??= []).push(a);
    return acc;
  }, {});

  const lowRisk  = actionsProp.filter(a => a.risque === 'low').length;
  const medRisk  = actionsProp.filter(a => a.risque === 'medium').length;

  return (
    <div>
      <PageHeader
        title="Actions Teddy"
        subtitle={`${actionsProp.length} action${actionsProp.length > 1 ? 's' : ''} en attente`}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={analyse} disabled={loading || fetchingProp}>
              <RefreshCw className={`w-4 h-4 ${loading || fetchingProp ? 'animate-spin' : ''}`} />
              Analyser
            </Button>
            {actionsProp.length > 0 && (
              <>
                <Button variant="outline" size="sm" onClick={() => void approve([], true)} disabled={loading}
                  className="text-green-600 hover:text-green-700 border-green-200 hover:border-green-300">
                  <CheckCheck className="w-4 h-4" /> Tout approuver
                </Button>
                <Button variant="outline" size="sm" onClick={() => void reject([], true)} disabled={loading}
                  className="text-red-500 hover:text-red-600">
                  <X className="w-4 h-4" /> Tout rejeter
                </Button>
              </>
            )}
          </div>
        }
      />

      {/* KPIs */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
          <p className="text-xs text-gray-500 mb-1">En attente</p>
          <p className="text-2xl font-bold text-gray-900">{actionsProp.length}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
          <p className="text-xs text-gray-500 mb-1">Risque faible</p>
          <p className="text-2xl font-bold" style={{ color: lowRisk > 0 ? '#15803d' : '#9ca3af' }}>{lowRisk}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
          <p className="text-xs text-gray-500 mb-1">Risque moyen</p>
          <p className="text-2xl font-bold" style={{ color: medRisk > 0 ? '#d97706' : '#9ca3af' }}>{medRisk}</p>
        </div>
      </div>

      {/* Empty state */}
      {actionsProp.length === 0 && !fetchingProp && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm py-16 flex flex-col items-center justify-center text-gray-400">
          <div className="w-12 h-12 rounded-2xl bg-indigo-50 flex items-center justify-center mb-3">
            <Bot className="w-6 h-6 text-indigo-400" />
          </div>
          <p className="text-sm font-medium text-gray-500">Aucune action proposée</p>
          <p className="text-xs mt-1 text-center max-w-xs">
            Clique sur <strong>Analyser</strong> pour que Teddy inspecte tes données et propose des actions.
          </p>
        </div>
      )}

      {/* Actions groupées par type */}
      {Object.entries(byType).map(([type, actions]) => {
        const meta = TYPE_META[type] ?? { label: type, icon: Bot, color: '#6b7280', bg: '#f3f4f6' };
        const Icon = meta.icon;
        return (
          <div key={type} className="mb-6">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-5 h-5 rounded flex items-center justify-center" style={{ backgroundColor: meta.bg }}>
                <Icon className="w-3 h-3" style={{ color: meta.color }} />
              </div>
              <p className="text-xs font-semibold text-gray-700">{meta.label}</p>
              <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium" style={{ backgroundColor: meta.bg, color: meta.color }}>
                {actions.length}
              </span>
              {actions.length > 1 && (
                <button
                  onClick={() => void approve(actions.map(a => a.id))}
                  disabled={loading}
                  className="ml-auto text-[10px] px-2 py-1 rounded-lg border font-medium transition-all"
                  style={{ borderColor: meta.color + '40', color: meta.color }}
                >
                  Approuver les {actions.length}
                </button>
              )}
            </div>
            <div className="space-y-2">
              {actions.map(a => (
                <ActionCard
                  key={a.id}
                  action={a}
                  onApprove={id => void approve([id])}
                  onReject={id => void reject([id])}
                  loading={loading}
                />
              ))}
            </div>
          </div>
        );
      })}

      {/* Historique */}
      <div className="mt-8">
        <div className="flex items-center justify-between mb-3">
          <button
            onClick={() => setShowDone(v => !v)}
            className="text-xs text-gray-400 hover:text-gray-600 transition-colors flex items-center gap-1"
          >
            {showDone ? '▾' : '▸'} Historique des actions exécutées
          </button>
          {showDone && actionsDone.length > 0 && (
            <button onClick={cleanup} className="flex items-center gap-1 text-[10px] text-red-400 hover:text-red-600">
              <Trash2 className="w-3 h-3" /> Nettoyer
            </button>
          )}
        </div>
        {showDone && (
          <div className="space-y-2">
            {fetchingDone && <p className="text-xs text-gray-400">Chargement...</p>}
            {actionsDone.map(a => (
              <ActionCard
                key={a.id}
                action={a}
                onApprove={() => {}}
                onReject={() => {}}
                loading={false}
              />
            ))}
          </div>
        )}
      </div>

      {/* Config seuils */}
      <div className="mt-8 bg-white rounded-xl border border-gray-100 shadow-sm p-4">
        <div className="flex items-center gap-2 mb-3">
          <AlertTriangle className="w-4 h-4 text-amber-500" />
          <p className="text-xs font-semibold text-gray-700">Seuils de déclenchement</p>
        </div>
        <p className="text-[11px] text-gray-500 leading-relaxed">
          Dis à <strong>Teddy</strong> dans le chat de modifier les seuils. Par exemple :<br />
          <em>"Mémorise que le seuil d'écart de prix auto est 3%"</em><br />
          <em>"Mémorise que le seuil de score rapprochement est 0.90"</em><br />
          <em>"Mémorise que le délai de relance BE est 7 jours"</em>
        </p>
      </div>

      {/* Planification */}
      <div className="mt-8 bg-white rounded-xl border border-gray-100 shadow-sm p-4">
        <div className="flex items-center gap-2 mb-4">
          <Clock className="w-4 h-4 text-indigo-500" />
          <p className="text-xs font-semibold text-gray-700">Tâches planifiées</p>
          <span className="text-[10px] text-gray-400 ml-1">— automatiques du lundi au vendredi</span>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {[
            { label: 'Brief du matin', desc: 'Synthèse quotidienne à 7h', path: '/api/cron/morning-brief', icon: '☀️' },
            { label: 'Matching du soir', desc: 'Matching auto à 18h', path: '/api/cron/evening-matching', icon: '🔄' },
          ].map(task => (
            <div key={task.path} className="rounded-xl border border-gray-100 p-3">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-base">{task.icon}</span>
                <div>
                  <p className="text-[11px] font-semibold text-gray-800">{task.label}</p>
                  <p className="text-[10px] text-gray-400">{task.desc}</p>
                </div>
              </div>
              <CronTriggerButton path={task.path} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
