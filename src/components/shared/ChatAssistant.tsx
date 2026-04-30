'use client';

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { usePathname } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  Bot, Send, X, Loader2, Sparkles, User, RotateCcw,
  ImagePlus, Zap, BarChart2, AlertTriangle, Clock, Wrench, ChevronRight,
  Sun, CheckCheck, Package, HelpCircle, Bell, Download, TrendingUp,
  ThumbsUp, ThumbsDown,
} from 'lucide-react';
import { cn } from '@/utils';

// ── Types ────────────────────────────────────────────────────────────────────

interface PendingImage { base64: string; mimeType: string }
interface Message {
  role: 'user' | 'assistant';
  content: string;
  images?: PendingImage[];
  exportFile?: { filename: string; b64: string };
  quickActions?: { label: string; prompt: string; icon: string }[];
}

// ── Tool name labels ─────────────────────────────────────────────────────────

const TOOL_LABELS: Record<string, string> = {
  get_morning_brief: 'Brief du jour',
  get_kpis: 'Lecture des KPIs',
  list_factures: 'Recherche factures',
  list_be_receptions: 'Recherche BEs',
  list_commandes: 'Recherche commandes',
  list_exceptions: 'Recherche anomalies',
  list_rapprochements: 'Recherche rapprochements',
  get_fournisseur_stats: 'Stats fournisseur',
  get_activite_recente: 'Activité récente',
  lancer_matching: 'Matching automatique',
  valider_rapprochements: 'Validation rapprochements',
  resoudre_exceptions: 'Résolution exceptions',
  lancer_scan_gmail: 'Scan Gmail',
  mettre_a_jour_prix: 'Mise à jour prix',
  mettre_a_jour_lignes_commande: 'Mise à jour commande',
  get_exception_detail: 'Analyse anomalie',
  corriger_ecart_prix: 'Correction prix',
  forcer_rapprochement_manuel: 'Rapprochement manuel',
  rechercher_be_pour_facture: 'Recherche BE',
  annoter_exception: 'Annotation',
  get_contacts_fournisseur: 'Contacts fournisseur',
  envoyer_email: 'Envoi email',
  lier_be_commande: 'Liaison BE-commande',
  get_alertes: 'Lecture alertes',
  creer_commande: 'Création commande',
  get_detail_commande: 'Détail commande',
  get_detail_be: 'Détail BE',
  get_tendances: 'Analyse tendances',
  recherche_avancee: 'Recherche avancée',
  traitement_conditionnel: 'Traitement en masse',
  exporter_csv: 'Export CSV',
  lire_memoire_teddy: 'Lecture mémoire',
  sauvegarder_memoire_teddy: 'Mémorisation',
  analyser_et_proposer: 'Analyse proactive',
  voir_actions_proposees: 'Actions en attente',
  approuver_actions_teddy: 'Approbation actions',
  rejeter_actions_teddy: 'Rejet actions',
  modifier_commande: 'Modification commande',
  modifier_ligne_commande: 'Modification ligne commande',
  modifier_facture: 'Modification facture',
  modifier_ligne_facture: 'Modification ligne facture',
  modifier_be: 'Modification BE',
  analyser_patterns_fournisseur: 'Analyse patterns fournisseur',
  analyser_ecarts_prix_fournisseur: 'Analyse écarts prix',
  get_flux_tresorerie: 'Flux de trésorerie',
  detecter_surfacturations: 'Détection surfacturations',
  get_bes_sur_factures: 'BEs sur factures',
  planifier_rappel: 'Rappel planifié',
  rapport_complet_fournisseur: 'Rapport fournisseur',
  synthese_mensuelle: 'Synthèse mensuelle',
};

// ── Workflows ────────────────────────────────────────────────────────────────

const WORKFLOWS = [
  {
    label: 'Traiter anomalies',
    icon: AlertTriangle,
    prompt: 'Gère toutes les anomalies ouvertes selon la procédure standard : traite automatiquement celles avec écart ≤ 5%, présente-moi les autres pour validation.',
  },
  {
    label: 'Valider rapprochements',
    icon: CheckCheck,
    prompt: 'Valide tous les rapprochements proposés avec un score ≥ 0.85.',
  },
  {
    label: 'Sync + matching',
    icon: Zap,
    prompt: 'Lance le scan Gmail pour importer les nouvelles commandes, puis le matching automatique sur toutes les factures non rapprochées.',
  },
  {
    label: 'Clôture fournisseur',
    icon: Package,
    prompt: 'Je veux faire la clôture complète d\'un fournisseur : liste les factures non soldées, les BEs en attente et les anomalies. Quel fournisseur ?',
  },
];

// ── Context-aware chips ──────────────────────────────────────────────────────

type Chip = { icon: React.ElementType; label: string; prompt: string };

function getContextChips(pathname: string): Chip[] {
  if (/^\/commandes\/[^/]+/.test(pathname)) return [
    { icon: BarChart2,    label: 'Résumé',      prompt: 'Fais le résumé de cette commande.' },
    { icon: CheckCheck,   label: 'Facture liée', prompt: 'Y a-t-il une facture liée à cette commande ?' },
    { icon: Package,      label: 'BEs liés',     prompt: 'Quels BEs sont liés à cette commande ?' },
    { icon: AlertTriangle,label: 'Anomalies',    prompt: 'Y a-t-il des anomalies sur cette commande ?' },
  ];
  if (pathname.startsWith('/commandes')) return [
    { icon: Clock,         label: 'En retard',        prompt: 'Quelles commandes sont en retard ou non soldées ?' },
    { icon: AlertTriangle, label: 'Anomalies',         prompt: 'Liste les commandes avec des anomalies.' },
    { icon: TrendingUp,    label: 'Top fournisseurs',  prompt: 'Quels sont mes top fournisseurs par montant commandé ?' },
    { icon: Download,      label: 'Export',            prompt: 'Exporte les commandes en CSV.' },
  ];
  if (/^\/factures\/[^/]+/.test(pathname)) return [
    { icon: Zap,           label: 'Rapprocher',  prompt: 'Lance le rapprochement pour cette facture.' },
    { icon: BarChart2,     label: 'Résumé',      prompt: 'Fais le résumé de cette facture.' },
    { icon: Wrench,        label: 'Corriger',    prompt: 'Y a-t-il des écarts à corriger sur cette facture ?' },
    { icon: AlertTriangle, label: 'Anomalies',   prompt: 'Y a-t-il des anomalies sur cette facture ?' },
  ];
  if (pathname.startsWith('/factures')) return [
    { icon: AlertTriangle, label: 'Non rapprochées', prompt: 'Quelles factures ne sont pas encore rapprochées ?' },
    { icon: Zap,           label: 'Lancer matching', prompt: 'Lance le matching automatique sur toutes les factures non rapprochées.' },
    { icon: Clock,         label: 'Échues',          prompt: 'Quelles factures sont échues ou en retard de paiement ?' },
    { icon: Download,      label: 'Export',          prompt: 'Exporte les factures en CSV.' },
  ];
  if (/^\/be-receptions\/[^/]+/.test(pathname)) return [
    { icon: BarChart2,  label: 'Résumé',      prompt: 'Fais le résumé de ce bon d\'entrée.' },
    { icon: CheckCheck, label: 'Facture liée', prompt: 'Y a-t-il une facture liée à ce BE ?' },
    { icon: Zap,        label: 'Rapprocher',  prompt: 'Lance le rapprochement pour ce BE.' },
  ];
  if (pathname.startsWith('/be-receptions')) return [
    { icon: Clock,      label: 'BEs anciens', prompt: 'Quels BEs sont en attente depuis plus de 14 jours ?' },
    { icon: Zap,        label: 'Matching',    prompt: 'Lance le matching automatique sur tous les BEs en attente.' },
    { icon: CheckCheck, label: 'À valider',   prompt: 'Quels BEs sont prêts à être validés ?' },
    { icon: Download,   label: 'Export',      prompt: 'Exporte les BEs en CSV.' },
  ];
  if (pathname.startsWith('/prix-reference')) return [
    { icon: TrendingUp,    label: 'Écarts prix', prompt: 'Y a-t-il des références avec des écarts de prix suspects ?' },
    { icon: BarChart2,     label: 'Top refs',    prompt: 'Quelles sont les références les plus commandées ?' },
    { icon: Download,      label: 'Export',      prompt: 'Exporte le catalogue prix en CSV.' },
  ];
  if (pathname.startsWith('/exceptions')) return [
    { icon: Wrench,        label: 'Résoudre auto',  prompt: 'Résous automatiquement les exceptions avec un écart ≤ 5%.' },
    { icon: AlertTriangle, label: 'Priorité haute', prompt: 'Liste les exceptions de priorité haute.' },
    { icon: BarChart2,     label: 'Par fournisseur',prompt: 'Résume les exceptions ouvertes par fournisseur.' },
  ];
  return [
    { icon: Sun,           label: 'Brief',   prompt: 'Briefing du jour' },
    { icon: AlertTriangle, label: 'Audit',   prompt: 'Fais un audit complet et donne-moi le score de santé.' },
    { icon: BarChart2,     label: 'Rapport', prompt: 'Génère le bilan global : commandes, factures, BEs, top fournisseurs.' },
    { icon: Download,      label: 'Export',  prompt: 'Exporte les commandes en CSV.' },
  ];
}

