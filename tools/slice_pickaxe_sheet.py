"""
slice_pickaxe_sheet.py

Cuts the GPT-generated "Twin Cel-Shaded Fantasy Pickaxes.png" (plain pickaxe on
the left, glinting copy on the right) into the images the game loads from
assets/sprites/pickaxe/:

  pickaxe.png        128x128  thrown pickaxe (2x game resolution), head up
  pickaxe_glint.png  128x128  same with a blade highlight, flashed once per spin

  python3 tools/slice_pickaxe_sheet.py ["/path/to/sheet.png"]

The canvas centre is the spin point: on the handle just below the head, so the
heavy head swings around it instead of the pickaxe wobbling about empty space.

Requires Pillow, numpy and scipy.
"""

import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage as nd

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SHEET = ROOT.parent / 'Twin Cel-Shaded Fantasy Pickaxes.png'
OUT_DIR = ROOT / 'assets' / 'sprites' / 'pickaxe'

SIZE = 128
HEAD_WIDTH = 96       # stored px across the head
# Spin point as a fraction of the pickaxe's bounding box (x centre, just below the head collar)
PIVOT = (0.5, 0.38)


def pickaxe_bboxes(rgba: np.ndarray) -> list[tuple[int, int, int, int]]:
    """Bounding boxes of the two pickaxes, left to right."""
    lab, n = nd.label(rgba[:, :, 3] > 100)
    objs = nd.find_objects(lab)
    sizes = nd.sum(np.ones(lab.shape), lab, range(1, n + 1))
    biggest = sorted(np.argsort(sizes)[-2:], key=lambda i: objs[i][1].start)
    return [(objs[i][1].start, objs[i][0].start, objs[i][1].stop, objs[i][0].stop) for i in biggest]


def main() -> None:
    sheet = Image.open(Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SHEET).convert('RGBA')
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    for name, (x0, y0, x1, y1) in zip(('pickaxe', 'pickaxe_glint'), pickaxe_bboxes(np.array(sheet))):
        src = sheet.crop((x0 - 4, y0 - 4, x1 + 4, y1 + 4))
        scale = HEAD_WIDTH / (x1 - x0)
        src = src.resize((round(src.width * scale), round(src.height * scale)), Image.LANCZOS)
        pivot_x = (4 + (x1 - x0) * PIVOT[0]) * scale
        pivot_y = (4 + (y1 - y0) * PIVOT[1]) * scale
        ox, oy = round(SIZE / 2 - pivot_x), round(SIZE / 2 - pivot_y)
        if ox < 0 or oy < 0 or ox + src.width > SIZE or oy + src.height > SIZE:
            print(f'warning: {name}.png clipped')
        out = Image.new('RGBA', (SIZE, SIZE))
        out.alpha_composite(src, (max(ox, 0), max(oy, 0)), (max(-ox, 0), max(-oy, 0)))
        out.save(OUT_DIR / f'{name}.png', optimize=True)
        print(f'{name}.png')


if __name__ == '__main__':
    main()
