import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { normalizeRef, type ParsedDocument } from '@/lib/document-parser';

function adminSb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
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
  return (data ?? []).some(row => normalizeDocNum(String((row as unknown as Record<string, unknown>)[field] ?? '')) === norm);
}

type DocWithUrl = ParsedDocument & { pdf_url?: string };

// Tente de créer des rapprochements automatiques pour une facture qui vient d'être importée
async function autoRapprocher(
  sb: ReturnType<typeof adminSb>,
  factureId: string,
  fournisseur: string | null,
  lignesFacture: { id: string; reference_article: string | null; quantite_facturee: number; montant_ht: number | null; numero_be_detecte?: string | null }[],
) {
  if (!fournisseur || !lignesFacture.length) return;
  const normF = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
  const normFact = normF(fournisseur);

  // Récupérer les BEs candidats (même fournisseur)
  const { data: bes } = await sb
    .from('be_receptions')
    .select('id, numero_be, fournisseur')
    .order('created_at', { ascending: false })
    .limit(300);

  const candidatBeIds = (bes ?? [])
    .filter(b => {
      const n = normF(b.fournisseur ?? '');
      return n === normFact || n.includes(normFact.slice(0, 5)) || normFact.includes(n.slice(0, 5));
    })
    .map(b => b.id);

  if (!candidatBeIds.length) return;

  // Index BE par numéro pour lookup rapide
  const beByNumero = new Map((bes ?? []).map(b => [b.numero_be?.toUpperCase().replace(/[^A-Z0-9]/g, ''), b.id]));

  const { data: lignesBE } = await sb
    .from('lignes_be')
    .select('id, be_id, reference_article, quantite_restante_a_facturer')
    .in('be_id', candidatBeIds)
    .gt('quantite_restante_a_facturer', 0);

  if (!lignesBE?.length) return;

  // Rapprochements déjà existants pour cette facture (éviter doublons)
  const { data: existingRaps } = await sb
    .from('rapprochements')
    .select('ligne_facture_id, ligne_be_id')
    .eq('facture_id', factureId);
  const existingSet = new Set((existingRaps ?? []).map(r => `${r.ligne_facture_id}|${r.ligne_be_id}`));

  const raps: object[] = [];

  for (const lf of lignesFacture) {
    if (!lf.reference_article) continue;
    const normRef = normalizeRef(lf.reference_article);

    // Essai 1 : chercher via numero_be_detecte
    let matchBE: typeof lignesBE[0] | undefined;
    let score = 85;

    if (lf.numero_be_detecte) {
      const normBeNum = lf.numero_be_detecte.toUpperCase().replace(/[^A-Z0-9]/g, '');
      const targetBeId = beByNumero.get(normBeNum);
      if (targetBeId) {
        matchBE = lignesBE.find(lb => lb.be_id === targetBeId && normalizeRef(lb.reference_article ?? '') === normRef);
        if (matchBE) score = 95;
      }
    }

    // Essai 2 : référence dans tous les BEs candidats
    if (!matchBE) {
      matchBE = lignesBE.find(lb => normalizeRef(lb.reference_article ?? '') === normRef);
    }

    if (!matchBE) continue;
    if (existingSet.has(`${lf.id}|${matchBE.id}`)) continue;

    raps.push({
      facture_id: factureId,
      ligne_facture_id: lf.id,
      be_id: matchBE.be_id,
      ligne_be_id: matchBE.id,
      quantite_rapprochee: Math.min(lf.quantite_facturee, matchBE.quantite_restante_a_facturer),
      montant_rapproche: lf.montant_ht,
      mode_match: 'automatique_article' as const,
      score_match: score,
      statut_validation: 'proposé',
    });
    existingSet.add(`${lf.id}|${matchBE.id}`);
  }

  if (raps.length) {
    await sb.from('rapprochements').insert(raps);
  }
}

// POST : sauvegarde en base des documents déjà parsés et validés par l'utilisateur
export async function POST(req: NextRequest) {
  const { docs } = await req.json() as { docs: DocWithUrl[] };

  if (!Array.isArray(docs) || !docs.length) {
    return NextResponse.json({ error: 'docs requis' }, { status: 400 });
  }

  const sb = adminSb();
  const result = {
    bes_importes: 0,
    factures_importees: 0,
    doublons_ignores: 0,
    erreurs: [] as string[],
    details: [] as string[],
  };

  for (const doc of docs) {
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
        pdf_url: (doc as DocWithUrl).pdf_url ?? null,
      }).select('id').single();

      if (error || !beRecord) {
        result.erreurs.push(`BE ${doc.data.numero_be} : ${error?.message}`);
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
            quantite_facturee: 0,
            quantite_restante_a_facturer: l.quantite_receptionnee,
          })),
        );
      }

      await sb.from('journal_activite').insert({
        type_action: 'import_pdf',
        entite_type: 'be_reception',
        entite_id: beRecord.id,
        details_action: JSON.stringify({ lignes: doc.data.lignes.length, source: 'import_valide' }),
      });

      result.bes_importes++;
      result.details.push(`✓ BE ${doc.data.numero_be} — ${doc.data.lignes.length} ligne(s)`);
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
        pdf_url: (doc as DocWithUrl).pdf_url ?? null,
      }).select('id').single();

      if (error || !factRecord) {
        result.erreurs.push(`Facture ${doc.data.numero_facture} : ${error?.message}`);
        continue;
      }

      // Agréger par beNum|ref|pu : même ref + même prix = même commande (agréger) ;
      // même ref + prix différent = commandes distinctes à des moments différents → lignes séparées
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

      const lignes = Array.from(aggMap.values()).map(l => ({
        ...l,
        prix_unitaire: l.montant_ht && l.quantite_facturee > 0
          ? l.montant_ht / l.quantite_facturee : l.prix_unitaire,
      }));

      let lignesFactureInserted: { id: string; reference_article: string | null; quantite_facturee: number; montant_ht: number | null; numero_be_detecte?: string | null }[] = [];
      if (lignes.length > 0) {
        const { data: inserted } = await sb.from('lignes_facture').insert(
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
        ).select('id, reference_article, quantite_facturee, montant_ht, numero_be_detecte');
        lignesFactureInserted = inserted ?? [];
      }

      // Tenter un rapprochement automatique (résultats = 'proposé', à valider par l'utilisateur)
      await autoRapprocher(sb, factRecord.id, doc.data.fournisseur, lignesFactureInserted);

      // Fire anomaly detection (non-blocking)
      void fetch(`${process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'}/api/anomalie-ia`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ factureId: factRecord.id }),
      }).catch(() => null);

      result.factures_importees++;
      result.details.push(`✓ Facture ${doc.data.numero_facture} — ${lignes.length} ligne(s)`);
    }
  }

  return NextResponse.json(result);
}
