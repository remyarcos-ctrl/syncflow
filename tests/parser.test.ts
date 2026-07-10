// Banc de test du parseur BE (lib/document-parser : prix net, auto-vérif quantité, agrégation).
// Vérifie les recoupements DÉTERMINISTES (indépendants du modèle) qui rattrapent les mauvaises
// lectures de scan. Exécution : npx tsx tests/parser.test.ts
import assert from 'node:assert/strict';
import { processBERaw, prixNetLigneBE, verifierQuantiteBE, type ParsedLigneBE } from '../src/lib/document-parser';

let n = 0, ko = 0;
function test(nom: string, fn: () => void) {
  n++;
  try { fn(); console.log(`  ✅ ${nom}`); }
  catch (e) { ko++; console.log(`  ❌ ${nom}\n     ${(e as Error).message.split('\n')[0]}`); }
}
type BeDoc = { data: { lignes: ParsedLigneBE[] } };
const be = (lignes: Partial<ParsedLigneBE>[]): BeDoc =>
  processBERaw({ type: 'be', numero_be: 'BE-26-06-1362', fournisseur: 'COLOMBI-SPORTS', date_bl: '2026-06-23', lignes }) as BeDoc;
const ligne = (b: BeDoc, ref: string) => b.data.lignes.find((l) => l.reference_article === ref)!;

console.log('══ Prix net = brut × (1 − remises) ══');
test('R3 seul : 99.99 à 20% → 79.99', () =>
  assert.ok(Math.abs(prixNetLigneBE({ prix_uht_brut: 99.99, remise_r3: 20 }) - 79.99) < 0.01));
test('R1+R3 cumulées multiplicativement : 4.40 à 10%+10% → 3.564', () =>
  assert.ok(Math.abs(prixNetLigneBE({ prix_uht_brut: 4.40, remise_r1: 10, remise_r3: 10 }) - 3.564) < 0.001));
test('sans remise : net = brut', () =>
  assert.equal(prixNetLigneBE({ prix_uht_brut: 12.5 }), 12.5));
test('repli sur prix_unitaire (net fourni) si brut absent', () =>
  assert.equal(prixNetLigneBE({ prix_unitaire: 7.99 }), 7.99));

console.log('══ Auto-vérif quantité (recoupement à l\'argent) ══');
test('16559 : modèle lit 16, mais 959.88 ÷ 79.99 = 12 → corrigé à 12', () =>
  assert.equal(verifierQuantiteBE(16, 79.99, 959.88), 12));
test('quantité juste laissée intacte (12 confirmé par l\'argent)', () =>
  assert.equal(verifierQuantiteBE(12, 79.99, 959.88), 12));
test('Unité prise à la place (1 au lieu de 10) : 182.40 ÷ 18.24 = 10 → 10', () =>
  assert.equal(verifierQuantiteBE(1, 18.24, 182.40), 10));
test('gros lot X500 : qté 45 tel quel (net×45 = total), pas touché', () =>
  assert.equal(verifierQuantiteBE(45, 2.8867, 129.90), 45));
test('ratio non entier + proche : ne corrige pas à tort (arrondi absorbe)', () =>
  assert.equal(verifierQuantiteBE(200, 3.564, 712.80), 200));
test('pas de prix → quantité inchangée', () =>
  assert.equal(verifierQuantiteBE(7, 0, 0), 7));
test('montant absent → quantité inchangée', () =>
  assert.equal(verifierQuantiteBE(7, 5, 0), 7));

console.log('══ processBERaw bout en bout ══');
test('16559 corrigé via brut+R3 (le modèle a lu 16)', () => {
  const b = be([{ reference_article: '16559', quantite_receptionnee: 16, prix_uht_brut: 99.99, remise_r3: 20, montant_ht: 959.88 }]) as BeDoc;
  assert.equal(ligne(b, '16559').quantite_receptionnee, 12);
});
test('CB00003 : 2 lignes 54 + 50 agrégées → 104 (une lue 154, recorrigée)', () => {
  const b = be([
    { reference_article: 'CB00003', quantite_receptionnee: 154, prix_uht_brut: 18.40, remise_r3: 30, montant_ht: 54 * 18.40 * 0.7 },
    { reference_article: 'CB00003', quantite_receptionnee: 50, prix_uht_brut: 18.40, remise_r3: 30, montant_ht: 50 * 18.40 * 0.7 },
  ]) as BeDoc;
  assert.equal(ligne(b, 'CB00003').quantite_receptionnee, 104);
});
test('code position AAxx (4 lettres maj) ignoré', () => {
  const b = be([{ reference_article: 'AACP', quantite_receptionnee: 5 }, { reference_article: '16559', quantite_receptionnee: 12, prix_uht_brut: 99.99, remise_r3: 20, montant_ht: 959.88 }]) as BeDoc;
  assert.equal(b.data.lignes.length, 1);
  assert.equal(b.data.lignes[0].reference_article, '16559');
});
test('code EAN (chiffres seuls 8+) ignoré', () => {
  const b = be([{ reference_article: '2123456034714', quantite_receptionnee: 1 }, { reference_article: 'CFT36', quantite_receptionnee: 10 }]) as BeDoc;
  assert.equal(b.data.lignes.length, 1);
  assert.equal(b.data.lignes[0].reference_article, 'CFT36');
});
test('SAV (hors_systeme) gardé séparé de la même réf normale', () => {
  const b = be([
    { reference_article: '70', quantite_receptionnee: 3, hors_systeme: true },
    { reference_article: 'SN0006', quantite_receptionnee: 10 },
  ]) as BeDoc;
  const sav = b.data.lignes.find((l) => l.hors_systeme);
  assert.ok(sav); assert.equal(sav!.reference_article, '70');
});
test('conditionnement X500 : quantité NON multipliée (45 reste 45)', () => {
  const b = be([{ reference_article: 'P00001', designation: 'CARTOUCHES CO2 12GR X 500', quantite_receptionnee: 45, prix_uht_brut: 129.90, montant_ht: 45 * 129.90 }]) as BeDoc;
  assert.equal(ligne(b, 'P00001').quantite_receptionnee, 45);
});

