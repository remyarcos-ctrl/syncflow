import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatEur(amount: number | null | undefined): string {
  if (amount == null) return '—';
  return amount.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

export function formatDate(date: string | null | undefined): string {
  if (!date) return '—';
  const d = new Date(date);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('fr-FR');
}

export function exportToCsv(
  filename: string,
  rows: Record<string, unknown>[],
  columns: Array<{ label: string; key?: string; getValue?: (row: Record<string, unknown>) => string }>
) {
  const header = columns.map((c) => c.label).join(';');
  const lines = rows.map((row) =>
    columns
      .map((c) => {
        const val = c.getValue ? c.getValue(row) : (row[c.key!] ?? '');
        return `"${String(val).replace(/"/g, '""')}"`;
      })
      .join(';')
  );
  const csv = [header, ...lines].join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
