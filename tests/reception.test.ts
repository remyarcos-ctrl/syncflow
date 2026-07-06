// Banc de test du moteur CONTRÔLE RÉCEPTION (lib/reception : controlerReceptions, §1).
// Exécution : npx tsx tests/reception.test.ts
import assert from 'node:assert/strict';
import { controlerReceptions, normalizeRef, aliasKey, type LigneBeInput, type LigneCmdInput } from '../src/lib/reception';
import { aliasRef } from '../src/lib/pointage';

let n = 0, ko = 0;
function test(nom: string, fn: () => void) {
  n++;
  try { fn(); console.log(`  ✅ ${nom}`); }
  catch (e) { ko++; console.log(`  ❌ ${nom}\n     ${(e as Error).message.split('\n')[0]}`); }
}
const be = (ref: string, qte: number, extra: Partial<LigneBeInput> = {}): LigneBeInput =>
  ({ be_id: 'B1', reference_article: ref, designation: null, quantite_receptionnee: qte, ...extra });
const cmd = (ref: string, q: number, r: number): LigneCmdInput =>
  ({ reference_article: ref, quantite_commandee: q, quantite_receptionnee_reelle: r });

console.log('══ Normalisation UNIFIÉE (une seule règle dans toute l\'appli) ══');
test('reception.normalizeRef = pointage.aliasRef (sans alias) sur les réfs réelles à slash', () => {
  for (const r of ['1404/16928A', '700104/PR009', '90213/16929', '9/16', 'PR004', 'CO00016']) {
    assert.equal(aliasKey(r), aliasRef(r), r);
  }
});
test('préfixe 6 chiffres coupé : 700104/PR009 = PR009 (cas réel en base)', () =>
  assert.equal(normalizeRef('700104/PR009'), 'PR009'));
test('préfixe 4 chiffres coupé : 1404/16928A = 16928A', () =>
  assert.equal(normalizeRef('1404/16928A'), '16928A'));
test('« 9/16 » (préfixe court) PAS coupé', () => assert.equal(normalizeRef('9/16'), '916'));
test('aliasKey applique les alias (LTLPK03 → LTL014)', () => assert.equal(aliasKey('LTLPK03'), 'LTL014'));

console.log('══ controlerReceptions — verdicts ══');
test('conforme : reçu = commandé', () => {
  const [c] = controlerReceptions([be('AA1', 10)], [cmd('AA1', 10, 10)]);
  assert.equal(c.verdict, 'conforme'); assert.equal(c.surLivraisonNette, 0);
});
test('hors commande : réf jamais commandée', () => {
  const [c] = controlerReceptions([be('ZZZ', 5)], [cmd('AA1', 10, 10)]);
  assert.equal(c.verdict, 'hors_commande'); assert.equal(c.totalCommande, null);
});
test('sur-livraison : reçu > commandé', () => {
  const [c] = controlerReceptions([be('AA1', 12)], [cmd('AA1', 10, 12)]);
  assert.equal(c.verdict, 'sur_livraison'); assert.equal(c.surLivraisonNette, 2);
});
test('multi-commandes agrégées par réf (M2M)', () => {
  const [c] = controlerReceptions([be('AA1', 30)], [cmd('AA1', 10, 10), cmd('AA1', 20, 20)]);
  assert.equal(c.verdict, 'conforme'); assert.equal(c.totalCommande, 30);
});
test('alias : papier code Colombi vs commande code CL → PAS hors commande', () => {
  const [c] = controlerReceptions([be('LTL014', 5)], [cmd('LTLPK03', 5, 5)]);
  assert.equal(c.verdict, 'conforme');
});
test('préfixe slash : commande « 700104/PR009 » matche le papier « PR009 »', () => {
  const [c] = controlerReceptions([be('PR009', 5)], [cmd('700104/PR009', 5, 5)]);
  assert.equal(c.verdict, 'conforme');
});

console.log('══ Avoirs / retours (lignes négatives) ══');
test('retour couvre le surplus : cmd 10, reçu 12, retour -2 → net 0, conforme', () => {
  const [c] = controlerReceptions([be('AA1', 12)], [cmd('AA1', 10, 12), cmd('AA1', -2, -2)]);
  assert.equal(c.verdict, 'conforme'); assert.equal(c.totalRetour, 2);
});
test('retour partiel : cmd 10, reçu 15, retour -2 → surplus net 3', () => {
  const [c] = controlerReceptions([be('AA1', 15)], [cmd('AA1', 10, 15), cmd('AA1', -2, -2)]);
  assert.equal(c.verdict, 'sur_livraison'); assert.equal(c.surLivraisonNette, 3);
});
test('ligne 100 % retour (cmd -1, reçu -1) ne crée pas de reçu fantôme', () => {
  const [c] = controlerReceptions([be('AA1', 0)], [cmd('AA1', -1, -1)]);
  assert.equal(c.totalRecu, 0); assert.equal(c.totalRetour, 1);
});

console.log('══ Double saisie (reçu = ×N commandé) ══');
test('reçu = 2× commandé → corrigé au commandé + flag doubleSaisie', () => {
  const [c] = controlerReceptions([be('AA1', 10)], [cmd('AA1', 10, 20)]);
  assert.equal(c.doubleSaisie, true); assert.equal(c.totalRecu, 10); assert.equal(c.verdict, 'conforme');
});
test('reçu = 1.5× commandé → PAS un doublon (pas multiple entier) → sur-livraison', () => {
  const [c] = controlerReceptions([be('AA1', 15)], [cmd('AA1', 10, 15)]);
  assert.equal(c.doubleSaisie, false); assert.equal(c.verdict, 'sur_livraison');
});
test('commandé 0, reçu 5 : pas de division par zéro, surplus 5', () => {
  const [c] = controlerReceptions([be('AA1', 5)], [cmd('AA1', 0, 5)]);
  assert.equal(c.doubleSaisie, false); assert.equal(c.surLivraisonNette, 5);
});

console.log('══ Edge cases ══');
test('réf null dans les commandes ignorée sans crash', () => {
  const out = controlerReceptions([be('AA1', 5)], [cmd(null as never, 10, 10)]);
  assert.equal(out[0].verdict, 'hors_commande');
});
test('papier vide → résultat vide', () => assert.equal(controlerReceptions([], [cmd('AA1', 1, 1)]).length, 0));
test('qteBe conservé tel quel (l\'affichage, pas le verdict)', () => {
  const [c] = controlerReceptions([be('AA1', 7)], [cmd('AA1', 100, 100)]);
  assert.equal(c.qteBe, 7); assert.equal(c.verdict, 'conforme');
});

console.log(`\n═══ ${n} tests, ${n - ko} OK, ${ko} KO ═══`);
if (ko > 0) process.exit(1);
