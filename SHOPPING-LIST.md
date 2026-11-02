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
- **Suggestions as you type** (desktop and mobile): typing in the add box shows matches from the farrier's own
  inventory first (with how many they have, and a low-stock flag), then the supply catalog (size buttons for products
  that come in several sizes or colours). Tapping your own item fills in the name and unit. For a catalog product with
  several choices (e.g. Buffing Compound: Green, Grey, White) the choices are **multi-select**: tick as many as needed (a ✓
  shows on each), then **Add N to the list** puts each on the list as its own line ("Buffing Compound - Green (Fine)",
  "Protector Plate Pair (7)"), using the quantity in the box and the product's unit, all or none. With exactly one ticked,
  **Fill the box instead** fills the name and unit so they can edit before adding. Typing more clears the ticks. If nothing matches anywhere it says so and offers
  **+ Add "what they typed" to the list as a new item**; ignoring the suggestions and pressing Add always works. Matching
  is the same as the Inventory search (`lib/inventory-search.js`, see `INVENTORY-SEARCH.md`); the catalog is only
  downloaded the first time they type, and if it can't load the farrier's own matches still show.
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
