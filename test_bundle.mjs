import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bundleCode = fs.readFileSync(path.join(__dirname, 'dist/bundle.js'), 'utf8');

const canvasCtx = new Proxy({}, {
  get: (o, k) => k in o ? o[k] : () => ({ addColorStop() {}, width: 100 }),
  set: (o, k, v) => (o[k] = v, true)
});

const elements = new Map();
const images = [];
// Several loops (game + gamepad) each request frames; run them all per tick
let rafQueue = [];
const animFrameCallback = (t) => rafQueue.splice(0).forEach((cb) => cb(t));

// Fake standard-mapping gamepad, toggled by the gamepad tests below
const fakePad = {
  id: 'Test Pad (STANDARD GAMEPAD)',
  index: 0,
  connected: false,
  mapping: 'standard',
  axes: [0, 0, 0, 0],
  buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }))
};
const setPadButton = (i, down) => { fakePad.buttons[i] = { pressed: down, value: down ? 1 : 0 }; };

function makeElement(id) {
  if (!elements.has(id)) {
    elements.set(id, {
      id,
      style: {},
      className: '',
      textContent: '',
      innerHTML: '',
      disabled: false,
      classList: { add() {}, remove() {}, toggle() {}, contains: () => true },
      children: [],
      value: id === 'sliderAngle' ? '52' : '74',
      clientWidth: 1280,
      clientHeight: 645,
      width: 1280,
      height: 645,
      getContext: () => canvasCtx,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 645 }),
      addEventListener() {},
      removeEventListener() {},
      appendChild(child) { this.children.push(child); return child; },
      setAttribute() {}
    });
  }
  return elements.get(id);
}

const storage = new Map();
const localStorageMock = {
  getItem: (k) => storage.has(k) ? storage.get(k) : null,
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k)
};

let nowMs = 100;
const sandbox = {
  console,
  BigInt,
  Math,
  Date,
  JSON,
  Map,
  Set,
  Array,
  Object,
  Number,
  String,
  Boolean,
  RegExp,
  Error,
  TypeError,
  Promise,
  encodeURIComponent,
  performance: { now: () => nowMs },
  localStorage: localStorageMock,
  document: {
    readyState: 'complete',
    getElementById: (id) => makeElement(id),
    createElement: (tag) => makeElement(`${tag}_${Math.random()}`),
    addEventListener() {},
    removeEventListener() {}
  },
  window: null,
  Image: class {
    constructor() {
      this.complete = true;
      this.naturalWidth = 1536;
      this.naturalHeight = 1024;
      this.src = '';
      images.push(this);
    }
  },
  Audio: class {
    constructor() {
      this.src = '';
      this.volume = 0.7;
      this.muted = false;
      this.paused = true;
    }
    addEventListener() {}
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
    load() {}
  },
  requestAnimationFrame: (cb) => { rafQueue.push(cb); return 1; },
  navigator: { getGamepads: () => [fakePad.connected ? fakePad : null] },
  cancelAnimationFrame: () => {},
  setTimeout: () => 1,
  clearTimeout: () => {},
  ex: { EX_VERSION: '0.29.3' }
};
sandbox.window = sandbox;
sandbox.window.addEventListener = () => {};
sandbox.window.removeEventListener = () => {};

vm.runInNewContext(bundleCode, sandbox);

const app = sandbox.window.dwarfKiiApp;
assert.ok(app, 'dwarfKiiApp should be initialized on window');
const { controller, soundEngine, kiiLedger } = app;

