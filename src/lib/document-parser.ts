// Parsing de documents (email corps + PDF) via Claude API
// Applique toutes les règles métier de CONTEXT.md

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const MODEL_EMAIL = 'claude-haiku-4-5-20251001';
// PDF scannés : Haiku par défaut (3× moins cher). Sonnet en repli si l'extraction Haiku est douteuse.
const MODEL_PDF_PRIMAIRE = 'claude-haiku-4-5-20251001';
const MODEL_PDF_REPLI = 'claude-sonnet-4-6';

// Tarifs API Claude ($/1M tokens) pour estimer le coût de chaque import.
const TARIFS: Record<string, { in: number; out: number }> = {
  'claude-haiku-4-5-20251001': { in: 1, out: 5 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
};
interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}
function coutUSD(model: string, u: Usage): number {
  const p = TARIFS[model] ?? { in: 3, out: 15 };
  const tokIn =
    (u.input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0) * 1.25 +
    (u.cache_read_input_tokens ?? 0) * 0.1;
  return (tokIn * p.in + (u.output_tokens ?? 0) * p.out) / 1_000_000;
}

// ── Types résultats ───────────────────────────────────────────────────────────

export interface ParsedLigneCommande {
  reference_article: string | null;
  designation: string | null;
  quantite_commandee: number;
  pu_commande: number | null;
}

export interface ParsedCommande {
  numero_commande_interne: string;
  fournisseur: string;
  date_commande: string | null;
  montant_total_commande: number | null;
  lignes: ParsedLigneCommande[];
}

export interface ParsedLigneBE {
  reference_article: string;
  designation: string | null;
  quantite_receptionnee: number;
  hors_systeme?: boolean;
}

export interface ParsedBE {
  numero_be: string;
  fournisseur: string | null;
  date_bl: string | null;
  lignes: ParsedLigneBE[];
}

export interface ParsedLigneFacture {
  reference_article: string | null;
  designation: string | null;
  quantite_facturee: number;
  prix_unitaire: number | null;
  montant_ht: number | null;
  numero_be_detecte: string | null;
}

export interface ParsedFacture {
  numero_facture: string;
  fournisseur: string | null;
  date_facture: string | null;
  total_ht: number | null;
  total_ttc: number | null;
  lignes: ParsedLigneFacture[];
}

export type ParsedDocument =
  | { type: 'commande'; data: ParsedCommande }
  | { type: 'be'; data: ParsedBE }
  | { type: 'facture'; data: ParsedFacture }
  | { type: 'inconnu'; raison: string };

// ── Normalisation références (CONTEXT.md) ────────────────────────────────────

export const normalizeRef = (s: string | null | undefined): string =>
  String(s ?? '').toUpperCase().replace(/O/g, '0').replace(/[^A-Z0-9]/g, '');

const isPositionCode = (s: string) => /^[A-Z]{4}$/.test(s.trim());
const isEanBarcode = (s: string) => /^\d{8,}$/.test(s.trim());

// ── Appel Claude API ──────────────────────────────────────────────────────────

async function callClaude(messages: object[], systemPrompt: string, model = MODEL_EMAIL, maxTokens = 4096): Promise<{ text: string; usage: Usage }> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY manquante');

  const body = JSON.stringify({
    model,
    max_tokens: maxTokens,
    system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    messages,
  });

  const MAX_RETRIES = 4;
  let lastError = '';

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const resp = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
        'content-type': 'application/json',
      },
      body,
    });

    if (resp.ok) {
      const data = await resp.json() as { content: { type: string; text: string }[]; usage?: Usage };
      return { text: data.content.find((c) => c.type === 'text')?.text ?? '', usage: data.usage ?? {} };
    }

    // Rate limit : attendre selon Retry-After ou backoff exponentiel
    if (resp.status === 429 || resp.status === 529) {
      const retryAfter = resp.headers.get('retry-after');
      const waitMs = retryAfter
        ? parseInt(retryAfter) * 1000
        : Math.min(2000 * Math.pow(2, attempt), 60_000); // 2s, 4s, 8s, 16s
      console.warn(`[callClaude] rate limit (${resp.status}), attente ${waitMs}ms (tentative ${attempt + 1}/${MAX_RETRIES})`);
      await new Promise(res => setTimeout(res, waitMs));
      continue;
    }

    lastError = await resp.text();
    throw new Error(`Claude API error ${resp.status}: ${lastError}`);
  }

  throw new Error(`Claude API rate limit persistant après ${MAX_RETRIES} tentatives`);
}