console.log('══ Avertissements d\'import (faire remonter, pas corriger en silence) ══');
type BeDocAv = { data: { lignes: ParsedLigneBE[]; avertissements?: string[] } };
test('quantité corrigée par l\'argent → avertissement remonté (16559 : 16→12)', () => {
  const b = be([{ reference_article: '16559', quantite_receptionnee: 16, prix_uht_brut: 99.99, remise_r3: 20, montant_ht: 959.88 }]) as BeDocAv;
  const av = b.data.avertissements ?? [];
  assert.ok(av.some((a) => a.includes('16559') && a.includes('16') && a.includes('12')), `attendu un avertissement 16→12, reçu : ${JSON.stringify(av)}`);
});
test('quantité confirmée par l\'argent → AUCUN avertissement', () => {
  const b = be([{ reference_article: '16559', quantite_receptionnee: 12, prix_uht_brut: 99.99, remise_r3: 20, montant_ht: 959.88 }]) as BeDocAv;
  assert.ok(!(b.data.avertissements ?? []).some((a) => a.includes('corrigée')));
});
test('ligne sans prix/Total HT → avertissement « sans filet »', () => {
  const b = be([{ reference_article: 'CFT36', quantite_receptionnee: 10 }]) as BeDocAv;
  assert.ok((b.data.avertissements ?? []).some((a) => a.includes('sans prix')), JSON.stringify(b.data.avertissements));
});

console.log('══ Croisement catalogue (réfs inconnues → coquille de scan probable) ══');
void (async () => {
  const { distance1, controlerRefsCatalogue } = await import('../src/lib/catalogue');
  test('distance1 : RGA4412 vs RGA4712 (1 substitution) → vrai', () =>
    assert.ok(distance1('RGA4412', 'RGA4712')));
  test('distance1 : 16553 vs 16533 (1 substitution) → vrai', () =>
    assert.ok(distance1('16553', '16533')));
  test('distance1 : identiques après normalisation (RGAO012 vs RGA0012) → faux (alias, pas coquille)', () =>
    assert.ok(!distance1('RGAO012', 'RGA0012')));
  test('distance1 : 2 caractères d\'écart → faux', () =>
    assert.ok(!distance1('CFT36', 'CFT58')));
  const catalogue = new Set(['CFT36', '16559', 'RGA4412']);
  test('réf connue → aucun avertissement', () =>
    assert.equal(controlerRefsCatalogue([{ reference_article: 'CFT36', quantite: 10 }], catalogue).length, 0));
  test('réf inconnue à 1 caractère d\'une connue → signale la réf proche', () => {
    const av = controlerRefsCatalogue([{ reference_article: 'CFT56', quantite: 10 }], catalogue);
    assert.equal(av.length, 1);
    assert.ok(av[0].includes('CFT36'), av[0]);
  });
  test('réf inconnue sans voisine → signale « jamais commandée »', () => {
    const av = controlerRefsCatalogue([{ reference_article: 'ZZTOP99', quantite: 1 }], catalogue);
    assert.equal(av.length, 1);
    assert.ok(av[0].includes('jamais commandée'), av[0]);
  });
  test('catalogue vide (indisponible) → aucun faux positif', () =>
    assert.equal(controlerRefsCatalogue([{ reference_article: 'CFT36', quantite: 1 }], new Set()).length, 0));

  console.log(`\n═══ ${n} tests, ${n - ko} OK, ${ko} KO ═══`);
  if (ko > 0) process.exit(1);
})();
