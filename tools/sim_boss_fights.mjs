/**
 * sim_boss_fights.mjs
 *
 * Headless sample boss fights against the real bundle (dist/bundle.js).
 * A scripted "couch player" aims at the boss with human-ish error, fires at a
 * human pace, sometimes steps to another ledge when the boss throws, and tries to
 * jump incoming collideables / swatted-back axes (JUMP_SKILL chance, imperfect timing).
 *
 * Scenarios: Dog 1st encounter (no birds), Dog 2nd (birds), Son 1st, Son 2nd.
 * knockedOut = coins lost to boss throws; ownAxeHits = coins lost to swatted-back axes.
 *
 * Usage: node tools/sim_boss_fights.mjs [stage=12] [fightsPerScenario=3] [startKii=40] [jumpSkill=0.55]
 */

import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bundleCode = fs.readFileSync(path.join(__dirname, '../dist/bundle.js'), 'utf8');

const STAGE = Number(process.argv[2] || 12);
const FIGHTS = Number(process.argv[3] || 3);
const START_KII = Number(process.argv[4] || 40);
const DT_MS = 16;
const MAX_SECONDS = 240;
const JUMP_SKILL = Number(process.argv[5] ?? 0.55);

// Seeded PRNG so every run is reproducible (the bundle shares this realm's Math)
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeHarness() {
  const ctx = new Proxy({}, {
    get: (o, k) => (k in o ? o[k] : () => ({ addColorStop() {}, width: 100 })),
    set: (o, k, v) => ((o[k] = v), true)
  });
  const elements = new Map();
  const el = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        id, style: {}, className: '', textContent: '', innerHTML: '', disabled: false,
        classList: { add() {}, remove() {}, toggle() {}, contains: () => true },
        children: [], value: '50', clientWidth: 1280, clientHeight: 645, width: 1280, height: 645,
        getContext: () => ctx,
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 645 }),
        addEventListener() {}, removeEventListener() {},
        appendChild(c) { this.children.push(c); return c; },
        setAttribute() {}, click() {}
      });
    }
    return elements.get(id);
  };
  const storage = new Map();
  let nowMs = 100;
  let raf = [];
  const sandbox = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    BigInt, Math, Date, JSON, Map, Set, Array, Object, Number, String, Boolean, RegExp, Error, TypeError, Promise,
    encodeURIComponent,
    performance: { now: () => nowMs },
    localStorage: { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) },
    document: { readyState: 'complete', getElementById: el, createElement: (t) => el(`${t}_${Math.random()}`), addEventListener() {}, removeEventListener() {} },
    Image: class { constructor() { this.complete = true; this.naturalWidth = 1536; this.naturalHeight = 1024; this.src = ''; } },
    Audio: class { constructor() { this.paused = true; } addEventListener() {} play() { return Promise.resolve(); } pause() {} load() {} },
    requestAnimationFrame: (cb) => { raf.push(cb); return 1; },
    cancelAnimationFrame: () => {},
    navigator: { getGamepads: () => [null] },
    setTimeout: () => 1,
    clearTimeout: () => {},
    ex: { EX_VERSION: '0.29.3' }
  };
  sandbox.window = sandbox;
  sandbox.window.addEventListener = () => {};
  sandbox.window.removeEventListener = () => {};
  vm.runInNewContext(bundleCode, sandbox);
  const tick = () => { nowMs += DT_MS; const q = raf; raf = []; q.forEach((cb) => cb(nowMs)); };
  return { app: sandbox.window.dwarfKiiApp, tick, now: () => nowMs };
}

/** Player lob solve (launches right from the dwarf), mirroring the boss solver. */
function solvePlayerLob(origin, target, rand) {
  const dx = Math.max(40, target.x - origin.x);
  const dy = target.y - origin.y;
  const start = 35 + Math.floor(rand() * 20);
  for (let k = 0; k <= 45; k++) {
    const angleDeg = 15 + ((start - 15 + k) % 66);
    const rad = (angleDeg * Math.PI) / 180;
    const denom = 2 * Math.cos(rad) ** 2 * (dy + dx * Math.tan(rad));
    if (denom <= 0) continue;
    const speed = Math.sqrt((980 * dx * dx) / denom);
    const powerPct = ((speed - 440) / 800) * 100;
    if (powerPct >= 25 && powerPct <= 100) return { angleDeg, powerPct };
  }
  return { angleDeg: 45, powerPct: 100 };
}

