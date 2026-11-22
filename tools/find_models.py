#!/usr/bin/env python3
"""Find downloadable, modification-friendly Sketchfab models for every car. Writes assets/cars/candidates.json.
Public search API only (no token needed)."""
import json, re, sys, time, urllib.parse, urllib.request, pathlib
ROOT = pathlib.Path(__file__).resolve().parent.parent
cars = json.loads(sys.stdin.read())  # [{id, make, model}] from node
OK = {'CC Attribution', 'CC0 Public Domain', 'CC Attribution-NonCommercial', 'CC Attribution-ShareAlike', 'CC Attribution-NonCommercial-ShareAlike', 'Free Standard'}
QUERY_FIX = {'miata_na': 'mazda miata na', 'miata_nd': 'mazda mx-5 nd', 'fd3s': 'mazda rx-7 fd', 'gr86': 'toyota gr86', 'brz_zc6': 'subaru brz',
  'a80': 'toyota supra mk4', 'a90': 'toyota supra gr a90', 'ae86': 'toyota ae86', 'grcorolla': 'gr corolla', 'z33': 'nissan 350z', 'z34': 'nissan 370z',
  's13': 'nissan 240sx s13', 's15': 'nissan silvia s15', 'r34': 'nissan skyline r34', 'r35': 'nissan gtr r35', 'fl5': 'civic type r fl5', 'eg6': 'honda civic eg',
  's2000': 'honda s2000', 'nsx_na1': 'honda nsx na1', 'dc2': 'integra type r dc2', 'evo9': 'lancer evolution ix', 'sti_gd': 'subaru impreza sti 2006',
  'wrx_vb': 'subaru wrx 2022', 's550gt': 'ford mustang gt 2018', 'gt350': 'shelby gt350', 'focusrs': 'ford focus rs', 'raptor': 'ford f-150 raptor',
  'c6z06': 'corvette c6 z06', 'c8': 'corvette c8', 'camaro_ss': 'camaro ss 2017', 'camaro69': '1969 camaro', 'hellcat': 'challenger hellcat',
  'viper_acr': 'viper acr', 'e30': 'bmw e30', 'e46m3': 'bmw m3 e46', 'g80': 'bmw m3 g80', 'gt3_991': 'porsche 911 gt3 991', 'gt4_718': 'cayman gt4',
  '944t': 'porsche 944', 'huracan_evo': 'huracan evo', 'r8v10': 'audi r8 v10', 'f488': 'ferrari 488', 'm720s': 'mclaren 720s', 'm3p': 'tesla model 3',
  'miata_nb': 'mazda mx-5 nb', 'miata_nc': 'mazda mx-5 nc', 'fc3s': 'mazda rx-7 fc', 'rx8': 'mazda rx-8', 'a70': 'toyota supra mk3', 's30': 'datsun 240z',
  's14': 'nissan silvia s14', 'z32': 'nissan 300zx', 'rz34': 'nissan z 2023', 'r32': 'nissan skyline r32', 'r33': 'nissan skyline r33', 'ek9': 'civic type r ek9',
  'fk8': 'civic type r fk8', 'dc5': 'integra dc5', 'nc1': 'acura nsx 2017', 'evo6': 'lancer evolution vi', 'evox': 'lancer evolution x', 'sti_gr': 'subaru impreza sti 2010 hatchback',
  'sti_va': 'subaru wrx sti 2018', 'fox': 'mustang fox body', 's197': 'ford mustang gt 2012', 's650': 'ford mustang 2024', 'c5z06': 'corvette c5', 'c7z06': 'corvette c7 z06',
  'camaro5': 'chevrolet camaro ss 2010', 'e36m3': 'bmw m3 e36', 'e92m3': 'bmw m3 e92', 'f80m3': 'bmw m3 f80', 'gt3_996': 'porsche 996 gt3', 'gt3_997': 'porsche 997 gt3',
  'gti_mk2': 'golf gti mk2', 'gti_mk5': 'golf gti mk5', 'viper_gts': 'dodge viper gts',
  'gti_mk7': 'golf gti mk7', 'golfr': 'golf r mk7', 'elantra_n': 'elantra n', 'elise_s2': 'lotus elise'}
KIT = re.compile(r'pandem|rocket ?bunny|liberty|lb[★\s-]|lbworks|widebody|wide ?body|veilside|drift|f&f|2f2f|tokyo|trofeo|super ?trofeo|race|racing|gt3 ?r\b|gtr e46|spider|convertible|cabrio|tribute|wrap|csr2|need for speed|nfs|custom|aimgain|varis|apr |bodykit|body kit|tuned|stance|rally|nismo gt|hoonigan|joker|copo|police|taxi|intake|engine', re.I)
BAD = re.compile(r'low ?poly|lowpoly|toy|lego|cartoon|wreck|destroyed|rusty|interior only|engine only|wheel only|rim|stylized|minecraft|voxel|police|drift ?trike', re.I)
out = {}
for c in cars:
    q = QUERY_FIX.get(c['id'], f"{c['make']} {c['model']}")
    url = 'https://api.sketchfab.com/v3/search?' + urllib.parse.urlencode({'type': 'models', 'downloadable': 'true', 'q': q, 'count': 24, 'sort_by': '-likeCount'})
    try:
        d = json.load(urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'TorqueForge-asset-finder'}), timeout=30))
    except Exception as e:
        print(c['id'], 'ERR', e); continue
    words = [w for w in re.split(r'\W+', q.lower()) if len(w) > 1]
    cands = []
    for m in d.get('results', []):
        lic = (m.get('license') or {}).get('label')
        faces = m.get('faceCount') or 0
        name = m['name']
        if lic not in OK or BAD.search(name) or not (25000 <= faces <= 2500000): continue
        hit = sum(w in name.lower() for w in words) / len(words)
        if hit < 0.34: continue
        score = hit * 3 + min(m.get('likeCount', 0), 2000) / 400 - (2.5 if KIT.search(name) else 0)
        if c['id'] == 'gt350' and re.search(r'196\d', name): continue
        thumbs = (m.get('thumbnails') or {}).get('images') or []
        thumb = min((t for t in thumbs if t.get('width', 0) >= 200), key=lambda t: t['width'], default={}).get('url')
        cands.append({'uid': m['uid'], 'name': name, 'license': lic, 'faces': faces, 'likes': m.get('likeCount', 0), 'author': m['user']['username'],
                      'url': m['viewerUrl'], 'score': round(score, 2), 'thumb': thumb})
    cands.sort(key=lambda x: -x['score'])
    out[c['id']] = cands[:4]
    best = cands[0] if cands else None
    print(f"{c['id']:12} {len(cands):2} cands  best: {best['name'][:45] if best else '-':45} {best['license'] if best else '':28} {best['faces'] if best else '':>8}")
    time.sleep(0.4)
prev = json.loads((ROOT / 'assets/cars/candidates.json').read_text()) if (ROOT / 'assets/cars/candidates.json').exists() else {}
prev.update(out)
(ROOT / 'assets/cars/candidates.json').write_text(json.dumps(prev, indent=1))
print('missing:', [k for k, v in out.items() if not v])
