'use client';

import { useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { cn } from '@/utils';
import {
  Upload, CheckCircle2, XCircle, FileText,
  Loader2, ChevronDown, ChevronRight, AlertTriangle, ArrowLeft,
} from 'lucide-react';
import { toast } from 'sonner';
import type { ParsedDocument } from '@/lib/document-parser';

// ── Types ─────────────────────────────────────────────────────────────────────

type DocStatus = 'pending' | 'valid' | 'skip';

interface ReviewDoc {
  key: string;
  fileIndex: number;
  type: 'be' | 'facture' | 'inconnu';
  numero: string;
  fournisseur: string | null;
  date: string | null;
  nbLignes: number;
  qteTotale: number;
  lignes: { ref: string | null; designation: string | null; qte: number }[];
  status: DocStatus;
  rawParsed: ParsedDocument;
  pdfUrl?: string;
}

type EditTarget =
  | { key: string; field: 'numero' | 'fournisseur' | 'date'; value: string }
  | { key: string; field: 'ligne_qte'; lineIdx: number; value: string }
  | null;

interface FileData {
  file: File;
  objectUrl: string;
  docs: ReviewDoc[];
}

type Step = 'upload' | 'analyzing' | 'review' | 'importing' | 'done';

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildReviewDoc(parsed: ParsedDocument, fileIndex: number, docIndex: number): ReviewDoc {
  const key = `${fileIndex}-${docIndex}`;
  if (parsed.type === 'be') {
    const qteTotale = parsed.data.lignes.reduce((s, l) => s + l.quantite_receptionnee, 0);
    return {
      key, fileIndex, type: 'be',
      numero: parsed.data.numero_be,
      fournisseur: parsed.data.fournisseur,
      date: parsed.data.date_bl,
      nbLignes: parsed.data.lignes.length,
      qteTotale,
      lignes: parsed.data.lignes.map(l => ({ ref: l.reference_article, designation: l.designation, qte: l.quantite_receptionnee })),
      status: 'pending',
      rawParsed: parsed,
    };
  }
  if (parsed.type === 'facture') {
    const qteTotale = parsed.data.lignes.reduce((s, l) => s + l.quantite_facturee, 0);
    return {
      key, fileIndex, type: 'facture',
      numero: parsed.data.numero_facture,
      fournisseur: parsed.data.fournisseur,
      date: parsed.data.date_facture,
      nbLignes: parsed.data.lignes.length,
      qteTotale,
      lignes: parsed.data.lignes.map(l => ({ ref: l.reference_article, designation: l.designation, qte: l.quantite_facturee })),
      status: 'pending',
      rawParsed: parsed,
    };
  }
  return {
    key, fileIndex, type: 'inconnu',
    numero: '—', fournisseur: null, date: null,
    nbLignes: 0, qteTotale: 0, lignes: [],
    status: 'skip',
    rawParsed: parsed,
  };
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ImportPage() {
  const router = useRouter();
  const dropRef = useRef<HTMLDivElement>(null);

  const [step, setStep] = useState<Step>('upload');
  const [files, setFiles] = useState<File[]>([]);
  const [fileData, setFileData] = useState<FileData[]>([]);
  const [activeFileIndex, setActiveFileIndex] = useState(0);
  const [activeDocKey, setActiveDocKey] = useState<string | null>(null);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const [editTarget, setEditTarget] = useState<EditTarget>(null);
  const [importResult, setImportResult] = useState<{ bes_importes: number; factures_importees: number; doublons_ignores: number; details: string[] } | null>(null);

  const allDocs = fileData.flatMap(fd => fd.docs);
  const validDocs = allDocs.filter(d => d.status === 'valid');
  const pendingDocs = allDocs.filter(d => d.status === 'pending');

  // ── Upload ─────────────────────────────────────────────────────────────────

  const addFiles = useCallback((newFiles: File[]) => {
    const pdfs = newFiles.filter(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
    setFiles(prev => {
      const existing = new Set(prev.map(f => f.name));
      return [...prev, ...pdfs.filter(f => !existing.has(f.name))];
    });
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    addFiles(Array.from(e.dataTransfer.files));
  }, [addFiles]);

  const onFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) addFiles(Array.from(e.target.files));
  };

  // ── Analyse ────────────────────────────────────────────────────────────────

  const handleAnalyze = async () => {
    if (!files.length) return;
    setStep('analyzing');

    const formData = new FormData();
    files.forEach(f => formData.append('files', f));

    try {
      const res = await fetch('/api/preview-pdf', { method: 'POST', body: formData });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json() as {
        files: { fileIndex: number; fileName: string; docs: ParsedDocument[] }[]
      };

      const fd: FileData[] = files.map((file, fi) => {
        const fileResult = data.files.find(r => r.fileIndex === fi);
        const parsedDocs = fileResult?.docs ?? [];
        const objectUrl = URL.createObjectURL(file);
        const docs = parsedDocs.map((d, di) => buildReviewDoc(d, fi, di));
        return { file, objectUrl, docs };
      });

      setFileData(fd);
      setActiveFileIndex(0);

      // Sélectionner le premier doc non-inconnu
      const firstValid = fd.flatMap(f => f.docs).find(d => d.type !== 'inconnu');
      if (firstValid) {
        setActiveDocKey(firstValid.key);
        // Auto-expand tous les docs pour la review rapide
        setExpandedKeys(new Set(fd.flatMap(f => f.docs).map(d => d.key)));
        // Auto-valider les BEs et factures (inconnus restent skip)
        setFileData(prev => prev.map(f => ({
          ...f,
          docs: f.docs.map(d => ({ ...d, status: d.type !== 'inconnu' ? 'pending' : 'skip' })),
        })));
      }

      setStep('review');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur analyse');
      setStep('upload');
    }
  };

  // ── Édition inline ─────────────────────────────────────────────────────────

  const commitEdit = (target: EditTarget) => {
    if (!target) return;
    setFileData(prev => prev.map(fd => ({
      ...fd,
      docs: fd.docs.map(doc => {
        if (doc.key !== target.key) return doc;
        if (target.field === 'ligne_qte') {
          const qte = parseFloat(target.value);
          if (isNaN(qte) || qte < 0) return doc;
          const newLignes = doc.lignes.map((l, i) => i === target.lineIdx ? { ...l, qte } : l);
          const newRaw = JSON.parse(JSON.stringify(doc.rawParsed)) as ParsedDocument;
          if (newRaw.type === 'be') newRaw.data.lignes[target.lineIdx].quantite_receptionnee = qte;
          if (newRaw.type === 'facture') newRaw.data.lignes[target.lineIdx].quantite_facturee = qte;
          return { ...doc, lignes: newLignes, qteTotale: newLignes.reduce((s, l) => s + l.qte, 0), rawParsed: newRaw };
        }
        const newRaw = JSON.parse(JSON.stringify(doc.rawParsed)) as ParsedDocument;
        if (target.field === 'numero') {
          if (newRaw.type === 'be') newRaw.data.numero_be = target.value;
          if (newRaw.type === 'facture') newRaw.data.numero_facture = target.value;
          return { ...doc, numero: target.value, rawParsed: newRaw };
        }
        if (target.field === 'fournisseur') {
          if (newRaw.type === 'be') newRaw.data.fournisseur = target.value;
          if (newRaw.type === 'facture') newRaw.data.fournisseur = target.value;
          return { ...doc, fournisseur: target.value, rawParsed: newRaw };
        }
        if (target.field === 'date') {
          if (newRaw.type === 'be') newRaw.data.date_bl = target.value || null;
          if (newRaw.type === 'facture') newRaw.data.date_facture = target.value || null;
          return { ...doc, date: target.value || null, rawParsed: newRaw };
        }
        return doc;
      }),
    })));
    setEditTarget(null);
  };

  // ── Statut ─────────────────────────────────────────────────────────────────

  const setDocStatus = (key: string, status: DocStatus) => {
    setFileData(prev => prev.map(fd => ({
      ...fd,
      docs: fd.docs.map(d => d.key === key ? { ...d, status } : d),
    })));
  };

  const validateAll = () => {
    setFileData(prev => prev.map(fd => ({
      ...fd,
      docs: fd.docs.map(d => ({ ...d, status: d.type !== 'inconnu' ? 'valid' : 'skip' })),
    })));
  };

  const toggleExpand = (key: string) => {
    setExpandedKeys(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  const selectDoc = (doc: ReviewDoc) => {
    setActiveDocKey(doc.key);
    setActiveFileIndex(doc.fileIndex);
  };

  // ── Import ─────────────────────────────────────────────────────────────────

  const handleImport = async () => {
    if (!validDocs.length) return;
    setStep('importing');

    try {
      // Upload PDFs vers Supabase Storage (bucket "documents")
      const pdfUrls: Record<number, string> = {};
      for (let fi = 0; fi < fileData.length; fi++) {
        const fd = fileData[fi];
        const hasValidDoc = fd.docs.some(d => d.status === 'valid');
        if (!hasValidDoc) continue;
        try {
          const path = `pdf/${Date.now()}-${fi}-${fd.file.name}`;
          const { data: uploaded, error } = await supabase.storage.from('documents').upload(path, fd.file, { upsert: false });
          if (!error && uploaded) {
            const { data: { publicUrl } } = supabase.storage.from('documents').getPublicUrl(uploaded.path);
            pdfUrls[fi] = publicUrl;
          }
        } catch { /* storage non configuré, on ignore */ }
      }

      const docsWithUrl = validDocs.map(d => ({
        ...d.rawParsed,
        ...(pdfUrls[d.fileIndex] ? { pdf_url: pdfUrls[d.fileIndex] } : {}),
      }));

      const res = await fetch('/api/import-parsed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docs: docsWithUrl }),
      });
      const data = await res.json();
      setImportResult(data);
      setStep('done');
      fileData.forEach(fd => URL.revokeObjectURL(fd.objectUrl));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur import');
      setStep('review');
    }
  };

  const currentObjectUrl = fileData[activeFileIndex]?.objectUrl ?? null;

  // ── Render ─────────────────────────────────────────────────────────────────

  if (step === 'done' && importResult) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-6">
        <CheckCircle2 className="w-14 h-14 text-emerald-500" />
        <div className="text-center">
          <h2 className="text-xl font-bold text-gray-900 mb-1">Import terminé</h2>
          <p className="text-sm text-gray-500">
            {importResult.bes_importes} BE{importResult.bes_importes !== 1 ? 's' : ''} importé{importResult.bes_importes !== 1 ? 's' : ''}
            {importResult.factures_importees > 0 && ` · ${importResult.factures_importees} facture(s)`}
            {importResult.doublons_ignores > 0 && ` · ${importResult.doublons_ignores} doublon(s) ignoré(s)`}
          </p>
        </div>
        <div className="bg-gray-50 rounded-xl p-4 max-w-sm w-full text-xs text-gray-600 space-y-1">
          {importResult.details.map((d, i) => <p key={i}>{d}</p>)}
        </div>
        <button
          onClick={() => router.push('/be-receptions')}
          className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700"
        >
          Voir les BEs importés
        </button>
      </div>
    );
  }

  if (step === 'upload' || step === 'analyzing') {
    return (
      <div className="max-w-xl mx-auto space-y-6 py-8">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Import PDF</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Dépose un ou plusieurs PDFs — un seul scan groupé fonctionne aussi.
          </p>
        </div>

        {/* Drop zone */}
        <div
          ref={dropRef}
          onDrop={onDrop}
          onDragOver={e => e.preventDefault()}
          className="border-2 border-dashed border-gray-200 rounded-2xl p-10 text-center hover:border-indigo-300 hover:bg-indigo-50/30 transition-colors cursor-pointer"
          onClick={() => document.getElementById('file-input')?.click()}
        >
          <Upload className="w-8 h-8 text-gray-300 mx-auto mb-3" />
          <p className="text-sm font-medium text-gray-600">Glisse tes PDFs ici</p>
          <p className="text-xs text-gray-400 mt-1">ou clique pour sélectionner</p>
          <input id="file-input" type="file" accept=".pdf,application/pdf" multiple className="hidden" onChange={onFileInput} />
        </div>

        {/* Liste fichiers sélectionnés */}
        {files.length > 0 && (
          <div className="space-y-1.5">
            {files.map((f, i) => (
              <div key={i} className="flex items-center gap-2 bg-gray-50 rounded-lg px-3 py-2">
                <FileText className="w-4 h-4 text-gray-400 shrink-0" />
                <span className="text-xs text-gray-700 flex-1 truncate">{f.name}</span>
                <span className="text-xs text-gray-400">{(f.size / 1024).toFixed(0)} Ko</span>
                <button onClick={() => setFiles(prev => prev.filter((_, j) => j !== i))} className="text-gray-300 hover:text-red-400">
                  <XCircle className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}

        <button
          disabled={!files.length || step === 'analyzing'}
          onClick={handleAnalyze}
          className="w-full flex items-center justify-center gap-2 py-3 bg-indigo-600 text-white text-sm font-semibold rounded-xl hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {step === 'analyzing' ? (
            <><Loader2 className="w-4 h-4 animate-spin" /> Analyse en cours…</>
          ) : (
            <><FileText className="w-4 h-4" /> Analyser {files.length} fichier{files.length > 1 ? 's' : ''}</>
          )}
        </button>
        {step === 'analyzing' && (
          <p className="text-xs text-center text-gray-400">
            Claude lit chaque BE… {files.length > 1 ? `~${files.length * 4}s` : '~4s'}
          </p>
        )}
      </div>
    );
  }

  // ── Review (split-screen) ──────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)]">

      {/* Barre du haut */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-100 bg-white shrink-0">
        <div className="flex items-center gap-3">
          <button onClick={() => setStep('upload')} className="p-1.5 rounded hover:bg-gray-100 text-gray-400">
            <ArrowLeft className="w-4 h-4" />
          </button>
          <span className="text-sm font-semibold text-gray-800">
            Vérification — {allDocs.filter(d => d.type !== 'inconnu').length} document{allDocs.length > 1 ? 's' : ''} détecté{allDocs.length > 1 ? 's' : ''}
          </span>
          {pendingDocs.length > 0 && (
            <span className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">
              {pendingDocs.filter(d => d.type !== 'inconnu').length} en attente
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={validateAll}
            className="text-xs font-medium text-indigo-600 hover:text-indigo-800 px-2.5 py-1.5 rounded-lg hover:bg-indigo-50"
          >
            Tout valider
          </button>
          <button
            disabled={!validDocs.length || step === 'importing'}
            onClick={handleImport}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 bg-indigo-600 text-white text-xs font-semibold rounded-lg hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {step === 'importing' ? (
              <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Import…</>
            ) : (
              <><CheckCircle2 className="w-3.5 h-3.5" /> Importer {validDocs.length} validé{validDocs.length > 1 ? 's' : ''}</>
            )}
          </button>
        </div>
      </div>

      {/* Corps split-screen */}
      <div className="flex flex-1 overflow-hidden">

        {/* ── Gauche : PDF ─────────────────────────────────────────── */}
        <div className="flex flex-col border-r border-gray-100" style={{ width: '58%' }}>
          {/* Sélecteur de fichier */}
          {fileData.length > 1 && (
            <div className="flex gap-1 px-2 py-1.5 border-b border-gray-100 bg-gray-50/60 overflow-x-auto shrink-0">
              {fileData.map((fd, i) => (
                <button
                  key={i}
                  onClick={() => setActiveFileIndex(i)}
                  className={cn(
                    'text-xs px-2.5 py-1 rounded-lg whitespace-nowrap transition-colors',
                    activeFileIndex === i
                      ? 'bg-indigo-600 text-white font-medium'
                      : 'text-gray-500 hover:bg-gray-100'
                  )}
                >
                  {fd.file.name.replace(/\.pdf$/i, '')}
                </button>
              ))}
            </div>
          )}
          {currentObjectUrl ? (
            <iframe
              key={currentObjectUrl}
              src={currentObjectUrl}
              className="flex-1 w-full"
              title="PDF"
            />
          ) : (
            <div className="flex-1 flex items-center justify-center text-gray-300 text-sm">Aucun PDF</div>
          )}
        </div>

        {/* ── Droite : documents extraits ──────────────────────────── */}
        <div className="flex flex-col overflow-y-auto bg-gray-50/40" style={{ width: '42%' }}>
          {fileData.map((fd) => (
            <div key={fd.file.name}>
              {fileData.length > 1 && (
                <div className="px-3 py-1.5 bg-gray-100/70 border-b border-gray-200 sticky top-0 z-10">
                  <p className="text-xs font-semibold text-gray-500 truncate">{fd.file.name}</p>
                </div>
              )}
              {fd.docs.map((doc) => {
                const isActive = doc.key === activeDocKey;
                const isExpanded = expandedKeys.has(doc.key);
                return (
                  <div
                    key={doc.key}
                    className={cn(
                      'border-b border-gray-100 transition-colors',
                      isActive ? 'bg-indigo-50/60' : 'bg-white hover:bg-gray-50/60',
                      doc.status === 'skip' ? 'opacity-40' : ''
                    )}
                  >
                    {/* En-tête du doc */}
                    <div
                      className="flex items-center gap-2 px-3 py-2.5 cursor-pointer"
                      onClick={() => selectDoc(doc)}
                    >
                      {/* Statut */}
                      <div className="flex gap-1 shrink-0">
                        <button
                          onClick={e => { e.stopPropagation(); setDocStatus(doc.key, doc.status === 'valid' ? 'pending' : 'valid'); }}
                          title="Valider"
                          className={cn(
                            'w-6 h-6 rounded-full flex items-center justify-center transition-colors',
                            doc.status === 'valid'
                              ? 'bg-emerald-500 text-white'
                              : 'border-2 border-gray-200 text-gray-300 hover:border-emerald-400 hover:text-emerald-400'
                          )}
                        >
                          <CheckCircle2 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={e => { e.stopPropagation(); setDocStatus(doc.key, doc.status === 'skip' ? 'pending' : 'skip'); }}
                          title="Ignorer"
                          className={cn(
                            'w-6 h-6 rounded-full flex items-center justify-center transition-colors',
                            doc.status === 'skip'
                              ? 'bg-red-400 text-white'
                              : 'border-2 border-gray-200 text-gray-300 hover:border-red-400 hover:text-red-400'
                          )}
                        >
                          <XCircle className="w-3.5 h-3.5" />
                        </button>
                      </div>

                      {/* Infos */}
                      <div className="flex-1 min-w-0" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center gap-2">
                          {doc.type === 'inconnu' ? (
                            <span className="flex items-center gap-1 text-xs font-semibold text-amber-700">
                              <AlertTriangle className="w-3.5 h-3.5" /> Non reconnu
                            </span>
                          ) : (
                            <>
                              {editTarget?.key === doc.key && editTarget.field === 'numero' ? (
                                <input
                                  className="text-xs font-bold font-mono w-32 border-b border-indigo-400 bg-transparent outline-none"
                                  value={editTarget.value}
                                  autoFocus
                                  onChange={e => setEditTarget({ ...editTarget, value: e.target.value })}
                                  onBlur={() => commitEdit(editTarget)}
                                  onKeyDown={e => { if (e.key === 'Enter') commitEdit(editTarget); if (e.key === 'Escape') setEditTarget(null); }}
                                />
                              ) : (
                                <span
                                  className={cn('text-xs font-bold font-mono cursor-text hover:text-indigo-600', isActive ? 'text-indigo-700' : 'text-gray-900')}
                                  title="Cliquer pour modifier"
                                  onClick={() => setEditTarget({ key: doc.key, field: 'numero', value: doc.numero })}
                                >
                                  {doc.numero}
                                </span>
                              )}
                              <span className={cn('text-xs rounded-full px-1.5 py-0.5 font-medium', doc.type === 'be' ? 'bg-indigo-50 text-indigo-600' : 'bg-purple-50 text-purple-600')}>
                                {doc.type === 'be' ? 'BE' : 'Facture'}
                              </span>
                            </>
                          )}
                        </div>
                        <div className="flex items-center gap-2 mt-0.5">
                          {editTarget?.key === doc.key && editTarget.field === 'fournisseur' ? (
                            <input
                              className="text-xs text-gray-700 border-b border-indigo-400 bg-transparent outline-none flex-1 min-w-0"
                              value={editTarget.value}
                              autoFocus
                              onChange={e => setEditTarget({ ...editTarget, value: e.target.value })}
                              onBlur={() => commitEdit(editTarget)}
                              onKeyDown={e => { if (e.key === 'Enter') commitEdit(editTarget); if (e.key === 'Escape') setEditTarget(null); }}
                            />
                          ) : (
                            <span
                              className="text-xs text-gray-400 truncate cursor-text hover:text-gray-700"
                              title="Cliquer pour modifier le fournisseur"
                              onClick={() => doc.type !== 'inconnu' && setEditTarget({ key: doc.key, field: 'fournisseur', value: doc.fournisseur ?? '' })}
                            >
                              {doc.fournisseur ?? '—'}
                            </span>
                          )}
                          {editTarget?.key === doc.key && editTarget.field === 'date' ? (
                            <input
                              type="date"
                              className="text-xs text-gray-500 border-b border-indigo-400 bg-transparent outline-none w-28"
                              value={editTarget.value}
                              autoFocus
                              onChange={e => setEditTarget({ ...editTarget, value: e.target.value })}
                              onBlur={() => commitEdit(editTarget)}
                              onKeyDown={e => { if (e.key === 'Enter') commitEdit(editTarget); if (e.key === 'Escape') setEditTarget(null); }}
                            />
                          ) : (
                            <span
                              className="text-xs text-gray-300 cursor-text hover:text-gray-500"
                              title="Cliquer pour modifier la date"
                              onClick={() => doc.type !== 'inconnu' && setEditTarget({ key: doc.key, field: 'date', value: doc.date ?? '' })}
                            >
                              {doc.date || '—'}
                            </span>
                          )}
                          <span className="text-xs font-semibold text-gray-600 ml-auto shrink-0">
                            {doc.nbLignes}L · {doc.qteTotale}u
                          </span>
                        </div>
                      </div>

                      {/* Expand toggle */}
                      <button
                        onClick={e => { e.stopPropagation(); toggleExpand(doc.key); }}
                        className="p-0.5 text-gray-300 hover:text-gray-500 shrink-0"
                      >
                        {isExpanded
                          ? <ChevronDown className="w-3.5 h-3.5" />
                          : <ChevronRight className="w-3.5 h-3.5" />
                        }
                      </button>
                    </div>

                    {/* Lignes détail */}
                    {isExpanded && doc.lignes.length > 0 && (
                      <div className="px-3 pb-2.5 border-t border-gray-50">
                        <table className="w-full text-xs mt-1.5">
                          <thead>
                            <tr className="text-gray-400">
                              <th className="text-left pb-1 font-medium w-24">Réf.</th>
                              <th className="text-left pb-1 font-medium">Désignation</th>
                              <th className="text-right pb-1 font-medium w-10">Qté</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-50">
                            {doc.lignes.map((l, i) => (
                              <tr key={i} className="hover:bg-gray-50/50">
                                <td className="py-1 font-mono font-medium text-gray-700 truncate max-w-[90px]">{l.ref ?? '—'}</td>
                                <td className="py-1 text-gray-400 truncate max-w-[140px]" title={l.designation ?? ''}>{l.designation ?? '—'}</td>
                                <td className="py-1 text-right font-mono font-semibold text-gray-800">
                                  {editTarget?.key === doc.key && editTarget.field === 'ligne_qte' && editTarget.lineIdx === i ? (
                                    <input
                                      type="number"
                                      className="w-14 text-right border-b border-indigo-400 bg-transparent outline-none font-mono text-xs"
                                      value={editTarget.value}
                                      autoFocus
                                      onClick={e => e.stopPropagation()}
                                      onChange={e => setEditTarget({ ...editTarget, value: e.target.value })}
                                      onBlur={() => commitEdit(editTarget)}
                                      onKeyDown={e => { if (e.key === 'Enter') commitEdit(editTarget); if (e.key === 'Escape') setEditTarget(null); }}
                                    />
                                  ) : (
                                    <span
                                      className="cursor-text hover:text-indigo-600"
                                      title="Cliquer pour modifier la quantité"
                                      onClick={e => { e.stopPropagation(); setEditTarget({ key: doc.key, field: 'ligne_qte', lineIdx: i, value: String(l.qte) }); }}
                                    >
                                      {l.qte}
                                    </span>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}

          {/* Footer */}
          <div className="sticky bottom-0 bg-white border-t border-gray-200 px-3 py-2.5 text-xs text-gray-500 flex items-center justify-between">
            <span>
              {validDocs.length} validé{validDocs.length !== 1 ? 's' : ''} ·{' '}
              {pendingDocs.filter(d => d.type !== 'inconnu').length} en attente ·{' '}
              {allDocs.filter(d => d.status === 'skip').length} ignoré{allDocs.filter(d => d.status === 'skip').length !== 1 ? 's' : ''}
            </span>
            {pendingDocs.filter(d => d.type !== 'inconnu').length > 0 && (
              <span className="text-amber-600">⚠ valider ou ignorer avant d'importer</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
