import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { parsePdfDocuments, normalizeRef } from '@/lib/document-parser';

function adminSb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(),
  );
}

// POST { beId } : re-parse le PDF déjà stocké d'un BE avec le parser à jour et
// CORRIGE la quantité des lignes existantes (match par référence). Ne touche pas
// aux flags manuels (hors_systeme/SAV, statut_retour, ligne_commande_id) ni à la
// structure — on met seulement à jour quantite_receptionnee / document / reste à facturer.
export async function POST(req: NextRequest) {
  const sb = adminSb();
  let beId: string;
  try { beId = (await req.json() as { beId: string }).beId; if (!beId) throw new Error(); }
  catch { return NextResponse.json({ error: 'beId requis' }, { status: 400 }); }

  const { data: be } = await sb.from('be_receptions').select('id, numero_be, pdf_url').eq('id', beId).single();
  if (!be?.pdf_url) return NextResponse.json({ error: 'BE ou PDF introuvable' }, { status: 404 });

  // Chemin storage = ce qui suit /documents/ dans l'URL publique
  const m = be.pdf_url.match(/\/documents\/(.+)$/);
  if (!m) return NextResponse.json({ error: 'Chemin PDF illisible' }, { status: 400 });
  const path = decodeURIComponent(m[1]);
  const { data: blob, error: dlErr } = await sb.storage.from('documents').download(path);
  if (dlErr || !blob) return NextResponse.json({ error: `Téléchargement PDF échoué : ${dlErr?.message ?? ''}` }, { status: 500 });
  const base64 = Buffer.from(await blob.arrayBuffer()).toString('base64');

  let docs, coutEUR = 0, moteur = '';
  try { const p = await parsePdfDocuments(base64, be.numero_be); docs = p.docs; coutEUR = p.coutEUR; moteur = p.moteur; }
  catch (e) { return NextResponse.json({ error: `Parse : ${e instanceof Error ? e.message : String(e)}` }, { status: 500 }); }

  const nbe = (s: string) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const beDoc = docs.find(d => d.type === 'be' && nbe(d.data.numero_be) === nbe(be.numero_be))
    ?? docs.find(d => d.type === 'be');
  if (!beDoc || beDoc.type !== 'be') return NextResponse.json({ error: 'Aucun BE détecté dans le PDF' }, { status: 422 });

  const { data: existing } = await sb.from('lignes_be')
    .select('id, reference_article, quantite_receptionnee, quantite_facturee, hors_systeme')
    .eq('be_id', beId);
  const exByRef = new Map<string, { id: string; qty: number; fact: number; sav: boolean }>();
  for (const l of existing ?? []) {
    exByRef.set(normalizeRef(l.reference_article), {
      id: l.id, qty: l.quantite_receptionnee ?? 0, fact: l.quantite_facturee ?? 0, sav: !!l.hors_systeme,
    });
  }

  const changes: { ref: string | null; avant: number; apres: number }[] = [];
  const nonTrouvees: string[] = [];
  for (const l of beDoc.data.lignes) {
    const k = normalizeRef(l.reference_article);
    const ex = exByRef.get(k);
    if (!ex) { nonTrouvees.push(l.reference_article ?? '?'); continue; }
    if (ex.qty !== l.quantite_receptionnee) {
      await sb.from('lignes_be').update({
        quantite_receptionnee: l.quantite_receptionnee,
        quantite_document_be: l.quantite_receptionnee,
        quantite_restante_a_facturer: ex.sav ? 0 : Math.max(0, l.quantite_receptionnee - ex.fact),
      }).eq('id', ex.id);
      changes.push({ ref: l.reference_article, avant: ex.qty, apres: l.quantite_receptionnee });
    }
  }

  await sb.from('journal_activite').insert({
    type_action: 'rescan_be', entite_type: 'be_reception', entite_id: beId,
    details_action: JSON.stringify({ numero_be: be.numero_be, corrigees: changes.length, moteur }),
  });

  return NextResponse.json({ ok: true, corrigees: changes.length, changes, nonTrouvees, moteur, coutEUR });
}
