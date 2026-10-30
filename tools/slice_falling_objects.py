"""
slice_falling_objects.py

Cuts "Fantasy Blacksmithing Assets Sprite Sheet.png" into the falling object
images the game loads from assets/sprites/objects/ (128x128, 2x game res, object
centre = canvas centre, base resting on the bottom of the hit circle):

  anvil.png  boulder.png  cart.png  keg.png  keg_lit.png  cart_wheel.png

  python3 tools/slice_falling_objects.py ["/path/to/sheet.png"]

Sheet layout: top row anvil, boulder, cart, keg; bottom row wheel, lit keg (the
lit keg is drawn smaller and is scaled to match the keg). The wheel's see-through
gaps are filled so the spinning overlay fully hides the cart's painted wheels.
Also writes src/actors/FallingObjectSpriteMeta.ts with the cart wheel positions.

Requires Pillow, numpy and scipy.
"""

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as nd

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SHEET = ROOT.parent / 'Fantasy Blacksmithing Assets Sprite Sheet.png'
OUT_DIR = ROOT / 'assets' / 'sprites' / 'objects'
META_TS = ROOT / 'src' / 'actors' / 'FallingObjectSpriteMeta.ts'

SIZE = 128
# name -> (stored width, bottom row). Bottom row = 64 + 2 * hit radius.
TARGETS = {
    'anvil': (96, 108),
    'boulder': (92, 110),
    'cart': (86, 108),
    'keg': (64, 104),
}
# Painted cart wheels in the sheet: centre x, centre y, radius (sheet px)
CART_WHEELS_SHEET = [(1080, 485, 72), (1304, 485, 72)]
WHEEL_HUB_FILL = (38, 30, 32, 255)


def blobs(rgba: np.ndarray) -> list[tuple[np.ndarray, tuple[int, int, int, int]]]:
    """Large opaque blobs with nearby specks (sparks, fuse embers) merged in."""
    lab, n = nd.label(rgba[:, :, 3] > 60)
    sizes = nd.sum(np.ones(lab.shape), lab, range(1, n + 1))
    big = [i + 1 for i, s in enumerate(sizes) if s >= 10000]
    masks = {i: lab == i for i in big}
    centres = {i: np.argwhere(masks[i]).mean(axis=0) for i in big}
    for i in range(1, n + 1):
        if i in masks or sizes[i - 1] < 3:
            continue
        c = np.argwhere(lab == i).mean(axis=0)
        masks[min(big, key=lambda j: np.hypot(*(centres[j] - c)))] |= lab == i
    out = []
    for i in big:
        grown = nd.binary_dilation(masks[i], iterations=3)
        ys, xs = np.nonzero(grown)
        out.append((grown, (xs.min(), ys.min(), xs.max() + 1, ys.max() + 1)))
    return out


def cut(sheet: np.ndarray, mask: np.ndarray, box: tuple[int, int, int, int]) -> Image.Image:
    img = sheet.copy()
    img[~mask] = 0
    x0, y0, x1, y1 = box
    return Image.fromarray(img[y0:y1, x0:x1])


def place(img: Image.Image, scale: float, bottom_row: int) -> tuple[Image.Image, int, int]:
    """Scales img, centres it horizontally and puts its base on bottom_row."""
    scaled = img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)
    ox = (SIZE - scaled.width) // 2
    oy = bottom_row - scaled.height
    if oy < 0 or scaled.width > SIZE:
        print(f'warning: clipped ({scaled.width}x{scaled.height})')
    out = Image.new('RGBA', (SIZE, SIZE))
    out.alpha_composite(scaled, (max(ox, 0), max(oy, 0)), (max(-ox, 0), max(-oy, 0)))
    return out, ox, oy


def main() -> None:
    sheet = np.array(Image.open(Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SHEET).convert('RGBA'))
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    found = blobs(sheet)
    top = sorted([b for b in found if b[1][1] < 400], key=lambda b: b[1][0])
    bottom = sorted([b for b in found if b[1][1] >= 400], key=lambda b: b[1][0])
    named = dict(zip(['anvil', 'boulder', 'cart', 'keg'], top)) | dict(zip(['wheel', 'keg_lit'], bottom))

    scales = {}
    for name, (width, bottom_row) in TARGETS.items():
        mask, box = named[name]
        img = cut(sheet, mask, box)
        scales[name] = width / img.width
        out, ox, oy = place(img, scales[name], bottom_row)
        out.save(OUT_DIR / f'{name}.png', optimize=True)
        if name == 'cart':
            cart_box, cart_origin = box, (ox, oy)
        print(f'{name}.png')

    # Lit keg: drawn smaller in the sheet; match the keg's barrel width (its fuse flame adds height)
    mask, box = named['keg_lit']
    img = cut(sheet, mask, box)
    barrel_rows = np.array(img)[img.height // 2:, :, 3] > 60
    barrel_width = np.ptp(np.nonzero(barrel_rows.any(axis=0))[0]) + 1
    keg_mask, keg_box = named['keg']
    keg_barrel = (np.array(cut(sheet, keg_mask, keg_box))[(keg_box[3] - keg_box[1]) // 2:, :, 3] > 60)
    keg_barrel_width = np.ptp(np.nonzero(keg_barrel.any(axis=0))[0]) + 1
    out, _, _ = place(img, scales['keg'] * keg_barrel_width / barrel_width, TARGETS['keg'][1])
    out.save(OUT_DIR / 'keg_lit.png', optimize=True)
    print('keg_lit.png')

    # Cart wheel overlay: gaps filled, sized to just cover a painted wheel
    mask, box = named['wheel']
    wheel = cut(sheet, mask, box)
    filled = Image.new('RGBA', wheel.size)
    ImageDraw.Draw(filled).ellipse([4, 4, wheel.width - 5, wheel.height - 5], fill=WHEEL_HUB_FILL)
    filled.alpha_composite(wheel)
    wheel_px = round(2 * CART_WHEELS_SHEET[0][2] * scales['cart']) + 2
    filled.resize((wheel_px, wheel_px), Image.LANCZOS).save(OUT_DIR / 'cart_wheel.png', optimize=True)
    print('cart_wheel.png')

    # Wheel centres relative to the object centre, in game px (stored / 2)
    wheels = [
        [round((cart_origin[0] + (cx - cart_box[0]) * scales['cart'] - SIZE / 2) / 2, 1),
         round((cart_origin[1] + (cy - cart_box[1]) * scales['cart'] - SIZE / 2) / 2, 1)]
        for cx, cy, _ in CART_WHEELS_SHEET
    ]
    META_TS.write_text(
        '/**\n'
        ' * FallingObjectSpriteMeta.ts\n'
        ' * GENERATED by tools/slice_falling_objects.py - do not edit by hand.\n'
        ' * Cart wheel overlay centres (game px from the object centre) and wheel size.\n'
        ' */\n\n'
        f'export const CART_WHEEL_CENTERS: number[][] = {json.dumps(wheels)};\n'
        f'export const CART_WHEEL_SIZE = {wheel_px / 2};\n'
    )
    print(f'wrote {META_TS.relative_to(ROOT)}')


if __name__ == '__main__':
    main()
