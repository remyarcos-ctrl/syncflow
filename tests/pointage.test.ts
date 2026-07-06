// Banc de test EXHAUSTIF du moteur de pointage ②↔③ (lib/pointage) + conditionnement + alias.
// Chaque cas d'école REEL de l'audit (17655, SN0006, LTL014, PO0005…) + les cas imaginables.
// Exécution : npx tsx tests/pointage.test.ts   (aucun framework requis, node:assert)
import assert from 'node:assert/strict';
import { comparerPointage, causeEcart, aEcart, normalizeRef, aliasRef, type EcartPointage } from '../src/lib/pointage';
import { facteurConditionnement, quantitesConcordent } from '../src/lib/conditionnement';

let n = 0, ko = 0;
function test(nom: string, fn: () => void) {
  n++;
  try { fn(); console.log(`  ✅ ${nom}`); }
  catch (e) { ko++; console.log(`  ❌ ${nom}\n     ${(e as Error).message.split('\n')[0]}`); }
}
const row = (rows: EcartPointage[], ref: string) => {
  const r = rows.find(x => normalizeRef(x.ref) === normalizeRef(ref) || aliasRef(x.ref) === aliasRef(ref));
  assert.ok(r, `ligne ${ref} absente du résultat (${rows.map(x => x.ref).join(', ')})`);
  return r!;
};

console.log('══ A. normalizeRef / aliasRef ══');
test('O→0 : CO00016 = C000016', () => assert.equal(normalizeRef('CO00016'), normalizeRef('C000016')));
test('casse + espaces + tirets ignorés', () => assert.equal(normalizeRef(' pr-004 '), 'PR004'));
test('null/undefined/vide → chaîne vide', () => { assert.equal(normalizeRef(null), ''); assert.equal(normalizeRef(undefined), ''); assert.equal(normalizeRef(''), ''); });
test('alias LTLPK03 → LTL014', () => assert.equal(aliasRef('LTLPK03'), normalizeRef('LTL014')));
test('alias insensible casse/format (ltlpk03)', () => assert.equal(aliasRef('ltlpk03'), normalizeRef('LTL014')));
test('alias 490041 → 490042', () => assert.equal(aliasRef('490041'), '490042'));
test('réf sans alias inchangée', () => assert.equal(aliasRef('17655'), '17655'));
test('alias GNQ vrac → PO0005', () => assert.equal(aliasRef('GNQ-PLOMBS-PLATS-55'), normalizeRef('PO0005')));

console.log('══ B. conditionnement ══');
test('X500 → facteur 500', () => assert.equal(facteurConditionnement('PLOMBS PLATS C4.5 X500'), 500));
test('X250 → facteur 250 (PO0005)', () => assert.equal(facteurConditionnement('PLOMBS PLATS C5.5 X250'), 250));
test('spec optique 4X32 ignorée (lunette, pas conditionnement)', () => assert.equal(facteurConditionnement('CARA RX20 S3 COMBO 4X32'), 1));
test('spec optique 3-9X40 ignorée', () => assert.equal(facteurConditionnement('LUNETTE 3-9X40'), 1));
test('BOITE DE 250', () => assert.equal(facteurConditionnement('Boite de 250 plombs'), 250));
test('désignation null → 1', () => assert.equal(facteurConditionnement(null), 1));
test('nom de modèle RX20 ignoré (lettre avant X ≠ conditionnement)', () => assert.equal(facteurConditionnement('CARA AIR STOEGER RX20 BOIS'), 1));
test('réels base : « X 1500 » avec espace → 1500', () => assert.equal(facteurConditionnement('BILLES ACIER BB NOIRES C4.5 X 1500'), 1500));
test('réels base : minuscule « x50 » → 50', () => assert.equal(facteurConditionnement('BALLES 44 REM MAG 240GR SJSP FLAT x50'), 50));
test('réels base : « 21X21 X100 » → 100 (21X21 = format cible, rejeté)', () => assert.equal(facteurConditionnement('CENTRES DE CIBLES 21X21 X100'), 100));
test('réels base : « X50- 400BARS » → 50', () => assert.equal(facteurConditionnement('BALLE 9MM PA A BLANC X50- 400BARS'), 50));
test('réels base : « CO2 12GR X 500 » → 500', () => assert.equal(facteurConditionnement('CARTOUCHES CO2 12GR X 500'), 500));
test('concordance via facteur : 400 boîtes vs 410 pièces X250 = pas concordant', () => assert.equal(quantitesConcordent(400, 410, 'PLOMBS X250'), false));
test('concordance via facteur : 2 cartons X500 = 1000 pièces', () => assert.equal(quantitesConcordent(2, 1000, 'BILLES X500'), true));