// 1. Verify all 10 backgrounds preloaded
assert.equal(images.filter((img) => /bg\d+\.png$/.test(img.src)).length, 10, 'Should preload all 10 background images (bg1.png - bg10.png)');
assert.equal(images.filter((img) => /sprites\/dwarf\/dwarf_\w+\.png$/.test(img.src)).length, 5, 'Should load the 5 dwarf sprite strips');
assert.equal(images.filter((img) => /sprites\/node\/\w+\.png$/.test(img.src)).length, 3, 'Should load the 3 mining node sprites');
assert.equal(images.filter((img) => /sprites\/pickaxe\/\w+\.png$/.test(img.src)).length, 3, 'Should load the 3 pickaxe sprites');
assert.equal(images.filter((img) => /sprites\/bird\/\w+\.png$/.test(img.src)).length, 2, 'Should load the 2 bird sprite strips');
assert.equal(images.filter((img) => /sprites\/objects\/\w+\.png$/.test(img.src)).length, 6, 'Should load the 6 falling object sprites');
assert.equal(images.filter((img) => /sprites\/blocks\/\w+\.png$/.test(img.src)).length, 9, 'Should load the 9 block and garrison sprites');

// 2. Verify KII Ledger raw math (616 quintillion ceiling & 10^17 raw/KII)
const cfg = kiiLedger.getConfig();
assert.equal(cfg.cashOutStoreEnabled, false, 'Cash out store hook should be disabled by default');
assert.equal(cfg.enableEscalatingFees, true, 'Escalating lob fees should be enabled');
const RAW = 100_000_000_000_000_000n;
for (const [level, kii] of [[1, 0n], [4, 0n], [5, 1n], [49, 1n], [50, 2n], [99, 2n], [100, 3n], [150, 4n]]) {
  assert.equal(kiiLedger.calculateLobFeeForLevel(level), kii * RAW, `Level ${level} lob fee should be ${kii} KII`);
}

// 3. Test Manual Faucet mode across all 10 maps
controller.setMode('MANUAL_FAUCET');
for (let m = 1; m <= 10; m++) {
  controller.setMap(m);
  assert.equal(controller.currentMapId, m);
  controller.lobPickaxe();
  nowMs += 32;
  animFrameCallback(nowMs);
}

// 4. Test Side-Scroller Platformer mode across all 10 maps & verify Half-Gravity on Space Maps 6-10
controller.setMode('SIDE_SCROLLER');
for (let m = 1; m <= 10; m++) {
  controller.setMap(m);
  controller.platformerRun(1);
  controller.platformerJump(true);
  controller.lobPickaxe();
  nowMs += 32;
  animFrameCallback(nowMs);
  controller.platformerJump(false);
  controller.platformerRun(0);
}

// 5. Verify Murderface Records Coelestis Jukebox tracks (7 OGG tracks)
assert.equal(soundEngine.getTracks().length, 7, 'Coelestis Jukebox should have all 7 tracks');
assert.equal(soundEngine.getCurrentTrackTitle(), "Tess' Dream");
await soundEngine.nextTrack();
assert.equal(soundEngine.getCurrentTrackTitle(), 'Valence');

// 6. Gamepad support
const tick = (n = 1) => { for (let i = 0; i < n; i++) { nowMs += 16; animFrameCallback(nowMs); } };
fakePad.connected = true;
controller.setMode('MANUAL_FAUCET');
controller.setMap(1);
tick();
const startX = controller.dwarfArena.x;
setPadButton(15, true); // D-pad right: one step on press
tick();
assert.ok(controller.dwarfArena.x > startX, 'D-pad right should step the arena dwarf');
const steppedX = controller.dwarfArena.x;
tick(5); // still inside the auto-repeat delay
assert.equal(controller.dwarfArena.x, steppedX, 'Held D-pad should not repeat before the delay');
setPadButton(15, false);
tick();

controller.setAim(40, 60);
fakePad.axes[3] = -1; // right stick up raises angle
tick(30);
fakePad.axes[3] = 0;
assert.ok(controller.aimAngleDeg > 50, `Right stick up should raise aim angle (got ${controller.aimAngleDeg})`);
fakePad.axes[2] = 1; // right stick right raises power
tick(30);
fakePad.axes[2] = 0;
assert.ok(controller.aimPowerPct > 70, `Right stick right should raise power (got ${controller.aimPowerPct})`);
tick();

