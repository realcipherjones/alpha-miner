# Alpha Miner: where we left off (2026-11-05)

## State of the builds

`Alpha Miner.exe` is v1.1 alpha (SHA256 `6b0864e692b0c00d246776815323130f9fdb2f840d378f6725b43e80ab865c23`): live and in playtesting, not gold. It's the v0.99b-alpha game
with only the music changed. The countdown after beating a boss is still 3 s, against 5 s after a stage; should it be
5 s too?

To package: `./build_exe.sh`. The launcher tests expect 65 files (`test_launcher.c`).

## What's in the game now

- **Bosses:**
  - Bone Crusher, the dog (green, +10), and YesChef, the son (purple, +15), both with real sprites cut from
    the GPT green-screen sheet.
  - The first 2 boss fights of each run are always Bone Crusher, whichever badge triggered them; YesChef can
    spawn from the 3rd fight on. This rule is `BOSS_DOG_ONLY_FIGHTS`.
  - That sheet is archived at `assets/reference/boss_sheet_gpt.png`. The strips are in
    `assets/sprites/boss/`.
- **Deflects:**
  - The son hair-whips 15% of axes and the dog tail-whips 7.55%.
  - A whipped-back axe flies with bird-shield physics and costs 1 KII if it hits the dwarf.
- **Jump:** the dwarf can jump in boss fights (A on the gamepad, W on the keyboard). The
  platformer jump code and art are deliberately kept.
- **Restart:** a new run from the game-over screen is the only restart.
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
  It's in `live` mode and pays real KII (`/api/leaderboard` reported this on 2026-11-05).
  v1.1 alpha didn't redeploy the server, so it still runs the v0.99b-alpha bundle. Gameplay didn't change, and
  replay logs matched and verified both ways between the two bundles. Sync the bundle on the next server deploy.

## Tools

- **Re-slice sprites:**
  - Dog: `python3 tools/slice_boss_sheet.py dog <sheet> --frames 4,4,4,3,2,2 --mirror deflect:3`
  - Son: `python3 tools/slice_boss_sheet.py son <sheet> --frames 4,3,4,3,3,2`
  - Prompts and full instructions are in `assets/reference/BOSS_SPRITE_PROMPTS.md`.
- **Boss balance sim:** `node tools/sim_boss_fights.mjs [stage] [fights] [startKii] [jumpSkill]`
- **Bundle:** `node build.mjs` (node lives at
  `~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`)

## Music

- Cues are in `src/audio/SoundEngine.ts`, using OGGs from `../GameMusic/ogg/` (21 MB, Vorbis q5). They're encoded
  from the WAV masters in `../GameMusic/wav/` (184 MB), rendered from the HTML studios in `~/Music`. The masters
  aren't packaged; keep them for the album release.
  - Each stage start: a random stage song, never the same twice in a row. If one ends mid-stage, another follows.
  - Bone Crusher: Sector 7. YesChef: Yes Chef. Both loop for the whole fight.
  - Credits: `playCreditsMusic()` plays Twin Valkyrie once. Nothing calls it until the credits exist.
- Song picks must stay on `Math.random`, never `this.rng`, or replays stop verifying.

## Optional polish (not requested yet)

- Floor spikes draw over the boss's feet.
- The son's hurt animation includes a sitting frame.
- A higher-resolution son sheet would look sharper.
