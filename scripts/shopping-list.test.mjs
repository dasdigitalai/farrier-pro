// Tests for the shopping list logic: node --test scripts/shopping-list.test.mjs  (no network, no Firestore)
import test from 'node:test';
import assert from 'node:assert/strict';
import '../lib/shopping-list.js';

const S = globalThis.FarriShopping;
const fv = { increment: (n) => ({ __inc: n }), serverTimestamp: () => 'SERVER_TS' };

test('adding: name is required and tidied, quantity defaults to 1, bad input is explained', () => {
  assert.deepEqual(S.cleanNewItem({ name: '  Horse   shoe   nails ', qty: '', unit: ' box ' }), { ok: true, value: { name: 'Horse shoe nails', qty: 1, unit: 'box' } });
  assert.deepEqual(S.cleanNewItem({ name: 'Rasp', qty: '2.5' }).value, { name: 'Rasp', qty: 2.5, unit: '' });
  assert.deepEqual(S.cleanNewItem({ name: 'Rasp', qty: 3 }).value.qty, 3);
  for (const bad of [{ name: '' }, { name: '   ' }, { name: 'x', qty: '0' }, { name: 'x', qty: '-1' }, { name: 'x', qty: 'abc' }, { name: 'x', qty: '1e9' }, { name: 'x'.repeat(101) }, { name: 'x', unit: 'y'.repeat(21) }, undefined]) {
    const r = S.cleanNewItem(bad); assert.equal(r.ok, false, JSON.stringify(bad)); assert.ok(r.error);
  }
  assert.equal(S.cleanNewItem({ name: 'x', qty: '0.0004' }).ok, false); // rounds to 0
});

test('grouping: to buy in the order added, purchased newest first, just-added items last', () => {
  const t = (n) => ({ toMillis: () => n });
  const r = S.group([
    { id: 'a', name: 'Nails', createdAt: t(100) }, { id: 'b', name: 'Rasp', createdAt: t(50) }, { id: 'c', name: 'Pending', createdAt: null },
    { id: 'd', name: 'Pads', purchased: true, purchasedAt: t(10) }, { id: 'e', name: 'Gloves', purchased: true, purchasedAt: t(20) },
  ]);
  assert.deepEqual(r.toBuy.map(i => i.id), ['b', 'a', 'c']);
  assert.deepEqual(r.purchased.map(i => i.id), ['e', 'd']);
  assert.deepEqual(S.group(null), { toBuy: [], purchased: [] });
  assert.equal(S.toMillis({ seconds: 5 }), 5000); assert.equal(S.toMillis('2026-01-01T00:00:00Z'), Date.parse('2026-01-01T00:00:00Z')); assert.equal(S.toMillis('junk'), null);
});

test('matching an inventory item: exact (ignoring case/punctuation), then closest containing name, else none', () => {
  const inv = [{ id: '1', name: 'St. Croix Eventer Front', size: '00' }, { id: '2', name: 'Horseshoe Nails' }, { id: '3', name: 'Horseshoe Nails Heavy Duty' }, { id: '4', name: 'Rasp' }];
  assert.equal(S.suggestInventoryMatch('horseshoe nails', inv).id, '2');
  assert.equal(S.suggestInventoryMatch('HORSESHOE-NAILS!', inv).id, '2');
  assert.equal(S.suggestInventoryMatch('nails', inv).id, '2');                    // contained in two names: the shorter one
  assert.equal(S.suggestInventoryMatch('St Croix Eventer Front 00', inv).id, '1'); // name + size
  assert.equal(S.suggestInventoryMatch('Rasp 14 inch', inv).id, '4');             // inventory name contained in what was typed
  assert.equal(S.suggestInventoryMatch('Anvil', inv), null);
  assert.equal(S.suggestInventoryMatch('', inv), null);
  assert.equal(S.suggestInventoryMatch('x', []), null);
});

const item = { id: 'sl1', name: 'Horseshoe nails', qty: 2, unit: 'box', purchased: true };

test('add to an existing inventory item: increments stock, logs a restock, marks the list item', () => {
  const r = S.buildAddToInventory({ item, mode: 'existing', existing: { id: 'inv9', name: 'Horseshoe Nails' }, qty: '2', farrierId: 'biz1', userId: 'u1', fv });
  assert.equal(r.error, undefined);
  assert.deepEqual(r.inventory, { kind: 'update', id: 'inv9', data: { quantityOnHand: { __inc: 2 }, updatedAt: 'SERVER_TS' } });
  assert.deepEqual(r.transaction, { farrierId: 'biz1', itemId: 'inv9', qtyDelta: 2, type: 'restock', source: 'shopping-list', shoppingItemId: 'sl1', createdAt: 'SERVER_TS' });
  assert.deepEqual(r.shopping, { inventoryItemId: 'inv9', inventoryItemName: 'Horseshoe Nails', addedQty: 2, addedToInventoryAt: 'SERVER_TS', addedBy: 'u1' });
});

test('add as a new inventory item: the same fields the Inventory screen saves, quantity = what was bought', () => {
  const r = S.buildAddToInventory({ item, mode: 'new', newId: 'newInv', fresh: { name: ' Nails  #5 ', category: 'Nails', unit: 'box', costPerUnit: '12.345', isTool: false }, qty: 2, farrierId: 'biz1', userId: 'u1', fv });
  assert.equal(r.error, undefined);
  assert.equal(r.inventory.kind, 'create'); assert.equal(r.inventory.id, 'newInv');
  assert.deepEqual(r.inventory.data, { farrierId: 'biz1', name: 'Nails #5', category: 'Nails', brand: '', size: '', unit: 'box', quantityOnHand: 2, reorderThreshold: 0, costPerUnit: 12.35, isConsumable: true, isActive: true, notes: '', createdAt: 'SERVER_TS', updatedAt: 'SERVER_TS' });
  assert.equal(r.transaction.itemId, 'newInv'); assert.equal(r.transaction.qtyDelta, 2); assert.equal(r.shopping.inventoryItemId, 'newInv');
  const tool = S.buildAddToInventory({ item, mode: 'new', newId: 'n', fresh: { name: 'Rasp', isTool: true }, qty: 1, farrierId: 'biz1', fv });
  assert.equal(tool.inventory.data.isConsumable, false); assert.equal(tool.inventory.data.costPerUnit, 0);
});

test('add to inventory: refuses what would corrupt stock', () => {
  const base = { item, mode: 'existing', existing: { id: 'i', name: 'N' }, qty: 1, farrierId: 'biz1', fv };
  for (const [what, args, msg] of [
    ['no quantity', { qty: '' }, /Quantity/], ['zero', { qty: 0 }, /Quantity/], ['negative', { qty: -2 }, /Quantity/], ['not a number', { qty: 'lots' }, /Quantity/],
    ['already added', { item: { ...item, inventoryItemId: 'inv1' } }, /already in your inventory/],
    ['no item picked', { existing: null }, /Pick the inventory item/], ['no item', { item: null }, /missing/],
    ['no mode', { mode: '' }, /Choose/], ['no business', { farrierId: '' }, /business/i],
    ['new without a name', { mode: 'new', newId: 'n', fresh: { name: ' ' } }, /name/],
    ['new without an id', { mode: 'new', fresh: { name: 'A' } }, /id/],
    ['new with a bad cost', { mode: 'new', newId: 'n', fresh: { name: 'A', costPerUnit: '-3' } }, /Cost/],
  ]) { const r = S.buildAddToInventory({ ...base, ...args }); assert.ok(r.error && msg.test(r.error), `${what}: ${JSON.stringify(r)}`); assert.equal(r.inventory, undefined, what); }
});
