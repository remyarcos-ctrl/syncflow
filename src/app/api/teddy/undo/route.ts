import { NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALLOWED_FIELDS: Record<string, string[]> = {
  commandes: ['numero_commande_interne', 'fournisseur', 'date_commande', 'montant_total_commande', 'statut_commande'],
  factures: ['numero_facture', 'fournisseur', 'date_facture', 'date_echeance', 'montant_ht', 'montant_ttc', 'statut_facture', 'notes'],
  be_receptions: ['numero_be', 'fournisseur', 'date_bl', 'date_reception', 'statut_be', 'notes'],
};

export async function POST(req: NextRequest) {
  const body = await req.json() as { table?: unknown; id?: unknown; champs?: unknown };
  const { table, id, champs } = body;

  if (typeof table !== 'string' || typeof id !== 'string' || typeof champs !== 'object' || champs === null) {
    return Response.json({ error: 'Paramètres invalides' }, { status: 400 });
  }

  const allowedTables = ['commandes', 'factures', 'be_receptions'];
  if (!allowedTables.includes(table)) {
    return Response.json({ error: 'Table non autorisée' }, { status: 400 });
  }

  if (!UUID_RE.test(id)) {
    return Response.json({ error: 'ID invalide' }, { status: 400 });
  }

  // Allowlist fields per table to prevent injecting system columns
  const allowedFields = ALLOWED_FIELDS[table];
  const safeChamps = Object.fromEntries(
    Object.entries(champs as Record<string, unknown>).filter(([k]) => allowedFields.includes(k))
  );
  if (Object.keys(safeChamps).length === 0) {
    return Response.json({ error: 'Aucun champ valide à restaurer' }, { status: 400 });
  }

  const { error } = await supabase.from(table).update(safeChamps).eq('id', id);
  if (error) return Response.json({ error: error.message }, { status: 400 });
  return Response.json({ ok: true });
}
