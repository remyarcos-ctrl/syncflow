// Parsing de documents (email corps + PDF) via Claude API
// Applique toutes les règles métier de CONTEXT.md
import { PDFDocument } from 'pdf-lib';

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const MODEL_EMAIL = 'claude-haiku-4-5-20251001';
// PDF scannés : Haiku par défaut (3× moins cher). Sonnet en repli si l'extraction Haiku
// est douteuse. Les filets (auto-vérif montant + pointage ②↔③) rattrapent les erreurs résiduelles.
const MODEL_PDF_PRIMAIRE = 'claude-sonnet-4-6';
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
  prix_unitaire?: number | null;   // prix NET unitaire (après remises) — calculé, sert à l'auto-vérif
  prix_uht_brut?: number | null;   // colonne « Prix UHT » (BRUT, avant remise) — lue telle quelle
  remise_r1?: number | null;       // % colonne R1 (0 si vide)
  remise_r2?: number | null;       // % colonne R2 (0 si vide)
  remise_r3?: number | null;       // % colonne R3 (0 si vide)
  montant_ht?: number | null;      // Total HT de la ligne — sert à l'auto-vérif
  ref_cde_client?: string | null;  // colonne « Référence cde client » = n° de commande SD (ex. 5567) — scope papier↔commande
  hors_systeme?: boolean;
}

