'use client';

import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import PageHeader from '@/components/shared/PageHeader';
import { Bell, AlertCircle, AlertTriangle, Info, Check, CheckCheck, Trash2, ChevronRight, RefreshCw } from 'lucide-react';
import { formatDate } from '@/utils';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';

interface Notification {
  id: string;
  type: string;
  severite: 'info' | 'warning' | 'error';
  titre: string;
  message: string | null;
  lien: string | null;
  lu: boolean;
  created_at: string;
}

const TYPE_LABEL: Record<string, string> = {
  be_non_lie: 'BE non lié',
  rapprochement_en_attente: 'Rapprochement',
  commande_anomalie: 'Commande anomalie',
  be_sans_facture: 'BE sans facture',
  be_anomalie: 'BE anomalie',
};

const SEVERITY_COLORS = {
  error:   { bg: '#fef2f2', border: '#fecaca', icon: <AlertCircle   className="w-4 h-4" style={{ color: '#dc2626' }} /> },
  warning: { bg: '#fffbeb', border: '#fde68a', icon: <AlertTriangle className="w-4 h-4" style={{ color: '#d97706' }} /> },
  info:    { bg: '#eef2ff', border: '#c7d2fe', icon: <Info          className="w-4 h-4" style={{ color: '#6366f1' }} /> },
};

export default function AlertesPage() {
  const qc = useQueryClient();

  const { data: notifications = [], isFetching } = useQuery<Notification[]>({
    queryKey: ['notifications'],
    queryFn: async () => {
      const res = await fetch('/api/notifications');
      if (!res.ok) return [];
      const json = await res.json() as { notifications?: Notification[] };
      return json.notifications ?? [];
    },
    staleTime: 30_000,
  });

  const refresh = useCallback(async () => {
    await fetch('/api/notifications/generate', { method: 'POST' });
    void qc.invalidateQueries({ queryKey: ['notifications'] });
    toast.success('Alertes actualisées');
  }, [qc]);

  const markRead = useCallback(async (ids: string[]) => {
    await fetch('/api/notifications', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    void qc.invalidateQueries({ queryKey: ['notifications'] });
  }, [qc]);

  const markAllRead = useCallback(async () => {
    await fetch('/api/notifications', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ all: true }),
    });
    void qc.invalidateQueries({ queryKey: ['notifications'] });
    toast.success('Toutes les alertes marquées comme lues');
  }, [qc]);

  const cleanup = useCallback(async () => {
    await fetch('/api/notifications', { method: 'DELETE' });
    void qc.invalidateQueries({ queryKey: ['notifications'] });
    toast.success('Alertes lues supprimées');
  }, [qc]);

  const unread = notifications.filter(n => !n.lu);
  const errors = notifications.filter(n => n.severite === 'error' && !n.lu).length;
  const warnings = notifications.filter(n => n.severite === 'warning' && !n.lu).length;

  return (
    <div>
      <PageHeader
        title="Alertes"
        subtitle={`${unread.length} non lue${unread.length > 1 ? 's' : ''} · ${notifications.length} au total`}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={refresh} disabled={isFetching}>
              <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} /> Actualiser
            </Button>
            {unread.length > 0 && (
              <Button variant="outline" size="sm" onClick={markAllRead}>
                <CheckCheck className="w-4 h-4" /> Tout marquer lu
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={cleanup} className="text-red-500 hover:text-red-600">
              <Trash2 className="w-4 h-4" /> Nettoyer les lues
            </Button>
          </div>
        }
      />

      {/* KPIs */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
          <p className="text-xs text-gray-500 mb-1">Erreurs critiques</p>
          <p className="text-2xl font-bold" style={{ color: errors > 0 ? '#dc2626' : '#059669' }}>{errors}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
          <p className="text-xs text-gray-500 mb-1">Avertissements</p>
          <p className="text-2xl font-bold" style={{ color: warnings > 0 ? '#d97706' : '#059669' }}>{warnings}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
          <p className="text-xs text-gray-500 mb-1">Non lues</p>
          <p className="text-2xl font-bold text-gray-900">{unread.length}</p>
        </div>
      </div>

      {/* Notifications list */}
      <div className="space-y-2">
        {notifications.length === 0 && (
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm py-16 flex flex-col items-center justify-center text-gray-400">
            <Bell className="w-10 h-10 mb-3" style={{ color: '#e5e7eb' }} />
            <p className="text-sm font-medium text-gray-500">Aucune alerte</p>
            <p className="text-xs mt-1">Cliquez sur "Actualiser" pour vérifier les conditions</p>
          </div>
        )}
        {notifications.map(n => {
          const severity = SEVERITY_COLORS[n.severite] ?? SEVERITY_COLORS.info;
          return (
            <div
              key={n.id}
              className="bg-white rounded-xl border shadow-sm p-4 flex items-start gap-4 transition-all"
              style={{
                borderColor: !n.lu ? severity.border : '#f3f4f6',
                backgroundColor: !n.lu ? severity.bg : '#ffffff',
                opacity: n.lu ? 0.65 : 1,
              }}
            >
              <div className="mt-0.5">{severity.icon}</div>
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className={`text-sm font-medium ${n.lu ? 'text-gray-500' : 'text-gray-900'}`}>{n.titre}</p>
                    {n.message && <p className="text-xs text-gray-400 mt-0.5">{n.message}</p>}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <span className="text-xs text-gray-400">{formatDate(n.created_at)}</span>
                    {n.type in TYPE_LABEL && (
                      <span className="ml-2 text-xs px-1.5 py-0.5 bg-gray-100 text-gray-500 rounded">
                        {TYPE_LABEL[n.type]}
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {n.lien && (
                  <Link
                    href={n.lien}
                    onClick={() => { if (!n.lu) void markRead([n.id]); }}
                    className="p-1.5 rounded hover:bg-white/80 transition-colors"
                    title="Voir le détail"
                  >
                    <ChevronRight className="w-4 h-4 text-gray-400" />
                  </Link>
                )}
                {!n.lu ? (
                  <button
                    onClick={() => void markRead([n.id])}
                    className="p-1.5 rounded hover:bg-white/80 transition-colors"
                    style={{ color: '#818cf8' }}
                    title="Marquer comme lu"
                  >
                    <Check className="w-4 h-4" />
                  </button>
                ) : (
                  <span className="p-1.5" style={{ color: '#d1d5db' }} title="Déjà lu">
                    <Check className="w-4 h-4" />
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
