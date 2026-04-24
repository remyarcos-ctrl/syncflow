import { ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/utils';
import type { SortDir } from '@/hooks/useTableFeatures';

interface Props {
  label: string;
  field: string;
  sortKey: string | null;
  sortDir: SortDir;
  onSort: (key: string) => void;
  align?: 'left' | 'right';
  className?: string;
}

export default function SortableHeader({ label, field, sortKey, sortDir, onSort, align = 'left', className }: Props) {
  const active = sortKey === field;
  return (
    <th
      onClick={() => onSort(field)}
      className={cn(
        'px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide cursor-pointer select-none group',
        align === 'right' ? 'text-right' : 'text-left',
        active && 'text-indigo-600',
        className,
      )}
    >
      <span className={cn('inline-flex items-center gap-1', align === 'right' && 'flex-row-reverse')}>
        {label}
        {active
          ? sortDir === 'asc' ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />
          : <ChevronsUpDown className="w-3 h-3 opacity-0 group-hover:opacity-40" />}
      </span>
    </th>
  );
}
