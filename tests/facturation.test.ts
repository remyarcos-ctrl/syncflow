// Banc de test du moteur CONTRÔLE FACTURATION (lib/facturation : controlerLignesFacture, ④).
// Exécution : npx tsx tests/facturation.test.ts
import assert from 'node:assert/strict';
import {
  controlerLignesFacture,
  type LigneFactureInput, type LigneCommandeInput, type CommandeInput, type SaisieInput,
} from '../src/lib/facturation';

let n = 0, ko = 0;
function test(nom: string, fn: () => void) {
  n++;
  try { fn(); console.log(`  ✅ ${nom}`); }
  catch (e) { ko++; console.log(`  ❌ ${nom}\n     ${(e as Error).message.split('\n')[0]}`); }
}

let seq = 0;
const lf = (ref: string, qte: number, pu: number | null, extra: Partial<LigneFactureInput> = {}): LigneFactureInput =>
  ({ id: `L${++seq}`, facture_id: 'F1', ligne_no: seq, reference_article: ref, designation: null,
     quantite_facturee: qte, pu_facture: pu, montant_ht: pu != null ? qte * pu : null, numero_be_detecte: null, ...extra });
const lc = (cmdId: string, ref: string, q: number, pu: number | null, recu: number): LigneCommandeInput =>
  ({ commande_id: cmdId, reference_article: ref, quantite_commandee: q, pu_commande: pu, quantite_receptionnee_reelle: recu });
const CMDS: CommandeInput[] = [
  { id: 'C1', numero_commande_interne: '#4721' },
  { id: 'C2', numero_commande_interne: '#4842' },
];
const run = (
  fact: LigneFactureInput[], cmd: LigneCommandeInput[],
  saisies: SaisieInput[] = [], opts = {},
) => controlerLignesFacture(fact, cmd, CMDS, saisies, opts);

console.log('══ Verdicts de base ══');
test('conforme : facturé = reçu, prix identique', () => {
  const [c] = run([lf('AA1', 10, 5)], [lc('C1', 'AA1', 10, 5, 10)]);
  assert.equal(c.verdict, 'conforme'); assert.equal(c.problemes.length, 0);
});
test('sur-facturation : facturé > reçu', () => {
  const [c] = run([lf('AA1', 15, 5)], [lc('C1', 'AA1', 10, 5, 10)]);
  assert.equal(c.verdict, 'sur_facturation'); assert.equal(c.ecartQteRecu, 5);
});
test('partiel : facturé < reçu (le reste viendra)', () => {
  const [c] = run([lf('AA1', 6, 5)], [lc('C1', 'AA1', 10, 5, 10)]);
  assert.equal(c.verdict, 'partiel');
});
test('écart prix : PU facturé +5 % vs commande', () => {
  const [c] = run([lf('AA1', 10, 5.25)], [lc('C1', 'AA1', 10, 5, 10)]);
  assert.equal(c.verdict, 'ecart_prix'); assert.ok(Math.abs(c.ecartPrixPct! - 5) < 0.01);
});
test('écart prix ≤ 1 % toléré', () => {
  const [c] = run([lf('AA1', 10, 5.04)], [lc('C1', 'AA1', 10, 5, 10)]);
  assert.equal(c.verdict, 'conforme');
});
test('hors commande : réf jamais commandée', () => {
  const [c] = run([lf('ZZZ', 5, 5)], [lc('C1', 'AA1', 10, 5, 10)]);
  assert.equal(c.verdict, 'hors_commande');
});

