'use client';

import { useState, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Upload, CheckCircle, AlertCircle, Clock, Loader2, X } from 'lucide-react';
import { cn } from '@/utils';
import { supabase } from '@/lib/supabase';

interface FileResult {
  name: string;
  status: 'waiting' | 'processing' | 'done' | 'error' | 'duplicate';
  message?: string;
}

interface ApiResult {
  bes_importes: number;
  factures_importees: number;
  doublons_ignores: number;
  erreurs: string[];
  details: string[];
}

interface Props {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
  title?: string;
}

const DELAY_MS = 2000;

export default function PdfImportModal({ open, onClose, onSuccess, title = 'Importer des PDFs' }: Props) {
  const [files, setFiles] = useState<File[]>([]);
  const [fileResults, setFileResults] = useState<FileResult[]>([]);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  if (!open) return null;

  const completed = fileResults.filter((r) => r.status !== 'waiting' && r.status !== 'processing').length;
  const total = files.length;
  const progress = total > 0 ? Math.round((completed / total) * 100) : 0;

  const handleFiles = (selected: File[]) => {
    const pdfs = selected.filter((f) => f.name.toLowerCase().endsWith('.pdf'));
    setFiles(pdfs);
    setFileResults(pdfs.map((f) => ({ name: f.name, status: 'waiting' })));
    setDone(false);
  };

  const updateResult = (index: number, update: Partial<FileResult>) => {
    setFileResults((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], ...update };
      return next;
    });
  };

  const handleImport = async () => {
    if (files.length === 0 || running) return;
    setRunning(true);

    let totalImported = 0;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      updateResult(i, { status: 'processing', message: 'Envoi du fichier…' });
      try {
        // 1. Obtenir une URL signée
        const urlResp = await fetch('/api/storage/upload-url', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileName: file.name }),
        });
        if (!urlResp.ok) throw new Error('Impossible de créer l\'URL d\'upload');
        const { path, token } = await urlResp.json() as { signedUrl: string; path: string; token: string };

        // 2. Upload direct vers Supabase Storage (contourne la limite Vercel 4.5 MB)
        const { error: uploadError } = await supabase.storage
          .from('documents')
          .uploadToSignedUrl(path, token, file, { contentType: 'application/pdf' });
        if (uploadError) throw new Error(`Upload storage : ${uploadError.message}`);

        updateResult(i, { status: 'processing', message: 'Analyse Claude en cours…' });

        // 3. API reçoit uniquement le chemin storage (payload ~200 octets)
        const r = await fetch('/api/import-pdf', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ storagePath: path, fileName: file.name }),
        });
        if (!r.ok && !r.headers.get('content-type')?.includes('application/json')) {
          throw new Error(`Erreur serveur (${r.status})`);
        }
        const data = await r.json() as ApiResult;

        const imported = data.bes_importes + data.factures_importees;
        if (imported > 0) {
          totalImported += imported;
          const msg = data.details[0] ?? `${imported} importé(s)`;
          updateResult(i, { status: 'done', message: msg });
        } else if (data.doublons_ignores > 0) {
          updateResult(i, { status: 'duplicate', message: 'Doublon — déjà importé' });
        } else if (data.erreurs.length > 0) {
          updateResult(i, { status: 'error', message: data.erreurs[0] });
        } else {
          updateResult(i, { status: 'error', message: 'Type non reconnu' });
        }
      } catch (err) {
        updateResult(i, { status: 'error', message: err instanceof Error ? err.message : 'Erreur réseau' });
      }
      if (i < files.length - 1) await new Promise((res) => setTimeout(res, DELAY_MS));
    }

    if (totalImported > 0) onSuccess();
    setRunning(false);
    setDone(true);
  };

  const handleClose = () => {
    if (running) return;
    setFiles([]);
    setFileResults([]);
    setDone(false);
    onClose();
  };

  const statusIcon = (s: FileResult['status']) => {
    if (s === 'waiting') return <Clock className="w-4 h-4 text-gray-300 shrink-0" />;
    if (s === 'processing') return <Loader2 className="w-4 h-4 text-indigo-500 shrink-0 animate-spin" />;
    if (s === 'done') return <CheckCircle className="w-4 h-4 text-emerald-500 shrink-0" />;
    if (s === 'duplicate') return <Clock className="w-4 h-4 text-amber-400 shrink-0" />;
    return <AlertCircle className="w-4 h-4 text-red-500 shrink-0" />;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-900">{title}</h2>
          <button onClick={handleClose} disabled={running} className="p-1 rounded hover:bg-gray-100 text-gray-400 disabled:opacity-40">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 space-y-4 overflow-y-auto flex-1">
          {/* Zone de sélection */}
          {!running && !done && (
            <div
              className="border-2 border-dashed border-gray-200 rounded-lg p-8 text-center cursor-pointer hover:border-indigo-300 transition-colors"
              onClick={() => inputRef.current?.click()}
            >
              <Upload className="w-8 h-8 text-gray-300 mx-auto mb-2" />
              <p className="text-sm text-gray-500">Cliquez ou déposez des PDFs ici</p>
              <p className="text-xs text-gray-400 mt-1">Claude AI détecte automatiquement le type (BE ou Facture)</p>
              {files.length > 0 && (
                <p className="text-xs text-indigo-600 mt-2 font-medium">{files.length} fichier(s) sélectionné(s)</p>
              )}
            </div>
          )}
          <input ref={inputRef} type="file" multiple accept=".pdf" className="hidden"
            onChange={(e) => handleFiles(Array.from(e.target.files ?? []))} />

          {/* Barre de progression */}
          {(running || done) && total > 0 && (
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs text-gray-500">
                <span>{running ? 'Analyse en cours…' : 'Terminé'}</span>
                <span>{completed}/{total} fichier{total > 1 ? 's' : ''}</span>
              </div>
              <div className="h-2 w-full rounded-full bg-gray-100 overflow-hidden">
                <div
                  className={cn(
                    'h-full rounded-full transition-all duration-300',
                    done ? 'bg-emerald-500' : 'bg-indigo-500',
                  )}
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          )}

          {/* Liste des fichiers */}
          {fileResults.length > 0 && (
            <ul className="space-y-1.5">
              {fileResults.map((fr, i) => (
                <li key={i} className="flex items-start gap-2.5 text-sm">
                  {statusIcon(fr.status)}
                  <div className="flex-1 min-w-0">
                    <p className={cn(
                      'truncate font-medium',
                      fr.status === 'done' ? 'text-emerald-700' :
                      fr.status === 'error' ? 'text-red-600' :
                      fr.status === 'duplicate' ? 'text-amber-600' :
                      'text-gray-500',
                    )}>
                      {fr.name}
                    </p>
                    {fr.message && (
                      <p className="text-xs text-gray-400 truncate">{fr.message}</p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-6 py-4 border-t border-gray-100">
          <Button variant="outline" onClick={handleClose} disabled={running}>
            {done ? 'Fermer' : 'Annuler'}
          </Button>
          {!done && (
            <Button onClick={handleImport} disabled={running || files.length === 0}>
              {running
                ? <><Loader2 className="w-4 h-4 mr-1.5 animate-spin" />Analyse…</>
                : `Importer (${files.length})`}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
