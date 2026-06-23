'use client';

import type { ReactNode } from 'react';
import { cn } from '@/utils';

const MOIS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];
const MOIS_LABEL = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Aoû', 'Sep', 'Oct', 'Nov', 'Déc'];

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'px-2.5 py-0.5 rounded-full text-xs font-medium transition-colors',
        active ? 'bg-indigo-600 text-white' : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50',
      )}
    >
      {children}
    </button>
  );
}

// Filtre période réutilisable : puces Année (+ puces Mois quand une année est choisie).
// `annees` = liste des années dispo (ex. ['2025','2026']). Les valeurs sont des chaînes
// ('' = toutes / tous, '2026', '03'). Choisir une année réinitialise le mois côté parent.
export default function PeriodeChips({
  annees, annee, mois, onAnnee, onMois,
}: {
  annees: string[];
  annee: string;
  mois: string;
  onAnnee: (a: string) => void;
  onMois: (m: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-gray-400 w-9 shrink-0">Année</span>
        <Chip active={annee === ''} onClick={() => onAnnee('')}>Toutes</Chip>
        {annees.map((a) => <Chip key={a} active={annee === a} onClick={() => onAnnee(a)}>{a}</Chip>)}
      </div>
      {annee !== '' && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-gray-400 w-9 shrink-0">Mois</span>
          <Chip active={mois === ''} onClick={() => onMois('')}>Tous</Chip>
          {MOIS.map((m, i) => <Chip key={m} active={mois === m} onClick={() => onMois(m)}>{MOIS_LABEL[i]}</Chip>)}
        </div>
      )}
    </div>
  );
}
