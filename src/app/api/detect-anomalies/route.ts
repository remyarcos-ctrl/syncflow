import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { controlerReceptions, normalizeRef, type LigneBeInput, type LigneCmdInput } from '@/lib/reception';

function adminSb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(),
  );
}

// Mappe un verdict réception → type d'exception du centre.
const TYPE: Record<string, string> = {
  sur_livraison: 'sur-livraison',
  hors_commande: 'hors-commande',
};

// POST : détecte les anomalies du contrôle réception et les déverse dans `exceptions`
// (idempotent : on n'insère pas une anomalie déjà présente pour ce BE + réf + type).
export async function POST() {
  const sb = adminSb();

  const [{ data: lignesBe }, { data: lignesCmd }, { data: existing }] = await Promise.all([
    sb.from('lignes_be').select('be_id, reference_article, designation, quantite_receptionnee, hors_systeme'),
    sb.from('lignes_commande').select('reference_article, quantite_commandee, quantite_receptionnee_reelle'),
    sb.from('exceptions').select('be_id, reference_article, type_exception').eq('origine', 'réception'),
  ]);

  const be = (lignesBe ?? []).filter((l) => !l.hors_systeme && (l.quantite_receptionnee ?? 0) > 0) as LigneBeInput[];
  const controles = controlerReceptions(be, (lignesCmd ?? []) as LigneCmdInput[]);

  // Clés déjà présentes : be_id|réf normalisée|type
  const seen = new Set(
    (existing ?? []).map((e) => `${e.be_id}|${normalizeRef(e.reference_article)}|${e.type_exception}`),
  );

  const aInserer = controles
    .filter((c) => c.verdict === 'sur_livraison' || c.verdict === 'hors_commande')
    .filter((c) => !seen.has(`${c.be_id}|${normalizeRef(c.ref)}|${TYPE[c.verdict]}`))
    .map((c) => {
      const ecart = c.verdict === 'sur_livraison' ? (c.totalRecu ?? 0) - (c.totalCommande ?? 0) : c.qteBe;
      return {
        be_id: c.be_id,
        reference_article: c.ref,
        type_exception: TYPE[c.verdict],
        origine: 'réception',
        destinataire: 'Colombi',
        statut_exception: 'ouverte',
        niveau_priorite: 'moyenne',
        motif: c.verdict === 'sur_livraison'
          ? `Sur-livraison ${c.ref} : commandé ${c.totalCommande} / reçu ${c.totalRecu} (+${ecart})`
          : `Hors commande ${c.ref} : reçu ${c.qteBe}, jamais commandé`,
        valeur_attendue: c.verdict === 'sur_livraison' ? c.totalCommande : null,
        valeur_obtenue: c.verdict === 'sur_livraison' ? c.totalRecu : c.qteBe,
        ecart,
      };
    });

  let inserted = 0;
  if (aInserer.length > 0) {
    const { error, count } = await sb.from('exceptions').insert(aInserer, { count: 'exact' });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    inserted = count ?? aInserer.length;
  }

  return NextResponse.json({
    origine: 'réception',
    detectees: controles.filter((c) => c.verdict !== 'conforme').length,
    deja_presentes: seen.size,
    inserees: inserted,
  });
}
