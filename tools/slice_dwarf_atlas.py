"""
slice_dwarf_atlas.py

Cuts the GPT-generated "Pixel Dwarf Animation Sprite Atlas.png" into the
horizontal frame strips the game loads from assets/sprites/dwarf/.

  python3 tools/slice_dwarf_atlas.py ["/path/to/atlas.png"]

Each output frame is FRAME x FRAME px, stored at 2x game resolution. Frames are
aligned so the ground line sits on row ANCHOR_Y and the kilt is centred on
column FRAME/2. Also writes src/actors/DwarfSpriteMeta.ts with frame counts and
per-frame head centres (used to place the space bubble helmet).

Requires Pillow, numpy and scipy.
"""

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage as nd

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_ATLAS = ROOT.parent / 'Pixel Dwarf Animation Sprite Atlas.png'
OUT_DIR = ROOT / 'assets' / 'sprites' / 'dwarf'
META_TS = ROOT / 'src' / 'actors' / 'DwarfSpriteMeta.ts'

FRAME = 256          # stored frame size (2x game pixels)
ANCHOR_Y = 244       # ground line row inside a stored frame
SCALE = 0.78         # atlas px -> stored px (game px = stored / 2)

# The atlas draws later run frames progressively smaller; rescale those frames
# so the head height matches the cycle's median and he doesn't pulse in size.
NORMALIZE_HEIGHT = {'run'}

# Ground (shadow) line of each atlas row band, in atlas px
GROUND = {'top': 259, 'mid': 604, 'bot': 949}
BANDS = {'top': (50, 268), 'mid': (335, 612), 'bot': (676, 960)}

# (animation, band, x0, x1) crops; run frames overlap so the cuts sit on the
# narrowest column between neighbours. Throw frame 3 in the atlas is only the
# flying pickaxe (the game spawns its own projectile), so it is skipped.
CROPS = [
    ('idle', 'top', 15, 197), ('idle', 'top', 197, 360), ('idle', 'top', 360, 545), ('idle', 'top', 538, 715),
    ('run', 'top', 727, 893), ('run', 'top', 893, 1013), ('run', 'top', 1013, 1157),
    ('run', 'top', 1157, 1285), ('run', 'top', 1285, 1390), ('run', 'top', 1390, 1532),
    ('jump', 'mid', 20, 222), ('jump', 'mid', 215, 410), ('jump', 'mid', 425, 612),
    ('throw', 'mid', 668, 906), ('throw', 'mid', 906, 1106), ('throw', 'mid', 1300, 1532),
    ('cheer', 'bot', 30, 252), ('cheer', 'bot', 252, 442), ('cheer', 'bot', 442, 650), ('cheer', 'bot', 650, 900),
]


def clean_frame(rgba: np.ndarray, ground_local: int) -> np.ndarray:
    """Hardens the soft glow, strips the bluish ground shadow, keeps the figure."""
    out = rgba.copy()
    a = out[:, :, 3].astype(np.float32)
    r, g, b = (out[:, :, i].astype(np.int32) for i in range(3))

    # Soft glow halo -> crisp edge
    a = np.clip((a - 70) * 255.0 / (170 - 70), 0, 255)

    # Ground shadow: bluish-grey pixels in the strip around the ground line
    rows = np.arange(out.shape[0])[:, None]
    shadow = (rows >= ground_local - 10) & (b > r + 3)
    a[shadow] = 0
    a[ground_local + 2:, :] = 0

    # Keep the main figure plus any sizeable attached piece (detached pickaxe parts)
    lab, n = nd.label(a > 0)
    if n:
        sizes = nd.sum(np.ones_like(a), lab, range(1, n + 1))
        keep = [i + 1 for i, s in enumerate(sizes) if s >= sizes.max() * 0.12]
        a[~np.isin(lab, keep)] = 0

    out[:, :, 3] = a.astype(np.uint8)
    out[out[:, :, 3] == 0] = 0
    return out


def kilt_center_x(rgba: np.ndarray) -> float:
    r, g, b, a = (rgba[:, :, i].astype(np.int32) for i in range(4))
    kilt = (a > 0) & (r > 110) & (g < 80) & (b < 70)
    ys, xs = np.nonzero(kilt)
    if len(xs) < 50:
        ys, xs = np.nonzero(a > 0)
    return float(xs.mean())


