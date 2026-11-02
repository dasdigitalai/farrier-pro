// Inventory search — type-to-filter for the Inventory screens, shared by index.html (desktop) and mobile.html so
// both match the same way.
//
// Plain script, like lib/pricing.js: pages load it with <script src="/lib/inventory-search.js"> and use
// window.FarriInventorySearch. It only filters the items the page already loaded; it never touches Firestore.
//
// Matching: the typed words are split on spaces and every word must appear somewhere in the item's name, brand,
// category, size, unit, notes or supplier part number (case and punctuation ignored, so "st croix 00" finds
// "St. Croix Eventer Front" in size 00, and "nail" finds "Horseshoe Nails"). Best matches first: name starts
// with what was typed, then a name word does, then the name contains it, then matches in other fields.
(function (root) {
  const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const FIELDS = ['name', 'brand', 'category', 'size', 'unit', 'notes', 'supplierSku'];
  const haystack = (item) => norm(FIELDS.map(f => item && item[f]).filter(v => v != null && v !== '').join(' '));

  // Items matching `query` (all of them, in their given order, when the query is empty), best match first.
  function search(items, query) {
    const list = Array.isArray(items) ? items : [];
    const q = norm(query);
    if (!q) return list.slice();
    const tokens = q.split(' ');
    const rank = (item) => {
      const name = norm(item.name);
      if (name.startsWith(q)) return 0;
      if (name.split(' ').some(w => w.startsWith(tokens[0]))) return 1;
      if (name.includes(q)) return 2;
      return 3;
    };
    return list
      .map((item, i) => ({ item, i, h: haystack(item) }))
      .filter(x => tokens.every(t => x.h.includes(t)))
      .map(x => ({ item: x.item, i: x.i, r: rank(x.item) }))
      .sort((a, b) => a.r - b.r || a.i - b.i)
      .map(x => x.item);
  }

  // Is there already an item with exactly this name (or name + size)? Then there's no point offering "add new".
  function hasExactName(items, query) {
    const q = norm(query);
    if (!q) return false;
    return (Array.isArray(items) ? items : []).some(i => i && (norm(i.name) === q || norm([i.name, i.size].filter(Boolean).join(' ')) === q));
  }

  // ── The supply catalog (what a farrier can add from) ──
  // catalog: { general: [{ category, name, unit, common }], products: [{ t: title, b: brand, c: 'Top > Sub', u: unit, v: [[size, partNumber], ...] }] }
  //   (the shapes in inventory-catalog.js / supply-catalog.json).
  // Finds catalog items matching what was typed, leaving out what the farrier already has. `keyFn(name, size)` is the
  // picker's own "already owned" key (inventoryCatalogKey) and `owned` the set of keys from their inventory, so
  // this agrees with the Add-from-Catalog picker about what counts as already theirs. A product with several
  // sizes lists only the sizes they don't have; if they have them all, it's left out.
  // Returns { general: [{ idx, entry }], supply: [{ pi, product, variants: [{ vi, size, part }] }], totalGeneral, totalSupply }
  // (the lists are cut to maxGeneral / maxSupply; the totals are before cutting).
  const productText = new WeakMap();
  function searchCatalog(catalog, query, { owned, keyFn, maxGeneral = 5, maxSupply = 8 } = {}) {
    const empty = { general: [], supply: [], totalGeneral: 0, totalSupply: 0 };
    const q = norm(query);
    if (!q || !catalog) return empty;
    const tokens = q.split(' ');
    const has = owned || new Set();
    const key = keyFn || ((n, z) => `${norm(n)}|${norm(z)}`);
    const rank = (name) => { const n = norm(name); return n.startsWith(q) ? 0 : n.split(' ').some(w => w.startsWith(tokens[0])) ? 1 : n.includes(q) ? 2 : 3; };

    const gen = (catalog.general || [])
      .map((entry, idx) => ({ entry, idx }))
      .filter(({ entry }) => !has.has(key(entry.name, '')) && tokens.every(t => norm(entry.name + ' ' + entry.category).includes(t)))
      .map(x => ({ ...x, r: rank(x.entry.name) }))
      .sort((a, b) => a.r - b.r || a.idx - b.idx);

    const sup = [];
    (catalog.products || []).forEach((product, pi) => {
      let text = productText.get(product);
      if (text === undefined) { text = norm([product.t, product.b, product.c, ...(product.v || []).map(v => v[1])].join(' ')); productText.set(product, text); }
      if (!tokens.every(t => text.includes(t))) return;
      const variants = (product.v || [['', '']]).map((v, vi) => ({ vi, size: v[0] || '', part: v[1] || '' })).filter(v => !has.has(key(product.t, v.size)));
      if (variants.length) sup.push({ pi, product, variants, r: rank(product.t) });
    });
    sup.sort((a, b) => a.r - b.r || a.pi - b.pi);

    return {
      general: gen.slice(0, maxGeneral).map(({ idx, entry }) => ({ idx, entry })),
      supply: sup.slice(0, maxSupply).map(({ pi, product, variants }) => ({ pi, product, variants })),
      totalGeneral: gen.length, totalSupply: sup.length,
    };
  }

  // What goes into the shopping list's add box when a suggestion is picked: { name, unit }.
  //   'own':     thing = one of the farrier's inventory items    -> "Name (size)" and its unit
  //   'supply':  thing = a supply-catalog product, size = the size picked (may be '')  -> "Title (size)" and the product's unit
  //   'general': thing = a general-supplies entry               -> its name and unit
  function shoppingPick(kind, thing, size) {
    const t = thing || {};
    // "Protector Plate Pair (7)", but "Buffing Compound - Green (Fine)": no brackets inside brackets.
    const withSize = (name, z) => (!z ? name : /[()]/.test(z) ? `${name} - ${z}` : `${name} (${z})`);
    const out = kind === 'own' ? { name: withSize(t.name || '', t.size), unit: t.unit || '' }
      : kind === 'supply' ? { name: withSize(t.t || '', size), unit: t.u || '' }
      : { name: t.name || '', unit: t.unit || '' };
    return { name: String(out.name).slice(0, 100), unit: String(out.unit).slice(0, 20) };
  }

  // The label for one choice of a catalog product: "Size 7" for a number-like size, otherwise the choice as written
  // (a colour, "Green (Fine)", "12 inch"...). A product with a single, unnamed choice is "Use this".
  function variantLabel(size) {
    const z = String(size == null ? '' : size).trim();
    if (!z) return 'Use this';
    return /^[0-9][0-9./\-]*[a-z]{0,2}$/i.test(z) ? `Size ${z}` : z;
  }

  root.FarriInventorySearch = { norm, search, hasExactName, searchCatalog, shoppingPick, variantLabel };
})(typeof window !== 'undefined' ? window : globalThis);