export interface ParsedBE {
  numero_be: string;
  fournisseur: string | null;
  date_bl: string | null;
  lignes: ParsedLigneBE[];
  // Contrôles d'import à FAIRE REMONTER (pas de correction silencieuse) : quantité corrigée
  // par l'argent, lignes sans filet arithmétique… Affichés dans le résultat d'import.
  avertissements?: string[];
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

// Fusionne les n° de commande client (« Référence cde client ») d'une réf agrégée : liste
// distincte, séparée par des virgules (ex. « 5567 » ou « 5567,5570 »). Les non-numériques
// (« CC26... » parasites) sont écartés — seul le n° de commande SD compte.
function mergeCdeClient(existant: string | null | undefined, ajout: string | null | undefined): string | null {
  const set = new Set<string>();
  for (const src of [existant, ajout]) {
    for (const part of String(src ?? '').split(/[,;/]/)) {
      const n = part.replace(/[^0-9]/g, '');
      if (n.length >= 3) set.add(n);
    }
  }
  return set.size ? [...set].join(',') : null;
}

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
    // Crédit épuisé / facturation → inutile de retenter, message clair pour l'utilisateur.
    if (resp.status === 402 || /credit|billing|insufficient|quota|payment|balance|low_balance/i.test(lastError)) {
      throw new Error('CRÉDIT_API : crédit Anthropic épuisé — recharge le compte (console.anthropic.com → Plans & Billing), puis réessaie l\'import.');
    }
    throw new Error(`Claude API error ${resp.status}: ${lastError}`);
  }

  // Si le « rate limit » persistant est en fait un manque de crédit, le dire clairement.
  if (/credit|billing|insufficient|quota|balance/i.test(lastError)) {
    throw new Error('CRÉDIT_API : crédit Anthropic épuisé — recharge le compte (console.anthropic.com → Plans & Billing), puis réessaie l\'import.');
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

// Prix net unitaire d'une ligne BE. Priorité au calcul DÉTERMINISTE brut × (1 − remises) :
// les colonnes « Prix UHT » et « R1/R2/R3 » se lisent SANS calcul, alors que le prix net
// demandé au modèle l'oblige à calculer (source d'erreur). Repli sur le net fourni si le brut
// manque. Les remises se cumulent multiplicativement (vérifié sur les BL Colombi).
export function prixNetLigneBE(l: Partial<ParsedLigneBE>): number {
  const brut = Number(l.prix_uht_brut) || 0;
  if (brut > 0) {
    const f = (r: unknown) => 1 - (Number(r) || 0) / 100;
    const net = brut * f(l.remise_r1) * f(l.remise_r2) * f(l.remise_r3);
    if (net > 0) return net;
  }
  return Number(l.prix_unitaire) || 0;
}

// Corrige la quantité d'une ligne BE par recoupement à l'argent : la quantité DOIT valoir
// Total HT ÷ prix net. Si ce ratio tombe NET sur un entier différent de la quantité lue, la
// quantité lue est fausse (colonne « Unité » prise à la place, ligne sérialisée mal comptée,
// chiffre inversé) → on prend l'entier calculé. Ex. 16559 : 959.88 ÷ 79.99 = 12 alors que le
// modèle avait lu 16. Repli (prix douteux, ratio non entier) : ancien filet grossier ×1.5.
export function verifierQuantiteBE(qte: number, net: number, montantHt: number): number {
  if (net <= 0 || montantHt <= 0) return qte;
  const qteCalc = montantHt / net;
  const arrondi = Math.round(qteCalc);
  const tolerance = Math.max(0.04, arrondi * 0.02);         // absorbe l'arrondi du Total HT
  const estEntierNet = arrondi >= 1 && Math.abs(qteCalc - arrondi) <= tolerance;
  if (estEntierNet) return arrondi !== qte ? arrondi : qte; // entier franc → autorité
  const ratio = qteCalc > 0 ? qte / qteCalc : 1;            // prix imprécis → filet large
  if (qteCalc >= 1 && (ratio > 1.5 || ratio < 0.67)) return Math.round(qteCalc);
  return qte;
}

export function processBERaw(raw: Record<string, unknown>): ParsedDocument {
  const be = raw as unknown as ParsedBE;
  const avertissements: string[] = [];
  let sansFilet = 0; // lignes sans Total HT ou prix → l'auto-vérif par l'argent n'a pas pu jouer
  const lignes = (be.lignes ?? [])
    .filter((l) => l.reference_article && !isPositionCode(l.reference_article) && !isEanBarcode(l.reference_article))
    .map((l) => {
      const net = prixNetLigneBE(l);
      const qteLue = Number(l.quantite_receptionnee) || 0;
      const qte = verifierQuantiteBE(qteLue, net, Number(l.montant_ht) || 0);
      // On corrige (l'argent fait foi) mais on FAIT REMONTER : la correction doit se voir
      // dans le résultat d'import, pas s'appliquer en douce (cf. 16559 lu 16, corrigé 12).
      if (qte !== qteLue) {
        avertissements.push(`${l.reference_article} : quantité lue ${qteLue} corrigée à ${qte} par l'argent (Total HT ${Number(l.montant_ht).toFixed(2)} ÷ prix net ${net.toFixed(2)}) → vérifier sur le PDF`);
      }
      if (!(net > 0) || !(Number(l.montant_ht) > 0)) sansFilet++;
      return {
        ...l,
        quantite_receptionnee: qte,
        prix_unitaire: net > 0 ? net : (l.prix_unitaire ?? null),
        designation: l.designation ?? null,
      };
    });
  if (sansFilet > 0) {
    avertissements.push(`${sansFilet} ligne${sansFilet > 1 ? 's' : ''} sans prix/Total HT lisible${sansFilet > 1 ? 's' : ''} → quantité non recoupée par l'argent, à vérifier d'un œil`);
  }

  const aggregated = new Map<string, ParsedLigneBE>();
  for (const l of lignes) {
    const isSav = !!(l as ParsedLigneBE & { hors_systeme?: boolean }).hors_systeme;
    const key = `${normalizeRef(l.reference_article)}|${isSav ? '1' : '0'}`;
    if (aggregated.has(key)) {
      const cur = aggregated.get(key)!;
      cur.quantite_receptionnee += l.quantite_receptionnee;
      cur.ref_cde_client = mergeCdeClient(cur.ref_cde_client, l.ref_cde_client); // une réf peut servir 2 commandes sur le même bon
    } else {
      aggregated.set(key, { ...l, hors_systeme: isSav, ref_cde_client: mergeCdeClient(null, l.ref_cde_client) });
    }
  }

  // Pas de multiplication par le conditionnement : la quantité du BL est prise telle quelle
  // (le « X500 / X1000 » fait partie du nom produit). Comparer ② et ③ dans la même unité.
  const finalLignes = Array.from(aggregated.values());

  return {
    type: 'be',
    data: {
      numero_be: String(be.numero_be ?? '').split('/')[0],
      fournisseur: be.fournisseur ?? null,
      date_bl: be.date_bl ?? null,
      lignes: finalLignes,
      avertissements,
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
        "reference_article": "1er code de la colonne « Code article » (ex: 16559, CR00033). IGNORER le 2e code interne à 4 lettres majuscules qui le suit (AACP, AAFB…) et les codes EAN (chiffres seuls).",
        "designation": "désignation du produit",
        "quantite_receptionnee": nombre de la colonne « Quantité » (JAMAIS « Unité »),
        "prix_uht": valeur BRUTE de la colonne « Prix UHT » lue TELLE QUELLE, sans retrancher les remises (ex: 99.99). null si absent.,
        "remise_r1": pourcentage de la colonne R1 lu tel quel (nombre, ex: 15 ; 0 si la case est vide),
        "remise_r2": pourcentage de la colonne R2 (nombre, 0 si vide),
        "remise_r3": pourcentage de la colonne R3 (nombre, ex: 20 ; 0 si vide),
        "montant_ht": valeur de la colonne « Total HT » (dernière colonne) lue telle quelle (ex: 959.88) ou null,
        "ref_cde_client": contenu de la colonne « Référence cde client » = le numéro de commande du client (ex: "5567"). Prends UNIQUEMENT le nombre de la COLONNE (pas les « (cde CC... du .../.../...) » qui sont dans la désignation). null si vide.,
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
- quantite_receptionnee = la valeur de la colonne « Quantité » du BL.
  ⚠️ PIÈGE COLONNES : le BL Colombi a DEUX colonnes voisines, « Quantité » PUIS « Unité ». La colonne « Unité » vaut presque toujours 1 (= unité de vente). Il faut IMPÉRATIVEMENT prendre « Quantité », JAMAIS « Unité ». Ordre des colonnes : Code article · Désignation/EAN · N° de série · Cde client · Référence · **Quantité** · Unité · Prix UHT · R1 · R2 · R3 · Total HT. Exemple réel : ligne « 17655 … 10 1 18.24 » → la Quantité est 10 et l'Unité est 1 → quantite_receptionnee: 10 (surtout PAS 1). Autre repère décisif : Total HT = Quantité × Prix UHT × (1 − R1) × (1 − R2) × (1 − R3). Ex. « 16559 … qté 12 … Prix UHT 99.99 … R3 20% … Total HT 959.88 » → 12 × 99.99 × 0.80 = 959.90 ✓. Si « Quantité × Prix UHT × (1 − remises) » ne tombe pas sur le Total HT, tu as mal lu la Quantité (Unité prise à la place, chiffre inversé) — corrige-la.
  NE JAMAIS multiplier par le conditionnement : « X500 », « X1000 », « PAR 100 » font partie du NOM du produit (boîte/lot de N), PAS un multiplicateur. Ex : « GOMMETTES D19 X1000 » avec quantité 50 → quantite_receptionnee: 50 (surtout pas 50000).
- PRODUITS SÉRIALISÉS (armes) : si une référence a une colonne « Numéros de série » remplie (ex. V2IEKCAYS03-2401865), 1 unité = 1 n° de série. La quantité de la référence = le NOMBRE de numéros de série DISTINCTS, JAMAIS le nombre de lignes (un même article s'étale sur plusieurs lignes — code position AAVW/AAWB, EAN, n° de série — sans que ce soit des unités en plus). Ex : 10 n° de série distincts pour EK0003 → quantite_receptionnee: 10 (surtout pas 16).
  ⚠️ PIÈGE MULTI-PAGES : quand un article sérialisé s'étale sur PLUSIEURS pages, l'en-tête de colonne « Numéros de série / cde client » SE RÉPÈTE en haut de chaque page. Ces lignes d'en-tête ne portent NI numéro de série NI prix → ce ne sont PAS des unités, NE les compte JAMAIS. Ne compte QUE les lignes portant un vrai n° de série ET un prix/Total HT.
  RECOUPEMENT OBLIGATOIRE par l'argent : quantité de l'article = (Total HT cumulé de toutes ses lignes) ÷ (prix net unitaire). Ex. PI00008 à 134,25 € net : si le cumul Total HT = 7 786,50 € alors quantité = 58 (et surtout pas 64). Si ton compte de lignes ≠ ce ratio, c'est que tu as compté des en-têtes répétés → corrige vers le ratio.
- Si une ligne mentionne "SAV", "S.A.V.", "Service Après-Vente" ou similaire dans la désignation ou une colonne dédiée → hors_systeme: true

Règles Facture :
- prix_unitaire = montant_ht / quantite (prix net après remise, pas le prix catalogue)
- Si même article dans 2 BEs différents → 2 lignes séparées

Si un document n'est pas reconnu : {"type": "inconnu", "raison": "..."}`;

  // 0) GROS PDF multi-pages → découper en paquets, parser EN PARALLÈLE, fusionner par n° de BE.
  // Évite le timeout serverless ET la troncature JSON (8192 tokens) sur les PDF de 20-30 pages.
  // Le chemin « petit PDF » (≤ 5 pages) ci-dessous reste INCHANGÉ.
  let nbPages = 0;
  try { nbPages = (await PDFDocument.load(Buffer.from(padded, 'base64'), { ignoreEncryption: true })).getPageCount(); } catch { /* illisible → chemin normal */ }
  if (nbPages > 6) {
    const paquets = await splitPdfBase64(padded, 6);
    const res = await mapLimit(paquets, 5, async (chunk) => {
      const a = await callPdfClaude(chunk, system, prompt, MODEL_PDF_PRIMAIRE);
      return { docs: rawToDocs(a.text, filename, MODEL_PDF_PRIMAIRE), cost: coutUSD(MODEL_PDF_PRIMAIRE, a.usage) };
    });
    const docsG = fusionnerDocs(res.map((r) => r.docs));
    const coutEURg = res.reduce((s, r) => s + r.cost, 0) * 0.92;
    console.log(`[parsePdfDocuments:${filename}] GROS PDF ${nbPages}p → ${paquets.length} paquets // · ${nbLignes(docsG)} ligne(s) · coût≈${coutEURg.toFixed(3)} €`);
    if (!docsG.length) return { docs: [{ type: 'inconnu', raison: `Gros PDF (${nbPages}p) non parseable` }], coutEUR: coutEURg, moteur: 'sonnet' };
    return { docs: docsG, coutEUR: coutEURg, moteur: 'sonnet' };
  }

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
  const label = /sonnet/i.test(moteur) ? 'sonnet' : /opus/i.test(moteur) ? 'opus' : 'haiku';
  console.log(`[parsePdfDocuments:${filename}] moteur=${label} · ${nbLignes(docs)} ligne(s) · coût≈${coutEUR.toFixed(3)} € ($${coutTotal.toFixed(3)})`);

  if (!docs.length) return { docs: [{ type: 'inconnu', raison: `Réponse IA (${label}) non parseable` }], coutEUR, moteur: label };
  return { docs, coutEUR, moteur: label };
}

// Découpe un PDF base64 en paquets de N pages (base64 chacun).
async function splitPdfBase64(base64: string, pagesParPaquet: number): Promise<string[]> {
  const src = await PDFDocument.load(Buffer.from(base64, 'base64'), { ignoreEncryption: true });
  const n = src.getPageCount();
  const paquets: string[] = [];
  for (let start = 0; start < n; start += pagesParPaquet) {
    const sub = await PDFDocument.create();
    const idxs: number[] = [];
    for (let i = start; i < Math.min(start + pagesParPaquet, n); i++) idxs.push(i);
    const pages = await sub.copyPages(src, idxs);
    pages.forEach((p) => sub.addPage(p));
    const bytes = await sub.save();
    paquets.push(Buffer.from(bytes).toString('base64'));
  }
  return paquets;
}

// Exécute fn sur chaque item avec une concurrence max (évite les rate limits Anthropic).
async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Fusionne les docs de plusieurs paquets : un même BE/facture à cheval sur 2 paquets est recollé
// par son numéro, et les lignes BE ré-agrégées par (référence, hors_systeme).
function fusionnerDocs(listes: ParsedDocument[][]): ParsedDocument[] {
  const bes = new Map<string, ParsedBE>();
  const facts = new Map<string, ParsedFacture>();
  for (const docs of listes) {
    for (const d of docs) {
      if (d.type === 'be') {
        const num = normalizeRef(d.data.numero_be) || String(d.data.numero_be ?? '');
        if (!num) continue;
        const cur = bes.get(num);
        if (!cur) bes.set(num, { ...d.data, lignes: [...d.data.lignes], avertissements: [...(d.data.avertissements ?? [])] });
        else {
          cur.lignes.push(...d.data.lignes);
          (cur.avertissements ??= []).push(...(d.data.avertissements ?? []));
          if (!cur.fournisseur && d.data.fournisseur) cur.fournisseur = d.data.fournisseur;
          if (!cur.date_bl && d.data.date_bl) cur.date_bl = d.data.date_bl;
        }
      } else if (d.type === 'facture') {
        const num = String(d.data.numero_facture ?? '');
        const cur = facts.get(num);
        if (!cur) facts.set(num, { ...d.data, lignes: [...d.data.lignes] });
        else cur.lignes.push(...d.data.lignes);
      }
    }
  }
  const out: ParsedDocument[] = [];
  for (const [, data] of bes) {
    const agg = new Map<string, ParsedLigneBE>();
    for (const l of data.lignes) {
      const sav = !!(l as ParsedLigneBE & { hors_systeme?: boolean }).hors_systeme;
      const key = normalizeRef(l.reference_article) + '|' + (sav ? '1' : '0');
      const e = agg.get(key);
      if (e) {
        e.quantite_receptionnee += Number(l.quantite_receptionnee) || 0;
        if (l.montant_ht != null) e.montant_ht = (Number(e.montant_ht) || 0) + Number(l.montant_ht);
        e.ref_cde_client = mergeCdeClient(e.ref_cde_client, l.ref_cde_client);
      } else agg.set(key, { ...l, ref_cde_client: mergeCdeClient(null, l.ref_cde_client) });
    }
    out.push({ type: 'be', data: { ...data, numero_be: String(data.numero_be ?? '').split('/')[0], lignes: [...agg.values()] } });
  }
  for (const [, data] of facts) out.push({ type: 'facture', data });
  return out;
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
