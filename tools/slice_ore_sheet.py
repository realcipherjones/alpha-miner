"""
slice_ore_sheet.py

Cuts the GPT-generated "Cel-Shaded Ore Sprite Sheet.png" into the mining node
images the game loads from assets/sprites/node/:

  node.png      256x256  ore rock (2x game resolution)
  node_hit.png  256x256  cracked rock shown briefly when the tosser target is hit
  sparkle.png    48x48   twinkle glint, placed and animated in code

  python3 tools/slice_ore_sheet.py ["/path/to/sheet.png"]

The rock is centred on the canvas (the node's hit centre in game). node_hit is
scaled identically and aligned on the same bottom-centre point so swapping the
two doesn't make the rock jump.

Requires Pillow, numpy and scipy.
"""

import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage as nd

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SHEET = ROOT / 'Cel-Shaded Ore Sprite Sheet.png'
OUT_DIR = ROOT / 'assets' / 'sprites' / 'node'

NODE_SIZE = 256
ROCK_WIDTH = 208     # stored px across the rock (104 game px at scale 1.0)
SPARKLE_SIZE = 48
SPARKLE_FIT = 44

# Sheet regions (sheet px); the labels below y=655 are excluded
NODE_REGION = (0, 0, 800, 655)
HIT_REGION = (800, 0, 1640, 655)
SPARKLE_REGION = (1690, 360, 1981, 650)


def main_body_bbox(rgba: np.ndarray) -> tuple[int, int, int, int]:
    """Bounding box of the largest opaque blob (the rock, without debris)."""
    lab, n = nd.label(rgba[:, :, 3] > 100)
    sizes = nd.sum(np.ones(lab.shape), lab, range(1, n + 1))
    ys, xs = nd.find_objects(lab)[int(np.argmax(sizes))]
    return xs.start, ys.start, xs.stop, ys.stop


def main() -> None:
    sheet = Image.open(Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SHEET).convert('RGBA')
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    node_src = sheet.crop(NODE_REGION)
    hit_src = sheet.crop(HIT_REGION)
    nx0, ny0, nx1, ny1 = main_body_bbox(np.array(node_src))
    scale = ROCK_WIDTH / (nx1 - nx0)

    # Anchor: the rock's bottom-centre lands where node.png's rock is centred on the canvas
    anchor_x = NODE_SIZE / 2
    anchor_y = NODE_SIZE / 2 + (ny1 - ny0) * scale / 2

    for name, src in (('node', node_src), ('node_hit', hit_src)):
        x0, y0, x1, y1 = main_body_bbox(np.array(src))
        scaled = src.resize((round(src.width * scale), round(src.height * scale)), Image.LANCZOS)
        ox = round(anchor_x - (x0 + x1) / 2 * scale)
        oy = round(anchor_y - y1 * scale)
        out = Image.new('RGBA', (NODE_SIZE, NODE_SIZE))
        out.alpha_composite(scaled, (max(ox, 0), max(oy, 0)), (max(-ox, 0), max(-oy, 0)))
        bbox = scaled.getbbox()
        if ox + bbox[0] < 0 or ox + bbox[2] > NODE_SIZE or oy + bbox[1] < 0 or oy + bbox[3] > NODE_SIZE:
            print(f'warning: {name}.png clipped')
        out.save(OUT_DIR / f'{name}.png', optimize=True)
        print(f'{name}.png')

    sparkle = sheet.crop(SPARKLE_REGION)
    sparkle = sparkle.crop(Image.fromarray((np.array(sparkle)[:, :, 3] > 10).astype(np.uint8) * 255).getbbox())
    fit = SPARKLE_FIT / max(sparkle.size)
    sparkle = sparkle.resize((round(sparkle.width * fit), round(sparkle.height * fit)), Image.LANCZOS)
    out = Image.new('RGBA', (SPARKLE_SIZE, SPARKLE_SIZE))
    out.alpha_composite(sparkle, ((SPARKLE_SIZE - sparkle.width) // 2, (SPARKLE_SIZE - sparkle.height) // 2))
    out.save(OUT_DIR / 'sparkle.png', optimize=True)
    print('sparkle.png')


if __name__ == '__main__':
    main()