// ── Help categories ──────────────────────────────────────────────────────────

const HELP_CATEGORIES = [
  {
    icon: BarChart2, color: '#6366f1', bg: '#eef2ff',
    label: 'Analyse & reporting',
    examples: ['Briefing du jour', 'KPIs du moment', 'Stats fournisseur SONEPAR'],
  },
  {
    icon: TrendingUp, color: '#8b5cf6', bg: '#ede9fe',
    label: 'Tendances & export',
    examples: ['Tendances des prix sur 6 mois', 'Exporte les factures non soldées en CSV', 'Anomalies du mois en cours'],
  },
  {
    icon: Clock, color: '#0ea5e9', bg: '#e0f2fe',
    label: 'Recherche avancée',
    examples: ['Factures COLOMBI > 5000€ en anomalie', 'BEs non facturés depuis 7 jours', 'Commandes ouvertes ce mois'],
  },
  {
    icon: Zap, color: '#f59e0b', bg: '#fef3c7',
    label: 'Matching & rapprochements',
    examples: ['Lance le matching sur toutes les factures', 'Valide les rapprochements avec score ≥ 0.85', 'Rapprochements proposés en attente'],
  },
  {
    icon: AlertTriangle, color: '#ef4444', bg: '#fee2e2',
    label: 'Anomalies',
    examples: ['Traiter toutes les anomalies', 'Anomalies critiques', 'Corriger les écarts de prix'],
  },
  {
    icon: Package, color: '#10b981', bg: '#d1fae5',
    label: 'Commandes & BEs',
    examples: ['Créer une commande', 'Lier un BE à une commande', 'Détail commande BC-2025-001'],
  },
  {
    icon: Send, color: '#8b5cf6', bg: '#ede9fe',
    label: 'Emails fournisseurs',
    examples: ['Email relance livraison SONEPAR', 'Contacts fournisseur COLOMBI', 'Rédiger une demande d\'avoir'],
  },
  {
    icon: RotateCcw, color: '#f97316', bg: '#ffedd5',
    label: 'Import Gmail',
    examples: ['Scan Gmail', 'Scan Gmail filtre COLOMBI', 'Forcer le scan Gmail (force)'],
  },
  {
    icon: Bell, color: '#d97706', bg: '#fef3c7',
    label: 'Alertes',
    examples: ['Voir les alertes non lues', 'Alertes critiques', 'Gérer les alertes'],
  },
];

// ── Page-specific suggestions ────────────────────────────────────────────────

const PAGE_SUGGESTIONS: Record<string, { label: string; icon: React.ElementType }[]> = {
  '/commandes': [
    { label: 'Commandes ouvertes ce mois', icon: Package },
    { label: 'Lancer le scan Gmail', icon: Zap },
    { label: 'Commandes sans BE associé', icon: AlertTriangle },
    { label: 'Exporter les commandes en CSV', icon: Download },
  ],
  '/be-receptions': [
    { label: 'BEs non facturés depuis 7 jours', icon: AlertTriangle },
    { label: 'Réceptions du jour', icon: Package },
    { label: 'Lier un BE à une commande', icon: Zap },
    { label: 'BEs avec écart de prix', icon: TrendingUp },
  ],
  '/factures': [
    { label: 'Factures non rapprochées', icon: AlertTriangle },
    { label: 'Lancer le matching', icon: Zap },
    { label: 'Exporter les factures en CSV', icon: Download },
    { label: 'Factures COLOMBI > 5000€', icon: BarChart2 },
  ],
  '/rapprochements': [
    { label: 'Valider rapprochements ≥ 0.85', icon: CheckCheck },
    { label: 'Rapprochements proposés en attente', icon: Zap },
    { label: 'Anomalies en attente', icon: AlertTriangle },
    { label: 'Stats par fournisseur', icon: BarChart2 },
  ],
  '/exceptions': [
    { label: 'Traiter toutes les anomalies', icon: AlertTriangle },
    { label: 'Anomalies critiques', icon: AlertTriangle },
    { label: 'Corriger les écarts de prix', icon: CheckCheck },
    { label: 'Anomalies du mois en cours', icon: Clock },
  ],
  '/dashboard': [
    { label: 'Briefing du jour', icon: Sun },
    { label: 'KPIs du moment', icon: BarChart2 },
    { label: 'Tendances des prix sur 6 mois', icon: TrendingUp },
    { label: 'Lancer le scan Gmail', icon: Zap },
  ],
  '/alertes': [
    { label: 'Voir les alertes non lues', icon: Bell },
    { label: 'Alertes critiques', icon: AlertTriangle },
    { label: 'Marquer toutes les alertes comme lues', icon: CheckCheck },
    { label: 'Briefing du jour', icon: Sun },
  ],
};

const PAGE_HELP: Record<string, { label: string; examples: string[] }> = {
  '/commandes': {
    label: 'Sur la page Commandes',
    examples: [
      'Commandes ouvertes sans BE depuis 5 jours',
      'Créer une commande pour SONEPAR',
      'Commandes COLOMBI ce mois',
      'Modifier le statut de BC-2025-001',
    ],
  },
  '/be-receptions': {
    label: 'Sur la page BEs / Réceptions',
    examples: [
      'BEs non facturés depuis 7 jours',
      'Lier le BE 12345 à la commande BC-001',
      'Réceptions du jour',
      'BEs avec écart de prix',
    ],
  },
  '/factures': {
    label: 'Sur la page Factures',
    examples: [
      'Factures COLOMBI non soldées',
      'Lancer le matching automatique',
      'Exporter les factures en CSV',
      'Factures > 5000€ en anomalie',
    ],
  },
  '/rapprochements': {
    label: 'Sur la page Rapprochements',
    examples: [
      'Valider tous les rapprochements ≥ 0.85',
      'Rapprochements en attente SONEPAR',
      'Lancer le matching sur toutes les factures',
      'Anomalies de rapprochement',
    ],
  },
  '/exceptions': {
    label: 'Sur la page Anomalies',
    examples: [
      'Traiter toutes les anomalies ouvertes',
      'Anomalies critiques uniquement',
      'Corriger les écarts de prix < 5%',
      'Anomalies du mois en cours',
    ],
  },
  '/dashboard': {
    label: 'Sur le Dashboard',
    examples: [
      'Briefing du jour complet',
      'KPIs du moment',
      'Tendances des prix sur 6 mois',
      'Résumé activité de la semaine',
    ],
  },
  '/alertes': {
    label: 'Sur la page Alertes',
    examples: [
      'Lire toutes les alertes non lues',
      'Alertes critiques uniquement',
      'Marquer toutes les alertes comme lues',
      'Alertes fournisseur COLOMBI',
    ],
  },
};

// ── Slash commands ───────────────────────────────────────────────────────────

