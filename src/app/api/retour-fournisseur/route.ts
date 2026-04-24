import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { getValidToken, sendEmail } from '@/lib/gmail-api';

function adminSb() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

const VALID_STATUTS = ['a_retourner', 'retourne', 'avoir_demande', 'avoir_recu'] as const;

// POST — initier un retour (marque a_retourner + envoi email optionnel)
export async function POST(req: NextRequest) {
  const { ligneBeId, motif, sendEmailFlag, emailTo, emailSubject, emailBody } = await req.json() as {
    ligneBeId: string;
    motif: string;
    sendEmailFlag: boolean;
    emailTo: string;
    emailSubject: string;
    emailBody: string;
  };

  if (!ligneBeId || !motif) {
    return NextResponse.json({ error: 'ligneBeId et motif requis' }, { status: 400 });
  }

  const sb = adminSb();

  const { error } = await sb.from('lignes_be').update({
    statut_retour: 'a_retourner',
    motif_retour: motif,
  }).eq('id', ligneBeId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (sendEmailFlag && emailTo && emailBody) {
    try {
      const tokenData = await getValidToken();
      if (tokenData) {
        await sendEmail(tokenData.token, {
          from: tokenData.config.email,
          to: emailTo,
          subject: emailSubject,
          body: emailBody,
        });
        await sb.from('journal_activite').insert({
          type_action: 'retour_fournisseur_email',
          entite_type: 'ligne_be',
          entite_id: ligneBeId,
          details_action: JSON.stringify({ to: emailTo, subject: emailSubject, motif }),
        });
      }
    } catch (e) {
      console.error('[retour-fournisseur] email error:', e);
      // Ne pas bloquer — le retour est quand même créé
    }
  }

  return NextResponse.json({ ok: true });
}

// PATCH — avancer le statut du retour
export async function PATCH(req: NextRequest) {
  const { ligneBeId, statut, avoirFactureId } = await req.json() as {
    ligneBeId: string;
    statut: string;
    avoirFactureId?: string | null;
  };

  if (!ligneBeId || !VALID_STATUTS.includes(statut as typeof VALID_STATUTS[number])) {
    return NextResponse.json({ error: 'Paramètres invalides' }, { status: 400 });
  }

  const sb = adminSb();
  const today = new Date().toISOString().slice(0, 10);
  const updates: Record<string, unknown> = { statut_retour: statut };

  if (statut === 'retourne') updates.date_retour_effectif = today;
  if (statut === 'avoir_demande') updates.date_avoir_demande = today;
  if (statut === 'avoir_recu' && avoirFactureId) updates.avoir_facture_id = avoirFactureId;

  const { error } = await sb.from('lignes_be').update(updates).eq('id', ligneBeId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await sb.from('journal_activite').insert({
    type_action: `retour_${statut}`,
    entite_type: 'ligne_be',
    entite_id: ligneBeId,
    details_action: JSON.stringify({ statut, ...(avoirFactureId ? { avoir_facture_id: avoirFactureId } : {}) }),
  });

  return NextResponse.json({ ok: true });
}