console.log('══ Alias & normalisation (réserve audit 06/07 levée) ══');
test('alias : facture code Colombi (LTL014) vs commande code CL (LTLPK03) → PAS hors commande', () => {
  const [c] = run([lf('LTL014', 5, 3)], [lc('C1', 'LTLPK03', 5, 3, 5)]);
  assert.equal(c.verdict, 'conforme');
});
test('préfixe commande : facture « PR009 » matche la commande « 700104/PR009 »', () => {
  const [c] = run([lf('PR009', 5, 3)], [lc('C1', '700104/PR009', 5, 3, 5)]);
  assert.equal(c.verdict, 'conforme');
});
test('O→0 : facture « CO0016 » matche la commande « C00016 »', () => {
  const [c] = run([lf('CO0016', 2, 9)], [lc('C1', 'C00016', 2, 9, 2)]);
  assert.equal(c.verdict, 'conforme');
});

console.log('══ Rattachement par BE ══');
test('BE détecté → seules les commandes du BE sont sommées', () => {
  const saisies: SaisieInput[] = [{ numero_be: 'BE-26-04-1006', commande_ref: '#4721' }];
  const [c] = run(
    [lf('AA1', 10, 5, { numero_be_detecte: 'BE26041006' })],
    [lc('C1', 'AA1', 10, 5, 10), lc('C2', 'AA1', 99, 5, 99)],
    saisies,
  );
  assert.equal(c.verdict, 'conforme'); assert.deepEqual(c.commandesRattachees, ['#4721']);
});
test('normalisation n° BE : « BE26041006 » (facture) ↔ « BE-26-04-1006 » (saisie)', () => {
  const saisies: SaisieInput[] = [{ numero_be: 'BE-26-04-1006', commande_ref: '#4842' }];
  const [c] = run([lf('BB2', 3, 7, { numero_be_detecte: 'BE26041006' })], [lc('C2', 'BB2', 3, 7, 3)], saisies);
  assert.deepEqual(c.commandesRattachees, ['#4842']);
});
test('BE trop étroit (la réf n\'est dans aucune commande du BE) → repli par réf, pas hors commande', () => {
  const saisies: SaisieInput[] = [{ numero_be: 'BE-26-04-1006', commande_ref: '#4721' }];
  const [c] = run(
    [lf('CC3', 4, 2, { numero_be_detecte: 'BE26041006' })],
    [lc('C1', 'AA1', 10, 5, 10), lc('C2', 'CC3', 4, 2, 4)],
    saisies,
  );
  assert.equal(c.verdict, 'conforme'); assert.deepEqual(c.commandesRattachees, ['#4842']);
});
test('repli par réf : multi-commandes agrégées (M2M)', () => {
  const [c] = run([lf('AA1', 30, 5)], [lc('C1', 'AA1', 10, 5, 10), lc('C2', 'AA1', 20, 5, 20)]);
  assert.equal(c.verdict, 'conforme'); assert.equal(c.qteRecue, 30);
});

console.log('══ Prix multi-commandes (on n\'accuse que si AUCUN prix ne colle) ══');
test('2 commandes à 2 prix, la facture colle au 2e → conforme', () => {
  const [c] = run([lf('AA1', 30, 5.5)], [lc('C1', 'AA1', 10, 5, 10), lc('C2', 'AA1', 20, 5.5, 20)]);
  assert.equal(c.verdict, 'conforme'); assert.equal(c.puCommande, 5.5);
});
test('2 prix, la facture ne colle à aucun → écart vs le plus proche', () => {
  const [c] = run([lf('AA1', 30, 6)], [lc('C1', 'AA1', 10, 5, 10), lc('C2', 'AA1', 20, 5.5, 20)]);
  assert.equal(c.verdict, 'ecart_prix'); assert.equal(c.puCommande, 5.5);
});

