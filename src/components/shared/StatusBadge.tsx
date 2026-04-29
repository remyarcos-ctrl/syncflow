type StatusConfig = { label: string; bg: string; color: string; border: string };

const STATUS_MAP: Record<string, StatusConfig> = {
  // Commandes
  'ouverte':                      { label: 'Ouverte',          bg: '#dbeafe', color: '#1e40af', border: '#93c5fd' },
  'partiellement réceptionnée':   { label: 'Part. reçue',      bg: '#fef3c7', color: '#92400e', border: '#fbbf24' },
  'réceptionnée':                 { label: 'Réceptionnée',     bg: '#cffafe', color: '#155e75', border: '#67e8f9' },
  'partiellement facturée':       { label: 'Part. facturée',   bg: '#ffedd5', color: '#9a3412', border: '#fb923c' },
  'soldée':                       { label: 'Soldée',           bg: '#059669', color: '#ffffff', border: '#047857' },
  // BEs
  'reçu':                         { label: 'Reçu',             bg: '#dbeafe', color: '#1e40af', border: '#93c5fd' },
  'partiellement facturé':        { label: 'Part. facturé',    bg: '#fef3c7', color: '#92400e', border: '#fbbf24' },
  'facturé':                      { label: 'Facturé',          bg: '#cffafe', color: '#155e75', border: '#67e8f9' },
  'soldé':                        { label: 'Soldé',            bg: '#059669', color: '#ffffff', border: '#047857' },
  // Factures
  'importée':                     { label: 'Importée',         bg: '#f3f4f6', color: '#4b5563', border: '#d1d5db' },
  'en cours de rapprochement':    { label: 'En cours',         bg: '#ede9fe', color: '#5b21b6', border: '#c4b5fd' },
  'partiellement rapprochée':     { label: 'Part. rapprochée', bg: '#ffedd5', color: '#9a3412', border: '#fb923c' },
  'rapprochée':                   { label: 'Rapprochée',       bg: '#059669', color: '#ffffff', border: '#047857' },
  // Rapprochements
  'proposé':                      { label: 'Proposé',          bg: '#e0e7ff', color: '#3730a3', border: '#a5b4fc' },
  'validé':                       { label: 'Validé',           bg: '#059669', color: '#ffffff', border: '#047857' },
  'rejeté':                       { label: 'Rejeté',           bg: '#dc2626', color: '#ffffff', border: '#b91c1c' },
  'à revoir':                     { label: 'À revoir',         bg: '#f59e0b', color: '#451a03', border: '#d97706' },
  // Exceptions
  'en cours':                     { label: 'En cours',         bg: '#ede9fe', color: '#5b21b6', border: '#c4b5fd' },
  'résolue':                      { label: 'Résolue',          bg: '#059669', color: '#ffffff', border: '#047857' },
  'ignorée':                      { label: 'Ignorée',          bg: '#f3f4f6', color: '#9ca3af', border: '#e5e7eb' },
  // Sources
  'email':                        { label: 'Email',            bg: '#f3e8ff', color: '#6b21a8', border: '#d8b4fe' },
  'pdf':                          { label: 'PDF',              bg: '#fee2e2', color: '#991b1b', border: '#fca5a5' },
  'csv':                          { label: 'CSV',              bg: '#d1fae5', color: '#065f46', border: '#6ee7b7' },
  'manuel':                       { label: 'Manuel',           bg: '#f3f4f6', color: '#374151', border: '#d1d5db' },
  // Lignes commande
  'non reçue':                    { label: 'Non reçue',        bg: '#f3f4f6', color: '#6b7280', border: '#d1d5db' },
  'reçue':                        { label: 'Reçue',            bg: '#059669', color: '#ffffff', border: '#047857' },
  'partiellement reçue':          { label: 'Part. reçue',      bg: '#fef3c7', color: '#92400e', border: '#fbbf24' },
  'sur-réceptionné':              { label: 'Sur-réceptionné',  bg: '#f97316', color: '#ffffff', border: '#ea580c' },
  'sur-facturée':                 { label: 'Sur-facturée',     bg: '#dc2626', color: '#ffffff', border: '#b91c1c' },
  'en anomalie':                  { label: 'Anomalie',         bg: '#dc2626', color: '#ffffff', border: '#b91c1c' },
};

export default function StatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return null;
  const cfg = STATUS_MAP[status.toLowerCase()] ?? {
    label: status, bg: '#f3f4f6', color: '#374151', border: '#d1d5db',
  };
  return (
    <span
      style={{ backgroundColor: cfg.bg, color: cfg.color, borderColor: cfg.border }}
      className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold"
    >
      {cfg.label}
    </span>
  );
}
