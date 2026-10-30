#!/usr/bin/env python3
"""
build_offline.py

Packages α Alpha Miner (Excalibur.js + KII Dual-Ledger + Coelestis OST)
into a self-contained offline payload (`build/payload.bin` and `build/version.h`) for
the Windows x64 Chrome standalone launcher (`launcher.c`).
"""

from pathlib import Path
import re
import struct
import hashlib
import zlib
import json

root = Path(__file__).resolve().parent
docs_dir = root.parent
build_dir = root / 'build'
game_dir = build_dir / 'game'

build_dir.mkdir(exist_ok=True)
game_dir.mkdir(exist_ok=True)

# 1. Read index.html and src/main.ts to generate offline utility CSS for dynamic classes
index_html = (root / 'index.html').read_text(encoding='utf-8')
main_ts = (root / 'src/main.ts').read_text(encoding='utf-8')

# Only generate utility rules for dynamic classes in main_ts not already defined in index.html
classes = set()
for m in re.findall(r'class="([^"]*)"', main_ts):
    classes.update(m.split())
for m in re.findall(r"className\s*=\s*(?:[\n\s]*['\"]([^'\"]*)['\"]|\s*[^;]+\?\s*['\"]([^'\"]*)['\"]\s*:\s*['\"]([^'\"]*)['\"])", main_ts):
    for group in m:
        if group:
            classes.update(group.split())

semantic_classes = set(re.findall(r'\.([a-zA-Z0-9_-]+)', index_html))
utility_classes = sorted(
    [c for c in classes if c not in semantic_classes],
    key=lambda x: ('sm:' in x or 'lg:' in x, ':' in x, x)
)

colors = {
    'slate-200': 'e2e8f0', 'slate-300': 'cbd5e1', 'slate-400': '94a3b8', 'slate-500': '64748b',
    'slate-700': '334155', 'slate-800': '1e293b', 'slate-900': '0f172a', 'slate-950': '020617',
    'amber-50': 'fffbeb', 'amber-100': 'fef3c7', 'amber-200': 'fde68a', 'amber-300': 'fcd34d',
    'amber-400': 'fbbf24', 'amber-500': 'f59e0b', 'amber-600': 'd97706', 'amber-700': 'b45309',
    'orange-400': 'fb923c', 'orange-500': 'f97316',
    'sky-200': 'bae6fd', 'sky-300': '7dd3fc', 'sky-400': '38bdf8', 'sky-500': '0ea5e9',
    'emerald-300': '6ee7b7', 'emerald-400': '34d399', 'emerald-500': '10b981',
    'rose-400': 'fb7185', 'rose-500': 'f43f5e', 'rose-950': '4c0519',
    'white': 'ffffff'
}

def color(v):
    name, _, opacity = v.partition('/')
    h = colors[name]
    if not opacity:
        return '#' + h
    rgb = ','.join(str(int(h[i:i+2], 16)) for i in (0, 2, 4))
    return f'rgb({rgb},{int(opacity)/100})'

fixed = {
    'absolute': 'position:absolute', 'relative': 'position:relative',
    'flex': 'display:flex', 'inline-block': 'display:inline-block', 'inline': 'display:inline',
    'grid': 'display:grid', 'hidden': 'display:none', 'block': 'display:block',
    'flex-col': 'flex-direction:column', 'flex-row': 'flex-direction:row', 'flex-wrap': 'flex-wrap:wrap',
    'flex-1': 'flex:1 1 0%', 'flex-initial': 'flex:0 1 auto', 'shrink-0': 'flex-shrink:0',
    'items-center': 'align-items:center', 'items-stretch': 'align-items:stretch',
    'justify-center': 'justify-content:center', 'justify-between': 'justify-content:space-between',
    'justify-stretch': 'justify-content:stretch',
    'w-full': 'width:100%', 'h-full': 'height:100%',
    'text-center': 'text-align:center', 'uppercase': 'text-transform:uppercase',
    'whitespace-nowrap': 'white-space:nowrap', 'leading-none': 'line-height:1',
    'leading-tight': 'line-height:1.25', 'border': 'border-width:1px;border-style:solid',
    'border-2': 'border-width:2px;border-style:solid'
}
for k, v in {'lg': '.5rem', 'xl': '.75rem', '2xl': '1rem', '3xl': '1.5rem', 'full': '9999px'}.items():
    fixed['rounded-' + k] = 'border-radius:' + v
for k, v in {'semibold': 600, 'bold': 700, 'extrabold': 800, 'black': 900}.items():
    fixed['font-' + k] = 'font-weight:' + str(v)
for k, v in {'tight': '-.025em', 'wide': '.025em', 'wider': '.05em', 'widest': '.1em'}.items():
    fixed['tracking-' + k] = 'letter-spacing:' + v
