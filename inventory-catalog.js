// FarriTech master consumables catalog.
// Shared by the desktop app (index.html) and the mobile app (mobile.html) as the
// "Add from Catalog" picker on the Inventory screen. Picking an item copies it into
// the farrier's own inventoryItems collection with qty 0 — from then on it's theirs
// to edit (brand, size, cost, reorder level). Nothing here is ever written back or
// read after the copy, so editing this list only affects future picks.
//
// Source: Farrier_Consumables_Inventory.xlsx (Sep 2026), de-duplicated and given a
// single default unit per item. `common: true` marks the items preselected by the
// picker's "Select common items" shortcut.
//
// The supplier product catalog (loaded on demand) is further down.
//
// Mobile caches this file for offline use (see APP_SHELL in mobile-sw.js).
window.INVENTORY_CATALOG = [
  // Horseshoes
  { category: 'Horseshoes', name: 'Steel keg shoes', unit: 'pair', common: true },
  { category: 'Horseshoes', name: 'Aluminum shoes', unit: 'pair', common: true },
  { category: 'Horseshoes', name: 'Racing plates', unit: 'pair' },
  { category: 'Horseshoes', name: 'Draft shoes', unit: 'pair' },
  { category: 'Horseshoes', name: 'Pony shoes', unit: 'pair' },
  { category: 'Horseshoes', name: 'Therapeutic shoes', unit: 'pair' },
  { category: 'Horseshoes', name: 'Heart-bar shoes', unit: 'pair' },
  { category: 'Horseshoes', name: 'Egg-bar shoes', unit: 'pair' },
  { category: 'Horseshoes', name: 'Straight-bar shoes', unit: 'pair' },
  { category: 'Horseshoes', name: 'Wedge shoes', unit: 'pair' },
  { category: 'Horseshoes', name: 'Glue-on shoes', unit: 'pair' },
  { category: 'Horseshoes', name: 'Composite / plastic shoes', unit: 'pair' },
  { category: 'Horseshoes', name: 'Pads with integrated shoes', unit: 'pair' },

  // Nails & Fasteners
  { category: 'Nails & Fasteners', name: 'Horseshoe nails', unit: 'box', common: true },
  { category: 'Nails & Fasteners', name: 'City-head nails', unit: 'box' },
  { category: 'Nails & Fasteners', name: 'E-head nails', unit: 'box' },
  { category: 'Nails & Fasteners', name: 'Race nails', unit: 'box' },
  { category: 'Nails & Fasteners', name: 'Copper-coated nails', unit: 'box' },
  { category: 'Nails & Fasteners', name: 'Slim / blade nails', unit: 'box' },
  { category: 'Nails & Fasteners', name: 'Specialty therapeutic nails', unit: 'box' },
  { category: 'Nails & Fasteners', name: 'Horseshoe screws', unit: 'box' },
  { category: 'Nails & Fasteners', name: 'Studs', unit: 'box' },
  { category: 'Nails & Fasteners', name: 'Drive-in studs', unit: 'box' },

  // Pads
  { category: 'Pads', name: 'Leather pads', unit: 'pair' },
  { category: 'Pads', name: 'Rubber pads', unit: 'pair', common: true },
  { category: 'Pads', name: 'Plastic / polyurethane pads', unit: 'pair' },
  { category: 'Pads', name: 'Pour-in pads', unit: 'cartridge' },
  { category: 'Pads', name: 'Wedge pads', unit: 'pair' },
  { category: 'Pads', name: 'Degree pads', unit: 'pair' },
  { category: 'Pads', name: 'Rim pads', unit: 'pair' },
  { category: 'Pads', name: 'Frog-support pads', unit: 'pair' },
  { category: 'Pads', name: 'Hospital / treatment pads', unit: 'pair' },
  { category: 'Pads', name: 'Snowball / anti-snow pads', unit: 'pair' },

  // Adhesives & Hoof Repair
  { category: 'Adhesives & Hoof Repair', name: 'Hoof adhesive', unit: 'cartridge' },
  { category: 'Adhesives & Hoof Repair', name: 'Acrylic hoof repair material', unit: 'kit' },
  { category: 'Adhesives & Hoof Repair', name: 'Urethane hoof repair material', unit: 'kit' },
  { category: 'Adhesives & Hoof Repair', name: 'Glue-on shoe adhesive', unit: 'cartridge' },
  { category: 'Adhesives & Hoof Repair', name: 'Adhesive cartridges', unit: 'each' },
  { category: 'Adhesives & Hoof Repair', name: 'Hoof-repair mesh', unit: 'pack' },
  { category: 'Adhesives & Hoof Repair', name: 'Fiberglass repair material', unit: 'kit' },

  // Hoof Treatments
  { category: 'Hoof Treatments', name: 'Hoof hardener', unit: 'bottle' },
  { category: 'Hoof Treatments', name: 'Hoof conditioner / dressing', unit: 'container' },
  { category: 'Hoof Treatments', name: 'Thrush treatment', unit: 'bottle', common: true },
  { category: 'Hoof Treatments', name: 'White-line treatment', unit: 'bottle' },
  { category: 'Hoof Treatments', name: 'Antibacterial hoof treatment', unit: 'bottle' },
  { category: 'Hoof Treatments', name: 'Antifungal treatment', unit: 'bottle' },
  { category: 'Hoof Treatments', name: 'Sole toughener', unit: 'bottle' },
  { category: 'Hoof Treatments', name: 'Hoof sealant', unit: 'bottle' },
  { category: 'Hoof Treatments', name: 'Copper sulfate', unit: 'container' },
  { category: 'Hoof Treatments', name: 'Packing compounds', unit: 'container', common: true },
  { category: 'Hoof Treatments', name: 'Medicated hoof packing', unit: 'container' },

  // Welding & Fabrication
  { category: 'Welding & Fabrication', name: 'Welding rods', unit: 'pack' },
  { category: 'Welding & Fabrication', name: 'MIG wire', unit: 'spool' },
  { category: 'Welding & Fabrication', name: 'Flux', unit: 'can' },
  { category: 'Welding & Fabrication', name: 'Brazing rods', unit: 'pack' },
  { category: 'Welding & Fabrication', name: 'Borax', unit: 'can' },
  { category: 'Welding & Fabrication', name: 'Propane', unit: 'tank', common: true },
  { category: 'Welding & Fabrication', name: 'Forge gas', unit: 'tank' },
  { category: 'Welding & Fabrication', name: 'Oxygen', unit: 'tank' },
  { category: 'Welding & Fabrication', name: 'Acetylene', unit: 'tank' },

  // Grinding & Finishing
  { category: 'Grinding & Finishing', name: 'Grinding wheels', unit: 'each' },
  { category: 'Grinding & Finishing', name: 'Cutoff wheels', unit: 'each' },
  { category: 'Grinding & Finishing', name: 'Flap discs', unit: 'each' },
  { category: 'Grinding & Finishing', name: 'Sanding belts', unit: 'each' },
  { category: 'Grinding & Finishing', name: 'Sanding discs', unit: 'each' },
  { category: 'Grinding & Finishing', name: 'Grinding belts', unit: 'each' },
  { category: 'Grinding & Finishing', name: 'Polishing wheels', unit: 'each' },
  { category: 'Grinding & Finishing', name: 'Buffing compound', unit: 'each' },
  { category: 'Grinding & Finishing', name: 'Wire wheels', unit: 'each' },

  // Rasps & Blades
  { category: 'Rasps & Blades', name: 'Hoof rasps', unit: 'each', common: true },
  { category: 'Rasps & Blades', name: 'Finishing rasps', unit: 'each' },
  { category: 'Rasps & Blades', name: 'Rasp blades', unit: 'each' },
  { category: 'Rasps & Blades', name: 'Hoof-knife blades', unit: 'each' },
  { category: 'Rasps & Blades', name: 'Replaceable knife blades', unit: 'pack' },
  { category: 'Rasps & Blades', name: 'Sharpening belts / discs', unit: 'each' },

  // Glue-On / Application Supplies
  { category: 'Glue-On / Application Supplies', name: 'Mixing tips / nozzles', unit: 'pack' },
  { category: 'Glue-On / Application Supplies', name: 'Dispensing tips', unit: 'pack' },
  { category: 'Glue-On / Application Supplies', name: 'Glue tabs', unit: 'pack' },
  { category: 'Glue-On / Application Supplies', name: 'Fabric cuffs', unit: 'pack' },
  { category: 'Glue-On / Application Supplies', name: 'Composite cuffs', unit: 'pack' },
  { category: 'Glue-On / Application Supplies', name: 'Applicator sleeves', unit: 'pack' },
  { category: 'Glue-On / Application Supplies', name: 'Hoof-cleaning solvent', unit: 'bottle' },
  { category: 'Glue-On / Application Supplies', name: 'Acetone', unit: 'bottle' },
  { category: 'Glue-On / Application Supplies', name: 'Alcohol wipes', unit: 'box' },
  { category: 'Glue-On / Application Supplies', name: 'Adhesive primers', unit: 'bottle' },

  // Casting & Therapeutic
  { category: 'Casting & Therapeutic', name: 'Hoof casting tape', unit: 'roll' },
  { category: 'Casting & Therapeutic', name: 'Fiberglass casting material', unit: 'roll' },
  { category: 'Casting & Therapeutic', name: 'Impression putty', unit: 'kit' },
  { category: 'Casting & Therapeutic', name: 'Dental impression material', unit: 'kit' },
  { category: 'Casting & Therapeutic', name: 'Sole packing', unit: 'container' },
  { category: 'Casting & Therapeutic', name: 'Foam board', unit: 'sheet' },
  { category: 'Casting & Therapeutic', name: 'Felt', unit: 'sheet' },
  { category: 'Casting & Therapeutic', name: 'Therapeutic wedges', unit: 'pair' },

  // Cleaning & Prep
  { category: 'Cleaning & Prep', name: 'Wire brushes', unit: 'each' },
  { category: 'Cleaning & Prep', name: 'Disposable brushes', unit: 'pack' },
  { category: 'Cleaning & Prep', name: 'Shop towels', unit: 'roll' },
  { category: 'Cleaning & Prep', name: 'Paper towels', unit: 'roll' },
  { category: 'Cleaning & Prep', name: 'Cleaning rags', unit: 'pack' },
  { category: 'Cleaning & Prep', name: 'Degreaser', unit: 'bottle' },
  { category: 'Cleaning & Prep', name: 'Disinfectant', unit: 'bottle' },
  { category: 'Cleaning & Prep', name: 'Hand cleaner', unit: 'bottle' },
  { category: 'Cleaning & Prep', name: 'Hoof-cleaning products', unit: 'bottle' },

  // PPE / Disposable Supplies
  { category: 'PPE / Disposable Supplies', name: 'Disposable gloves', unit: 'box', common: true },
  { category: 'PPE / Disposable Supplies', name: 'Dust masks', unit: 'box' },
  { category: 'PPE / Disposable Supplies', name: 'Respirator cartridges', unit: 'pair' },
  { category: 'PPE / Disposable Supplies', name: 'Safety-glasses lenses', unit: 'each' },
  { category: 'PPE / Disposable Supplies', name: 'Ear plugs', unit: 'box' },
  { category: 'PPE / Disposable Supplies', name: 'First-aid supplies', unit: 'kit' },
  { category: 'PPE / Disposable Supplies', name: 'Bandages', unit: 'box' },
  { category: 'PPE / Disposable Supplies', name: 'Gauze', unit: 'box' },
  { category: 'PPE / Disposable Supplies', name: 'Athletic / vet wrap', unit: 'roll', common: true },

  // Marking & Miscellaneous
  { category: 'Marking & Miscellaneous', name: 'Marking chalk', unit: 'each' },
  { category: 'Marking & Miscellaneous', name: 'Paint markers', unit: 'each' },
  { category: 'Marking & Miscellaneous', name: 'Permanent markers', unit: 'each' },
  { category: 'Marking & Miscellaneous', name: 'Layout dye', unit: 'bottle' },
  { category: 'Marking & Miscellaneous', name: 'Zip ties', unit: 'pack' },
  { category: 'Marking & Miscellaneous', name: 'Electrical tape', unit: 'roll' },
  { category: 'Marking & Miscellaneous', name: 'Duct tape', unit: 'roll' },
  { category: 'Marking & Miscellaneous', name: 'Lubricants', unit: 'can' },
  { category: 'Marking & Miscellaneous', name: 'Penetrating oil', unit: 'can' },
  { category: 'Marking & Miscellaneous', name: 'Tool oil', unit: 'can' },
  { category: 'Marking & Miscellaneous', name: 'Anti-seize compound', unit: 'container' },
];