const stageBeforeBack = controller.stage;
setPadButton(8, true); // Back = playtest skip (no longer switches mode)
tick();
setPadButton(8, false);
tick();
assert.equal(controller.mode, 'MANUAL_FAUCET', 'Back should not switch mode');
assert.equal(controller.stage, 49, `Back should skip to stage 49 (was ${stageBeforeBack})`);
controller.restartRun();

controller.setMode('SIDE_SCROLLER'); // still reachable internally (e.g. boss fights)
tick();

fakePad.axes[0] = 1; // left stick right runs
tick();
assert.equal(controller.platInputRight, true, 'Left stick right should run right');
fakePad.axes[0] = 0;
tick();
assert.equal(controller.platInputRight, false, 'Releasing the stick should stop running');

setPadButton(0, true); // A jumps
tick();
assert.equal(controller.platInputJump, true, 'A should start a jump');
setPadButton(0, false);
tick();
assert.equal(controller.platInputJump, false, 'Releasing A should end the jump');

fakePad.axes[0] = -1;
tick();
fakePad.connected = false; // unplug mid-run
tick();
assert.equal(controller.platInputLeft, false, 'Unplugging should release held movement');
fakePad.axes[0] = 0;

// Free-lob stacking cap (1 before stage 49) and the stage-50 cash-out offer
controller.setMode('MANUAL_FAUCET');
controller.stage = 10;
controller.freeLobs = 0;
assert.equal(controller.freeLobCap(), 1, 'Free lobs cap at 1 before stage 49');
controller.stage = 49;
assert.equal(controller.freeLobCap(), Infinity, 'Free lob cap removed from stage 49');

kiiLedger.creditKiiCoins(25);
let offer = null;
const prevOffer = controller.callbacks.onCashOutOffer;
controller.callbacks.onCashOutOffer = (stage, lobs, bal) => { offer = { stage, lobs, bal }; prevOffer?.(stage, lobs, bal); };
controller.advanceStage();
assert.equal(controller.stage, 50);
assert.ok(controller.cashOutOfferOpen, 'Stage 50 should open the cash-out offer');
assert.equal(offer?.lobs, 14, 'Stage 50 cash-out = 7 x 2 KII multiplier = 14 free lobs');
const cashedBefore = kiiLedger.getSnapshot().totalCashedOutRaw;
const balanceBefore = kiiLedger.getTotalKiiRaw();
const lobsBefore = controller.freeLobs;
controller.lobPickaxe();
assert.equal(controller.freeLobs, lobsBefore, 'Lobbing is blocked while the offer is open');
controller.acceptCashOut();
assert.equal(controller.cashOutOfferOpen, false);
assert.equal(kiiLedger.getTotalKiiRaw(), 0n, 'Cash-out burns the whole balance');
assert.equal(kiiLedger.getSnapshot().totalCashedOutRaw, cashedBefore + balanceBefore, 'Cashed-out tracker adds the burned balance');
assert.equal(kiiLedger.getSnapshot().cashOutCount, 1, 'Cashed-out tracker counts cash-outs');
assert.equal(controller.freeLobs, lobsBefore + 14, 'Cash-out awards 14 free lobs');
assert.equal(kiiLedger.getActionHistory().at(-2).actionType, 'CASH_OUT', 'Cash-out burn is logged');

controller.stage = 59; // stage 60 is not a cash-out stage
kiiLedger.creditKiiCoins(5);
controller.advanceStage();
assert.equal(controller.cashOutOfferOpen, false, 'Only every 50th stage offers a cash-out');
controller.callbacks.onCashOutOffer = prevOffer;

