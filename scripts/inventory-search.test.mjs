// Tests for the Inventory search: node --test scripts/inventory-search.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import '../lib/inventory-search.js';

const S = globalThis.FarriInventorySearch;
const inv = [
  { id: '1', name: 'St. Croix Eventer Front', brand: 'St. Croix', category: 'Shoes', size: '00', unit: 'pair' },
  { id: '2', name: 'Horseshoe Nails', brand: 'Mustad', category: 'Nails', unit: 'box', notes: 'Part #1234', supplierSku: 'MN-5' },
  { id: '3', name: 'Rasp', brand: 'Heller', category: 'Tools', unit: 'each' },
  { id: '4', name: 'Nail pullers', category: 'Tools' },
  { id: '5', name: 'Clinch Nails', category: 'Nails' },
];
const ids = (q) => S.search(inv, q).map(i => i.id);

test('typing filters as you go, ignoring case and punctuation', () => {
  assert.deepEqual(ids('nail'), ['4', '2', '5']);     // 'Nail pullers' starts with it; then the two 'Nails' (tied: list order)
  assert.deepEqual(ids('NAILS'), ['2', '5']);
  assert.deepEqual(ids('st croix'), ['1']);
  assert.deepEqual(ids('St.Croix'), ['1']);
  assert.deepEqual(ids('ras'), ['3']);
  assert.deepEqual(ids('zzz'), []);
});

test('every word must match, in any order, across all the fields', () => {
  assert.deepEqual(ids('eventer 00'), ['1']);          // name + size
  assert.deepEqual(ids('00 eventer'), ['1']);
  assert.deepEqual(ids('mustad box'), ['2']);          // brand + unit
  assert.deepEqual(ids('tools heller'), ['3']);        // category + brand
  assert.deepEqual(ids('1234'), ['2']);                // part number in notes
  assert.deepEqual(ids('mn 5'), ['2']);                // supplier part number
  assert.deepEqual(ids('nails tools'), []);            // no item is both
});

test('best matches first: name starts with it, then a name word, then name contains, then other fields', () => {
  const items = [
    { id: 'a', name: 'Hoof knife', notes: 'rasp handle' },   // only in notes
    { id: 'b', name: 'Farrier rasp 14 inch' },                // a name word starts with it
    { id: 'c', name: 'Rasp' },                                // name starts with it
    { id: 'd', name: 'Grasp aid' },                           // name contains it
  ];
  assert.deepEqual(S.search(items, 'rasp').map(i => i.id), ['c', 'b', 'd', 'a']);
});

test('an empty search shows everything, in the original order, without changing the list', () => {
  assert.deepEqual(S.search(inv, '').map(i => i.id), ['1', '2', '3', '4', '5']);
  assert.deepEqual(S.search(inv, '   ').map(i => i.id), ['1', '2', '3', '4', '5']);
  assert.deepEqual(S.search(null, 'x'), []);
  const copy = JSON.stringify(inv); S.search(inv, 'nail'); assert.equal(JSON.stringify(inv), copy);
});

test('exact-name check decides whether to offer "add as new"', () => {
  assert.equal(S.hasExactName(inv, 'horseshoe nails'), true);
  assert.equal(S.hasExactName(inv, 'HORSESHOE-NAILS'), true);
  assert.equal(S.hasExactName(inv, 'St Croix Eventer Front 00'), true);   // name + size
  assert.equal(S.hasExactName(inv, 'nails'), false);                      // only part of a name
  assert.equal(S.hasExactName(inv, ''), false);
  assert.equal(S.hasExactName([], 'x'), false);
});

