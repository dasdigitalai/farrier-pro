# Inventory search

The Inventory screen (desktop and mobile) has a search box that filters as you type.

- It searches the farrier's own inventory by name, brand, category, size, unit, notes and supplier part number.
  Every typed word must match somewhere (case and punctuation ignored), best matches first.
- It **also searches the supply catalog** (the supplier products and the general supplies list the
  *Add from Catalog* picker uses), because an item may be in the catalog but not in this farrier's inventory yet.
  Anything they already have (same name + size, the picker's own rule) is left out. The catalog is only
  downloaded the first time something is searched.
- A catalog match has a **+ Add** button (one per size for products with several sizes). It adds the item to their
  inventory with quantity 0, exactly as the picker does, then asks **how many do you have** (the normal Restock
  window on desktop, a prompt on mobile).
- If nothing matches in either place, it says so and offers **+ Add “what they typed” as a new item**, which opens
  the usual New Item form with the name filled in. If there are matches but not the right one, a smaller
  "Not what you're looking for?" row offers the same.
- If the catalog can't be loaded (for example offline and never loaded before), the farrier's own results still
  work, it says the catalog couldn't be checked, and adding as a new item is still offered.

Code: `lib/inventory-search.js` (shared matching, also cached by the mobile service worker). Tests:

```
node --test scripts/inventory-search.test.mjs
```
