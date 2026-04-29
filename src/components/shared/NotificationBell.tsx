'use client';

import { useState, useEffect, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import Link from 'next/link';
import { Bell, X, Check, CheckCheck, AlertTriangle, Info, AlertCircle, ChevronRight } from 'lucide-react';
import { formatDate } from '@/utils';

interface Notification {
  id: string;
  type: string;
  severite: 'info' | 'warning' | 'error';
  titre: string;
  message: string | null;
  lien: string | null;
  entite_type: string | null;
  entite_id: string | null;
  lu: boolean;
  created_at: string;
}

const SEVERITY_ICON = {
  error:   <AlertCircle   className="w-3.5 h-3.5 shrink-0" style={{ color: '#dc2626' }} />,
  warning: <AlertTriangle className="w-3.5 h-3.5 shrink-0" style={{ color: '#d97706' }} />,
  info:    <Info          className="w-3.5 h-3.5 shrink-0" style={{ color: '#6366f1' }} />,
};

export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();

  const { data: notifications = [] } = useQuery<Notification[]>({
    queryKey: ['notifications'],
    queryFn: async () => {
      const res = await fetch('/api/notifications');
      if (!res.ok) return [];
      const json = await res.json() as { notifications?: Notification[] };
      return json.notifications ?? [];
    },
    staleTime: 60_000,
    refetchInterval: 5 * 60 * 1000,
  });

  // Supabase real-time
  useEffect(() => {
    const channel = supabase
      .channel('notifications-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications' }, () => {
        void qc.invalidateQueries({ queryKey: ['notifications'] });
      })
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [qc]);

  // Generate once per session (throttled to every 5 min)
  useEffect(() => {
    const key = 'notif_gen_at';
    const last = sessionStorage.getItem(key);
    const now = Date.now();
    if (!last || now - parseInt(last) > 5 * 60 * 1000) {
      sessionStorage.setItem(key, String(now));
      void fetch('/api/notifications/generate', { method: 'POST' });
    }
  }, []);

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
  }, [qc]);

  const unread = notifications.filter(n => !n.lu);
  const errors = unread.filter(n => n.severite === 'error').length;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(v => !v)}
        className="relative p-2 rounded-lg hover:bg-gray-100 transition-colors"
        aria-label="Alertes"
      >
        <Bell className="w-5 h-5 text-gray-600" />
        {unread.length > 0 && (
          <span
            className="absolute flex items-center justify-center rounded-full text-white font-bold"
            style={{
              top: -2, right: -2, minWidth: 17, height: 17,
              fontSize: 10, padding: '0 3px',
              backgroundColor: errors > 0 ? '#dc2626' : '#d97706',
            }}
          >
            {unread.length > 9 ? '9+' : unread.length}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className="absolute right-0 top-11 z-50 bg-white rounded-xl shadow-xl border border-gray-100 overflow-hidden"
            style={{ width: 380 }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-sm text-gray-900">Alertes</span>
                {unread.length > 0 && (
                  <span
                    className="rounded-full px-1.5 py-0.5 text-xs font-semibold text-white"
                    style={{ backgroundColor: errors > 0 ? '#dc2626' : '#d97706' }}
                  >
                    {unread.length}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                {unread.length > 0 && (
                  <button
                    onClick={markAllRead}
                    className="flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-700 px-2 py-1 rounded hover:bg-indigo-50 transition-colors"
                  >
                    <CheckCheck className="w-3.5 h-3.5" /> Tout lire
                  </button>
                )}
                <button onClick={() => setOpen(false)} className="p-1 rounded hover:bg-gray-100">
                  <X className="w-3.5 h-3.5 text-gray-400" />
                </button>
              </div>
            </div>

            {/* List */}
            <div className="max-h-[400px] overflow-y-auto divide-y divide-gray-50">
              {notifications.length === 0 ? (
                <div className="py-10 text-center">
                  <Bell className="w-8 h-8 mx-auto mb-2" style={{ color: '#e5e7eb' }} />
                  <p className="text-sm text-gray-400">Aucune alerte</p>
                  <p className="text-xs text-gray-300 mt-0.5">Tout est en ordre</p>
                </div>
              ) : (
                notifications.map(n => (
                  <div
                    key={n.id}
                    className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-gray-50/50"
                    style={{ backgroundColor: !n.lu ? 'rgba(238,242,255,0.4)' : undefined }}
                  >
                    <div className="mt-0.5">{SEVERITY_ICON[n.severite] ?? SEVERITY_ICON.info}</div>
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm leading-snug ${!n.lu ? 'font-medium text-gray-900' : 'text-gray-500'}`}>
                        {n.titre}
                      </p>
                      {n.message && (
                        <p className="text-xs text-gray-400 mt-0.5 leading-relaxed">{n.message}</p>
                      )}
                      <p className="text-xs mt-1" style={{ color: '#d1d5db' }}>{formatDate(n.created_at)}</p>
                    </div>
                    <div className="flex items-center gap-0.5 shrink-0 mt-0.5">
                      {n.lien && (
                        <Link
                          href={n.lien}
                          onClick={() => { setOpen(false); if (!n.lu) void markRead([n.id]); }}
                          className="p-1.5 rounded hover:bg-gray-100 transition-colors"
                          title="Voir le détail"
                        >
                          <ChevronRight className="w-3.5 h-3.5 text-gray-400" />
                        </Link>
                      )}
                      {!n.lu && (
                        <button
                          onClick={() => void markRead([n.id])}
                          className="p-1.5 rounded hover:bg-indigo-50 transition-colors"
                          style={{ color: '#818cf8' }}
                          title="Marquer comme lu"
                        >
                          <Check className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Footer */}
            <div className="px-4 py-2.5 border-t border-gray-100 bg-gray-50/50">
              <Link
                href="/alertes"
                onClick={() => setOpen(false)}
                className="text-xs text-indigo-600 hover:text-indigo-700 font-medium"
              >
                Voir toutes les alertes →
              </Link>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
