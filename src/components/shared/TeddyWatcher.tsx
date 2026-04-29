'use client';

import { useEffect, useRef } from 'react';

export default function TeddyWatcher() {
  const lastNotifiedRef = useRef<Set<string>>(new Set());
  const permissionRef = useRef<NotificationPermission>('default');

  useEffect(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) return;

    // Request permission once
    if (Notification.permission === 'default') {
      void Notification.requestPermission().then(p => { permissionRef.current = p; });
    } else {
      permissionRef.current = Notification.permission;
    }

    const check = async () => {
      if (permissionRef.current !== 'granted') return;
      try {
        const res = await fetch('/api/teddy/watchdog');
        if (!res.ok) return;
        const { notifications } = await res.json() as { notifications: { title: string; body: string }[] };
        for (const notif of notifications) {
          const key = `${notif.title}:${notif.body}`;
          if (lastNotifiedRef.current.has(key)) continue;
          lastNotifiedRef.current.add(key);
          new Notification(notif.title, { body: notif.body, icon: '/favicon.ico' });
          // Clear the key after 30 min so it can notify again if still exceeded
          setTimeout(() => lastNotifiedRef.current.delete(key), 30 * 60 * 1000);
        }
      } catch {}
    };

    void check();
    const interval = setInterval(() => void check(), 5 * 60 * 1000); // every 5 min
    return () => clearInterval(interval);
  }, []);

  return null;
}
