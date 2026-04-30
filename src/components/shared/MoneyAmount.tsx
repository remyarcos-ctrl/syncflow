'use client';

import { useDisplayCurrency } from '@/contexts/DisplayCurrencyContext';
import { formatEur } from '@/utils';
import { cn } from '@/utils';

interface MoneyAmountProps {
  ht?: number | null;
  ttc?: number | null;
  className?: string;
}

export function MoneyAmount({ ht, ttc, className }: MoneyAmountProps) {
  const { showTTC, toggle } = useDisplayCurrency();
  const hasTTC = ttc !== null && ttc !== undefined;
  const value = showTTC && hasTTC ? ttc : ht;

  if (!hasTTC) {
    return <span className={className}>{formatEur(ht)}</span>;
  }

  return (
    <button
      type="button"
      onClick={e => { e.stopPropagation(); toggle(); }}
      title={showTTC ? `Voir en HT : ${formatEur(ht)}` : `Voir en TTC : ${formatEur(ttc)}`}
      className={cn('cursor-pointer hover:opacity-70 transition-opacity', className)}
    >
      {formatEur(value)}
      {showTTC && <span className="ml-0.5 text-[10px] opacity-50 font-sans not-italic">TTC</span>}
    </button>
  );
}
