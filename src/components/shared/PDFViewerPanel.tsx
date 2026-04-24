'use client';

import { X, FileText, ExternalLink } from 'lucide-react';

interface PDFViewerPanelProps {
  url: string | null | undefined;
  open: boolean;
  onClose: () => void;
  title?: string;
}

export default function PDFViewerPanel({ url, open, onClose, title }: PDFViewerPanelProps) {
  if (!open || !url) return null;

  return (
    <>
      {/* Overlay */}
      <div
        className="fixed inset-0 z-40 bg-black/20 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="fixed right-0 top-0 bottom-0 z-50 flex flex-col bg-white shadow-2xl border-l border-gray-200"
        style={{ width: 'min(52vw, 900px)' }}>

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 shrink-0">
          <div className="flex items-center gap-2 text-sm font-medium text-gray-700">
            <FileText className="w-4 h-4 text-indigo-500" />
            {title ?? 'Document PDF'}
          </div>
          <div className="flex items-center gap-2">
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:underline"
            >
              <ExternalLink className="w-3.5 h-3.5" /> Ouvrir dans l'onglet
            </a>
            <button
              onClick={onClose}
              className="p-1.5 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* PDF */}
        <iframe
          src={url}
          className="flex-1 w-full"
          title="PDF viewer"
        />
      </div>
    </>
  );
}
