'use client';

import { useState, useEffect } from 'react';
import { Menu } from 'lucide-react';
import Sidebar from '@/components/layout/Sidebar';
import GlobalSearch from '@/components/shared/GlobalSearch';
import ChatAssistant from '@/components/shared/ChatAssistant';
import TeddyWatcher from '@/components/shared/TeddyWatcher';
import NotificationBell from '@/components/shared/NotificationBell';
import { useQueryClient } from '@tanstack/react-query';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const qc = useQueryClient();

  useEffect(() => {
    const handler = () => void qc.invalidateQueries();
    window.addEventListener('teddy-data-changed', handler);
    return () => window.removeEventListener('teddy-data-changed', handler);
  }, [qc]);

  return (
    <div className="min-h-screen bg-slate-50 flex">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/20 backdrop-blur-sm lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar desktop */}
      <aside className="hidden lg:flex lg:w-60 lg:flex-col lg:fixed lg:inset-y-0 z-30">
        <Sidebar />
      </aside>

      {/* Sidebar mobile */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-60 transform transition-transform duration-200 ease-out lg:hidden ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <Sidebar onClose={() => setSidebarOpen(false)} />
      </aside>

      {/* Main */}
      <div className="flex-1 lg:pl-60 flex flex-col min-h-screen">
        {/* Topbar */}
        <header className="sticky top-0 z-20 h-14 bg-white/90 backdrop-blur-md border-b border-gray-200 flex items-center px-4 lg:px-6 shrink-0 gap-3 shadow-sm">
          <button
            onClick={() => setSidebarOpen(true)}
            className="lg:hidden p-2 -ml-2 rounded-lg hover:bg-gray-50"
          >
            <Menu className="w-5 h-5 text-gray-600" />
          </button>
          <GlobalSearch />
          <div className="ml-auto">
            <NotificationBell />
          </div>
        </header>

        {/* Content */}
        <main className="flex-1 p-4 lg:p-6 max-w-[1400px] mx-auto w-full">
          {children}
        </main>
      </div>

      <TeddyWatcher />
      <ChatAssistant />
    </div>
  );
}
