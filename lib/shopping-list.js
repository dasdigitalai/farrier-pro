// Shopping list — what a farrier needs to buy, shared by index.html (desktop "Shopping List" tab) and
// mobile.html (Shopping List screen), so both behave the same.
//
// Plain script, like lib/pricing.js: pages load it with <script src="/lib/shopping-list.js"> and use
// window.FarriShopping. It does no Firestore calls itself; it cleans input, groups the list, suggests
// which inventory item a bought thing belongs to, and builds the exact documents to write.
//
// Where it lives: farriers/{businessId}/shoppingList/{itemId} (the business's list, shared with team members;
// the existing rule for farriers/{id}/{document=**} already covers it, so no rules change is needed).
//   { name, qty, unit, purchased, purchasedAt, purchasedBy,
//     inventoryItemId, inventoryItemName, addedQty, addedToInventoryAt,   // set once it's been put into inventory
//     createdAt, createdBy }
//
// "Add to inventory" does what Inventory's own Restock does: it adds to inventoryItems/{id}.quantityOnHand and
// records an inventoryTransactions row (type 'restock'), or creates a new inventoryItems doc. The page writes the
// three documents in ONE batch, so a purchase is never half-recorded or added twice.
(function (root) {
  const MAX_NAME = 100, MAX_UNIT = 20, MAX_QTY = 1000000;

  const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const round3 = (n) => Math.round(n * 1000) / 1000;

  function toMillis(v) {
    if (!v) return null;
    if (typeof v.toMillis === 'function') return v.toMillis();
    if (typeof v.seconds === 'number') return v.seconds * 1000;
    const t = new Date(v).getTime();
    return isNaN(t) ? null : t;
  }

  // A quantity from a text box: a positive number (decimals allowed: "2.5 lb"), or null.
  function parseQty(v) {
    const n = round3(Number(String(v == null ? '' : v).trim())); // round first: 0.0004 must not slip through as 0
    return Number.isFinite(n) && n > 0 && n <= MAX_QTY ? n : null;
  }

  // Cleans what was typed into the add box. { ok: true, value: { name, qty, unit } } or { ok: false, error }.
  function cleanNewItem({ name, qty, unit } = {}) {
    const n = clean(name);
    if (!n) return { ok: false, error: 'Type what you need to buy.' };
    if (n.length > MAX_NAME) return { ok: false, error: `Keep the name under ${MAX_NAME} characters.` };
    const q = qty === '' || qty == null ? 1 : parseQty(qty);
    if (q == null) return { ok: false, error: 'Quantity must be a number above 0.' };
    const u = clean(unit);
    if (u.length > MAX_UNIT) return { ok: false, error: `Keep the unit under ${MAX_UNIT} characters.` };
    return { ok: true, value: { name: n, qty: q, unit: u } };
  }

  // Splits the list: still to buy (oldest first, so the list reads in the order things were added) and purchased
  // (most recently ticked first). An item just added has no server time yet, so it goes last.
  function group(items) {
    const list = Array.isArray(items) ? items : [];
    const at = (x, k) => toMillis(x[k]);
    const toBuy = list.filter(i => !i.purchased).sort((a, b) => (at(a, 'createdAt') ?? Infinity) - (at(b, 'createdAt') ?? Infinity) || String(a.name).localeCompare(String(b.name)));
    const purchased = list.filter(i => i.purchased).sort((a, b) => (at(b, 'purchasedAt') ?? Infinity) - (at(a, 'purchasedAt') ?? Infinity) || String(a.name).localeCompare(String(b.name)));
    return { toBuy, purchased };
  }

  // Which existing inventory item is this? An exact match on the name (ignoring case and punctuation), else
  // the one whose name contains it or is contained in it (the shortest such name). null when nothing fits.
  function suggestInventoryMatch(name, inventoryItems) {
    const want = norm(name);
    if (!want) return null;
    const label = (i) => norm([i.name, i.size].filter(Boolean).join(' '));
    const items = (inventoryItems || []).filter(i => i && i.name);
    const exact = items.find(i => norm(i.name) === want || label(i) === want);
    if (exact) return exact;
    const loose = items.filter(i => { const n = norm(i.name); return n && (n.includes(want) || want.includes(n)); });
    return loose.sort((a, b) => norm(a.name).length - norm(b.name).length)[0] || null;
  }

  // The documents to write when a bought item goes into inventory.
  //   item:     the shopping list doc ({ id, name, qty, unit, ... })
  //   mode:     'existing' (add to `existing`, an inventory doc) or 'new' (create `fresh`)
  //   qty:      how many to add (text or number)
  //   fresh:    { name, category, unit, costPerUnit, isTool } for a new inventory item
  //   newId:    for 'new', the id the page has already chosen for the new inventory doc (db.collection(...).doc().id)
  //   fv:       { increment(n), serverTimestamp() } (firebase.firestore.FieldValue; fakes in tests)
  // Returns { error } or { inventory: { kind: 'update' | 'create', id, data }, transaction, shopping, qty }.
  function buildAddToInventory({ item, mode, existing, fresh, newId, qty, farrierId, userId, fv }) {
    if (!item || !item.id) return { error: 'That item is missing.' };
    if (item.inventoryItemId) return { error: 'That item is already in your inventory.' };
    if (!farrierId) return { error: 'Missing business.' };
    const q = parseQty(qty);
    if (q == null) return { error: 'Quantity must be a number above 0.' };
    const now = fv.serverTimestamp();
    let inventory, name;
    if (mode === 'existing') {
      if (!existing || !existing.id) return { error: 'Pick the inventory item to add to.' };
      name = existing.name || item.name;
      inventory = { kind: 'update', id: existing.id, data: { quantityOnHand: fv.increment(q), updatedAt: now } };
    } else if (mode === 'new') {
      if (!newId) return { error: 'Missing id for the new inventory item.' };
      const nm = clean(fresh && fresh.name);
      if (!nm) return { error: 'Give the new inventory item a name.' };
      if (nm.length > MAX_NAME) return { error: `Keep the name under ${MAX_NAME} characters.` };
      const cost = fresh.costPerUnit === '' || fresh.costPerUnit == null ? 0 : Number(fresh.costPerUnit);
      if (!Number.isFinite(cost) || cost < 0) return { error: 'Cost must be a number, 0 or more.' };
      name = nm;
      inventory = { kind: 'create', id: newId, data: {
        farrierId, name: nm, category: clean(fresh.category), brand: '', size: '', unit: clean(fresh.unit).slice(0, MAX_UNIT),
        quantityOnHand: q, reorderThreshold: 0, costPerUnit: Math.round(cost * 100) / 100,
        isConsumable: !fresh.isTool, isActive: true, notes: '', createdAt: now, updatedAt: now,
      } };
    } else {
      return { error: 'Choose whether to add to an existing item or create a new one.' };
    }
    return {
      qty: q,
      inventory,
      transaction: { farrierId, itemId: inventory.id, qtyDelta: q, type: 'restock', source: 'shopping-list', shoppingItemId: item.id, createdAt: now },
      shopping: { inventoryItemId: inventory.id, inventoryItemName: name, addedQty: q, addedToInventoryAt: now, addedBy: userId || '' },
    };
  }

  root.FarriShopping = { clean, norm, toMillis, parseQty, cleanNewItem, group, suggestInventoryMatch, buildAddToInventory };
})(typeof window !== 'undefined' ? window : globalThis);
