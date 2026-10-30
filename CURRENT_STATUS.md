# Alpha Miner: where we left off (2026-10-29)

## State of the builds

`Alpha Miner.exe` is packaged and current as of 2026-10-29 (SHA256 `02f3e946…`). It includes:
- the 5 s stage-clear countdown (the countdown after beating a boss is still 3 s; should it be 5 s too?)
- the son boss triggering at +15 overkill, with the badge turning purple at +15
- the boss names **Bone Crusher** (dog) and **YesChef** (son), set in `src/scenes/BossFight.ts`

To package: `./build_exe.sh`. The launcher tests expect 63 files (`test_launcher.c`).

## What's in the game now (already in the exe)

- **Bosses:**
  - Bone Crusher, the dog (green, +10), and YesChef, the son (purple, +15), both with real sprites cut from
    the GPT green-screen sheet.
  - That sheet is archived at `assets/reference/boss_sheet_gpt.png`. The strips are in
    `assets/sprites/boss/`.
- **Deflects:**
  - The son hair-whips 15% of axes and the dog tail-whips 7.55%.
  - A whipped-back axe flies with bird-shield physics and costs 1 KII if it hits the dwarf.
- **Jump:** the dwarf can jump in boss fights (A on the gamepad, W on the keyboard). The
  platformer jump code and art are deliberately kept.
- **Free lobs:**
  - Boss-fight lobs are free through stage 150. That gives three cash-out chances
    (50/100/150) where the player nets positive KII.
  - After 150, normal fees return and the game is meant to effectively end.
  - Post-150 difficulty is intended, not a bug.

## Tools

- **Re-slice sprites:**
  - Dog: `python3 tools/slice_boss_sheet.py dog <sheet> --frames 4,4,4,3,2,2 --mirror deflect:3`
  - Son: `python3 tools/slice_boss_sheet.py son <sheet> --frames 4,3,4,3,3,2`
  - Prompts and full instructions are in `assets/reference/BOSS_SPRITE_PROMPTS.md`.
- **Boss balance sim:** `node tools/sim_boss_fights.mjs [stage] [fights] [startKii] [jumpSkill]`
- **Bundle:** `node build.mjs` (node lives at
  `~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`)

## To do before release

- Remove the playtest skip: the 🧪 Skip Stage button (`btnPlaytestSkip`),
  `skipToNextMilestone` and the gamepad Back hook.

## Optional polish (not requested yet)

- Floor spikes draw over the boss's feet.
- The son's hurt animation includes a sitting frame.
- A higher-resolution son sheet would look sharper.
- A playtest shortcut to jump straight into each boss fight.
