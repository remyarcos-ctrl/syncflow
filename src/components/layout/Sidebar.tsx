'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard, Mail, Package, FileText,
  Link2, AlertTriangle, ClipboardList, Building2, Settings,
  TrendingUp, X, Upload, Bell, Receipt, Bot, GitCompare
} from 'lucide-react';
import { cn } from '@/utils';

const navGroups = [
  {
    items: [
      { label: 'Dashboard',       href: '/dashboard',         icon: LayoutDashboard },
      { label: 'Emails',          href: '/emails',            icon: Mail },
    ],
  },
  {
    label: 'Réceptions',
    items: [
      { label: 'BE / Réceptions',  href: '/be-receptions',       icon: Package },
      { label: 'Rappro. pointage', href: '/rapprochement-pointage', icon: GitCompare },
      { label: 'Import PDF',       href: '/import',              icon: Upload },
    ],
  },
  {
    label: 'Finance',
    items: [
      { label: 'Factures',        href: '/factures',          icon: FileText },
      { label: 'À facturer',      href: '/a-facturer',        icon: Receipt },
      { label: 'Rapprochements',  href: '/rapprochements',    icon: Link2 },
      { label: 'Par fournisseur', href: '/rapprochements/par-fournisseur', icon: TrendingUp },
      { label: '3 Voies',         href: '/rapprochements/3-voies', icon: Link2 },
    ],
  },
  {
    label: 'Suivi',
    items: [
      { label: 'Alertes',         href: '/alertes',           icon: Bell },
      { label: 'Anomalies',       href: '/exceptions',        icon: AlertTriangle },
      { label: 'Actions Teddy',   href: '/teddy-actions',     icon: Bot },
      { label: 'Journal',         href: '/journal',           icon: ClipboardList },
    ],
  },
  {
    label: 'Admin',
    items: [
      { label: 'Fournisseurs',    href: '/fournisseurs',      icon: Building2 },
      { label: 'Paramètres',      href: '/settings',          icon: Settings },
    ],
  },
];

interface SidebarProps {
  onClose?: () => void;
}

export default function Sidebar({ onClose }: SidebarProps) {
  const pathname = usePathname();

  return (
    <div className="flex h-full flex-col bg-slate-950">
      {/* Logo */}
      <div className="flex items-center justify-between h-14 px-5 border-b border-slate-800 shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-indigo-400 to-indigo-600 flex items-center justify-center shadow-lg shadow-indigo-500/30">
            <Link2 className="w-3.5 h-3.5 text-white" />
          </div>
          <span className="font-bold text-sm text-white tracking-tight">SyncFlow</span>
        </div>
        {onClose && (
          <button onClick={onClose} className="lg:hidden p-1 rounded hover:bg-slate-800">
            <X className="w-4 h-4 text-slate-400" />
          </button>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-4">
        {navGroups.map((group, gi) => (
          <div key={gi}>
            {group.label && (
              <p className="px-3 mb-1 text-[10px] font-semibold uppercase tracking-widest text-slate-500">
                {group.label}
              </p>
            )}
            <div className="space-y-0.5">
              {group.items.map((item) => {
                const isActive =
                  pathname === item.href ||
                  (item.href !== '/dashboard' && pathname.startsWith(item.href));
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={onClose}
                    className={cn(
                      'flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-all',
                      isActive
                        ? 'bg-indigo-600 text-white font-medium shadow-sm shadow-indigo-900/50'
                        : 'text-slate-400 hover:bg-slate-800 hover:text-slate-100'
                    )}
                  >
                    <item.icon className={cn('w-4 h-4 shrink-0', isActive ? 'text-indigo-200' : 'text-slate-500')} />
                    {item.label}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className="px-5 py-3 border-t border-slate-800 shrink-0">
        <p className="text-xs text-slate-500">SD Équipements</p>
      </div>
    </div>
  );
}
