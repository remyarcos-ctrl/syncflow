import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

function adminSb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(),
  );
}

// Crée une commande "complément" pour absorber le surplus reçu hors commande initiale.
// Lie la ligne_be ciblée à la nouvelle commande créée → plus de ligne libre orpheline.
//
// Idempotence : on crée une commande à chaque appel (numero auto-généré unique).
// Cascades : aucune. Pas de trigger SQL impliqué. Le matching futur des factures verra
// cette nouvelle commande comme n'importe quelle autre.
export async function POST(req: NextRequest) {
  const { ligneBeId } = await req.json() as { ligneBeId: string };
  if (!ligneBeId) return NextResponse.json({ error: 'ligneBeId requis' }, { status: 400 });

  const sb = adminSb();

  // Récupérer la ligne_be et le BE associé
  const { data: ligne, error: errLigne } = await sb
    .from('lignes_be')
    .select('id, be_id, reference_article, designation, quantite_receptionnee, ligne_commande_id, hors_systeme, statut_retour')
    .eq('id', ligneBeId)
    .single();
  if (errLigne || !ligne) {
    return NextResponse.json({ error: errLigne?.message ?? 'Ligne BE introuvable' }, { status: 404 });
  }
  if (ligne.ligne_commande_id) {
    return NextResponse.json({ error: 'Ligne déjà attribuée à une commande' }, { status: 400 });
  }
  if (ligne.hors_systeme || ligne.statut_retour) {
    return NextResponse.json({ error: 'Ligne marquée hors système ou en retour — pas éligible' }, { status: 400 });
  }

  const { data: be, error: errBe } = await sb
    .from('be_receptions')
    .select('id, numero_be, fournisseur')
    .eq('id', ligne.be_id)
    .single();
  if (errBe || !be) {
    return NextResponse.json({ error: errBe?.message ?? 'BE introuvable' }, { status: 404 });
  }

  // Numéro unique pour la commande complément
  const refSlug = (ligne.reference_article ?? 'ART').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12).toUpperCase();
  const beSlug = (be.numero_be ?? 'BE').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12).toUpperCase();
  const numero = `COMP-${beSlug}-${refSlug}-${Date.now().toString().slice(-5)}`;
  const today = new Date().toISOString().slice(0, 10);

  // 1. Créer la commande
  const { data: cmd, error: errCmd } = await sb.from('commandes').insert({
    numero_commande_interne: numero,
    fournisseur: be.fournisseur,
    date_commande: today,
    statut_commande: 'réceptionnée',
    montant_total_commande: null,
    commentaire: `Commande complément créée automatiquement depuis BE ${be.numero_be} (surplus reçu).`,
  }).select('id').single();
  if (errCmd || !cmd) {
    return NextResponse.json({ error: errCmd?.message ?? 'Erreur création commande' }, { status: 500 });
  }

  // 2. Créer la ligne_commande correspondante
  const qte = ligne.quantite_receptionnee ?? 0;
  const { data: ligneCmd, error: errLc } = await sb.from('lignes_commande').insert({
    commande_id: cmd.id,
    reference_article: ligne.reference_article,
    designation: ligne.designation,
    quantite_commandee: qte,
    quantite_receptionnee_reelle: qte,
    quantite_facturee: 0,
    quantite_restante_a_recevoir: 0,
    quantite_restante_a_facturer: qte,
    statut_ligne: 'reçue',
    pu_commande: null,
  }).select('id').single();
  if (errLc || !ligneCmd) {
    // Rollback : supprimer la commande créée
    await sb.from('commandes').delete().eq('id', cmd.id);
    return NextResponse.json({ error: errLc?.message ?? 'Erreur création ligne commande' }, { status: 500 });
  }

  // 3. Attribuer la ligne_be à la nouvelle ligne_commande
  const { error: errUpdLb } = await sb.from('lignes_be')
    .update({ ligne_commande_id: ligneCmd.id })
    .eq('id', ligneBeId);
  if (errUpdLb) {
    return NextResponse.json({ error: errUpdLb.message }, { status: 500 });
  }

  // 4. Liaison many-to-many BE ↔ commande (idempotente : unique constraint)
  const { error: errLiaison } = await sb.from('liaison_be_commande').insert({
    be_id: be.id,
    commande_id: cmd.id,
  });
  if (errLiaison && !errLiaison.message.includes('unique') && !errLiaison.message.includes('duplicate')) {
    console.warn('[creer-commande-complement] liaison_be_commande insert error:', errLiaison.message);
  }

  // 5. Journal
  await sb.from('journal_activite').insert({
    type_action: 'commande_complement_creee',
    entite_type: 'be_reception',
    entite_id: be.id,
    details_action: JSON.stringify({
      commande_id: cmd.id,
      numero_commande: numero,
      ligne_be_id: ligneBeId,
      reference: ligne.reference_article,
      quantite: qte,
    }),
  });

  return NextResponse.json({ ok: true, commande_id: cmd.id, numero_commande: numero });
}