def head_center(rgba: np.ndarray) -> tuple[float, float]:
    """Head centre estimated from the magenta beard, which only the face has."""
    r, g, b, a = (rgba[:, :, i].astype(np.int32) for i in range(4))
    beard = (a > 0) & (r > 140) & (b > 70) & (b > g + 15) & (g < 120)
    ys, xs = np.nonzero(beard)
    top = np.percentile(ys, 5)
    upper = ys < top + (np.percentile(ys, 95) - top) * 0.5
    return float(xs[upper].mean()), float(top)


def main() -> None:
    atlas_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_ATLAS
    atlas = np.array(Image.open(atlas_path).convert('RGBA'))
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    cleaned = []
    for anim, band, x0, x1 in CROPS:
        y0, y1 = BANDS[band]
        crop = clean_frame(atlas[y0:y1, x0:x1], GROUND[band] - y0)
        cleaned.append((anim, band, y0, crop, head_center(crop)))

    head_height: dict[str, list[float]] = {}
    for anim, band, y0, crop, (hx, hy) in cleaned:
        head_height.setdefault(anim, []).append(GROUND[band] - y0 - hy)

    frames: dict[str, list[Image.Image]] = {}
    heads: dict[str, list[list[float]]] = {}
    for anim, band, y0, crop, (hx, hy) in cleaned:
        cx = kilt_center_x(crop)
        scale = SCALE
        if anim in NORMALIZE_HEIGHT:
            scale *= float(np.median(head_height[anim])) / (GROUND[band] - y0 - hy)

        src = Image.fromarray(crop)
        w, h = round(src.width * scale), round(src.height * scale)
        src = src.resize((w, h), Image.LANCZOS)

        # Place so kilt centre -> FRAME/2 and ground line -> ANCHOR_Y
        ox = round(FRAME / 2 - cx * scale)
        oy = round(ANCHOR_Y - (GROUND[band] - y0) * scale)
        frame = Image.new('RGBA', (FRAME, FRAME))
        frame.alpha_composite(src, (max(ox, 0), max(oy, 0)), (max(-ox, 0), max(-oy, 0)))

        bbox = Image.fromarray(crop).getbbox()
        if ox + bbox[0] * scale < 0 or ox + bbox[2] * scale > FRAME or oy + bbox[1] * scale < 0:
            print(f'warning: {anim} frame {len(frames.get(anim, []))} clipped')

        frames.setdefault(anim, []).append(frame)
        # Head centre relative to the in-game origin, in game px
        heads.setdefault(anim, []).append([
            round((ox + hx * scale - FRAME / 2) / 2, 1),
            round((oy + hy * scale - ANCHOR_Y) / 2, 1),
        ])

    for anim, imgs in frames.items():
        strip = Image.new('RGBA', (FRAME * len(imgs), FRAME))
        for i, img in enumerate(imgs):
            strip.paste(img, (i * FRAME, 0))
        strip.save(OUT_DIR / f'dwarf_{anim}.png', optimize=True)
        print(f'dwarf_{anim}.png: {len(imgs)} frames')

    counts = {anim: len(imgs) for anim, imgs in frames.items()}
    META_TS.write_text(
        '/**\n'
        ' * DwarfSpriteMeta.ts\n'
        ' * GENERATED by tools/slice_dwarf_atlas.py - do not edit by hand.\n'
        ' * Frame layout of the assets/sprites/dwarf/dwarf_<anim>.png strips, plus each\n'
        ' * frame\'s head centre for the space helmet (game px, relative to the ground point\n'
        ' * between the boot soles).\n'
        ' */\n\n'
        f'export const DWARF_SPRITE_FRAME_SIZE = {FRAME};\n'
        f'export const DWARF_SPRITE_ANCHOR_Y = {ANCHOR_Y};\n'
        f'export const DWARF_SPRITE_FRAME_COUNTS: Record<string, number> = {json.dumps(counts)};\n'
        f'export const DWARF_SPRITE_HEADS: Record<string, number[][]> = {json.dumps(heads)};\n'
    )
    print(f'wrote {META_TS.relative_to(ROOT)}')


if __name__ == '__main__':
    main()
