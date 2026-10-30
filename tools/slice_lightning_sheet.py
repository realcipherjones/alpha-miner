"""
slice_lightning_sheet.py

Cuts "Neon Magenta Electric Arc Frames.png" (three electric ring frames side by
side) into the strip the flying pickaxe crackles with:

  assets/sprites/pickaxe/pickaxe_lightning.png   3 frames of 128x128 (2x game res)

  python3 tools/slice_lightning_sheet.py ["/path/to/sheet.png"]

Each source frame sits on a dark purple disc. Brightness is folded into alpha so
the disc vanishes and only the glowing arcs remain; the game draws the strip
with additive blending, centred on the pickaxe's spin point.

Requires Pillow and numpy.
"""

import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SHEET = ROOT.parent / 'Neon Magenta Electric Arc Frames.png'
OUT = ROOT / 'assets' / 'sprites' / 'pickaxe' / 'pickaxe_lightning.png'

FRAME = 128
RING = 124            # stored px across the ring
DARK_CUTOFF = 0.22    # brightness below this becomes fully transparent


def find_frames(alpha: np.ndarray) -> list[tuple[int, int]]:
    """Column spans of the frames, split on fully empty gaps."""
    cols = np.where((alpha > 20).any(axis=0))[0]
    spans, start = [], cols[0]
    for a, b in zip(cols, cols[1:]):
        if b - a > 8:
            spans.append((start, a + 1))
            start = b
    spans.append((start, cols[-1] + 1))
    return spans


def main() -> None:
    sheet = np.array(Image.open(Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SHEET).convert('RGBA'))
    rows = np.where((sheet[:, :, 3] > 20).any(axis=1))[0]
    y0, y1 = rows[0], rows[-1] + 1

    frames = []
    for x0, x1 in find_frames(sheet[:, :, 3]):
        rgba = sheet[y0:y1, x0:x1].astype(np.float32) / 255.0
        bright = rgba[:, :, :3].max(axis=2)
        alpha = rgba[:, :, 3] * np.clip((bright - DARK_CUTOFF) / (1 - DARK_CUTOFF), 0, 1)
        # Normalise colour to full brightness so additive blending glows rather than tints
        rgb = rgba[:, :, :3] / np.maximum(bright, 1e-3)[:, :, None]
        out = np.dstack([rgb, alpha]) * 255
        img = Image.fromarray(out.clip(0, 255).astype(np.uint8))

        side = max(img.size)
        square = Image.new('RGBA', (side, side))
        square.paste(img, ((side - img.width) // 2, (side - img.height) // 2))
        ring = square.resize((RING, RING), Image.LANCZOS)
        frame = Image.new('RGBA', (FRAME, FRAME))
        frame.paste(ring, ((FRAME - RING) // 2, (FRAME - RING) // 2))
        frames.append(frame)

    strip = Image.new('RGBA', (FRAME * len(frames), FRAME))
    for i, f in enumerate(frames):
        strip.paste(f, (i * FRAME, 0))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    strip.save(OUT, optimize=True)
    print(f'{OUT.name}: {len(frames)} frames')


if __name__ == '__main__':
    main()