const SLASH_COMMANDS = [
  { cmd: '/brief',     label: 'Briefing du jour',           prompt: 'Briefing du jour' },
  { cmd: '/kpis',      label: 'KPIs du moment',             prompt: 'KPIs du moment' },
  { cmd: '/scan',      label: 'Scan Gmail',                 prompt: 'Lance le scan Gmail' },
  { cmd: '/matching',  label: 'Lancer le matching',         prompt: 'Lance le matching automatique sur toutes les factures non rapprochées.' },
  { cmd: '/anomalies', label: 'Traiter les anomalies',      prompt: 'Gère toutes les anomalies ouvertes selon la procédure standard.' },
  { cmd: '/valider',   label: 'Valider rapprochements',     prompt: 'Valide tous les rapprochements proposés avec un score ≥ 0.85.' },
  { cmd: '/export',    label: 'Export CSV',                 prompt: 'Exporte les données en CSV.' },
  { cmd: '/memoire',   label: 'Lire la mémoire',            prompt: 'Montre-moi tout ce que tu as mémorisé.' },
];

// ── Markdown renderer ────────────────────────────────────────────────────────

function renderInline(text: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\[[^\]]+\]\([^)]+\))/g);
  return parts.map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**')) return <strong key={i}>{p.slice(2, -2)}</strong>;
    if (p.startsWith('*') && p.endsWith('*')) return <em key={i}>{p.slice(1, -1)}</em>;
    if (p.startsWith('`') && p.endsWith('`')) return (
      <code key={i} className="px-1 py-0.5 rounded text-[10px] font-mono" style={{ backgroundColor: 'rgba(0,0,0,0.12)' }}>{p.slice(1, -1)}</code>
    );
    if (p.startsWith('[')) {
      const m = p.match(/^\[([^\]]+)\]\(([^)]+)\)/);
      if (m) return (
        <a key={i} href={m[2]} className="underline font-medium hover:opacity-80 transition-opacity" style={{ color: '#6366f1' }}>
          {m[1]}
        </a>
      );
    }
    return p;
  });
}

function StatusCell({ value }: { value: string }) {
  const lower = value.toLowerCase();
  const patterns: [RegExp, string, string][] = [
    [/validé|soldé|résolue|rapprochée|facturé$|complet/, '#dcfce7', '#15803d'],
    [/anomalie|rejeté|critique|erreur/, '#fee2e2', '#dc2626'],
    [/proposé|partiellement|en attente/, '#fef3c7', '#d97706'],
    [/en cours|ouverte/, '#dbeafe', '#1d4ed8'],
    [/ignorée|archivée/, '#f3f4f6', '#6b7280'],
  ];
  for (const [pattern, bg, color] of patterns) {
    if (pattern.test(lower)) {
      return (
        <span className="inline-block px-1.5 py-0.5 rounded text-[9px] font-medium leading-tight" style={{ backgroundColor: bg, color }}>
          {value}
        </span>
      );
    }
  }
  return <>{renderInline(value)}</>;
}

