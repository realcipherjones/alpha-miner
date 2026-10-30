# Alpha Miner boss sprite sheets

Two sheets: the dog and the son. Attach reference photos of the dog and the son (kept outside the repo) as reference
images, plus `assets/sprites/dwarf/dwarf_idle.png` so the style matches the dwarf.

When a sheet comes back, slice it into the game:

```
python3 tools/slice_boss_sheet.py dog "path/to/dog sheet.png" --preview /tmp/dog_check.png
python3 tools/slice_boss_sheet.py son "path/to/son sheet.png" --preview /tmp/son_check.png
```

Then rebuild (`./build_exe.sh`). The slicer finds the rows and frames on its own, keys out
the background, scales the boss to its hitbox, and puts its feet on the ground line. If
the boss faces right, add `--flip`. If a row is missing, pass `--rows` with the names
that are there, in order, e.g. `--rows idle,throw,deflect,jump`. Idle is the only
required row. Any missing animation falls back to idle.

## Rules for both sheets

- One animation per row, frames left to right, in this row order:
  **idle, throw, deflect, jump, hurt, defeat**.
- The character **faces LEFT** in every frame.
- Clear gaps between frames and between rows. Nothing overlaps (tail, hair and the
  thrown object stay inside the frame's own space).
- **Plain flat chroma-green background (#00FF00)**. No scenery, no ground shadow, no
  text labels, no grid lines, no frame borders.
- Every frame stands on the same ground line, full body visible, same size from frame
  to frame (don't let later frames shrink).
- Match the dwarf: detailed HD pixel art (16-bit era, high resolution), chunky heroic
  proportions, dark outlines, warm torch-light from the upper left.

## Prompt: the dog

> Pixel art sprite sheet for a 2D game boss, matching the attached dwarf sprite's style
> (detailed HD 16-bit pixel art, dark outlines, warm torch lighting from the upper left).
> The character is a **muscular 60 lb Staffordshire bull terrier**, based on the attached
> photos: **solid black coat with a slight brindle sheen, a white blaze on the chest, white
> toes, a pink collar with a round tag, rose ears, a broad blocky head, a pink tongue**,
> and a thin whip-like tail. Playful but powerful, a "bone-breaker" build. The dog faces
> LEFT in every frame.
>
> Six rows on a flat pure chroma-green (#00FF00) background, no text, no shadows, no
> scenery, wide gaps between frames:
> 1. **Idle (4 frames):** classic dog play bow. Front legs flat on the ground, chest low,
>    butt high in the air, tail up and wagging side to side, tongue out, eager eyes.
> 2. **Fetch / throw (3 frames):** still in the play bow, the head dips, the jaws open
>    wide, and a round grey stone boulder drops out of the mouth, as if returning a ball.
> 3. **Tail whip (3 frames):** tail swings hard forward over the back like a whip (with a
>    motion arc), then snaps back. The body stays in the bow.
> 4. **Jump (3 frames):** crouch, airborne leap with legs tucked, landing.
> 5. **Hurt (2 frames):** flinch, ears pinned back, eyes squeezed.
> 6. **Defeated (2 frames):** flops over, rolls belly-up, tongue out, happy.

## Prompt: the son

> Pixel art sprite sheet for a 2D game boss, matching the attached dwarf sprite's style
> (detailed HD 16-bit pixel art, dark outlines, warm torch lighting from the upper left).
> The character is a **big, broad-shouldered young man**, based on the attached photos:
> **long brown hair pulled back into a long braided ponytail, a full brown beard, a huge
> cocky grin**. He wears a **crisp white double-breasted chef's jacket with dark buttons,
> black chef pants, black work shoes**, and a **modern white chef's skull cap, a snug,
> slightly squared-off beanie-style chef hat** (NOT a tall paper toque and NOT a French
> pastry hat). He faces LEFT in every frame.
>
> Six rows on a flat pure chroma-green (#00FF00) background, no text, no shadows, no
> scenery, wide gaps between frames:
> 1. **Idle (4 frames):** classic fighting-game boss stance. Feet planted wide, arms
>    crossed high on the chest, chin up, smug lopsided grin. The ponytail sways slightly.
> 2. **Throw (3 frames):** the front arm uncrosses, winds up overhead, and throws
>    underhand-to-overhead toward the left. Hand empty at release (the game draws the
>    thrown object).
> 3. **Hair whip (3 frames):** snaps his head so the long braided ponytail whips around
>    in front of him like a whip (with a motion arc), then settles back. Arms stay crossed.
> 4. **Jump (3 frames):** crouch, airborne with knees up and arms still crossed, landing.
> 5. **Hurt (2 frames):** knocked back a step, the grin drops, the chef cap is askew.
> 6. **Defeated (2 frames):** sits down hard on the floor, arms crossed, pouting.

## Tips

- If the generator won't do six rows at once, ask for one or two rows per image. Stack
  them top to bottom on one green canvas in the row order above, or run the slicer on each
  image with `--rows` naming what it contains. Each run replaces only the strips it names.
- Start with idle and deflect. Those are on screen the most.
- Check the `--preview` image: the red line is the ground and the blue line is the feet
  centre. Every frame should stand on the red line.