console.log('══ Conditionnement (facture en pièces vs CL en boîtes) ══');
test('X500 : facturé 5000 pièces, reçu 10 boîtes → réconcilié, conforme', () => {
  const [c] = run(
    [lf('P00003', 5000, 0.014, { designation: 'PLOMBS PLATS C4.5 X500' })],
    [lc('C1', 'P00003', 10, 7, 10)],
  );
  assert.equal(c.verdict, 'conforme'); assert.equal(c.facteur, 500);
});
test('X500 : le PU est réconcilié dans le même sens (0.014 €/pièce ≈ 7 €/boîte)', () => {
  const [c] = run(
    [lf('P00003', 5000, 0.02, { designation: 'PLOMBS PLATS C4.5 X500' })],
    [lc('C1', 'P00003', 10, 7, 10)],
  );
  assert.equal(c.verdict, 'ecart_prix'); // 0.02×500 = 10 € vs 7 € commandé
});
test('X500 non multiple exact → sur-facturation MAIS avertissement unités', () => {
  const [c] = run(
    [lf('P00003', 5200, 0.014, { designation: 'PLOMBS PLATS C4.5 X500' })],
    [lc('C1', 'P00003', 10, 7, 10)],
  );
  assert.equal(c.verdict, 'sur_facturation');
  assert.ok(c.problemes.some((p) => p.includes('conditionnement')));
});
test('nom de modèle « CARA RX20 » PAS lu comme ×20 (pas de fausse réconciliation)', () => {
  const [c] = run(
    [lf('CR0001', 20, 100, { designation: 'CARA RX20 SYNTHETIQUE' })],
    [lc('C1', 'CR0001', 1, 100, 1)],
  );
  assert.equal(c.verdict, 'sur_facturation'); assert.equal(c.facteur, 1);
});

console.log('══ Reçu contesté (garde-fou double saisie non apurée, cas 17655) ══');
test('facturé = reçu MAIS reçu contesté → flag + problème « apurer avant paiement »', () => {
  const [c] = run(
    [lf('17655', 30, 12)],
    [lc('C1', '17655', 34, 12, 30)],
    [], { refsRecuConteste: new Set(['17655']) },
  );
  assert.equal(c.verdict, 'conforme'); // le verdict 3-voies ne change pas…
  assert.equal(c.recuConteste, true);  // …mais la ligne est marquée
  assert.ok(c.problemes.some((p) => p.includes('apurer avant paiement')));
});
test('réf non contestée → pas de flag', () => {
  const [c] = run([lf('AA1', 10, 5)], [lc('C1', 'AA1', 10, 5, 10)], [], { refsRecuConteste: new Set(['17655']) });
  assert.equal(c.recuConteste, false);
});
test('le flag suit la clé aliasée (réf facturée sous code Colombi, contestée sous code CL)', () => {
  const [c] = run(
    [lf('LTL014', 5, 3)],
    [lc('C1', 'LTLPK03', 5, 3, 5)],
    [], { refsRecuConteste: new Set(['LTLPK03']) }, // clé brute ≠ clé aliasée → à passer déjà aliasée
  );
  // Le set doit être construit avec aliasRef par l'appelant : LTLPK03 aliasé = LTL014.
  // Ici on vérifie qu'une clé NON aliasée ne matche PAS (contrat : l'appelant aliase).
  assert.equal(c.recuConteste, false);
});

console.log('══ Edge cases ══');
test('PU commande null → pas d\'écart prix, le reste jugé', () => {
  const [c] = run([lf('AA1', 15, 5)], [lc('C1', 'AA1', 10, null, 10)]);
  assert.equal(c.verdict, 'sur_facturation'); assert.equal(c.ecartPrixPct, null);
});
test('PU facture null → pas d\'écart prix', () => {
  const [c] = run([lf('AA1', 10, null)], [lc('C1', 'AA1', 10, 5, 10)]);
  assert.equal(c.verdict, 'conforme'); assert.equal(c.ecartPrixPct, null);
});
test('facture vide → résultat vide', () => assert.equal(run([], [lc('C1', 'AA1', 1, 1, 1)]).length, 0));
test('réf null sur la ligne facture → hors commande sans crash', () => {
  const [c] = run([lf(null as never, 5, 5)], [lc('C1', 'AA1', 10, 5, 10)]);
  assert.equal(c.verdict, 'hors_commande');
});

console.log(`\n═══ ${n} tests, ${n - ko} OK, ${ko} KO ═══`);
if (ko > 0) process.exit(1);