for k, v in {
    'xs': ('.75rem', '1rem'), 'sm': ('.875rem', '1.25rem'), 'base': ('1rem', '1.5rem'),
    'lg': ('1.125rem', '1.75rem'), 'xl': ('1.25rem', '1.75rem'), '2xl': ('1.5rem', '2rem'),
    '3xl': ('1.875rem', '2.25rem'), '4xl': ('2.25rem', '2.5rem')
}.items():
    fixed['text-' + k] = f'font-size:{v[0]};line-height:{v[1]}'
for k, v in {
    'sm': '0 1px 2px 0', 'md': '0 4px 6px -1px', 'lg': '0 10px 15px -3px',
    'xl': '0 20px 25px -5px', '2xl': '0 25px 50px -12px', 'inner': 'inset 0 2px 4px 0'
}.items():
    fixed['shadow-' + k] = 'box-shadow:' + v + ' var(--shadow-color,rgb(0,0,0,.25))'
for k in ('transition', 'transition-all', 'transition-opacity', 'transition-transform'):
    fixed[k] = 'transition-property:all;transition-duration:150ms'

def rule(c):
    if c in fixed:
        return fixed[c]
    if c.startswith('text-['):
        return 'font-size:' + c[6:-1]
    for prefix, prop in [('text-', 'color'), ('bg-', 'background-color'), ('border-', 'border-color'), ('shadow-', '--shadow-color')]:
        if c.startswith(prefix) and c[len(prefix):].split('/')[0] in colors:
            return prop + ':' + color(c[len(prefix):])
    m = re.fullmatch(r'(p[xytrbl]?|m[xytrbl]?|gap|w|h|top)-(\d+(?:\.\d+)?)', c)
    if m:
        p, n = m.groups()
        v = str(float(n) * 0.25) + 'rem'
        if p in ('gap', 'w', 'h', 'top'):
            return {'gap': 'gap', 'w': 'width', 'h': 'height', 'top': 'top'}[p] + ':' + v
        prop = 'padding' if p[0] == 'p' else 'margin'
        sides = {'': [''], 'x': ['-left', '-right'], 'y': ['-top', '-bottom'], 't': ['-top'], 'b': ['-bottom'], 'l': ['-left'], 'r': ['-right']}[p[1:]]
        return ';'.join(prop + side + ':' + v for side in sides)
    raise ValueError(f'Unhandled utility class: {c}')

extra_css_lines = ['    /* Dynamic utility classes used by main.ts */']
for c in utility_classes:
    parts = c.split(':')
    base = parts[-1]
    variants = parts[:-1]
    selector = '.' + re.sub(r'([^a-zA-Z0-9_-])', r'\\\1', c)
    selector += ''.join(':' + v for v in variants if v in ('hover', 'active'))
    r = f'    {selector} {{ {rule(base)}; }}'
    extra_css_lines.append(r)

extra_css = '\n'.join(extra_css_lines)

# Inject extra utility CSS and offline metadata + CSP into index.html
packaged_html = index_html.replace('  </style>', extra_css + '\n  </style>')
head_meta = (
    '  <meta name="application-name" content="α Alpha Miner">\n'
    '  <meta name="theme-color" content="#0b0914">\n'
    '  <link rel="icon" type="image/x-icon" href="icon.ico">\n'
    '  <link rel="manifest" href="manifest.webmanifest">\n'
    '  <meta http-equiv="Content-Security-Policy" content="default-src \'self\' data:; script-src \'self\' \'unsafe-inline\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data:; media-src \'self\' data:; manifest-src \'self\'; connect-src \'none\'">\n'
    '</head>'
)
packaged_html = packaged_html.replace('</head>', head_meta)

# 2. Render multi-resolution Windows ICO (32x32, 48x48 DIB + 256x256 PNG)
def render_icon_rgba(size):
    buf = bytearray(size * size * 4)
    for y in range(size):
        ny = (y + 0.5) / size * 2.0 - 1.0
        for x in range(size):
            nx = (x + 0.5) / size * 2.0 - 1.0
            idx = (y * size + x) * 4
            d = max(abs(nx), abs(ny), (abs(nx) + abs(ny)) * 0.74)
            if d > 0.94:
                continue
            if d > 0.82:
                r, g, b, a = 245, 158, 11, 255
            else:
                r, g, b, a = 15, 23, 42, 255
            ox, oy = nx - 0.22, ny - 0.22
            if abs(ox) + abs(oy) < 0.34:
                r, g, b = 52, 211, 153
                if ox + oy < 0:
                    r, g, b = 110, 231, 183
            u = (nx - ny) * 0.7071
            v = (nx + ny) * 0.7071
            if abs(u) < 0.09 and -0.62 < v < 0.48:
                r, g, b = 180, 83, 9
                if u < 0:
                    r, g, b = 217, 119, 6
            if 0.12 < v < 0.46 and abs(u) < 0.56:
                curve = 0.34 - 0.55 * (u * u)
                if abs(v - curve) < 0.11:
                    r, g, b = (253, 224, 71) if u < 0 else (245, 158, 11)
            buf[idx:idx+4] = bytes((r, g, b, a))
    return bytes(buf)