// ── Catalog lookups ──
const keyFn = (n, z) => [n, z].map(x => String(x || '').trim().toLowerCase().replace(/\s+/g, ' ')).join('|'); // same as inventoryCatalogKey
const catalog = {
  general: [
    { category: 'Horseshoes', name: 'Steel keg shoes', unit: 'pair', common: true },
    { category: 'Nails', name: 'Horseshoe nails', unit: 'box' },
    { category: 'Tools', name: 'Hoof rasp', unit: 'each' },
  ],
  products: [
    { t: 'St. Croix Eventer Front', b: 'St. Croix', c: 'Shoes > Steel', u: 'pair', v: [['0', 'SC-0'], ['00', 'SC-00'], ['1', 'SC-1']] },
    { t: 'Mustad Horseshoe Nails', b: 'Mustad', c: 'Nails > Keg', u: 'box', v: [['5', 'MN-5'], ['6', 'MN-6']] },
    { t: 'Heller Rasp 14"', b: 'Heller', c: 'Tools > Rasps', u: 'each', tool: 1, v: [['', 'HR-14']] },
    { t: 'Hoof Pick', b: '', c: 'Tools', u: 'each', tool: 1, v: [['', '']] },
  ],
};

test('catalog: finds supply products and general supplies by what was typed (name, brand, category, part number)', () => {
  const r = S.searchCatalog(catalog, 'nails', { keyFn });
  assert.deepEqual(r.supply.map(x => x.product.t), ['Mustad Horseshoe Nails']);
  assert.deepEqual(r.general.map(x => x.entry.name), ['Horseshoe nails']);
  assert.deepEqual(S.searchCatalog(catalog, 'heller', { keyFn }).supply.map(x => x.product.t), ['Heller Rasp 14"']);        // brand
  assert.deepEqual(S.searchCatalog(catalog, 'MN-6', { keyFn }).supply.map(x => x.product.t), ['Mustad Horseshoe Nails']);   // part number
  assert.deepEqual(S.searchCatalog(catalog, 'st croix 00', { keyFn }).supply.map(x => x.product.t), ['St. Croix Eventer Front']);
  assert.deepEqual(S.searchCatalog(catalog, 'tools', { keyFn }).supply.map(x => x.product.t).sort(), ['Heller Rasp 14"', 'Hoof Pick']); // category
  const none = S.searchCatalog(catalog, 'zzz', { keyFn }); assert.deepEqual([none.supply, none.general, none.totalSupply, none.totalGeneral], [[], [], 0, 0]);
  assert.deepEqual(S.searchCatalog(catalog, '', { keyFn }).supply, []);
  assert.deepEqual(S.searchCatalog(null, 'x', { keyFn }).supply, []);
});

test('catalog: leaves out what the farrier already has, using the picker\'s own name + size key', () => {
  const owned = new Set([keyFn('St. Croix Eventer Front', '00'), keyFn('Horseshoe nails', ''), keyFn('Hoof Pick', '')]);
  const r = S.searchCatalog(catalog, 'eventer', { keyFn, owned });
  assert.deepEqual(r.supply[0].variants.map(v => v.size), ['0', '1']);                // the size they have is not offered again
  assert.deepEqual(S.searchCatalog(catalog, 'horseshoe nails', { keyFn, owned }).general, []);   // general entry already theirs
  assert.deepEqual(S.searchCatalog(catalog, 'pick', { keyFn, owned }).supply, []);               // the only size already theirs: product left out
  const all = new Set(['0', '00', '1'].map(z => keyFn('St. Croix Eventer Front', z)));
  assert.deepEqual(S.searchCatalog(catalog, 'eventer', { keyFn, owned: all }).supply, []);
});

test('catalog: best matches first, cut to a few with the true totals, indexes point back into the catalog', () => {
  const many = { general: [], products: [...Array(20)].map((_, i) => ({ t: (i === 7 ? 'Nail ' : 'Big nail ') + i, b: '', c: 'Nails', u: 'box', v: [['', 'P' + i]] })) };
  const r = S.searchCatalog(many, 'nail', { keyFn, maxSupply: 8 });
  assert.equal(r.supply.length, 8); assert.equal(r.totalSupply, 20);
  assert.equal(r.supply[0].product.t, 'Nail 7');                       // name starts with it: first
  assert.equal(many.products[r.supply[0].pi].t, 'Nail 7');             // pi indexes the original list
  assert.equal(many.products[r.supply[1].pi].v[r.supply[1].variants[0].vi][1], 'P0');
});
