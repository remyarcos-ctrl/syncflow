import { NextRequest, NextResponse } from 'next/server';
import { parsePdfDocuments } from '@/lib/document-parser';

// POST : analyse les PDFs via Claude et retourne les données parsées SANS écrire en base
export async function POST(req: NextRequest) {
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: 'Requête invalide' }, { status: 400 });
  }

  const files = formData.getAll('files') as File[];
  if (!files.length) return NextResponse.json({ error: 'Aucun fichier' }, { status: 400 });

  const results: { fileIndex: number; fileName: string; docs: unknown[]; cout_eur?: number; moteur?: string }[] = [];

  for (let fi = 0; fi < files.length; fi++) {
    if (fi > 0) await new Promise(res => setTimeout(res, 3000));
    const file = files[fi];
    const arrayBuffer = await file.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString('base64');

    try {
      const { docs, coutEUR, moteur } = await parsePdfDocuments(base64, file.name);
      results.push({ fileIndex: fi, fileName: file.name, docs, cout_eur: coutEUR, moteur });
    } catch (err) {
      results.push({
        fileIndex: fi,
        fileName: file.name,
        docs: [{ type: 'inconnu', raison: err instanceof Error ? err.message : String(err) }],
      });
    }
  }

  return NextResponse.json({ files: results });
}
