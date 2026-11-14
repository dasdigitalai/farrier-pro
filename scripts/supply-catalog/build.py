"""Turn fd_products.jsonl (from pull.py) into ../../supply-catalog.json.

Refresh the catalog:  python pull.py && python build.py
(pull takes ~1 hour; delete fd_list.json and fd_products.jsonl first to re-fetch
everything — otherwise pull resumes and skips products it already has)."""
import json, re, os, collections, datetime

DIR = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(DIR, '..', '..', 'supply-catalog.json')
R = [json.loads(l) for l in open(os.path.join(DIR, 'fd_products.jsonl'), encoding='utf-8')]

ADHESIVES = 'Adhesives & Packing'
# Subcategories whose parent is hidden from the public category tree.
HIDDEN_PARENT = {
    'Knives': 'Tools', 'Nippers': 'Tools', 'Shoe Pullers': 'Tools', 'Hoof Stands': 'Tools',
    'Pritchel': 'Tools', 'Punch': 'Tools', 'Sharpener': 'Tools',
}
# Tools/equipment: tracked in the "Tools" section (no low-stock alerts).
TOOL_TOPS = {'Tools', 'Forging', 'Grinders & Buffers', 'Aprons / Chaps', 'Shoeing Boxes',
             'Protective Gear', 'Apparel', 'Trailers & Accessories'}
CONSUMABLE_SUBS = {('Forging', 'Bar Stock'), ('Forging', 'Inserts & Tabs')}

KEYWORDS = [  # for products with no category at all
    (ADHESIVES, r'equilox|hooflox|vettec|shubond|adhesive|glue(?!shu)|shusil|hoof cushion|cast\b|equicast|farrier\'s choice|md-420|hoof putty'),
    ('Nails', r'\bnails?\b'),
    ('Abrasives', r'flap dis|sanding belt'),
    ('Shoes', r'\bpr\b|swedge|glushu|victory|\bssp\b|standard, pr|open performance|heart bar|\bdf \d|hanton|ortho kit|stud'),
    ('Tools', r'hammer|pein|blurton|anvil|gouge|drill|\bbit\b|grinder|maverick|tool|stand|tray|handle|pull off|rebuild'),
    ('Hoof and Animal Care', r'beeswax|hoof cleanser'),
]

def category_of(r):
    if not r['categories']:
        t = r['title'].lower()
        for cat, rx in KEYWORDS:
            if re.search(rx, t): return [cat]
        return ['Other']
    path = [p for p in r['categories'][0]]
    if path[0] == '':
        rest = [p for p in path if p]
        top = HIDDEN_PARENT.get(rest[0]) or HIDDEN_PARENT.get(rest[-1]) or ADHESIVES
        return [top] + [p for p in rest if p != top]
    return path

def unit_of(title):
    t = title.lower()
    if re.search(r',\s*pr\b|\bpair\b|, pr ', t): return 'pair'
    m = re.search(r'(\d+)\s*pack|pack of (\d+)|box of (\d+)', t)
    if m: return 'pack'
    if re.search(r'\bbox\b', t): return 'box'
    return 'each'

def clean_size(v):
    # Variant labels come through as 'Size : 6 (0)', '"Color: Black","Size: 0"' or
    # 'Shape: 15 / Default / N 1.5' -> strip option labels and 'Default' fillers.
    parts = re.findall(r'"([^"]*)"', v) or [v]
    bits = []
    for p in parts:
        for b in p.split(' / '):
            b = re.sub(r'^[A-Za-z][A-Za-z ]{1,20}\s*:\s*', '', b.strip()).strip()
            if b and b.lower() != 'default': bits.append(b)
    return ' / '.join(bits) or 'Default'

# Categories left out of the app entirely.
EXCLUDED_TOPS = {'Apparel'}

out, cats = [], collections.Counter()
for r in R:
    path = category_of(r)
    top = path[0]
    if top in EXCLUDED_TOPS: continue
    sub = path[1] if len(path) > 1 else ''
    tool = top in TOOL_TOPS and (top, sub) not in CONSUMABLE_SUBS
    variants = []
    for v in r['variants']:
        size = clean_size(v['title'])
        variants.append([size if size != 'Default' else '', v.get('code') or v.get('sku') or ''])
    if not variants:
        variants = [['', '']]
    title = re.sub(r',\s*pr\.?$', '', r['title'], flags=re.I).strip()
    # The supplier is not named anywhere in the app — drop its house-brand label too.
    brand = '' if re.search(r'farriers?.?\s*depot', r['brand'] or '', re.I) else r['brand']
    rec = {'t': title, 'b': brand, 'c': ' > '.join(path), 'u': unit_of(r['title']), 'v': variants}
    if tool: rec['tool'] = 1
    out.append(rec)
    cats[top] += 1

out.sort(key=lambda x: (x['c'], x['t'].lower()))
doc = {
    'source': 'supplier',
    'retrieved': datetime.date.today().isoformat(),
    'note': 'Names, brands, categories, sizes and part numbers only.',
    'products': out,
}
json.dump(doc, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
print(len(out), 'products,', sum(len(p['v']) for p in out), 'sellable items,', os.path.getsize(OUT)//1024, 'KB')
for k, v in cats.most_common(): print(f'{v:5} {k}')
print('Other:', [p['t'] for p in out if p['c'] == 'Other'])
