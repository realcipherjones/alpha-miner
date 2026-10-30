"""
slice_boss_sheet.py

Cuts a generated boss sprite sheet into the strips the game loads from
assets/sprites/boss/ and regenerates src/scenes/BossSpriteMeta.ts.

  python3 tools/slice_boss_sheet.py dog  "/path/to/dog sheet.png"
  python3 tools/slice_boss_sheet.py son  "/path/to/son sheet.png" [--rows idle,throw,deflect,jump,hurt,defeat]
                                                                 [--flip] [--out DIR] [--preview FILE] [--ref-height PX]
                                                                 [--frames 4,3,4,3,3,2] [--mirror deflect:3]

Sheet layout (see assets/reference/BOSS_SPRITE_PROMPTS.md): one animation per row,
frames left to right, boss facing LEFT, on transparency or a flat solid background
(chroma green, or a fake "transparent" checkerboard - both get keyed out). Rows and
frames are found from the gaps between figures; when they touch, the rows are cut as a
grid and --frames gives the frame count of each row.

Every frame is scaled by the same factor (so the idle height matches the boss
hitbox) and placed with the lowest pixels on the ground row and the feet centred.
Stored at 2x game resolution, like the dwarf strips.

Requires Pillow, numpy and scipy.
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage as nd

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / 'assets' / 'sprites' / 'boss'
META_JSON = ROOT / 'tools' / 'boss_sprite_meta.json'
META_TS = ROOT / 'src' / 'scenes' / 'BossSpriteMeta.ts'

DEFAULT_ROWS = ['idle', 'throw', 'deflect', 'jump', 'hurt', 'defeat']

# Game hitbox height (px) of each boss (BOSS_DEFS in BossFight.ts) and stored frame size
BOSS = {
    'dog': {'height': 120, 'frame': 640},   # room for the belly-up roll
    'son': {'height': 258, 'frame': 1152},  # room for the braid whip / airborne braid
}
ANCHOR_PAD = 12  # ground row sits this far above the frame bottom


def key_background(rgba: np.ndarray) -> np.ndarray:
    """Alpha mask of the figures. Uses real alpha when present, else keys the border colours."""
    a = rgba[:, :, 3]
    if (a < 250).mean() > 0.05:
        return a >= 128
    rgb = rgba[:, :, :3].astype(np.int32)
    border = np.concatenate([rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]])
    # Up to two dominant border colours (solid background, or the two checkerboard greys)
    q = (border // 8) * 8
    colours, counts = np.unique(q, axis=0, return_counts=True)
    order = np.argsort(-counts)
    keys = [border[(q == colours[i]).all(axis=1)].mean(axis=0) for i in order[:2] if counts[i] > len(border) * 0.08]
    near = [np.abs(rgb - k).sum(axis=2) < 60 for k in keys]
    cand = np.logical_or.reduce(near) if near else np.zeros(a.shape, bool)
    r, g, b = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
    if any(kk[1] > 180 and kk[0] < 90 and kk[2] < 90 for kk in keys):
        # Chroma green can't be part of a boss: key it everywhere, including spill and the
        # darker green of painted-on ground shadows
        return ~(cand | ((g > 150) & (g > r + 60) & (g > b + 60)) | ((g > r + 35) & (g > b + 35)))
    # White/grey keys could also be chef whites: only remove background regions that touch
    # the sheet edge, or enclosed gaps that still show both checkerboard colours
    lab, n = nd.label(cand)
    edge = np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))
    bg = np.isin(lab, edge[edge > 0])
    if len(near) == 2 and n:
        sizes = nd.sum(cand, lab, range(1, n + 1))
        c0 = nd.sum(near[0] & ~near[1], lab, range(1, n + 1))
        c1 = nd.sum(near[1] & ~near[0], lab, range(1, n + 1))
        checker = np.flatnonzero((c0 >= sizes * 0.15) & (c1 >= sizes * 0.15)) + 1
        bg |= np.isin(lab, checker)
    return ~bg


def clean_mask(mask: np.ndarray) -> np.ndarray:
    """Drops specks and text: keeps components at least 2% of the largest one."""
    lab, n = nd.label(mask)
    if not n:
        return mask
    sizes = nd.sum(mask, lab, range(1, n + 1))
    keep = np.flatnonzero(sizes >= sizes.max() * 0.02) + 1
    return np.isin(lab, keep)


def spans(profile: np.ndarray, min_gap: int, min_len: int) -> list[tuple[int, int]]:
    """Runs of occupied rows/columns, merging gaps narrower than min_gap."""
    occ = np.flatnonzero(profile > 0)
    if not len(occ):
        return []
    out = [[occ[0], occ[0]]]
    for i in occ[1:]:
        if i - out[-1][1] <= min_gap:
            out[-1][1] = i
        else:
            out.append([i, i])
    return [(s, e + 1) for s, e in out if e + 1 - s >= min_len]


def grid_bands(mask: np.ndarray, n: int) -> list[np.ndarray]:
    """Splits figures into n rows when rows touch (a raised fist or braid crossing into the
    next row): cut lines go at the emptiest row near each 1/n of the height, and every
    connected figure joins the row holding its centre of mass, wherever its bits poke out."""
    occ = np.flatnonzero(mask.any(axis=1))
    top, bottom = occ[0], occ[-1] + 1
    pitch = (bottom - top) / n
    profile = mask.sum(axis=1)
    cuts = [top]
    for i in range(1, n):
        c = round(top + i * pitch)
        lo, hi = max(cuts[-1] + 1, c - round(pitch / 3)), min(bottom - 1, c + round(pitch / 3))
        cuts.append(lo + int(np.argmin(profile[lo:hi])))
    cuts.append(bottom)
    lab, count = nd.label(mask)
    centres = nd.center_of_mass(mask, lab, range(1, count + 1))
    out = [np.zeros_like(mask) for _ in range(n)]
    for i, (cy, _cx) in enumerate(centres):
        row = min(n - 1, max(0, int(np.searchsorted(cuts, cy, side='right')) - 1))
        out[row] |= lab == i + 1
    return out


def split_frames(band: np.ndarray, want: int | None, min_gap: int, min_len: int) -> list[tuple[int, int]]:
    """Column spans of the frames in a row. With a known count, splits touching frames at
    the emptiest column inside the widest span, or drops the smallest extra pieces."""
    profile = band.sum(axis=0)
    out = spans(profile, min_gap, min_len)
    if not want:
        return out
    while len(out) < want and out:
        i = max(range(len(out)), key=lambda k: out[k][1] - out[k][0])
        x0, x1 = out[i]
        inner = range(x0 + (x1 - x0) // 4, x1 - (x1 - x0) // 4)
        cut = min(inner, key=lambda x: profile[x])
        out[i:i + 1] = [(x0, cut), (cut, x1)]
    while len(out) > want:
        out.pop(min(range(len(out)), key=lambda k: profile[out[k][0]:out[k][1]].sum()))
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('kind', choices=sorted(BOSS))
    ap.add_argument('sheet')
    ap.add_argument('--rows', default=','.join(DEFAULT_ROWS), help='animation name per sheet row, top to bottom')
    ap.add_argument('--flip', action='store_true', help='mirror the sheet (if the boss faces right)')
    ap.add_argument('--out', default=str(OUT_DIR))
    ap.add_argument('--meta-json', default=str(META_JSON))
    ap.add_argument('--meta-ts', default=str(META_TS))
    ap.add_argument('--preview', help='write a contact sheet of the sliced frames here')
    ap.add_argument('--ref-height', type=float, help='sheet px height of a standing pose (defaults to the first idle frame)')
    ap.add_argument('--mirror', default='', help='frames drawn facing the wrong way, e.g. deflect:3,hurt:0 (0-based)')
    ap.add_argument('--frames', help='frames per row, e.g. 4,3,4,3,3,2 (needed when frames in a row touch)')
    args = ap.parse_args()

    spec = BOSS[args.kind]
    frame_size = spec['frame']
    anchor_y = frame_size - ANCHOR_PAD
    row_names = [r.strip() for r in args.rows.split(',') if r.strip()]

    img = Image.open(args.sheet).convert('RGBA')
    if args.flip:
        img = img.transpose(Image.FLIP_LEFT_RIGHT)
    rgba = np.array(img)
    mask = clean_mask(key_background(rgba))
    rgba[:, :, 3] = np.where(mask, 255, 0).astype(np.uint8)

    h, w = mask.shape
    frame_counts = [int(f) for f in args.frames.split(',')] if args.frames else [None] * len(row_names)
    if len(frame_counts) != len(row_names):
        sys.exit(f'error: --frames has {len(frame_counts)} counts for {len(row_names)} rows')
    bands = spans(mask.sum(axis=1), min_gap=max(4, h // 150), min_len=h // 40)
    if len(bands) == len(row_names):
        band_masks = []
        for y0, y1 in bands:
            bm = np.zeros_like(mask)
            bm[y0:y1] = mask[y0:y1]
            band_masks.append(bm)
    else:
        print(f'note: rows touch ({len(bands)} gaps found for {len(row_names)} rows); splitting as a grid')
        band_masks = grid_bands(mask, len(row_names))

    rows: dict[str, list[tuple[np.ndarray, np.ndarray]]] = {}
    for name, want, bm in zip(row_names, frame_counts, band_masks):
        for x0, x1 in split_frames(bm, want, min_gap=max(6, w // 120), min_len=w // 60):
            m = bm[:, x0:x1]
            ys, xs = np.nonzero(m)
            fy0, fy1, fx0, fx1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
            pix = rgba[fy0:fy1, x0 + fx0:x0 + fx1].copy()
            pix[:, :, 3] = np.where(m[fy0:fy1, fx0:fx1], 255, 0)  # only this row's figure
            rows.setdefault(name, []).append((pix, m[fy0:fy1, fx0:fx1]))

    if not rows:
        sys.exit('error: no figures found in the sheet')
    for spec_m in filter(None, (m.strip() for m in args.mirror.split(','))):
        name, idx = spec_m.split(':')
        pix, m = rows[name][int(idx)]
        rows[name][int(idx)] = (pix[:, ::-1].copy(), m[:, ::-1].copy())
    meta_path = Path(args.meta_json)
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
    if 'idle' not in rows and 'idle' not in meta.get(args.kind, {}).get('counts', {}):
        print('warning: no idle strip yet; the game keeps the placeholder art until one is sliced')

    # One scale for every frame: a standing pose's height -> hitbox height (2x stored)
    if args.ref_height:
        ref_h = args.ref_height
    elif 'idle' in rows:
        ref_h = rows['idle'][0][1].shape[0]
    else:
        first = next(iter(rows))
        ref_h = rows[first][0][1].shape[0]
        print(f'note: no idle row in this sheet; sizing from the first {first} frame '
              '(pass --ref-height with a standing pose height in sheet px if that is off)')
    scale = spec['height'] * 2 / ref_h
    print(f'{args.kind}: scale {scale:.3f} (sheet px -> stored px)')

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    counts: dict[str, int] = {}
    preview_rows = []
    for name, frames in rows.items():
        strip = Image.new('RGBA', (frame_size * len(frames), frame_size))
        for i, (pix, m) in enumerate(frames):
            src = Image.fromarray(pix)
            fw, fh = max(1, round(src.width * scale)), max(1, round(src.height * scale))
            if scale > 1:
                # Pixel art: blow up with hard edges first, then smooth down to size
                k = int(np.ceil(scale))
                src = src.resize((src.width * k, src.height * k), Image.NEAREST)
            src = src.resize((fw, fh), Image.LANCZOS)
            # Feet: centre of the lowest 20% of the figure's pixels
            ys, xs = np.nonzero(m)
            feet_x = xs[ys >= m.shape[0] * 0.8].mean() * scale
            ox = round(frame_size / 2 - feet_x)
            oy = anchor_y - fh
            if ox < 0 or ox + fw > frame_size or oy < 0:
                print(f'warning: {name} frame {i} is clipped ({fw}x{fh} stored px in a {frame_size} frame)')
            cell = Image.new('RGBA', (frame_size, frame_size))
            cell.alpha_composite(src, (max(ox, 0), max(oy, 0)), (max(-ox, 0), max(-oy, 0)))
            strip.paste(cell, (i * frame_size, 0))
        path = out_dir / f'{args.kind}_{name}.png'
        strip.save(path, optimize=True)
        counts[name] = len(frames)
        preview_rows.append(strip)
        print(f'{path.name}: {len(frames)} frames')

    # Merge into the shared meta (keeps the other boss's entry)
    # Merge per animation so a sheet with only some rows replaces just those strips
    prev = meta.get(args.kind, {}).get('counts', {})
    meta[args.kind] = {'frame': frame_size, 'anchorY': anchor_y, 'counts': {**prev, **counts}}
    meta_path.write_text(json.dumps(meta, indent=2) + '\n')
    Path(args.meta_ts).write_text(
        '/**\n'
        ' * BossSpriteMeta.ts\n'
        ' * GENERATED by tools/slice_boss_sheet.py - do not edit by hand.\n'
        ' * Frame layout of the assets/sprites/boss/<kind>_<anim>.png strips. Frames are stored at\n'
        ' * 2x game resolution; ANCHOR_Y is the ground row, and the feet sit on column FRAME/2.\n'
        ' * A kind with no idle strip here keeps the placeholder vector art.\n'
        ' */\n\n'
        'export const BOSS_SPRITE_META: Record<string, { frame: number; anchorY: number; counts: Record<string, number> }> = '
        f'{json.dumps(meta)};\n'
    )
    print(f'wrote {args.meta_ts}')

    if args.preview:
        cols = max(s.width for s in preview_rows)
        sheet = Image.new('RGBA', (cols, frame_size * len(preview_rows)), (40, 44, 52, 255))
        for r, s in enumerate(preview_rows):
            sheet.alpha_composite(s, (0, r * frame_size))
            for c in range(s.width // frame_size):  # ground line + feet column guides
                for x in range(c * frame_size, (c + 1) * frame_size):
                    sheet.putpixel((x, r * frame_size + anchor_y), (255, 80, 80, 255))
                for y in range(r * frame_size, (r + 1) * frame_size, 4):
                    sheet.putpixel((c * frame_size + frame_size // 2, y), (80, 160, 255, 255))
        sheet.thumbnail((1600, 1600))
        sheet.save(args.preview)
        print(f'preview: {args.preview}')


if __name__ == '__main__':
    main()