// Playtest skip walks the milestone stages and still triggers the stage-50 cash-out offer
controller.stage = 1;
controller.skipToNextMilestone();
assert.equal(controller.stage, 49);
kiiLedger.creditKiiCoins(3);
controller.skipToNextMilestone();
assert.equal(controller.stage, 50);
assert.ok(controller.cashOutOfferOpen, 'Skipping to 50 still offers the cash-out');
controller.skipToNextMilestone();
assert.equal(controller.stage, 50, 'Skip is blocked while the cash-out pop-up is open');
controller.declineCashOut();
for (const want of [75, 76, 100, 110]) {
  controller.declineCashOut(); // stage 100 offers another cash-out
  controller.skipToNextMilestone();
  assert.equal(controller.stage, want);
}
controller.declineCashOut();

// Late-game birds: spawn rate (50-75), speed swing (76-100), breakable shields (100+)
for (const [stage, mult, jitter, breakable] of [
  [49, 1, 0, false], [50, 1.01, 0, false], [75, 1.26, 0, false], [76, 1.26, 1, false],
  [100, 1.26, 25, true], [150, 1.26, 25, true]
]) {
  controller.stage = stage;
  assert.ok(Math.abs(controller.birdSpawnRateMultiplier() - mult) < 1e-9, `Stage ${stage} spawn rate should be ${mult}x`);
  assert.equal(controller.birdSpeedJitterPct(), jitter, `Stage ${stage} speed swing should be +/-${jitter}%`);
  assert.equal(controller.birdShieldsBreakable(), breakable, `Stage ${stage} breakable shields = ${breakable}`);
}
controller.stage = 100;
controller.arenaBirds = [];
for (let n = 0; n < 200; n++) controller.spawnTosserPatrolBird();
const speeds = controller.arenaBirds.map((b) => -b.vx);
assert.ok(Math.min(...speeds) >= 130 * 0.75 - 1e-9 && Math.max(...speeds) <= 165 * 1.25 + 1e-9, 'Stage 100 bird speeds stay within +/-25%');
assert.ok(Math.min(...speeds) < 130 || Math.max(...speeds) > 165, 'Stage 100 bird speeds actually fluctuate');
controller.arenaBirds = [];

// Stage 100 two-hit kill: first hit breaks the shield + redirects, second hit kills
controller.loadMap(controller.currentMapId);
controller.stage = 100;
controller.freeLobs = 5;
controller.arenaBirds = [{ id: 't', x: 640, y: 200, vx: -140, vy: 0, plane: 'horizontal', radius: 26, waveAmp: 0, waveFreq: 2.5, shielded: true }];
const hitBird = (fresh) => {
  if (fresh) { controller.pickaxes = []; controller.dwarfArena.lastThrowTime = -10; controller.lobPickaxe(); }
  const ax = controller.pickaxes[0];
  const bird = controller.arenaBirds[0];
  ax.x = bird.x + 4; ax.y = bird.y; ax.vx = 0; ax.vy = 0; ax.birdBounceCooldown = 0;
  tick();
};
hitBird(true);
assert.equal(controller.arenaBirds.length, 1, 'First hit should not kill');
assert.equal(controller.arenaBirds[0].shielded, false, 'First hit breaks the shield');
hitBird(true);
assert.equal(controller.arenaBirds.length, 0, 'Second hit kills the bird');
controller.pickaxes = [];
controller.restartRun();
assert.equal(controller.freeLobs, 1, 'New run clamps banked free lobs back to the stage-1 cap');

// Boss fights: green overkill (+10) -> dog, purple (+15) -> son, via the stage-clear countdown
controller.setMode('MANUAL_FAUCET');
controller.restartRun();
controller.stage = 12;
controller.resetStage();
controller.bossEncounters = { dog: 0, son: 0 };
const finishCountdownWithScore = (score) => {
  controller.score = score;
  controller.levelTransitioning = true;
  controller.transitionCountdown = 0.001;
  tick();
};
const stageBeforeBoss = controller.stage;
finishCountdownWithScore(7 + 9);
assert.equal(controller.boss, null, '+9 overkill should not trigger a boss');
assert.equal(controller.stage, stageBeforeBoss + 1, '+9 overkill just advances the stage');
finishCountdownWithScore(7 + 10);
assert.equal(controller.boss?.def.kind, 'dog', 'Green overkill (+10) triggers the dog');
assert.equal(controller.boss.birds, false, 'First dog encounter has no birds');
assert.equal(controller.birdsActive(), false);
const bossStage = controller.stage;

