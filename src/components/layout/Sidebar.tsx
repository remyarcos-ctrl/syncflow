'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard, Mail, ShoppingCart, Package, FileText,
  Link2, AlertTriangle, ClipboardList, Building2, Settings,
  TrendingUp, X, PackageOpen, Upload
} from 'lucide-react';
import { cn } from '@/utils';

const navItems = [
  { label: 'Dashboard',       href: '/dashboard',         icon: LayoutDashboard },
  { label: 'Emails',          href: '/emails',            icon: Mail },
  { label: 'Commandes',       href: '/commandes',         icon: ShoppingCart },
  { label: 'BE / Réceptions', href: '/be-receptions',     icon: Package },
  { label: 'Surplus / Libres', href: '/surplus',           icon: PackageOpen },
  { label: 'Import PDF',      href: '/import',            icon: Upload },
  { label: 'Factures',        href: '/factures',          icon: FileText },
  { label: 'Rapprochements',  href: '/rapprochements',    icon: Link2 },
  { label: 'Par fournisseur', href: '/rapprochements/par-fournisseur', icon: TrendingUp },
  { label: '3 Voies',         href: '/rapprochements/3-voies', icon: Link2 },
  { label: 'Anomalies',       href: '/exceptions',        icon: AlertTriangle },
  { label: 'Journal',         href: '/journal',           icon: ClipboardList },
  { label: 'Fournisseurs',    href: '/fournisseurs',      icon: Building2 },
  { label: 'Paramètres',      href: '/settings',          icon: Settings },
];

interface SidebarProps {
  onClose?: () => void;
}

export default function Sidebar({ onClose }: SidebarProps) {
  const pathname = usePathname();

  return (
    <div className="flex h-full flex-col bg-white border-r border-gray-100">
      {/* Logo */}
      <div className="flex items-center justify-between h-14 px-5 border-b border-gray-100 shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-indigo-500 to-indigo-600 flex items-center justify-center shadow-sm">
            <Link2 className="w-3.5 h-3.5 text-white" />
          </div>
          <span className="font-bold text-sm text-gray-900 tracking-tight">SyncFlow</span>
        </div>
        {onClose && (
          <button onClick={onClose} className="lg:hidden p-1 rounded hover:bg-gray-50">
            <X className="w-4 h-4 text-gray-400" />
          </button>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto p-3 space-y-0.5">
        {navItems.map((item) => {
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
                  ? 'bg-indigo-50 text-indigo-700 font-medium'
                  : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
              )}
            >
              <item.icon
                className={cn('w-4 h-4 shrink-0', isActive ? 'text-indigo-500' : 'text-gray-400')}
              />
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="px-5 py-3 border-t border-gray-100 shrink-0">
        <p className="text-xs text-gray-400">SD Équipements</p>
      </div>
    </div>
  );
}