// ── Lecture PDF par Claude ─────────────────────────────────────────────────────
// Pas de cache_control sur le document : chaque PDF n'est lu qu'une fois, le cacher
// n'ajouterait que la prime d'écriture (×1,25) sans aucune relecture.
async function callPdfClaude(pdfBase64: string, systemPrompt: string, prompt: string, model: string): Promise<{ text: string; usage: Usage }> {
  return callClaude([
    {
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
        { type: 'text', text: prompt },
      ],
    },
  ], systemPrompt, model, 8192);
}

function extractJSON<T>(text: string): { value: T } | { error: string } {
  const match = text.match(/```json\s*([\s\S]*?)```|(\{[\s\S]*\}|\[[\s\S]*\])/);
  const raw = match?.[1] ?? match?.[2];
  if (!raw) return { error: `Aucun bloc JSON trouvé dans la réponse. Réponse brute : ${text.slice(0, 300)}` };
  try {
    return { value: JSON.parse(raw) as T };
  } catch (e) {
    return { error: `JSON invalide : ${e instanceof Error ? e.message : String(e)}. Extrait : ${raw.slice(0, 300)}` };
  }
}

// ── Parser : Email corps → Commande ──────────────────────────────────────────

export async function parseCommandeFromEmail(
  emailBody: string,
  subject: string,
  from: string,
): Promise<ParsedCommande | null> {
  // Extraire fournisseur depuis le sujet (règle CONTEXT.md)
  const fournisseurMatch = subject.match(/COMMANDE\s+POUR\s+([^\-–\n]+)/i);
  const fournisseurFromSubject = fournisseurMatch ? fournisseurMatch[1].trim() : null;

  const system = `Tu es un extracteur de données pour une application de gestion de commandes.
Réponds UNIQUEMENT avec un objet JSON valide (pas de commentaires, pas de markdown sauf la balise json).`;

  const prompt = `Analyse cet email de commande et extrais les données au format JSON.

Sujet: ${subject}
De: ${from}
Corps (tronqué à 12000 chars):
${emailBody}

Extrais au format JSON :
{
  "numero_commande_interne": "le numéro après 'Numéro de bon de commande interne :' ou similaire",
  "date_commande": "date ISO YYYY-MM-DD ou null",
  "montant_total_commande": nombre ou null,
  "lignes": [
    {
      "reference_article": "référence article",
      "designation": "description",
      "quantite_commandee": nombre,
      "pu_commande": prix unitaire ou null
    }
  ]
}

Règles:
- numero_commande_interne : inclure le # si présent (ex: "#4721")
- Si plusieurs lignes identiques, les garder séparées
- quantite_commandee : toujours un nombre entier ou décimal
- Retourner null si un champ n'est pas trouvé`;

  const { text: raw } = await callClaude([{ role: 'user', content: prompt }], system);
  const result = extractJSON<Omit<ParsedCommande, 'fournisseur'>>(raw);
  if ('error' in result) { console.error('[parseCommande]', result.error); return null; }
  const parsed = result.value;

  return {
    ...parsed,
    fournisseur: fournisseurFromSubject ?? from,
    numero_commande_interne: parsed.numero_commande_interne ?? `CMD-${Date.now()}`,
    lignes: (parsed.lignes ?? []).map((l) => ({
      ...l,
      quantite_commandee: Number(l.quantite_commandee) || 1,
      pu_commande: l.pu_commande != null ? Number(l.pu_commande) : null,
    })),
  };
}

// ── Helpers post-traitement ───────────────────────────────────────────────────