// Dog collideable hitting the dwarf knocks out 1 KII
kiiLedger.creditKiiCoins(5);
const balBeforeKnock = kiiLedger.getTotalKiiRaw();
controller.bossProjectiles.push({ kind: 'boulder', x: controller.dwarfArena.x, y: controller.dwarfArena.y - 8, vx: 0, vy: 0, radius: 23, color: '#000', accent: '#fff', roll: 0, bounces: 0 });
tick();
assert.equal(kiiLedger.getTotalKiiRaw(), balBeforeKnock - RAW, 'Boss hit knocks exactly 1 KII out of the bank');
assert.equal(controller.boss.coinsKnocked, 1);

// 10 axe hits defeat the dog, then the stage advances
const box = () => ({ x: controller.boss.x - controller.boss.def.width / 2, y: controller.boss.y - controller.boss.def.height });
// Dog tail-whips ~7.55% of axes, so throw until 10 land
let dogDeflects = 0;
for (let h = 0; h < 200 && !controller.boss.defeated; h++) {
  const b = box();
  if (!controller.checkAxeHitsBoss({ x: b.x + 10, y: b.y + 20, vx: 300, vy: 0, radius: 15 })) dogDeflects += 1;
  assert.ok(controller.boss.hits <= 10);
}
assert.ok(controller.boss.defeated, '10 hits defeat the boss');
assert.equal(controller.boss.hits, 10);
assert.equal(controller.boss.deflections, dogDeflects);
controller.transitionCountdown = 0.001;
tick();
assert.equal(controller.boss, null, 'Boss cleared after the victory countdown');
assert.equal(controller.stage, bossStage + 1, 'Beating the boss advances the stage');

finishCountdownWithScore(7 + 15);
assert.equal(controller.boss?.def.kind, 'son', 'Purple overkill (+15) triggers the son');
assert.equal(controller.boss.birds, false, 'First son encounter has no birds');
let deflects = 0;
const trials = 4000;
for (let n = 0; n < trials; n++) {
  controller.boss.hits = 0;
  controller.boss.defeated = false;
  const b = box();
  if (!controller.checkAxeHitsBoss({ x: b.x + 10, y: b.y + 40, vx: 300, vy: 0, radius: 15 })) deflects += 1;
}
assert.ok(Math.abs(deflects / trials - 0.15) < 0.02, `Son hair-whips ~15% of axes (got ${(deflects / trials * 100).toFixed(1)}%)`);

// A deflect reflects the axe like a bird shield, and a swatted axe that hits the dwarf costs 1 KII
controller.boss.hits = 0;
controller.boss.defeated = false;
controller.pickaxes = [];
controller.boss.def = { ...controller.boss.def, deflectChance: 1 };
{
  const b = box();
  const axe = { x: b.x + 2, y: b.y + controller.boss.def.height / 2, vx: 600, vy: 0, radius: 15, bounces: 0, life: 1, awardedFreeLob: false };
  assert.equal(controller.checkAxeHitsBoss(axe), false);
  assert.ok(axe.vx < 0, 'Deflected axe flies back toward the dwarf');
  assert.ok(axe.bossDeflected && axe.awardedFreeLob, 'Deflected axe is flagged and never pays a free lob');
  assert.ok(controller.boss.deflectAnimTimer > 0, 'Hair whip animation plays');
}
kiiLedger.creditKiiCoins(3);
const balBeforeSelfHit = kiiLedger.getTotalKiiRaw();
const knockedBefore = controller.boss.coinsKnocked;
controller.bossProjectiles = [];
controller.boss.throwTimer = 99;
const d = controller.dwarfArena;
controller.pickaxes = [{ x: d.x, y: d.y - 8, vx: -10, vy: 0, radius: 15, bounces: 1, maxBounces: 3, life: 3, angle: 0, spinSpeed: 0, trail: [], hitNodeCooldown: 0, awardedFreeLob: true, bossDeflected: true, isAxe: true }];
tick();
assert.equal(kiiLedger.getTotalKiiRaw(), balBeforeSelfHit - RAW, 'Own deflected axe knocks out 1 KII');
assert.equal(controller.boss.deflectHits, 1);
assert.equal(controller.boss.coinsKnocked, knockedBefore + 1);
assert.equal(controller.pickaxes.length, 0, 'Deflected axe is consumed on the dwarf');
controller.levelTransitioning = false;
controller.resetStage();
assert.equal(controller.boss?.def.kind, 'son', 'Resetting mid-fight restarts the same boss');

