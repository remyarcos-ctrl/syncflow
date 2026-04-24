import { cn } from '@/utils';

const STATUS_MAP: Record<string, { label: string; className: string }> = {
  // Commandes
  ouverte:                    { label: 'Ouverte',           className: 'bg-blue-50 text-blue-700 border-blue-200' },
  'partiellement réceptionnée': { label: 'Part. reçue',     className: 'bg-amber-50 text-amber-700 border-amber-200' },
  réceptionnée:               { label: 'Réceptionnée',      className: 'bg-cyan-50 text-cyan-700 border-cyan-200' },
  'partiellement facturée':   { label: 'Part. facturée',    className: 'bg-orange-50 text-orange-700 border-orange-200' },
  soldée:                     { label: 'Soldée',            className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  // BEs
  reçu:                       { label: 'Reçu',              className: 'bg-blue-50 text-blue-700 border-blue-200' },
  'partiellement facturé':    { label: 'Part. facturé',     className: 'bg-amber-50 text-amber-700 border-amber-200' },
  facturé:                    { label: 'Facturé',           className: 'bg-cyan-50 text-cyan-700 border-cyan-200' },
  soldé:                      { label: 'Soldé',             className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  // Factures
  importée:                   { label: 'Importée',          className: 'bg-gray-50 text-gray-600 border-gray-200' },
  'en cours de rapprochement': { label: 'En cours',         className: 'bg-amber-50 text-amber-700 border-amber-200' },
  'partiellement rapprochée': { label: 'Part. rapprochée',  className: 'bg-orange-50 text-orange-700 border-orange-200' },
  rapprochée:                 { label: 'Rapprochée',        className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  // Rapprochements
  proposé:                    { label: 'Proposé',           className: 'bg-indigo-50 text-indigo-700 border-indigo-200' },
  validé:                     { label: 'Validé',            className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  rejeté:                     { label: 'Rejeté',            className: 'bg-red-50 text-red-700 border-red-200' },
  'à revoir':                 { label: 'À revoir',          className: 'bg-amber-50 text-amber-700 border-amber-200' },
  // Exceptions
  'en cours':                 { label: 'En cours',          className: 'bg-blue-50 text-blue-700 border-blue-200' },
  résolue:                    { label: 'Résolue',           className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  ignorée:                    { label: 'Ignorée',           className: 'bg-gray-50 text-gray-500 border-gray-200' },
  // Sources
  email:  { label: 'Email',  className: 'bg-purple-50 text-purple-700 border-purple-200' },
  pdf:    { label: 'PDF',    className: 'bg-red-50 text-red-600 border-red-200' },
  csv:    { label: 'CSV',    className: 'bg-green-50 text-green-700 border-green-200' },
  manuel: { label: 'Manuel', className: 'bg-gray-50 text-gray-600 border-gray-200' },
  // Statut lignes commande
  'non reçue':           { label: 'Non reçue',      className: 'bg-gray-50 text-gray-500 border-gray-200' },
  reçue:                 { label: 'Reçue',           className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  'partiellement reçue': { label: 'Part. reçue',    className: 'bg-amber-50 text-amber-700 border-amber-200' },
  'sur-réceptionné':     { label: 'Sur-réceptionné', className: 'bg-orange-50 text-orange-700 border-orange-200' },
  'sur-facturée':        { label: 'Sur-facturée',   className: 'bg-red-50 text-red-700 border-red-200' },
  // Anomalie (partagé)
  'en anomalie': { label: 'Anomalie', className: 'bg-red-50 text-red-700 border-red-200' },
};

export default function StatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return null;
  const cfg = STATUS_MAP[status.toLowerCase()] ?? { label: status, className: 'bg-gray-50 text-gray-600 border-gray-200' };
  return (
    <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium', cfg.className)}>
      {cfg.label}
    </span>
  );
}
