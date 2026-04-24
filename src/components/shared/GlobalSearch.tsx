'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { Search, Package, FileText, ShoppingCart, X } from 'lucide-react';

interface Result {
  id: string;
  type: 'be' | 'facture' | 'commande';
  label: string;
  sub: string;
  href: string;
}

export default function GlobalSearch() {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Result[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setResults([]); return; }

    const timer = setTimeout(async () => {
      setLoading(true);
      const [{ data: bes }, { data: factures }, { data: commandes }] = await Promise.all([
        supabase.from('be_receptions').select('id, numero_be, fournisseur').ilike('numero_be', `%${q}%`).limit(5),
        supabase.from('factures').select('id, numero_facture, fournisseur').ilike('numero_facture', `%${q}%`).limit(5),
        supabase.from('commandes').select('id, numero_commande_interne, fournisseur').ilike('numero_commande_interne', `%${q}%`).limit(5),
      ]);
      const r: Result[] = [
        ...(bes ?? []).map(b => ({ id: b.id, type: 'be' as const, label: b.numero_be, sub: b.fournisseur ?? '—', href: `/be-receptions/${b.id}` })),
        ...(factures ?? []).map(f => ({ id: f.id, type: 'facture' as const, label: f.numero_facture, sub: f.fournisseur ?? '—', href: `/factures/${f.id}` })),
        ...(commandes ?? []).map(c => ({ id: c.id, type: 'commande' as const, label: c.numero_commande_interne, sub: c.fournisseur ?? '—', href: `/commandes/${c.id}` })),
      ];
      setResults(r);
      setLoading(false);
    }, 280);

    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Ctrl+K shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); inputRef.current?.focus(); setOpen(true); }
      if (e.key === 'Escape') { setOpen(false); setQuery(''); }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  const icons = { be: Package, facture: FileText, commande: ShoppingCart };
  const labels = { be: 'BE', facture: 'Facture', commande: 'Commande' };
  const colors = { be: 'text-indigo-600 bg-indigo-50', facture: 'text-purple-600 bg-purple-50', commande: 'text-blue-600 bg-blue-50' };

  return (
    <div ref={containerRef} className="relative flex-1 max-w-sm">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
        <input
          ref={inputRef}
          value={query}
          onChange={e => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          placeholder="Rechercher… (Ctrl+K)"
          className="w-full h-8 pl-9 pr-8 rounded-lg border border-gray-200 bg-gray-50 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:bg-white transition-colors"
        />
        {query && (
          <button onClick={() => { setQuery(''); setResults([]); }} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {open && query.length >= 2 && (
        <div className="absolute top-full mt-1 left-0 right-0 bg-white rounded-xl border border-gray-200 shadow-lg z-50 overflow-hidden">
          {loading && <div className="px-4 py-3 text-xs text-gray-400">Recherche…</div>}
          {!loading && results.length === 0 && <div className="px-4 py-3 text-xs text-gray-400">Aucun résultat pour « {query} »</div>}
          {!loading && results.length > 0 && (
            <div className="divide-y divide-gray-50 max-h-72 overflow-y-auto">
              {results.map(r => {
                const Icon = icons[r.type];
                return (
                  <button
                    key={r.id}
                    className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50 text-left transition-colors"
                    onClick={() => { router.push(r.href); setOpen(false); setQuery(''); }}
                  >
                    <span className={`inline-flex items-center justify-center w-6 h-6 rounded-md text-xs font-bold shrink-0 ${colors[r.type]}`}>
                      <Icon className="w-3.5 h-3.5" />
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">{r.label}</p>
                      <p className="text-xs text-gray-400 truncate">{r.sub}</p>
                    </div>
                    <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${colors[r.type]}`}>{labels[r.type]}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