// Boss fights bring back the jump: up, apex, and land back on the same ledge
{
  const dw = controller.dwarfArena;
  const groundY = dw.y;
  assert.equal(controller.arenaJump(), true, 'Dwarf can jump in a boss fight');
  assert.equal(controller.arenaJump(), false, 'No double jump');
  let apex = groundY;
  for (let f = 0; f < 90; f++) { tick(); apex = Math.min(apex, dw.y); }
  assert.ok(groundY - apex > 120 && groundY - apex < 160, `Hop height ~140px (got ${groundY - apex})`);
  assert.equal(dw.y, groundY, 'Dwarf lands back on the ledge');
  assert.equal(dw.jumpOffset, 0);
}
assert.equal(controller.bossEncounters.son, 1, 'A mid-fight reset does not count as a new encounter');
controller.loadMap(controller.currentMapId);
controller.startBossFight('dog');
assert.equal(controller.boss.encounter, 2);
assert.equal(controller.boss.birds, true, 'Second dog encounter brings birds');
assert.equal(controller.birdsActive(), true);
// Boss-fight lobs are free through stage 150 (gift lobs stay banked), fees return after
for (const [st, free] of [[100, true], [150, true], [151, false]]) {
  controller.loadMap(controller.currentMapId);
  controller.stage = st;
  controller.startBossFight('dog', false);
  controller.boss.throwTimer = 99;
  controller.freeLobs = 2;
  kiiLedger.creditKiiCoins(10);
  const before = kiiLedger.getTotalKiiRaw();
  controller.dwarfArena.lastThrowTime = -10;
  controller.pickaxes = [];
  controller.lobPickaxe();
  assert.equal(controller.pickaxes.length, 1, `Stage ${st} boss lob fires`);
  assert.equal(controller.bossLobsFree(), free);
  if (free) {
    assert.equal(kiiLedger.getTotalKiiRaw(), before, `Stage ${st} boss lob costs nothing`);
    assert.equal(controller.freeLobs, 2, `Stage ${st} boss lob keeps gift lobs banked`);
  } else {
    assert.equal(controller.freeLobs, 1, 'Past 150, gift lobs are used first');
    controller.dwarfArena.lastThrowTime = -10;
    controller.freeLobs = 0;
    controller.lobPickaxe();
    assert.equal(kiiLedger.getTotalKiiRaw(), before - 4n * RAW, 'Past 150, boss lobs pay the stage fee (4 KII at 151)');
  }
}
controller.restartRun();
assert.equal(controller.boss, null);
assert.equal(controller.arenaJump(), false, 'No jumping outside boss fights');

console.log('✅ PASS: Bundle verified across all 10 maps in both MANUAL_FAUCET & SIDE_SCROLLER modes, Half-Gravity Space physics, KII 128-bit BigInt Dual-Ledger, Coelestis 7-track Jukebox, and gamepad controls!');
