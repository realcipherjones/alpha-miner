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
  - The first 2 boss fights of each run are always Bone Crusher, whichever badge triggered them; YesChef can
    spawn from the 3rd fight on. This rule is in source (`BOSS_DOG_ONLY_FIGHTS`), but not in the packaged exe yet.
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

## Replay and payouts (in progress)

- The simulation runs at a fixed 60 Hz with a seeded RNG, and records player inputs. Seed + inputs reproduce a
  run exactly (`src/scenes/RunReplay.ts`). Visual effects stay on `Math.random`; anything that affects gameplay must use
  `this.rng`, anything that reads time must use `simTick`, and gameplay math must use `DetMath.ts` (Chrome and Node
  differ in the last digit of `Math.sin`). Bump `REPLAY_VERSION` when gameplay changes.
- Verifier: `node tools/replay_run.mjs` (log JSON on stdin, outcome on stdout). Pay from its `cashOuts`, and reject logs
  with `debug` set, a `startBalanceRaw` the server didn't expect, or a seed the server didn't issue.
- Tests: `node tools/test_replay.mjs` (bot play on uneven frames, forged logs) and
  `node tools/test_replay_chrome.mjs` (record in real Chrome, verify in Node). Both need `node build.mjs` first.
- Every run starts with an empty bank and no free lobs. Only KII earned in that verified run can be paid.
- Payout service: `server/` (see `server/README.md`). Running at https://miner.murderfacerecords.com on the game box.
  Release v0.99b-alpha. Dry-run until the operator runs `server/deploy/go_live.sh`.

## Tools

- **Re-slice sprites:**
  - Dog: `python3 tools/slice_boss_sheet.py dog <sheet> --frames 4,4,4,3,2,2 --mirror deflect:3`
  - Son: `python3 tools/slice_boss_sheet.py son <sheet> --frames 4,3,4,3,3,2`
  - Prompts and full instructions are in `assets/reference/BOSS_SPRITE_PROMPTS.md`.
- **Boss balance sim:** `node tools/sim_boss_fights.mjs [stage] [fights] [startKii] [jumpSkill]`
- **Bundle:** `node build.mjs` (node lives at
  `~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`)

## To do before release

- Rebuild the exe: source has dropped the reset (button, R, Start), Play Again and the playtest
  skip (button, Back), so the packaged exe is out of date. A new run from the game-over screen is the
  only restart left.

## Optional polish (not requested yet)

- Floor spikes draw over the boss's feet.
- The son's hurt animation includes a sitting frame.
- A higher-resolution son sheet would look sharper.