function MarkdownContent({ text, isUser }: { text: string; isUser?: boolean }) {
  const lines = text.split('\n');
  const nodes: React.ReactNode[] = [];
  let i = 0;
  let k = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Chart block
    if (line.startsWith('```chart')) {
      const chartLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) { chartLines.push(lines[i]); i++; }
      i++;
      const parseAttr = (key: string) => chartLines.find(l => l.startsWith(`${key}:`))?.split(':').slice(1).join(':').trim() ?? '';
      const chartType = parseAttr('type') || 'bar';
      const title = parseAttr('title');
      const rawLabels = parseAttr('labels').split(',').map(s => s.trim());
      const rawValues = parseAttr('values').split(',').map(s => parseFloat(s.trim())).filter(n => !isNaN(n));
      const max = Math.max(...rawValues, 0.01);
      const W = 280; const H = 110; const BAR_W = Math.min(28, (W - 20) / Math.max(rawValues.length, 1) - 4);
      const spacing = (W - 20) / Math.max(rawValues.length, 1);
      nodes.push(
        <div key={k++} className="my-2 rounded-xl border overflow-hidden" style={{ borderColor: 'rgba(0,0,0,0.08)', backgroundColor: '#fafafa' }}>
          {title && <p className="text-[9px] font-semibold text-center pt-2 pb-0.5 text-gray-500">{title}</p>}
          <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="mx-auto block">
            {rawValues.map((v, idx) => {
              const barH = Math.max(4, (v / max) * (H - 30));
              const x = 10 + idx * spacing + (spacing - BAR_W) / 2;
              const y = H - 18 - barH;
              const isLine = chartType === 'line';
              if (isLine) return null;
              return (
                <g key={idx}>
                  <rect x={x} y={y} width={BAR_W} height={barH} rx={3} fill="#6366f1" opacity={0.8} />
                  <text x={x + BAR_W / 2} y={y - 2} textAnchor="middle" fontSize={7} fill="#64748b">{v % 1 === 0 ? v : v.toFixed(2)}</text>
                  <text x={x + BAR_W / 2} y={H - 4} textAnchor="middle" fontSize={7} fill="#94a3b8">{rawLabels[idx]?.slice(0, 5) ?? ''}</text>
                </g>
              );
            })}
            {chartType === 'line' && rawValues.length > 1 && (() => {
              const pts = rawValues.map((v, idx) => {
                const x = 10 + idx * spacing + spacing / 2;
                const y = H - 18 - Math.max(4, (v / max) * (H - 30));
                return { x, y, v, label: rawLabels[idx] ?? '' };
              });
              const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
              return (
                <>
                  <path d={d} fill="none" stroke="#6366f1" strokeWidth={2} strokeLinejoin="round" />
                  {pts.map((p, i) => (
                    <g key={i}>
                      <circle cx={p.x} cy={p.y} r={3} fill="#6366f1" />
                      <text x={p.x} y={p.y - 5} textAnchor="middle" fontSize={7} fill="#64748b">{p.v % 1 === 0 ? p.v : p.v.toFixed(2)}</text>
                      <text x={p.x} y={H - 4} textAnchor="middle" fontSize={7} fill="#94a3b8">{p.label.slice(0, 5)}</text>
                    </g>
                  ))}
                </>
              );
            })()}
          </svg>
        </div>
      );
      continue;
    }

    // Code block
    if (line.startsWith('```')) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) { codeLines.push(lines[i]); i++; }
      nodes.push(
        <pre key={k++} className="rounded-lg p-2.5 my-1.5 text-[10px] font-mono overflow-x-auto" style={{ backgroundColor: isUser ? 'rgba(0,0,0,0.2)' : '#1e293b', color: '#e2e8f0' }}>
          {codeLines.join('\n')}
        </pre>
      );
      i++; continue;
    }

    // Header
    const hMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (hMatch) {
      const size = hMatch[1].length;
      const sizes = ['text-sm font-bold mt-2 mb-0.5', 'text-xs font-bold mt-1.5 mb-0.5', 'text-xs font-semibold mt-1'];
      nodes.push(<p key={k++} className={sizes[size - 1]}>{renderInline(hMatch[2])}</p>);
      i++; continue;
    }

    // Markdown table: first line starts with | and next is a separator
    if (line.startsWith('|') && i + 1 < lines.length && /^\|[-|: ]+\|/.test(lines[i + 1])) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) { tableLines.push(lines[i]); i++; }
      const parseRow = (row: string) => row.split('|').slice(1, -1).map(c => c.trim());
      const headers = parseRow(tableLines[0]);
      const dataRows = tableLines.slice(2).map(parseRow);
      nodes.push(
        <div key={k++} className="overflow-x-auto my-2 rounded-lg border" style={{ borderColor: 'rgba(0,0,0,0.08)' }}>
          <table className="w-full text-[10px] border-collapse">
            <thead>
              <tr style={{ backgroundColor: 'rgba(99,102,241,0.06)' }}>
                {headers.map((h, j) => (
                  <th key={j} className="text-left px-2.5 py-1.5 font-semibold whitespace-nowrap" style={{ borderBottom: '1px solid rgba(0,0,0,0.08)' }}>
                    {renderInline(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {dataRows.map((row, rIdx) => (
                <tr key={rIdx} style={{ backgroundColor: rIdx % 2 === 1 ? 'rgba(0,0,0,0.02)' : undefined }}>
                  {row.map((cell, cIdx) => (
                    <td key={cIdx} className="px-2.5 py-1.5 whitespace-nowrap">
                      <StatusCell value={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    // HR
    if (/^---+$/.test(line.trim())) {
      nodes.push(<hr key={k++} className="my-2 border-current opacity-20" />);
      i++; continue;
    }

    // Bullet list
    if (/^[-*]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s/.test(lines[i])) { items.push(lines[i].replace(/^[-*]\s+/, '')); i++; }
      nodes.push(
        <ul key={k++} className="space-y-0.5 my-1">
          {items.map((it, j) => (
            <li key={j} className="flex items-start gap-1.5">
              <span className="shrink-0 mt-0.5 opacity-60">•</span>
              <span>{renderInline(it)}</span>
            </li>
          ))}
        </ul>
      );
      continue;
    }

    // Numbered list
    if (/^\d+\.\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) { items.push(lines[i].replace(/^\d+\.\s+/, '')); i++; }
      nodes.push(
        <ol key={k++} className="space-y-0.5 my-1">
          {items.map((it, j) => (
            <li key={j} className="flex items-start gap-1.5">
              <span className="font-mono text-[10px] shrink-0 mt-0.5 opacity-60">{j + 1}.</span>
              <span>{renderInline(it)}</span>
            </li>
          ))}
        </ol>
      );
      continue;
    }

    // Empty line
    if (!line.trim()) { nodes.push(<div key={k++} className="h-1" />); i++; continue; }

    // Paragraph
    nodes.push(<p key={k++} className="leading-relaxed">{renderInline(line)}</p>);
    i++;
  }

  return <>{nodes}</>;
}

// ── Confirmation button detection ────────────────────────────────────────────

function needsConfirmation(text: string): boolean {
  const tail = text.slice(-400).toLowerCase();
  return /[?]/.test(text.slice(-80)) &&
    /confirmes?-tu|veux-tu que je|dois-je proc[eé]der|ok pour|souhait[ei]|puis-je proc[eé]der|vas-y|je proc[eé]de/.test(tail);
}

// ── Page name helper ─────────────────────────────────────────────────────────

function pageLabel(pathname: string): string {
  const map: Record<string, string> = {
    '/dashboard': 'Dashboard',
    '/commandes': 'Commandes',
    '/be-receptions': 'BE / Réceptions',
    '/factures': 'Factures',
    '/rapprochements': 'Rapprochements',
    '/exceptions': 'Anomalies',
    '/alertes': 'Alertes',
    '/a-facturer': 'À facturer',
    '/reception-du-jour': 'Réception du jour',
    '/prix-reference': 'Catalogue prix',
  };
  for (const [key, label] of Object.entries(map)) {
    if (pathname.startsWith(key)) return label;
  }
  return pathname;
}

function parseEntityContext(pathname: string): { type: string; id: string } | null {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length < 2) return null;
  const [section, id] = segments;
  if (!id || !id.includes('-') || id.length < 10) return null;
  const typeMap: Record<string, string> = {
    'commandes': 'commande',
    'factures': 'facture',
    'be-receptions': 'bon_entree',
    'rapprochements': 'rapprochement',
    'exceptions': 'exception',
  };
  const type = typeMap[section];
  return type ? { type, id } : null;
}

// ── Main component ───────────────────────────────────────────────────────────

export default function ChatAssistant() {
  const pathname = usePathname();
  const contextChips = useMemo(() => getContextChips(pathname), [pathname]);
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [feedbackSent, setFeedbackSent] = useState<Record<number, 'up' | 'down'>>({});
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [streamingText, setStreamingText] = useState('');
  const [activeTools, setActiveTools] = useState<Set<string>>(new Set());
  const bottomRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hasLoadedRef = useRef(false);
  const [showHelp, setShowHelp] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [undoPending, setUndoPending] = useState<{ table: string; id: string; champs: Record<string, unknown> } | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [slashResults, setSlashResults] = useState<typeof SLASH_COMMANDS>([]);
  const prevOpenRef = useRef(false);
  const [isOnboarded, setIsOnboarded] = useState(true); // true par défaut pour éviter flash SSR
  useEffect(() => {
    setIsOnboarded(!!localStorage.getItem('teddy_onboarded'));
  }, []);

  // Mémorisation automatique à la fermeture du chat
  useEffect(() => {
    if (prevOpenRef.current && !open && messages.length >= 4) {
      const toMemorize = messages
        .filter(m => typeof m.content === 'string' && m.content.trim().length > 10)
        .slice(-30)
        .map(m => ({ role: m.role, content: m.content }));
      fetch('/api/teddy/memorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: toMemorize }),
      }).catch(() => null);
    }
    prevOpenRef.current = open;
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Morning brief : afficher la carte si première ouverture du jour avant 12h
  const showMorningBrief = useMemo(() => {
    const todayKey = new Date().toISOString().slice(0, 10);
    const lastBriefDate = typeof window !== 'undefined' ? localStorage.getItem('teddy_last_brief_date') : null;
    const hour = new Date().getHours();
    return messages.length === 0 && hour < 12 && lastBriefDate !== todayKey;
  }, [messages.length]);

  // Persistent conversation memory
  useEffect(() => {
    if (hasLoadedRef.current) return;
    hasLoadedRef.current = true;
    try {
      const saved = localStorage.getItem('teddy_history_v2');
      if (saved) {
        const parsed = JSON.parse(saved) as Message[];
        if (Array.isArray(parsed) && parsed.length > 0) setMessages(parsed);
      }
    } catch {}
  }, []);

  useEffect(() => {
    if (!hasLoadedRef.current) return;
    try {
      if (messages.length === 0) { localStorage.removeItem('teddy_history_v2'); return; }
      // Strip images, export blobs, quick actions, et messages vides avant sauvegarde
      const toSave = messages
        .slice(-30)
        .filter(m => m.content.trim().length > 0)
        .map(m => ({ ...m, images: undefined, exportFile: undefined, quickActions: undefined }));
      localStorage.setItem('teddy_history_v2', JSON.stringify(toSave));
    } catch {}
  }, [messages]);

  // Notification count for dynamic suggestions
  const { data: unreadCount = 0 } = useQuery<number>({
    queryKey: ['notifications-count-teddy'],
    queryFn: async () => {
      const res = await fetch('/api/notifications');
      if (!res.ok) return 0;
      const json = await res.json() as { notifications?: { lu: boolean }[] };
      return (json.notifications ?? []).filter(n => !n.lu).length;
    },
    staleTime: 2 * 60 * 1000,
  });

  const SUGGESTIONS = useMemo(() => {
    for (const [prefix, sgs] of Object.entries(PAGE_SUGGESTIONS)) {
      if (pathname.startsWith(prefix)) return sgs;
    }
    const alertSuggestion = unreadCount > 0
      ? { label: `Gérer les ${unreadCount} alerte${unreadCount > 1 ? 's' : ''}`, icon: AlertTriangle }
      : { label: 'Factures non rapprochées', icon: AlertTriangle };
    return [
      { label: 'Briefing du jour', icon: Sun },
      alertSuggestion,
      { label: 'KPIs du moment', icon: BarChart2 },
      { label: 'Lancer le scan Gmail', icon: Zap },
    ];
  }, [unreadCount, pathname]);

  const greeting = useMemo(() => {
    if (unreadCount > 0) return `Bonjour Rémy ! Tu as **${unreadCount} alerte${unreadCount > 1 ? 's' : ''}** non lue${unreadCount > 1 ? 's' : ''}. Je peux les traiter pour toi, ou réponds à toute autre question.`;
    const label = pageLabel(pathname);
    if (label !== pathname) return `Bonjour ! Tu es sur **${label}**. Comment puis-je t'aider ?`;
    return 'Bonjour ! Je suis Teddy, ton assistant SyncFlow. Que puis-je faire pour toi ?';
  }, [unreadCount, pathname]);

  const addImage = useCallback((file: File) => {
    if (file.size > 5 * 1024 * 1024) { alert('Image trop grande (max 5 Mo)'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      setPendingImages(prev => [...prev, { base64: dataUrl.split(',')[1], mimeType: file.type }]);
    };
    reader.readAsDataURL(file);
  }, []);


  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 150);
  }, [open]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingText, activeTools]);

  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ behavior: 'instant' });
  }, [open]);

  useEffect(() => {
    if (showHelp) messagesRef.current?.scrollTo({ top: 0, behavior: 'instant' });
    else bottomRef.current?.scrollIntoView({ behavior: 'instant' });
  }, [showHelp]);

  useEffect(() => {
    if (!open) return;
    const handlePaste = (e: ClipboardEvent) => {
      Array.from(e.clipboardData?.items ?? [])
        .filter(item => item.type.startsWith('image/'))
        .forEach(item => { const f = item.getAsFile(); if (f) addImage(f); });
    };
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [open, addImage]);

  // Onboarding automatique : première ouverture sans historique
  const onboardingDoneRef = useRef(false);
  useEffect(() => {
    if (!open || isOnboarded || onboardingDoneRef.current || !hasLoadedRef.current) return;
    if (messages.length > 0) { onboardingDoneRef.current = true; return; }
    onboardingDoneRef.current = true;
    localStorage.setItem('teddy_onboarded', 'true');
    const welcome: Message = {
      role: 'assistant',
      content: 'Bonjour Rémy ! Je suis **Teddy**, ton copilote SyncFlow.\n\nJe peux analyser tes données, résoudre des anomalies, lancer des matchings, envoyer des emails fournisseurs — le tout en langage naturel.\n\nLaisse-moi te préparer un résumé de la situation du jour...',
    };
    setMessages([welcome]);
    const t = setTimeout(() => { void sendMessageRef.current?.('Briefing du jour'); }, 900);
    return () => clearTimeout(t);
  }, [open, isOnboarded, messages.length]);

  const sendMessageRef = useRef<((text: string, imgs?: PendingImage[], confirmText?: string) => Promise<void>) | null>(null);

  const sendMessage = useCallback(async (text: string, imgs?: PendingImage[], confirmText?: string) => {
    const finalText = confirmText ?? text;
    if ((!finalText.trim() && (!imgs || imgs.length === 0)) || isLoading) return;

    const userMsg: Message = { role: 'user', content: finalText, images: imgs?.length ? imgs : undefined };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput('');
    setPendingImages([]);
    setIsLoading(true);
    setStreamingText('');
    setActiveTools(new Set());

    // Build Claude-format payload
    const payload = newMessages.map(m => {
      if (m.images?.length) {
        return {
          role: m.role,
          content: [
            ...m.images.map(img => ({ type: 'image', source: { type: 'base64', media_type: img.mimeType, data: img.base64 } })),
            { type: 'text', text: m.content || 'Analyse cette image.' },
          ],
        };
      }
      return { role: m.role, content: m.content };
    });

    try {
      const res = await fetch('/api/assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: payload,
          currentPage: pageLabel(pathname),
          entityContext: parseEntityContext(pathname),
        }),
      });

      if (!res.body) throw new Error('No stream');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let lineBuffer = '';
      let accumulated = '';
      let pendingExport: { filename: string; b64: string } | null = null;
      let pendingQuickActions: { label: string; prompt: string; icon: string }[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        lineBuffer += decoder.decode(value, { stream: true });
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (!raw) continue;

          let event: Record<string, unknown>;
          try { event = JSON.parse(raw); } catch { continue; }

          switch (event.type) {
            case 'text_chunk':
              accumulated += String(event.text ?? '');
              setStreamingText(accumulated);
              break;
            case 'tool_start':
              setActiveTools(prev => new Set([...prev, String(event.name)]));
              break;
            case 'tool_end':
              setActiveTools(prev => { const s = new Set(prev); s.delete(String(event.name)); return s; });
              break;
            case 'export':
              pendingExport = { filename: String(event.filename ?? 'export.csv'), b64: String(event.b64 ?? '') };
              break;
            case 'quick_actions':
              pendingQuickActions = (event.actions as { label: string; prompt: string; icon: string }[]) ?? [];
              break;
            case 'refresh':
              window.dispatchEvent(new CustomEvent('teddy-data-changed'));
              break;
            case 'undo':
              if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
              setUndoPending({ table: String(event.table ?? ''), id: String(event.id ?? ''), champs: (event.champs ?? {}) as Record<string, unknown> });
              undoTimerRef.current = setTimeout(() => setUndoPending(null), 10000);
              break;
            case 'done': {
              const exportData = pendingExport;
              const qas = pendingQuickActions;
              pendingExport = null;
              pendingQuickActions = [];
              if (accumulated || exportData) {
                setMessages(prev => [...prev, {
                  role: 'assistant',
                  content: accumulated || `Fichier **${exportData?.filename}** prêt au téléchargement.`,
                  exportFile: exportData ?? undefined,
                  quickActions: qas.length > 0 ? qas : undefined,
                }]);
              }
              setStreamingText('');
              setActiveTools(new Set());
              setIsLoading(false);
              break;
            }
            case 'error':
              setMessages(prev => [...prev, { role: 'assistant', content: `⚠️ ${String(event.message ?? 'Erreur')}` }]);
              setStreamingText('');
              setActiveTools(new Set());
              setIsLoading(false);
              break;
          }
        }
      }
    } catch {
      setMessages(prev => [...prev, { role: 'assistant', content: 'Désolé, une erreur de connexion est survenue.' }]);
      setStreamingText('');
      setActiveTools(new Set());
      setIsLoading(false);
    }
  }, [messages, isLoading, pathname]);

  // Sync ref so the onboarding effect can call sendMessage after it's defined
  sendMessageRef.current = sendMessage;

  // Listen for "Ask Teddy" events from table row buttons
  useEffect(() => {
    const handler = (e: Event) => {
      const prompt = (e as CustomEvent<{ prompt: string }>).detail?.prompt;
      if (!prompt) return;
      setOpen(true);
      setTimeout(() => { void sendMessageRef.current?.(prompt); }, 300);
    };
    window.addEventListener('teddy-ask', handler);
    return () => window.removeEventListener('teddy-ask', handler);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files);
    const images = files.filter(f => f.type.startsWith('image/'));
    const pdfs = files.filter(f => f.type === 'application/pdf');
    images.forEach(addImage);
    if (pdfs.length > 0) {
      void sendMessage(`J'ai glissé ${pdfs.length > 1 ? `${pdfs.length} fichiers PDF` : `le fichier "${pdfs[0].name}"`}. Peux-tu m'indiquer la marche à suivre pour les importer dans SyncFlow ?`);
    }
  }, [addImage, sendMessage]);

  const handleInputChange = useCallback((value: string) => {
    setInput(value);
    if (value.startsWith('/') && value.length >= 1) {
      const q = value.toLowerCase();
      setSlashResults(SLASH_COMMANDS.filter(c => c.cmd.startsWith(q) || c.label.toLowerCase().includes(q.slice(1))));
    } else {
      setSlashResults([]);
    }
  }, []);

  const lastMsg = messages[messages.length - 1];
  const showConfirmButtons = !isLoading && lastMsg?.role === 'assistant' && needsConfirmation(lastMsg.content);

  return (
    <>
      {open && (
        <div
          className="fixed bottom-20 right-4 z-50 flex flex-col bg-white rounded-2xl shadow-2xl border border-gray-100 overflow-hidden"
          style={{ width: 420, height: 580, maxWidth: 'calc(100vw - 2rem)', maxHeight: 'calc(100vh - 6rem)' }}
        >
          {/* ── Header ─────────────────────────────────────────────────── */}
          <div className="relative shrink-0 bg-gradient-to-br from-indigo-600 via-indigo-600 to-purple-700 px-4 py-3.5 overflow-hidden">
            <div className="absolute -top-6 -right-6 w-24 h-24 rounded-full bg-white/5" />
            <div className="absolute -bottom-8 -left-4 w-20 h-20 rounded-full bg-white/5" />
            <div className="relative flex items-center gap-3">
              <div className="relative shrink-0">
                <div className="w-9 h-9 rounded-xl bg-white/15 flex items-center justify-center ring-2 ring-white/20">
                  <Sparkles className="w-4 h-4 text-white" />
                </div>
                <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-emerald-400 border-2 border-indigo-600" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-white leading-tight">Teddy</p>
                <p className="text-[11px] text-indigo-200 mt-0.5 leading-tight">
                  {pageLabel(pathname)} · En ligne
                </p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  onClick={() => setShowHelp(v => !v)}
                  title="Que peut faire Teddy ?"
                  className={`p-1.5 rounded-lg transition-colors ${showHelp ? 'bg-white/20 text-white' : 'hover:bg-white/15 text-white/60 hover:text-white'}`}
                >
                  <HelpCircle className="w-3.5 h-3.5" />
                </button>
                {messages.length > 0 && (
                  <button onClick={() => { setMessages([]); setStreamingText(''); setActiveTools(new Set()); localStorage.removeItem('teddy_history_v2'); }} title="Nouvelle conversation" className="p-1.5 rounded-lg hover:bg-white/15 text-white/60 hover:text-white transition-colors">
                    <RotateCcw className="w-3.5 h-3.5" />
                  </button>
                )}
                <button onClick={() => setOpen(false)} className="p-1.5 rounded-lg hover:bg-white/15 text-white/60 hover:text-white transition-colors">
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>

          {/* ── Messages ───────────────────────────────────────────────── */}
          <div
            ref={messagesRef}
            className="flex-1 overflow-y-auto p-4 space-y-3 bg-gray-50/50 relative"
            onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
          >

            {/* Help panel overlay */}
            {showHelp && (
              <div className="absolute inset-0 z-20 bg-white overflow-y-auto">
                <div className="p-4 space-y-2.5">
                  <div className="flex items-center justify-between mb-1">
                    <p className="text-sm font-semibold text-gray-900">Que peut faire Teddy ?</p>
                    <button onClick={() => setShowHelp(false)} className="p-1 rounded-lg hover:bg-gray-100">
                      <X className="w-3.5 h-3.5 text-gray-400" />
                    </button>
                  </div>
                  <p className="text-[10px] text-gray-400 mb-3">Clique sur un exemple pour l&apos;envoyer directement.</p>
                  {(() => {
                    const entry = Object.entries(PAGE_HELP).find(([prefix]) => pathname.startsWith(prefix));
                    if (!entry) return null;
                    const [, help] = entry;
                    return (
                      <div className="rounded-xl border-2 p-3 mb-1" style={{ borderColor: '#c7d2fe', backgroundColor: '#eef2ff' }}>
                        <div className="flex items-center gap-2 mb-2">
                          <div className="w-5 h-5 rounded-md flex items-center justify-center shrink-0" style={{ backgroundColor: '#6366f1' }}>
                            <Sparkles className="w-3 h-3 text-white" />
                          </div>
                          <p className="text-[11px] font-semibold" style={{ color: '#3730a3' }}>{help.label}</p>
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {help.examples.map(ex => (
                            <button
                              key={ex}
                              onClick={() => { setShowHelp(false); void sendMessage(ex); }}
                              className="text-[10px] px-2 py-1 rounded-lg font-medium transition-all hover:opacity-80"
                              style={{ backgroundColor: '#c7d2fe', color: '#3730a3' }}
                            >
                              {ex}
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })()}
                  {HELP_CATEGORIES.map(({ icon: Icon, color, bg, label, examples }) => (
                    <div key={label} className="rounded-xl border border-gray-100 p-3">
                      <div className="flex items-center gap-2 mb-2">
                        <div className="w-5 h-5 rounded-md flex items-center justify-center shrink-0" style={{ backgroundColor: bg }}>
                          <Icon className="w-3 h-3" style={{ color }} />
                        </div>
                        <p className="text-[11px] font-semibold text-gray-700">{label}</p>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {examples.map(ex => (
                          <button
                            key={ex}
                            onClick={() => { setShowHelp(false); void sendMessage(ex); }}
                            className="text-[10px] px-2 py-1 rounded-lg border border-gray-100 bg-gray-50 hover:bg-indigo-50 hover:border-indigo-200 hover:text-indigo-700 text-gray-600 transition-all"
                          >
                            {ex}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Drag overlay */}
            {isDragging && (
              <div className="absolute inset-0 z-30 flex flex-col items-center justify-center rounded-2xl border-2 border-dashed" style={{ backgroundColor: 'rgba(99,102,241,0.08)', borderColor: '#6366f1' }}>
                <Download className="w-8 h-8 mb-2" style={{ color: '#6366f1' }} />
                <p className="text-sm font-medium" style={{ color: '#6366f1' }}>Dépose ici</p>
                <p className="text-[10px] mt-0.5 text-gray-400">Images ou PDF</p>
              </div>
            )}

            {/* Greeting + suggestions */}
            {messages.length === 0 && (
              <div className="space-y-3">
                {/* Morning brief card */}
                {showMorningBrief && (
                  <button
                    onClick={() => {
                      localStorage.setItem('teddy_last_brief_date', new Date().toISOString().slice(0, 10));
                      void sendMessage('Briefing du jour');
                    }}
                    className="w-full flex items-center gap-3 px-3.5 py-3 rounded-xl border-2 transition-all text-left"
                    style={{ background: 'linear-gradient(135deg, #fef3c7 0%, #fff7ed 100%)', borderColor: '#fcd34d' }}
                  >
                    <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0" style={{ backgroundColor: '#f59e0b' }}>
                      <Sun className="w-4 h-4 text-white" />
                    </div>
                    <div>
                      <p className="text-[11px] font-semibold" style={{ color: '#92400e' }}>Brief du matin disponible</p>
                      <p className="text-[9px] mt-0.5" style={{ color: '#b45309' }}>Clique pour un résumé complet de la journée</p>
                    </div>
                  </button>
                )}

                <div className="flex items-end gap-2">
                  <div className="w-6 h-6 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shrink-0">
                    <Bot className="w-3.5 h-3.5 text-white" />
                  </div>
                  <div className="bg-white rounded-2xl rounded-tl-sm px-3.5 py-2.5 text-xs shadow-sm border border-gray-100 text-gray-800 max-w-[80%]">
                    <MarkdownContent text={greeting} />
                  </div>
                </div>
                {/* 4 tuiles catégories */}
                <div className="grid grid-cols-2 gap-2 pt-1">
                  {[
                    { icon: Sun,           color: '#f59e0b', bg: '#fef3c7', label: 'État du jour',      sub: 'Résumé, alertes, BEs',    prompt: 'Donne-moi un résumé de l\'état actuel : exceptions actives, BEs anciens, factures en attente et rapprochements proposés.' },
                    { icon: Zap,           color: '#6366f1', bg: '#eef2ff', label: 'Lancer une action', sub: 'Matching, validation…',    prompt: 'Quelles actions dois-je lancer maintenant ? Propose-moi les plus urgentes.' },
                    { icon: Bot,           color: '#0ea5e9', bg: '#e0f2fe', label: 'Chercher',          sub: 'Commandes, factures…',     prompt: 'Je veux chercher quelque chose dans mes données. Que puis-je rechercher ?' },
                    { icon: Download,      color: '#10b981', bg: '#d1fae5', label: 'Créer / Exporter',  sub: 'CSV, nouveau document',    prompt: 'Je veux créer un document ou exporter des données en CSV. Que peux-tu faire ?' },
                  ].map(({ icon: Icon, color, bg, label, sub, prompt }) => (
                    <button
                      key={label}
                      onClick={() => sendMessage(prompt)}
                      className="flex flex-col items-start gap-1.5 p-3 rounded-xl border border-gray-100 bg-white hover:border-indigo-200 hover:bg-indigo-50/40 transition-all shadow-sm text-left group"
                    >
                      <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ backgroundColor: bg }}>
                        <Icon className="w-3.5 h-3.5" style={{ color }} />
                      </div>
                      <div>
                        <p className="text-[11px] font-semibold text-gray-700 group-hover:text-indigo-700 leading-tight">{label}</p>
                        <p className="text-[9px] text-gray-400 mt-0.5 leading-tight">{sub}</p>
                      </div>
                    </button>
                  ))}
                </div>

                {/* Brief contextuel si sur une entité */}
                {(() => {
                  const ec = parseEntityContext(pathname);
                  if (!ec) return null;
                  const entityLabels: Record<string, { label: string; prompt: string }> = {
                    commande:       { label: 'Commande ouverte', prompt: `Analyse la commande ${ec.id} : lignes, prix, avancement livraison et anomalies éventuelles.` },
                    facture:        { label: 'Facture active',   prompt: `Analyse la facture ${ec.id} : statut rapprochement, écarts, actions recommandées.` },
                    bon_entree:     { label: 'BE actif',         prompt: `Analyse le BE ${ec.id} : statut facturation, commande liée, retards.` },
                    exception:      { label: 'Anomalie',         prompt: `Analyse l'exception ${ec.id} et propose la meilleure action de résolution.` },
                    rapprochement:  { label: 'Rapprochement',    prompt: `Analyse le rapprochement ${ec.id} : score, écarts, recommandation.` },
                  };
                  const info = entityLabels[ec.type];
                  if (!info) return null;
                  return (
                    <button
                      onClick={() => sendMessage(info.prompt)}
                      className="w-full flex items-center gap-2.5 text-left px-3 py-2.5 rounded-xl border transition-all"
                      style={{ backgroundColor: '#eef2ff', borderColor: '#c7d2fe' }}
                    >
                      <div className="w-6 h-6 rounded-lg flex items-center justify-center shrink-0" style={{ backgroundColor: '#6366f1' }}>
                        <Sparkles className="w-3.5 h-3.5 text-white" />
                      </div>
                      <div>
                        <p className="text-[10px] font-semibold" style={{ color: '#4338ca' }}>Brief contextuel — {info.label}</p>
                        <p className="text-[9px] mt-0.5" style={{ color: '#6366f1' }}>Cliquer pour analyser cet élément</p>
                      </div>
                    </button>
                  );
                })()}

                <button
                  onClick={() => setShowHelp(true)}
                  className="w-full flex items-center justify-center gap-1.5 py-1.5 text-[10px] text-gray-400 hover:text-indigo-500 transition-colors"
                >
                  <HelpCircle className="w-3 h-3" />
                  Voir tout ce que Teddy peut faire →
                </button>
              </div>
            )}

            {/* History */}
            {messages.map((m, i) => (
              <React.Fragment key={i}>
              <div className={cn('flex items-end gap-2', m.role === 'user' ? 'flex-row-reverse' : '')}>
                <div className={cn('w-6 h-6 rounded-full flex items-center justify-center shrink-0 mb-0.5', m.role === 'assistant' ? 'bg-gradient-to-br from-indigo-500 to-purple-600' : 'bg-gray-200')}>
                  {m.role === 'assistant' ? <Bot className="w-3.5 h-3.5 text-white" /> : <User className="w-3 h-3 text-gray-500" />}
                </div>
                <div className={cn(
                  'max-w-[80%] text-xs leading-relaxed',
                  m.role === 'assistant'
                    ? 'bg-white rounded-2xl rounded-tl-sm px-3.5 py-2.5 shadow-sm border border-gray-100 text-gray-800'
                    : 'bg-gradient-to-br from-indigo-500 to-indigo-600 rounded-2xl rounded-br-sm px-3.5 py-2.5 text-white shadow-sm'
                )}>
                  {m.images?.map((img, idx) => (
                    <img key={idx} src={`data:${img.mimeType};base64,${img.base64}`} className="rounded-lg max-w-full mb-2" alt="" />
                  ))}
                  <MarkdownContent text={m.content} isUser={m.role === 'user'} />
                  {m.exportFile && (
                    <a
                      href={`data:text/csv;base64,${m.exportFile.b64}`}
                      download={m.exportFile.filename}
                      className="inline-flex items-center gap-1.5 mt-2 text-[10px] px-2.5 py-1.5 rounded-lg border font-medium transition-all"
                      style={{ backgroundColor: '#f0fdf4', borderColor: '#86efac', color: '#15803d' }}
                    >
                      <Download className="w-3 h-3" />
                      {m.exportFile.filename}
                    </a>
                  )}
                  {m.role === 'assistant' && (
                    <div className="flex gap-1 mt-2 justify-end">
                      {feedbackSent[i] ? (
                        <span className="text-[9px] text-gray-400">{feedbackSent[i] === 'up' ? '👍 Merci !' : '👎 Noté'}</span>
                      ) : (
                        <>
                          <button
                            onClick={() => {
                              setFeedbackSent(prev => ({ ...prev, [i]: 'up' }));
                              fetch('/api/teddy/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rating: 'up', message: m.content.slice(0, 500) }) }).catch(() => null);
                            }}
                            className="p-1 rounded hover:bg-green-50 text-gray-300 hover:text-green-500 transition-colors"
                            title="Bonne réponse"
                          >
                            <ThumbsUp className="w-3 h-3" />
                          </button>
                          <button
                            onClick={() => {
                              setFeedbackSent(prev => ({ ...prev, [i]: 'down' }));
                              fetch('/api/teddy/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rating: 'down', message: m.content.slice(0, 500) }) }).catch(() => null);
                            }}
                            className="p-1 rounded hover:bg-red-50 text-gray-300 hover:text-red-400 transition-colors"
                            title="Mauvaise réponse"
                          >
                            <ThumbsDown className="w-3 h-3" />
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>
              {m.role === 'assistant' && m.quickActions && m.quickActions.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pl-8 -mt-1">
                  {m.quickActions.map(qa => (
                    <button
                      key={qa.label}
                      onClick={() => void sendMessage(qa.prompt)}
                      disabled={isLoading}
                      className="flex items-center gap-1 text-[10px] px-2.5 py-1.5 rounded-lg border font-medium transition-all disabled:opacity-40"
                      style={{ backgroundColor: '#eef2ff', borderColor: '#c7d2fe', color: '#4338ca' }}
                    >
                      {qa.icon === 'download' ? <Download className="w-2.5 h-2.5" /> : qa.icon === 'zap' ? <Zap className="w-2.5 h-2.5" /> : <CheckCheck className="w-2.5 h-2.5" />}
                      {qa.label}
                    </button>
                  ))}
                </div>
              )}
              </React.Fragment>
            ))}

            {/* Active tools indicator */}
            {activeTools.size > 0 && (
              <div className="flex flex-wrap gap-1.5 pl-8">
                {Array.from(activeTools).map(tool => (
                  <span key={tool} className="inline-flex items-center gap-1 text-[10px] px-2 py-1 rounded-full border" style={{ backgroundColor: '#eef2ff', borderColor: '#c7d2fe', color: '#4338ca' }}>
                    <Wrench className="w-2.5 h-2.5 animate-pulse" />
                    {TOOL_LABELS[tool] ?? tool}
                  </span>
                ))}
              </div>
            )}

            {/* Streaming live bubble */}
            {streamingText && (
              <div className="flex items-end gap-2">
                <div className="w-6 h-6 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shrink-0 mb-0.5">
                  <Bot className="w-3.5 h-3.5 text-white" />
                </div>
                <div className="max-w-[80%] text-xs bg-white rounded-2xl rounded-tl-sm px-3.5 py-2.5 shadow-sm border border-indigo-100 text-gray-800">
                  <MarkdownContent text={streamingText} />
                  <span className="inline-block w-0.5 h-3 bg-indigo-400 ml-0.5 animate-pulse rounded-sm" />
                </div>
              </div>
            )}

            {/* Loading dots (no tools, no text yet) */}
            {isLoading && !streamingText && activeTools.size === 0 && (
              <div className="flex items-end gap-2">
                <div className="w-6 h-6 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shrink-0 mb-0.5">
                  <Bot className="w-3.5 h-3.5 text-white" />
                </div>
                <div className="bg-white rounded-2xl rounded-tl-sm px-4 py-3 shadow-sm border border-gray-100">
                  <div className="flex items-center gap-1">
                    {[0, 150, 300].map(delay => (
                      <span key={delay} className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: `${delay}ms` }} />
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Confirmation buttons */}
            {showConfirmButtons && (
              <div className="flex items-center gap-2 pl-8">
                <button
                  onClick={() => sendMessage('', undefined, 'Oui, confirme')}
                  className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-xl font-medium transition-colors"
                  style={{ backgroundColor: '#059669', color: '#fff' }}
                >
                  <ChevronRight className="w-3 h-3" /> Oui, confirmer
                </button>
                <button
                  onClick={() => sendMessage('', undefined, 'Non, annule')}
                  className="text-xs px-3 py-1.5 rounded-xl border font-medium transition-colors text-gray-600 hover:bg-gray-100"
                >
                  Non, annuler
                </button>
              </div>
            )}

            <div ref={bottomRef} />
          </div>

          {/* ── Images preview ──────────────────────────────────────────── */}
          {pendingImages.length > 0 && (
            <div className="px-4 pt-2.5 pb-1 shrink-0 flex flex-wrap gap-2 bg-white border-t border-gray-100">
              {pendingImages.map((img, i) => (
                <div key={i} className="relative">
                  <img src={`data:${img.mimeType};base64,${img.base64}`} className="h-14 w-14 rounded-lg border border-gray-200 object-cover" alt="" />
                  <button type="button" onClick={() => setPendingImages(prev => prev.filter((_, j) => j !== i))} className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-gray-800 rounded-full flex items-center justify-center hover:bg-black">
                    <X className="w-2.5 h-2.5 text-white" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Undo bar */}
          {undoPending && (
            <div className="shrink-0 flex items-center justify-between px-4 py-2 border-t" style={{ backgroundColor: '#1e293b' }}>
              <p className="text-[11px] text-gray-300">Modification effectuée</p>
              <button
                onClick={async () => {
                  await fetch('/api/teddy/undo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(undoPending) });
                  setUndoPending(null);
                  if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
                  window.dispatchEvent(new CustomEvent('teddy-data-changed'));
                }}
                className="text-[11px] font-semibold px-3 py-1.5 rounded-lg transition-colors"
                style={{ backgroundColor: '#f59e0b', color: '#1e293b' }}
              >
                Annuler
              </button>
            </div>
          )}

          {/* Quick chips — contextuels selon la page */}
          {messages.length > 0 && (
            <div className="shrink-0 px-3 pt-2 pb-0 bg-white border-t border-gray-50 flex gap-1.5 overflow-x-auto">
              {contextChips.map(({ icon: Icon, label, prompt }) => (
                <button key={label} type="button" onClick={() => void sendMessage(prompt)} disabled={isLoading}
                  className="flex items-center gap-1 text-[10px] px-2.5 py-1 rounded-lg border border-gray-200 bg-gray-50 hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-600 text-gray-500 transition-all whitespace-nowrap disabled:opacity-40 shrink-0">
                  <Icon className="w-2.5 h-2.5" />
                  {label}
                </button>
              ))}
            </div>
          )}

          {/* ── Input ──────────────────────────────────────────────────── */}
          <form
            onSubmit={e => {
              e.preventDefault();
              setSlashResults([]);
              void sendMessage(input, pendingImages.length > 0 ? pendingImages : undefined);
            }}
            className="shrink-0 bg-white border-t border-gray-100 px-3 py-3 relative"
          >
            {/* Slash command palette */}
            {slashResults.length > 0 && (
              <div className="absolute bottom-full left-3 right-3 mb-1 bg-white rounded-xl border border-gray-100 shadow-lg overflow-hidden z-10">
                {slashResults.map(cmd => (
                  <button
                    key={cmd.cmd}
                    type="button"
                    onClick={() => { setInput(''); setSlashResults([]); void sendMessage(cmd.prompt); }}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-indigo-50 transition-colors"
                  >
                    <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded" style={{ backgroundColor: '#eef2ff', color: '#6366f1' }}>{cmd.cmd}</span>
                    <span className="text-[11px] text-gray-600">{cmd.label}</span>
                  </button>
                ))}
              </div>
            )}

            <div className="flex items-center gap-2 bg-gray-50 border border-gray-200 rounded-xl px-2 py-1.5 focus-within:border-indigo-400 focus-within:ring-2 focus-within:ring-indigo-100 transition-all">
              <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple className="hidden" onChange={e => { Array.from(e.target.files ?? []).forEach(addImage); e.target.value = ''; }} />
              <button type="button" onClick={() => fileInputRef.current?.click()} disabled={isLoading} className={cn('p-1.5 rounded-lg transition-colors shrink-0 disabled:opacity-40', pendingImages.length > 0 ? 'text-indigo-500 bg-indigo-50' : 'text-gray-400 hover:text-indigo-500 hover:bg-indigo-50')}>
                <ImagePlus className="w-4 h-4" />
              </button>
              <input
                ref={inputRef}
                value={input}
                onChange={e => handleInputChange(e.target.value)}
                placeholder={pendingImages.length > 0 ? 'Commentaire optionnel…' : 'Écrivez ou /commande…'}
                disabled={isLoading}
                className="flex-1 text-xs bg-transparent outline-none text-gray-800 placeholder-gray-400 disabled:opacity-50 min-w-0"
              />
              <button type="submit" disabled={isLoading || (!input.trim() && pendingImages.length === 0)} className="w-7 h-7 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center transition-all shrink-0">
                {isLoading ? <Loader2 className="w-3.5 h-3.5 text-white animate-spin" /> : <Send className="w-3.5 h-3.5 text-white" />}
              </button>
            </div>
            <p className="text-[10px] text-gray-300 text-center mt-1.5">Ctrl+V pour coller une capture d&apos;écran</p>
          </form>
        </div>
      )}

      {/* ── Floating button ─────────────────────────────────────────────── */}
      {/* "Essaie-moi" bubble for first-time users */}
      {!open && !isOnboarded && (
        <div className="fixed bottom-5 right-16 z-50 pointer-events-none">
          <div className="bg-white rounded-xl shadow-lg border border-indigo-100 px-3 py-2 flex items-center gap-1.5 animate-bounce" style={{ animationDuration: '2s' }}>
            <Sparkles className="w-3 h-3 shrink-0" style={{ color: '#6366f1' }} />
            <p className="text-[11px] font-semibold whitespace-nowrap" style={{ color: '#4338ca' }}>Teddy, ton assistant</p>
          </div>
          <div className="absolute -right-1.5 top-1/2 -translate-y-1/2 w-2 h-2 bg-white border-r border-b border-indigo-100 rotate-45" />
        </div>
      )}
      <button
        onClick={() => setOpen(o => !o)}
        className={cn(
          'fixed bottom-4 right-4 z-50 rounded-2xl shadow-lg flex items-center justify-center transition-all duration-200',
          open
            ? 'bg-gray-700 hover:bg-gray-800 scale-95'
            : 'bg-gradient-to-br from-indigo-500 to-purple-600 hover:scale-105 shadow-indigo-200 hover:shadow-indigo-300 hover:shadow-xl'
        )}
        style={{ width: 52, height: 52 }}
        title="Teddy — Assistant IA"
      >
        {open ? <X className="w-5 h-5 text-white" /> : <Sparkles className="w-5 h-5 text-white" />}
        {!open && (
          <span className="absolute -top-1 -right-1 w-3 h-3 rounded-full border-2 border-white animate-pulse" style={{ backgroundColor: unreadCount > 0 ? '#f59e0b' : '#34d399' }} />
        )}
      </button>
    </>
  );
}