// Case/spacing-insensitive name+size key used to grey out catalog items the farrier
// already has (generic entries have no size, so they match on name alone).
window.inventoryCatalogKey = (name, size) =>
  [name, size].map(s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ')).join('|');

// Firestore fields for a new inventoryItems doc copied from a catalog entry. Callers add
// farrierId + timestamps. Everything in this catalog is a consumable (low-stock alerts
// on); stock only auto-deducts once the farrier maps it to a service themselves.
window.inventoryItemFromCatalog = (entry) => ({
  name: entry.name, category: entry.category, brand: '', size: '', unit: entry.unit,
  quantityOnHand: 0, reorderThreshold: 0, costPerUnit: 0,
  isConsumable: true, isActive: true, notes: '', source: 'catalog',
});

// ── Supply catalog ──
// supply-catalog.json holds public product facts from a farrier supply retailer
// (built by scripts/supply-catalog/). The supplier is deliberately not named in the app
// (names, brands, category paths, sizes, part numbers — no prices, descriptions or
// images; farriers enter their own cost). ~230 KB, so it's fetched only when the picker opens, then memoized.
// Shape: { retrieved, products: [{ t: title, b: brand, c: 'Top > Sub', u: unit,
//          tool?: 1, v: [[size, partNumber], ...] }] }
let supplyCatalogPromise = null;
window.loadSupplyCatalog = () => {
  if (!supplyCatalogPromise) {
    supplyCatalogPromise = fetch('/supply-catalog.json')
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .catch(err => { supplyCatalogPromise = null; throw err; });
  }
  return supplyCatalogPromise;
};

// Case-insensitive match on name, brand, category or any part number.
window.supplyCatalogProductMatches = (product, q) =>
  !q || (product.t + ' ' + product.b + ' ' + product.c + ' ' + product.v.map(v => v[1]).join(' '))
    .toLowerCase().includes(q);

// Firestore fields for one supply-catalog size. Cost starts at 0 — the catalog carries
// no prices; farriers enter what they actually pay.
window.inventoryItemFromSupplyCatalog = (product, variant) => {
  const [size, partNumber] = variant;
  return {
    name: product.t, category: product.c.split(' > ')[0], brand: product.b || '', size: size || '',
    unit: product.u || 'each', quantityOnHand: 0, reorderThreshold: 0, costPerUnit: 0,
    isConsumable: !product.tool, isActive: true,
    notes: partNumber ? `Part #${partNumber}` : '',
    supplierSku: partNumber || '', source: 'supply-catalog',
  };
};
