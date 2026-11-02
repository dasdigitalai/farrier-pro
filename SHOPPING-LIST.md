# Shopping List

Farriers keep a list of things to buy, tick them off when bought, and put them into inventory.

- **Desktop:** Manage menu → **Shopping List**. **Mobile:** **Shopping List** button on the home screen.
- Add an item (name, quantity, optional unit like *box* or *lb*). Tick **Purchased** when you've bought it.
  Purchased items move to their own section with an **Add to inventory** button.
- **Add to inventory** either adds the quantity to an inventory item you already have (the best name match is
  picked for you) or creates a new inventory item. It does what Inventory's own **Restock** does (adds to
  `quantityOnHand` and records an `inventoryTransactions` row, type `restock`, source `shopping-list`), and marks
  the list item **✓ In inventory** so it can't be added twice. The three writes are one all-or-nothing batch.
- **Clear purchased** removes the purchased items from the list (it warns if some aren't in inventory yet).
- The list is shared with everyone in the business (owner, managers, team farriers) and updates live between
  phone and desktop. On mobile it keeps working offline and syncs when the signal is back.

## Where it lives

`farriers/{businessId}/shoppingList/{itemId}`, so no Firestore rules change is needed (the existing
`farriers/{farrierId}/{document=**}` rule covers it). Shared logic (cleaning input, grouping, matching an inventory
item, building the writes) is in `lib/shopping-list.js`, loaded by both apps. The mobile service worker caches it
for offline use.

Item fields: `name, qty, unit, purchased, purchasedAt, purchasedBy, inventoryItemId, inventoryItemName, addedQty,
addedToInventoryAt, addedBy, createdAt, createdBy`.

## Tests

```
node --test scripts/shopping-list.test.mjs
```
