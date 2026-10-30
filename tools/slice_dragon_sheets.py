"""
slice_dragon_sheets.py

Cuts the pseudodragon sheets into the strips the game uses for birds:

  assets/sprites/bird/bird_flap.png     6 frames of 192x192 (2x game res), wingbeat loop
  assets/sprites/bird/bird_shatter.png  4 frames of 192x192, played once when a bird is killed

  python3 tools/slice_dragon_sheets.py [flight_sheet.png] [shatter_sheet.png]

Flight frames are aligned on the dragon's eye so the body holds still while the
wings beat; the canvas centre is the bird's hit centre. Shatter frames are
centred on their alpha mass and scaled so the intact dragon in frame 1 matches
the flying one. Both face left (the game mirrors them for right-flying birds).

Requires Pillow, numpy and scipy.
"""

import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage as nd

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_FLIGHT = ROOT.parent / 'Six-Frame Red Dragon Flight Cycle-1.png'
DEFAULT_SHATTER = ROOT.parent / 'Dragon Disintegration Sprite Sheet-2.png'
OUT_DIR = ROOT / 'assets' / 'sprites' / 'bird'

FRAME = 192
FLIGHT_SCALE = 0.30          # sheet px -> stored px; body ~110 stored (55 game) head to tail
EYE_TO_BODY = (62, 35)       # sheet px from the eye to the body centre (snout-to-tail midpoint)
SHATTER_SCALE = 0.27


def components_by_x(alpha: np.ndarray, min_px: int, threshold: int = 40) -> list[np.ndarray]:
    """Masks of the large blobs, left to right, each with nearby small debris merged in."""
    lab, n = nd.label(alpha > threshold)
    sizes = nd.sum(np.ones(lab.shape), lab, range(1, n + 1))
    big = [i + 1 for i, s in enumerate(sizes) if s >= min_px]
    centres = {i: np.nonzero(lab == i)[1].mean() for i in big}
    big.sort(key=lambda i: centres[i])
    masks = {i: lab == i for i in big}
    # Assign small pieces (sparks, flying scales) to the nearest big blob
    for i in range(1, n + 1):
        if i in masks or sizes[i - 1] < 4:
            continue
        cx = np.nonzero(lab == i)[1].mean()
        nearest = min(big, key=lambda j: abs(centres[j] - cx))
        masks[nearest] |= lab == i
    return [masks[i] for i in big]


def place(src: np.ndarray, mask: np.ndarray, scale: float, anchor: tuple[float, float]) -> Image.Image:
    """Cuts mask out of src, scales it, and puts sheet point `anchor` at the frame centre."""
    # Grow the mask a little so soft glow edges around each blob survive
    grown = nd.binary_dilation(mask, iterations=6)
    cut = src.copy()
    cut[~grown] = 0
    ys, xs = np.nonzero(grown)
    x0, y0, x1, y1 = xs.min(), ys.min(), xs.max() + 1, ys.max() + 1
    img = Image.fromarray(cut[y0:y1, x0:x1])
    img = img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)
    ox = round(FRAME / 2 - (anchor[0] - x0) * scale)
    oy = round(FRAME / 2 - (anchor[1] - y0) * scale)
    if ox < 0 or oy < 0 or ox + img.width > FRAME or oy + img.height > FRAME:
        print('warning: frame clipped')
    frame = Image.new('RGBA', (FRAME, FRAME))
    frame.alpha_composite(img, (max(ox, 0), max(oy, 0)), (max(-ox, 0), max(-oy, 0)))
    return frame


def save_strip(frames: list[Image.Image], name: str) -> None:
    strip = Image.new('RGBA', (FRAME * len(frames), FRAME))
    for i, f in enumerate(frames):
        strip.paste(f, (i * FRAME, 0))
    strip.save(OUT_DIR / name, optimize=True)
    print(f'{name}: {len(frames)} frames')


def main() -> None:
    flight_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_FLIGHT
    shatter_path = Path(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_SHATTER
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    flight = np.array(Image.open(flight_path).convert('RGBA'))
    r, g, b, a = (flight[:, :, i].astype(int) for i in range(4))
    eye = (a > 200) & (r > 200) & (g > 190) & (b < 140)
    frames = []
    for mask in components_by_x(flight[:, :, 3], 10000):
        ys, xs = np.nonzero(eye & mask)
        anchor = (xs.mean() + EYE_TO_BODY[0], ys.mean() + EYE_TO_BODY[1])
        frames.append(place(flight, mask, FLIGHT_SCALE, anchor))
    save_strip(frames, 'bird_flap.png')

    shatter = np.array(Image.open(shatter_path).convert('RGBA'))
    frames = []
    for mask in components_by_x(shatter[:, :, 3], 8000, threshold=10):
        weights = shatter[:, :, 3].astype(float) * mask
        ys, xs = np.nonzero(weights)
        w = weights[ys, xs]
        frames.append(place(shatter, mask, SHATTER_SCALE, ((xs * w).sum() / w.sum(), (ys * w).sum() / w.sum())))
    save_strip(frames, 'bird_shatter.png')


if __name__ == '__main__':
    main()
