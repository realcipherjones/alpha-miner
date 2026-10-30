# α Alpha Miner

A dwarf-mining pickaxe-lobbing game built on [Excalibur.js](https://excaliburjs.com/). Lob your
axe at the ore, earn KII, dodge the birds, and survive two boss fights: **Bone Crusher**, a
60 lb Staffordshire terrier, and **YesChef**, a chef with a whip of a braid.

## Play on Windows

1. Install [Google Chrome](https://www.google.com/chrome/) if it isn't already installed.
   The game runs as a Chrome standalone app.
2. Download **`Alpha Miner.exe`** from the
   [latest release](https://github.com/realcipherjones/alpha-miner/releases/latest).
3. Run it. Windows SmartScreen may warn about an unrecognised app (the exe isn't
   code-signed): click **More info → Run anyway**.
4. The installer adds **Alpha Miner** shortcuts to your Desktop and Start Menu.

## Controls

| Action | Keyboard | Gamepad |
|---|---|---|
| Aim angle | ↑ / ↓ | D-pad ↑ / ↓ or right stick ↕ |
| Aim power | ← / → | Right stick ↔ |
| Lob the axe | Space, F or Enter | X, B or RT (A outside boss fights) |
| Step between ledges | A / D | D-pad ← / → or left stick |
| Jump (boss fights) | W | A |
| Aim presets | — | LB (high) / RB (ore) |
| Toggle aim guide | — | Y |
| Reset the stage | R | Start |

The mouse also aims: drag to set the angle and power.

## Bosses

Clear a map's 7 KII goal and keep scoring. The overkill badge decides what happens next:

- **+10 (green): Bone Crusher.** He returns fire from a play bow and tail-whips 7.55% of
  your axes back at you.
- **+15 (purple): YesChef.** Arms crossed and grinning, he hair-whips 15% of your axes
  back at you.

Land 10 hits to win. A hit you take, including from your own swatted-back axe, knocks out
1 KII. Boss-fight lobs are free through stage 150.

## Building from source

The build expects the background art (`bg1.png` to `bg10.png`) and the soundtrack
(`Coelestis/ogg/`) in the parent folder. Those aren't in this repo.

```sh
node build.mjs          # bundles src/ into dist/bundle.js
node test_bundle.mjs    # headless game tests
./build_exe.sh          # packages "Alpha Miner.exe" (needs gcc + binutils for the Windows target)
```

### Tools

- `tools/slice_boss_sheet.py` slices a green-screen sprite sheet into boss animation
  strips. See `assets/reference/BOSS_SPRITE_PROMPTS.md`.
- `tools/sim_boss_fights.mjs` simulates boss fights for balance testing.

## Credits

The soundtrack is "Coelestis" by Murderface Records.