function processBERaw(raw: Record<string, unknown>): ParsedDocument {
  const be = raw as unknown as ParsedBE;
  const lignes = (be.lignes ?? [])
    .filter((l) => l.reference_article && !isPositionCode(l.reference_article) && !isEanBarcode(l.reference_article))
    .map((l) => ({
      ...l,
      quantite_receptionnee: Number(l.quantite_receptionnee) || 0,
      designation: l.designation ?? null,
    }));

  const aggregated = new Map<string, ParsedLigneBE>();
  for (const l of lignes) {
    const isSav = !!(l as ParsedLigneBE & { hors_systeme?: boolean }).hors_systeme;
    const key = `${normalizeRef(l.reference_article)}|${isSav ? '1' : '0'}`;
    if (aggregated.has(key)) {
      aggregated.get(key)!.quantite_receptionnee += l.quantite_receptionnee;
    } else {
      aggregated.set(key, { ...l, hors_systeme: isSav });
    }
  }

  const finalLignes = Array.from(aggregated.values()).map((l) => {
    const desig = (l.designation ?? '').toUpperCase();
    const isMunition = /CARTOUCHE/.test(desig) && !/BOITE\s+DE|BOÎTE\s+DE/.test(desig);
    if (isMunition) {
      const condMatch = desig.match(/[X×*]\s*(\d{2,})|PAR\s+(\d+)|LOT\s+DE\s+(\d+)/);
      if (condMatch) {
        const factor = parseInt(condMatch[1] ?? condMatch[2] ?? condMatch[3] ?? '1');
        if (factor > 1 && factor <= 10000 && l.quantite_receptionnee < factor) {
          l.quantite_receptionnee = l.quantite_receptionnee * factor;
        }
      }
    }
    return l;
  });

  return {
    type: 'be',
    data: {
      numero_be: String(be.numero_be ?? '').split('/')[0],
      fournisseur: be.fournisseur ?? null,
      date_bl: be.date_bl ?? null,
      lignes: finalLignes,
    },
  };
}

function processFactureRaw(raw: Record<string, unknown>): ParsedDocument {
  const fact = raw as unknown as ParsedFacture;
  const lignes = (fact.lignes ?? []).map((l) => ({
    ...l,
    quantite_facturee: Number(l.quantite_facturee) || 0,
    prix_unitaire: l.prix_unitaire != null ? Number(l.prix_unitaire) : null,
    montant_ht: l.montant_ht != null ? Number(l.montant_ht) : null,
    numero_be_detecte: l.numero_be_detecte
      ? String(l.numero_be_detecte).split('/')[0].replace(/[^a-zA-Z0-9]/g, '').toUpperCase() || null
      : null,
  }));

  return {
    type: 'facture',
    data: {
      numero_facture: String(fact.numero_facture ?? `FACT-${Date.now()}`),
      fournisseur: fact.fournisseur ?? null,
      date_facture: fact.date_facture ?? null,
      total_ht: fact.total_ht != null ? Number(fact.total_ht) : null,
      total_ttc: fact.total_ttc != null ? Number(fact.total_ttc) : null,
      lignes,
    },
  };
}

// ── Parser : PDF base64 → tableau de documents (1 appel Claude, N BEs) ────────
// Gère les PDFs multi-pages contenant plusieurs BEs ou factures.

