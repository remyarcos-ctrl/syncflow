import { useState, useMemo, useCallback } from 'react';

export type SortDir = 'asc' | 'desc';

interface TableFeaturesOptions {
  initialSortKey?: string;
  initialSortDir?: SortDir;
}

export function useTableFeatures<T extends { id: string }>(data: T[], options: TableFeaturesOptions = {}) {
  const [sortKey, setSortKey] = useState<string | null>(options.initialSortKey ?? null);
  const [sortDir, setSortDir] = useState<SortDir>(options.initialSortDir ?? 'asc');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggleSort = useCallback((key: string) => {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  }, [sortKey]);

  const sorted = useMemo(() => {
    if (!sortKey) return data;
    return [...data].sort((a, b) => {
      const av = (a as Record<string, unknown>)[sortKey];
      const bv = (b as Record<string, unknown>)[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      const cmp = typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv), 'fr', { sensitivity: 'base' });
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [data, sortKey, sortDir]);

  const toggleOne = (id: string) => {
    setSelected(s => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };

  const togglePage = (ids: string[]) => {
    const allChecked = ids.length > 0 && ids.every(id => selected.has(id));
    setSelected(s => {
      const n = new Set(s);
      if (allChecked) ids.forEach(id => n.delete(id));
      else ids.forEach(id => n.add(id));
      return n;
    });
  };

  const clearSelection = () => setSelected(new Set());

  const isPageChecked = (ids: string[]) => ids.length > 0 && ids.every(id => selected.has(id));
  const isPageIndeterminate = (ids: string[]) => ids.some(id => selected.has(id)) && !isPageChecked(ids);

  return {
    sorted, sortKey, sortDir, toggleSort,
    selected, toggleOne, togglePage, clearSelection,
    isPageChecked, isPageIndeterminate,
  };
}