function runFight(kind, encounter, seed) {
  Math.random = mulberry32(seed);
  const rand = mulberry32(seed ^ 0x9e3779b9);
  const { app, tick } = makeHarness();
  const { controller: c, kiiLedger } = app;
  c.setMode('MANUAL_FAUCET');
  c.stage = STAGE;
  c.restartRun();
  c.stage = STAGE;
  c.resetStage();
  kiiLedger.resetLedger(false);
  kiiLedger.creditKiiCoins(START_KII);
  // encounter 1 = first time; pre-load history for later encounters
  c.bossEncounters[kind] = encounter - 1;
  c.startBossFight(kind);

  const boss = c.boss;
  const feeKii = c.bossLobsFree() ? 0 : c.getLobFeeKii();
  let t = 0;
  let nextShot = 0.8;
  let lastBossThrows = 0;
  let steps = 0;
  let jumps = 0;
  const judged = new WeakSet();
  let birdsSeen = 0;
  let birdSamples = 0;
  const startRaw = kiiLedger.getTotalKiiRaw();
  const freeUsedStart = kiiLedger.getSnapshot().freeLobsUsed;

  while (t < MAX_SECONDS && !boss.defeated && !c.gameOver) {
    // React to a new boss throw: 45% chance to step to another ledge
    if (boss.throws > lastBossThrows) {
      lastBossThrows = boss.throws;
      if (rand() < 0.45) {
        c.stepDwarf(rand() < 0.5 ? -1 : 1);
        steps += 1;
      }
    }
    // Jump threats about to arrive (boss throws, and our own swatted-back axes)
    const d0 = c.dwarfArena;
    const threats = [...c.bossProjectiles, ...c.pickaxes.filter((p) => p.bossDeflected)];
    for (const o of threats) {
      if (judged.has(o) || o.vx === 0 || Math.sign(d0.x - o.x) !== Math.sign(o.vx)) continue;
      const arrive = (o.x - d0.x) / -o.vx;
      // Human reaction: commit somewhere in a 0.15-0.4 s window before arrival
      if (arrive > 0 && arrive < 0.15 + rand() * 0.25) {
        judged.add(o);
        if (rand() < JUMP_SKILL && c.arenaJump()) jumps += 1;
      }
    }
    if (t >= nextShot && c.pickaxes.length < 3) {
      const d = c.dwarfArena;
      const origin = { x: d.x + 24, y: d.y - 14 };
      const box = { x: boss.x - boss.def.width / 2, y: boss.y - boss.def.height, w: boss.def.width, h: boss.def.height };
      const target = { x: box.x + box.w / 2, y: box.y + box.h * 0.45 };
      const aim = solvePlayerLob(origin, target, rand);
      // Human error: +/-3 deg, +/-4% power
      c.setAim(aim.angleDeg + (rand() * 2 - 1) * 3, aim.powerPct + (rand() * 2 - 1) * 4);
      c.lobPickaxe();
      nextShot = t + 0.9 + rand() * 0.6;
    }
    tick();
    t += DT_MS / 1000;
    if (Math.floor(t * 4) !== Math.floor((t - DT_MS / 1000) * 4)) {
      birdSamples += 1;
      birdsSeen += c.arenaBirds.length;
    }
  }

  const endRaw = kiiLedger.getTotalKiiRaw();
  const RAW = 10n ** 17n;
  return {
    scenario: `${kind === 'dog' ? 'Dog' : 'Son'} #${encounter}${encounter === 1 ? ' (no birds)' : ' (birds)'}`,
    seed,
    outcome: boss.defeated ? 'WIN' : c.gameOver ? 'BROKE' : 'TIMEOUT',
    seconds: Math.round(t),
    axes: c.totalThrows,
    hits: boss.hits,
    accuracy: `${Math.round((boss.hits / Math.max(1, c.totalThrows)) * 100)}%`,
    deflected: boss.deflections,
    bossThrows: boss.throws,
    bossJumps: boss.jumps,
    knockedOut: boss.coinsKnocked - boss.deflectHits,
    ownAxeHits: boss.deflectHits,
    lobFees: (c.totalThrows - (kiiLedger.getSnapshot().freeLobsUsed - freeUsedStart)) * feeKii,
    kiiDelta: Number((endRaw - startRaw) / RAW),
    avgBirds: birdSamples ? (birdsSeen / birdSamples).toFixed(1) : '0',
    stepsDodged: steps,
    jumps
  };
}

const scenarios = [['dog', 1], ['dog', 2], ['son', 1], ['son', 2]];
const rows = [];
let seed = 1001;
for (const [kind, enc] of scenarios) {
  for (let f = 0; f < FIGHTS; f++) rows.push(runFight(kind, enc, seed++));
}
console.log(`Stage ${STAGE} · ${FIGHTS} fights/scenario · start ${START_KII} KII · max ${MAX_SECONDS}s`);
console.table(rows);