def make_png(size, rgba):
    raw = bytearray()
    stride = size * 4
    for y in range(size):
        raw.append(0)
        raw.extend(rgba[y * stride:(y + 1) * stride])
    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(bytes(raw), 9)) + chunk(b'IEND', b'')

def make_bmp_dib(size, rgba):
    xor_mask = bytearray()
    for y in range(size - 1, -1, -1):
        for x in range(size):
            i = (y * size + x) * 4
            r, g, b, a = rgba[i:i+4]
            xor_mask.extend((b, g, r, a))
    and_row_bytes = ((size + 31) // 32) * 4
    and_mask = bytes(and_row_bytes * size)
    bih = struct.pack('<IIIHHIIIIII', 40, size, size * 2, 1, 32, 0, len(xor_mask) + len(and_mask), 0, 0, 0, 0)
    return bih + bytes(xor_mask) + and_mask

def make_ico():
    dib32 = make_bmp_dib(32, render_icon_rgba(32))
    dib48 = make_bmp_dib(48, render_icon_rgba(48))
    png256 = make_png(256, render_icon_rgba(256))
    entries = [(32, 32, dib32), (48, 48, dib48), (0, 0, png256)]
    header = struct.pack('<HHH', 0, 1, len(entries))
    offset = 6 + 16 * len(entries)
    dir_entries = bytearray()
    payload = bytearray()
    for w, h, data in entries:
        dir_entries.extend(struct.pack('<BBBBHHII', w, h, 0, 0, 1, 32, len(data), offset))
        payload.extend(data)
        offset += len(data)
    return header + bytes(dir_entries) + bytes(payload)

ico_bytes = make_ico()
manifest = json.dumps({
    "name": "α Alpha Miner",
    "short_name": "Alpha Miner",
    "description": "α Alpha Miner standalone Chrome desktop game.",
    "start_url": "./index.html",
    "display": "fullscreen",
    "background_color": "#0b0914",
    "theme_color": "#0b0914",
    "icons": [{"src": "icon.ico", "sizes": "32x32 48x48 256x256", "type": "image/x-icon"}]
}, indent=2).encode('utf-8')

# 3. Prepare dist/bundle.js with self-contained relative paths inside the unpacked folder
raw_bundle = (root / 'dist/bundle.js').read_text(encoding='utf-8')
packaged_bundle = (
    raw_bundle
    .replace("'../bg'", "'./bg'")
    .replace('"../bg"', '"./bg"')
    .replace('`../bg${', '`./bg${')
    .replace("'../bg", "'./bg")
    .replace('"../bg', '"./bg')
    .replace("'../Coelestis/ogg'", "'./Coelestis/ogg'")
    .replace('"../Coelestis/ogg"', '"./Coelestis/ogg"')
)

excalibur_bytes = (root / 'vendor/excalibur.min.js').read_bytes()

# 4. Assemble all payload files (62 with the boss sprite strips)
files = [
    ('index.html', packaged_html.encode('utf-8')),
    ('icon.ico', ico_bytes),
    ('manifest.webmanifest', manifest),
    ('vendor/excalibur.min.js', excalibur_bytes),
    ('dist/bundle.js', packaged_bundle.encode('utf-8')),
]

# Add all 28 sprite sheets in deterministic sorted order
sprite_paths = sorted((root / 'assets/sprites').rglob('*.png'))
for sp in sprite_paths:
    rel = sp.relative_to(root).as_posix()
    files.append((rel, sp.read_bytes()))

# Add all 10 background images (bg1.png .. bg10.png)
for i in range(1, 11):
    bg_path = docs_dir / f'bg{i}.png'
    files.append((f'bg{i}.png', bg_path.read_bytes()))

# Add all 7 Murderface Records "Coelestis" OGG tracks
coelestis_tracks = [
    "Tess' Dream.ogg",
    "Valence.ogg",
    "Seahorse.ogg",
    "Ascent.ogg",
    "6th death.ogg",
    "DFD.ogg",
    "The Chemist - Outro.ogg"
]
for track_name in coelestis_tracks:
    track_path = docs_dir / 'Coelestis' / 'ogg' / track_name
    files.append((f'Coelestis/ogg/{track_name}', track_path.read_bytes()))

# Write staged files to build/game/ and pack into build/payload.bin
blob = bytearray()
for name, data in files:
    dest = game_dir / name
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    name_bytes = name.encode('utf-8') + b'\0'
    blob.extend(struct.pack('<II', len(name_bytes), len(data)))
    blob.extend(name_bytes)
    blob.extend(data)

blob.extend(struct.pack('<II', 0, 0))
payload_bytes = bytes(blob)
(build_dir / 'payload.bin').write_bytes(payload_bytes)

version = hashlib.sha256(payload_bytes).hexdigest()[:12]
(build_dir / 'version.h').write_text(f'#define CONTENT_VERSION L"{version}"\n', encoding='utf-8')

print(f'Bundled {len(files)} files, {len(payload_bytes):,} bytes, version {version}; {len(utility_classes)} utility styles.')