console.log('══ C. comparerPointage — agrégation & concordance ══');
test('papier multi-lignes même réf agrégées', () => {
  const rows = comparerPointage(
    [{ reference_article: 'AA1', quantite_receptionnee: 3 }, { reference_article: 'AA1', quantite_receptionnee: 7 }],
    [{ reference_article: 'AA1', quantite_recue: 10 }]);
  assert.equal(row(rows, 'AA1').ecart, 0);
});
test('saisie code CL aliasé fusionne avec papier code Colombi (LTL014/LTLPK03)', () => {
  const rows = comparerPointage(
    [{ reference_article: 'LTL014', quantite_receptionnee: 5 }],
    [{ reference_article: 'LTLPK03', quantite_recue: 5 }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ecart, 0);
});
test('papier O vs saisie 0 fusionnés (CO00016/C000016)', () => {
  const rows = comparerPointage(
    [{ reference_article: 'CO00016', quantite_receptionnee: 4 }],
    [{ reference_article: 'C000016', quantite_recue: 4 }]);
  assert.equal(rows.length, 1); assert.equal(rows[0].ecart, 0);
});
test('concordance conditionnement 2 sens (45 cartons vs 22500 pièces X500)', () => {
  const rows = comparerPointage(
    [{ reference_article: 'PO0003', quantite_receptionnee: 45, designation: 'PLOMBS X500' }],
    [{ reference_article: 'PO0003', quantite_recue: 22500 }]);
  assert.equal(row(rows, 'PO0003').ecart, 0);
  assert.equal(row(rows, 'PO0003').facteur, 500);
});
test('saisiAilleurs : papier sans saisie mais réf reçue ailleurs → concord (pas un oubli)', () => {
  const rows = comparerPointage(
    [{ reference_article: 'CR00031', quantite_receptionnee: 2 }], [],
    [], { refsRecues: new Set(['CR00031']) });
  assert.equal(row(rows, 'CR00031').ecart, 0);
  assert.equal(row(rows, 'CR00031').saisiAilleurs, true);
});
test('résolution humaine matchée via alias', () => {
  const rows = comparerPointage(
    [{ reference_article: 'LTL014', quantite_receptionnee: 9 }],
    [{ reference_article: 'LTLPK03', quantite_recue: 3 }],
    [{ reference_article: 'LTLPK03', statut: 'vérifié', note: 'ok' }]);
  assert.equal(row(rows, 'LTL014').statut, 'vérifié');
});
test('réfs null/vides ignorées sans crash', () => {
  const rows = comparerPointage(
    [{ reference_article: null as never, quantite_receptionnee: 5 }, { reference_article: 'BB2', quantite_receptionnee: 1 }],
    [{ reference_article: '', quantite_recue: 3 }]);
  assert.equal(rows.length, 1);
});

console.log('══ D. doublon STRICT (cas 17655) ══');
test('2 lignes identiques (réf+qté+commande) → doublonStrict', () => {
  const rows = comparerPointage(
    [{ reference_article: '17655', quantite_receptionnee: 10 }],
    [{ reference_article: '17655', quantite_recue: 10, commande_ref: '#4721' },
     { reference_article: '17655', quantite_recue: 10, commande_ref: '#4721' }]);
  const r = row(rows, '17655');
  assert.equal(r.doublonStrict, true);
  assert.equal(r.ecart, -10);
  assert.match(causeEcart(r).label, /Double saisie/);
});
test('même réf, qtés ≠ → PAS doublon', () => {
  const rows = comparerPointage(
    [{ reference_article: 'CC3', quantite_receptionnee: 5 }],
    [{ reference_article: 'CC3', quantite_recue: 3, commande_ref: '#1' },
     { reference_article: 'CC3', quantite_recue: 7, commande_ref: '#1' }]);
  assert.equal(row(rows, 'CC3').doublonStrict, false);
});
test('même réf+qté mais commandes ≠ → PAS doublon (cas SN0006 dispatch)', () => {
  const rows = comparerPointage(
    [{ reference_article: 'SN0006', quantite_receptionnee: 4 }],
    [{ reference_article: 'SN0006', quantite_recue: 4, commande_ref: '#4721' },
     { reference_article: 'SN0006', quantite_recue: 4, commande_ref: '#4730' }]);
  assert.equal(row(rows, 'SN0006').doublonStrict, false);
});
test('lignes qté 0 jamais doublon', () => {
  const rows = comparerPointage(
    [{ reference_article: 'DD4', quantite_receptionnee: 0 }],
    [{ reference_article: 'DD4', quantite_recue: 0, commande_ref: '#1' },
     { reference_article: 'DD4', quantite_recue: 0, commande_ref: '#1' }]);
  assert.equal(row(rows, 'DD4').doublonStrict, false);
});
test('doublon détecté même via alias (2 lignes code CL)', () => {
  const rows = comparerPointage(
    [{ reference_article: 'LTL014', quantite_receptionnee: 6 }],
    [{ reference_article: 'LTLPK03', quantite_recue: 6, commande_ref: '#9' },
     { reference_article: 'LTLPK03', quantite_recue: 6, commande_ref: '#9' }]);
  assert.equal(row(rows, 'LTL014').doublonStrict, true);
});
test('commande_ref absent (undefined) : 2 lignes identiques → doublon quand même', () => {
  const rows = comparerPointage(
    [{ reference_article: 'EE5', quantite_receptionnee: 2 }],
    [{ reference_article: 'EE5', quantite_recue: 2 }, { reference_article: 'EE5', quantite_recue: 2 }]);
  assert.equal(row(rows, 'EE5').doublonStrict, true);
});

console.log('══ E. causeEcart — la matrice des verdicts ══');
const base: EcartPointage = {
  ref: 'X', papier: 10, cl: 20, ecart: -10, recuTotal: null, facteur: 1,
  saisiAilleurs: false, commandeEnAttente: false, doublonStrict: false,
  surRecue: null, barcode: false, nonDetaille: 0, statut: 'à analyser', note: null,
};
test('conforme si écart 0', () => assert.equal(causeEcart({ ...base, ecart: 0 }).code, 'conforme'));
test('③>② doublonStrict → sur_saisie (Double saisie), prime sur tout', () =>
  assert.equal(causeEcart({ ...base, doublonStrict: true, surRecue: false }).code, 'sur_saisie'));
test('③>② surRecue=true → sur_saisie', () =>
  assert.equal(causeEcart({ ...base, surRecue: true }).code, 'sur_saisie'));
test('③>② surRecue=false → dispatch (SN0006 : reçu = commandé, blanchi)', () =>
  assert.equal(causeEcart({ ...base, surRecue: false }).code, 'dispatch'));
test('③>② surRecue=null (info absente) → sur_saisie (prudence, on ne blanchit pas)', () =>
  assert.equal(causeEcart({ ...base, surRecue: null }).code, 'sur_saisie'));
test('③>② barcode → mention scan dans le label', () =>
  assert.match(causeEcart({ ...base, surRecue: true, barcode: true }).label, /bar-code|scan/i));
test('②>③ nonDetaille couvre → detail_incomplet (order/view perd des lignes)', () =>
  assert.equal(causeEcart({ ...base, ecart: 5, nonDetaille: 5 }).code, 'detail_incomplet'));
test('②>③ nonDetaille couvre largement → detail_incomplet', () =>
  assert.equal(causeEcart({ ...base, ecart: 5, nonDetaille: 12 }).code, 'detail_incomplet'));
test('②>③ nonDetaille partiel (3 < 5) → PAS detail_incomplet → oubli si reliquat', () =>
  assert.equal(causeEcart({ ...base, ecart: 5, nonDetaille: 3, commandeEnAttente: true }).code, 'oubli_log'));
test('②>③ reliquat → oubli_log', () =>
  assert.equal(causeEcart({ ...base, ecart: 5, commandeEnAttente: true }).code, 'oubli_log'));
test('②>③ sans reliquat → hors_commande', () =>
  assert.equal(causeEcart({ ...base, ecart: 5 }).code, 'hors_commande'));

console.log('══ E2. fixes du balayage réel (06/07) ══');
test('slash-préfixe : 1404/16928A = 16928A', () => assert.equal(aliasRef('1404/16928A'), aliasRef('16928A')));
test('slash : petit nombre 9/16 NON coupé (pas un préfixe commande)', () => assert.equal(aliasRef('9/16'), normalizeRef('916')));
test('alias appliqué au PAPIER : papier LTLPK03 fusionne avec saisie LTL014', () => {
  const rows = comparerPointage(
    [{ reference_article: 'LTLPK03', quantite_receptionnee: 500 }],
    [{ reference_article: 'LTLPK03', quantite_recue: 492 }]);
  assert.equal(rows.length, 1);
  assert.equal(row(rows, 'LTL014').ecart, 8);
});
test('alias papier 490041 vs saisie 490041 → une seule ligne conforme', () => {
  const rows = comparerPointage(
    [{ reference_article: '490041', quantite_receptionnee: 24 }],
    [{ reference_article: '490041', quantite_recue: 24 }]);
  assert.equal(rows.length, 1); assert.equal(rows[0].ecart, 0);
});
test('hors_systeme (SAV) exclu du papier : pas de faux oubli (SN0004)', () => {
  const rows = comparerPointage(
    [{ reference_article: 'SN0004', quantite_receptionnee: 1000, hors_systeme: false },
     { reference_article: 'SN0004', quantite_receptionnee: 3, hors_systeme: true }],
    [{ reference_article: 'SN0004', quantite_recue: 1000 }]);
  assert.equal(row(rows, 'SN0004').ecart, 0);
});
test('ligne 100 % SAV (réf 70) absente du pointage', () => {
  const rows = comparerPointage(
    [{ reference_article: '70', quantite_receptionnee: 1, hors_systeme: true }], []);
  assert.equal(rows.length, 0);
});
test('②>③ sans reliquat mais réf commandée (recuTotal>0) → label surplus, pas « jamais commandée »', () => {
  const c = causeEcart({ ...({} as EcartPointage), ref: 'X', papier: 504, cl: 500, ecart: 4, recuTotal: 500, facteur: 1, saisiAilleurs: false, commandeEnAttente: false, doublonStrict: false, surRecue: false, barcode: false, nonDetaille: 0, statut: 'à analyser', note: null });
  assert.equal(c.code, 'hors_commande');
  assert.match(c.label, /Surplus vs saisie/);
});

console.log('══ F. scénarios bout-en-bout (bon complet) ══');
test('bon 1641 rejoué : 17655 double saisie + SN0006 dispatch, chacun son verdict', () => {
  const rows = comparerPointage(
    [{ reference_article: '17655', quantite_receptionnee: 10 },
     { reference_article: 'SN0006', quantite_receptionnee: 4 }],
    [{ reference_article: '17655', quantite_recue: 10, commande_ref: '#4721' },
     { reference_article: '17655', quantite_recue: 10, commande_ref: '#4721' },
     { reference_article: 'SN0006', quantite_recue: 4, commande_ref: '#4721' },
     { reference_article: 'SN0006', quantite_recue: 4, commande_ref: '#4730' }],
    [], { refsSurRecues: new Set<string>() }); // aucune sur-réception commande (ni 17655 ni SN0006 : reçu ≤ commandé)
  const r17 = row(rows, '17655'), rSN = row(rows, 'SN0006');
  assert.equal(causeEcart(r17).code, 'sur_saisie');       // doublon strict PRIME sur surRecue=false
  assert.match(causeEcart(r17).label, /Double saisie/);
  assert.equal(causeEcart(rSN).code, 'dispatch');          // pas doublon, pas sur-reçu → blanchi
});
test('oubli couvert par le Livré non détaillé → detail_incomplet, pas oubli', () => {
  const rows = comparerPointage(
    [{ reference_article: 'FF6', quantite_receptionnee: 30 }],
    [{ reference_article: 'FF6', quantite_recue: 20, commande_ref: '#2' }],
    [], { nonDetailleByRef: new Map([['FF6', 10]]), refsReliquat: new Set(['FF6']) });
  const r = row(rows, 'FF6');
  assert.equal(r.ecart, 10);
  assert.equal(causeEcart(r).code, 'detail_incomplet');
});
test('retour/avoir : papier négatif ne crée pas de faux positif absurde', () => {
  const rows = comparerPointage(
    [{ reference_article: 'GG7', quantite_receptionnee: -1 }],
    [{ reference_article: 'GG7', quantite_recue: -1 }]);
  assert.equal(row(rows, 'GG7').ecart, 0);
});
test('papier vide + saisies vides → aucun résultat, pas de crash', () =>
  assert.equal(comparerPointage([], []).length, 0));

console.log(`\n═══ ${n} tests, ${n - ko} OK, ${ko} KO ═══`);
if (ko > 0) process.exit(1);