export async function parsePdfDocuments(pdfBase64url: string, filename: string): Promise<{ docs: ParsedDocument[]; coutEUR: number; moteur: string }> {
  const base64 = pdfBase64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '==='.slice((base64.length + 3) % 4 ? (base64.length + 3) % 4 : 3);

  const system = `Tu es un extracteur de données pour une application de gestion de commandes, BEs et factures fournisseurs.
Réponds UNIQUEMENT avec un JSON valide dans une balise json. JSON compact sans indentation ni espaces superflus pour minimiser la taille.`;

  const prompt = `Ce PDF (nom: ${filename}) peut contenir UN OU PLUSIEURS documents : Bons d'Expédition (BE/BL) et/ou Factures.

Identifie CHAQUE document séparé dans le PDF et extrais-les tous.
Retourne un tableau JSON (même si un seul document) :

\`\`\`json
[
  {
    "type": "be",
    "numero_be": "numéro BE (SANS la partie après /, ex: BE26031735)",
    "fournisseur": "nom du fournisseur ou null",
    "date_bl": "YYYY-MM-DD ou null",
    "lignes": [
      {
        "reference_article": "référence (IGNORER les codes EXACTEMENT 4 lettres majuscules ex: AAAA, AAFB)",
        "designation": "désignation du produit",
        "quantite_receptionnee": nombre,
        "hors_systeme": true si la ligne concerne le SAV/Service Après-Vente, false sinon
      }
    ]
  },
  {
    "type": "facture",
    "numero_facture": "numéro de facture",
    "fournisseur": "nom du fournisseur ou null",
    "date_facture": "YYYY-MM-DD ou null",
    "total_ht": nombre ou null,
    "total_ttc": nombre ou null,
    "lignes": [
      {
        "reference_article": "référence ou null",
        "designation": "désignation",
        "quantite_facturee": nombre,
        "prix_unitaire": nombre (prix NET = montant_ht / quantite, JAMAIS le prix brut),
        "montant_ht": nombre ou null,
        "numero_be_detecte": "numéro BE mentionné sur cette ligne ou null"
      }
    ]
  }
]
\`\`\`

Règles BE (Colombi-sports) :
- Ignorer les références EXACTEMENT 4 lettres majuscules (codes position : AAAA, AAFB, etc.)
- Ignorer les codes EAN/barcodes (chiffres uniquement, 8+ chiffres)
- Agréger les lignes avec la même référence ET le même hors_systeme (additionner les quantités)
- Pour CARTOUCHE (sans BOITE DE) avec multiplicateur (X 500, PAR 100) → multiplier la quantité
- Si une ligne mentionne "SAV", "S.A.V.", "Service Après-Vente" ou similaire dans la désignation ou une colonne dédiée → hors_systeme: true

Règles Facture :
- prix_unitaire = montant_ht / quantite (prix net après remise, pas le prix catalogue)
- Si même article dans 2 BEs différents → 2 lignes séparées

Si un document n'est pas reconnu : {"type": "inconnu", "raison": "..."}`;

  // 1) Tentative Haiku (le moins cher)
  const a1 = await callPdfClaude(padded, system, prompt, MODEL_PDF_PRIMAIRE);
  let docs = rawToDocs(a1.text, filename, MODEL_PDF_PRIMAIRE);
  let coutTotal = coutUSD(MODEL_PDF_PRIMAIRE, a1.usage);
  let moteur: string = MODEL_PDF_PRIMAIRE;

  // 2) Extraction douteuse (illisible / 0 ligne) → repli Sonnet, on garde le meilleur
  if (extractionDouteuse(docs)) {
    console.warn(`[parsePdfDocuments:${filename}] Haiku douteux (${nbLignes(docs)} ligne(s)) → repli Sonnet`);
    const a2 = await callPdfClaude(padded, system, prompt, MODEL_PDF_REPLI);
    const docs2 = rawToDocs(a2.text, filename, MODEL_PDF_REPLI);
    coutTotal += coutUSD(MODEL_PDF_REPLI, a2.usage);
    if (nbLignes(docs2) >= nbLignes(docs)) { docs = docs2; moteur = MODEL_PDF_REPLI; }
  }

  const coutEUR = coutTotal * 0.92;
  const label = moteur === MODEL_PDF_PRIMAIRE ? 'haiku' : 'sonnet';
  console.log(`[parsePdfDocuments:${filename}] moteur=${label} · ${nbLignes(docs)} ligne(s) · coût≈${coutEUR.toFixed(3)} € ($${coutTotal.toFixed(3)})`);

  if (!docs.length) return { docs: [{ type: 'inconnu', raison: `Réponse IA (${label}) non parseable` }], coutEUR, moteur: label };
  return { docs, coutEUR, moteur: label };
}

// Compte les lignes extraites (BE + factures), pour juger la qualité d'une extraction.
function nbLignes(docs: ParsedDocument[]): number {
  return docs.reduce((n, d) =>
    n + (d.type === 'be' ? d.data.lignes.length : d.type === 'facture' ? d.data.lignes.length : 0), 0);
}

// Extraction douteuse : rien lu, que des "inconnu", ou aucune ligne → on retente en Sonnet.
function extractionDouteuse(docs: ParsedDocument[]): boolean {
  if (!docs.length) return true;
  if (docs.every((d) => d.type === 'inconnu')) return true;
  return nbLignes(docs) === 0;
}

// Réponse brute IA → documents post-traités (filtres position/EAN, agrégation, multiplicateurs).
function rawToDocs(raw: string, filename: string, moteur: string): ParsedDocument[] {
  const result = extractJSON<unknown[]>(raw);
  if ('error' in result) {
    console.error(`[parsePdfDocuments:${filename}] (${moteur})`, result.error);
    return [];
  }
  const items = Array.isArray(result.value) ? result.value : [result.value];
  const docs: ParsedDocument[] = [];
  for (const item of items) {
    const obj = item as Record<string, unknown>;
    if (obj.type === 'be') docs.push(processBERaw(obj));
    else if (obj.type === 'facture') docs.push(processFactureRaw(obj));
    else docs.push({ type: 'inconnu', raison: (obj.raison as string) ?? 'Type non reconnu' });
  }
  return docs;
}
