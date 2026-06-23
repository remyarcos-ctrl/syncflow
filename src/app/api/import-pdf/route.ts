import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { parsePdfDocuments, normalizeRef } from '@/lib/document-parser';

export const maxDuration = 60;
function adminSb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(),
  );
}

function normalizeDocNum(s: string): string {
  return String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

async function isDuplicate(sb: ReturnType<typeof adminSb>, table: string, field: string, value: string): Promise<boolean> {
  const norm = normalizeDocNum(value);
  const { data: exact } = await sb.from(table).select('id').eq(field, value).limit(1);
  if ((exact?.length ?? 0) > 0) return true;
  const suffix = norm.slice(-8);
  if (suffix.length < 4) return false;
  const { data } = await sb.from(table).select(field).ilike(field, `%${suffix}%`);
  return (data ?? []).some((row) => normalizeDocNum(String((row as unknown as Record<string, unknown>)[field] ?? '')) === norm);
}

export async function POST(req: NextRequest) {
  const sb = adminSb();

  let storagePath: string;
  let fileName: string;
  try {
    const body = await req.json() as { storagePath: string; fileName: string };
    storagePath = body.storagePath;
    fileName = body.fileName;
    if (!storagePath || !fileName) throw new Error('Champs manquants');
  } catch {
    return NextResponse.json({ error: 'Requête invalide' }, { status: 400 });
  }

  const result = {
    bes_importes: 0,
    factures_importees: 0,
    doublons_ignores: 0,
    cout_eur: 0,
    moteur: '' as string,
    erreurs: [] as string[],
    details: [] as string[],
  };

  // Persistance : on déplace le PDF de temp/ vers pdf/<timestamp>-<file>.
  // En cas d'échec de move (collisions, droits), on retombe sur le chemin temp et la suppression de fin n'a pas lieu.
  const sanitized = String(fileName).replace(/[^a-zA-Z0-9._-]/g, '_');
  const permanentPath = `pdf/${Date.now()}-${sanitized}`;
  let pdfPathForUrl = storagePath;
  let moveSucceeded = false;
  try {
    const { error: moveErr } = await sb.storage.from('documents').move(storagePath, permanentPath);
    if (!moveErr) {
      pdfPathForUrl = permanentPath;
      moveSucceeded = true;
    }
  } catch { /* fallback to temp path */ }
  const { data: { publicUrl: pdfUrl } } = sb.storage.from('documents').getPublicUrl(pdfPathForUrl);

  try {
    const { data: blob, error: dlErr } = await sb.storage.from('documents').download(pdfPathForUrl);
    if (dlErr || !blob) {
      result.erreurs.push(`${fileName} : impossible de télécharger depuis le storage — ${dlErr?.message}`);
      return NextResponse.json(result);
    }

    const arrayBuffer = await blob.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString('base64');

    let docs;
    try {
      const parsed = await parsePdfDocuments(base64, fileName);
      docs = parsed.docs;
      result.cout_eur = parsed.coutEUR;
      result.moteur = parsed.moteur;
    } catch (err) {
      result.erreurs.push(`${fileName} : erreur Claude API — ${err instanceof Error ? err.message : String(err)}`);
      return NextResponse.json(result);
    }

    console.log(`[import-pdf] ${fileName} → ${docs.length} document(s) détecté(s)`);

    for (const doc of docs) {
      if (doc.type === 'inconnu') {
        result.erreurs.push(`${fileName} : ${doc.raison}`);
        continue;
      }

      if (doc.type === 'be') {
        const isDup = await isDuplicate(sb, 'be_receptions', 'numero_be', doc.data.numero_be);
        if (isDup) {
          result.doublons_ignores++;
          result.details.push(`Doublon ignoré : BE ${doc.data.numero_be}`);
          continue;
        }

        const { data: beRecord, error } = await sb.from('be_receptions').insert({
          numero_be: doc.data.numero_be,
          fournisseur: doc.data.fournisseur,
          date_bl: doc.data.date_bl,
          statut_be: 'reçu',
          pdf_url: pdfUrl,
        }).select('id').single();

        if (error || !beRecord) {
          result.erreurs.push(`${fileName} / BE ${doc.data.numero_be} : erreur base de données — ${error?.message}`);
          continue;
        }

        if (doc.data.lignes.length > 0) {
          await sb.from('lignes_be').insert(
            doc.data.lignes.map((l, i) => ({
              be_id: beRecord.id,
              ligne_no: i + 1,
              reference_article: l.reference_article,
              designation: l.designation,
              quantite_receptionnee: l.quantite_receptionnee,
              quantite_document_be: l.quantite_receptionnee,
              quantite_facturee: 0,
              quantite_restante_a_facturer: l.hors_systeme ? 0 : l.quantite_receptionnee,
              hors_systeme: l.hors_systeme ?? false,
            })),
          );
        }

        await sb.from('journal_activite').insert({
          type_action: 'import_pdf',
          entite_type: 'be_reception',
          entite_id: beRecord.id,
          details_action: JSON.stringify({ fichier: fileName, lignes: doc.data.lignes.length }),
        });

        result.bes_importes++;
        result.details.push(`✓ BE importé : ${doc.data.numero_be} (${doc.data.lignes.length} ligne${doc.data.lignes.length > 1 ? 's' : ''})`);
      }

      if (doc.type === 'facture') {
        const isDup = await isDuplicate(sb, 'factures', 'numero_facture', doc.data.numero_facture);
        if (isDup) {
          result.doublons_ignores++;
          result.details.push(`Doublon ignoré : facture ${doc.data.numero_facture}`);
          continue;
        }

        const { data: factRecord, error } = await sb.from('factures').insert({
          numero_facture: doc.data.numero_facture,
          fournisseur: doc.data.fournisseur,
          date_facture: doc.data.date_facture,
          total_ht: doc.data.total_ht,
          total_ttc: doc.data.total_ttc,
          taux_rapprochement: 0,
          statut_facture: 'importée',
          pdf_url: pdfUrl,
        }).select('id').single();

        if (error || !factRecord) {
          result.erreurs.push(`${fileName} / Facture ${doc.data.numero_facture} : erreur base de données — ${error?.message}`);
          continue;
        }

        const aggMap = new Map<string, typeof doc.data.lignes[0]>();
        for (const l of doc.data.lignes) {
          const puKey = Math.round((l.prix_unitaire ?? 0) * 10000);
          const key = `${l.numero_be_detecte ?? ''}|${normalizeRef(l.reference_article ?? '')}|${puKey}`;
          if (aggMap.has(key)) {
            const ex = aggMap.get(key)!;
            ex.quantite_facturee += l.quantite_facturee;
            ex.montant_ht = (ex.montant_ht ?? 0) + (l.montant_ht ?? 0);
          } else {
            aggMap.set(key, { ...l });
          }
        }

        const lignes = Array.from(aggMap.values()).map((l) => ({
          ...l,
          prix_unitaire: l.montant_ht && l.quantite_facturee > 0
            ? l.montant_ht / l.quantite_facturee
            : l.prix_unitaire,
        }));

        if (lignes.length > 0) {
          await sb.from('lignes_facture').insert(
            lignes.map((l, i) => ({
              facture_id: factRecord.id,
              ligne_no: i + 1,
              reference_article: l.reference_article,
              designation: l.designation,
              quantite_facturee: l.quantite_facturee,
              pu_facture: l.prix_unitaire,
              montant_ht: l.montant_ht,
              numero_be_detecte: l.numero_be_detecte,
            })),
          );
        }

        await sb.from('journal_activite').insert({
          type_action: 'import_pdf',
          entite_type: 'facture',
          entite_id: factRecord.id,
          details_action: JSON.stringify({ fichier: fileName, lignes: lignes.length }),
        });

        result.factures_importees++;
        result.details.push(`✓ Facture importée : ${doc.data.numero_facture} (${lignes.length} ligne${lignes.length > 1 ? 's' : ''})`);
      }
    }

    // Trace du coût Claude de cet import (1 ligne par fichier), pour l'onglet Coûts Claude.
    if (result.cout_eur > 0) {
      await sb.from('journal_activite').insert({
        type_action: 'cout_claude',
        entite_type: 'import',
        details_action: JSON.stringify({
          fichier: fileName,
          cout_eur: result.cout_eur,
          moteur: result.moteur,
          bes: result.bes_importes,
          factures: result.factures_importees,
          doublons: result.doublons_ignores,
        }),
      });
    }

    return NextResponse.json(result);
  } finally {
    // Si le move a réussi, le PDF vit dans pdf/ — ne pas le supprimer (utilisé par pdf_url).
    // Sinon, on nettoie le fichier temp qui est resté en place.
    if (!moveSucceeded) {
      await sb.storage.from('documents').remove([storagePath]);
    }
  }
}
