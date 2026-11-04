// Replays a run log in the real game bundle (headless) and reports what the run actually earned.
// Everything in a log is untrusted: it is validated first, and only numbers reach the game.
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export const REPLAY_VERSION = 1;
export const LIMITS = { maxTicks: 60 * 60 * 60 * 12, maxInputs: 2_000_000 };

/** Headless stand-in for the browser. Set timing to drive frames for live play in tests. */
export function makeGame({ bundlePath = path.join(ROOT, 'dist/bundle.js'), strictMath = false } = {}) {
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
    encodeURIComponent,
    performance: { now: () => nowMs },
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k)
    },
    document: { readyState: 'complete', getElementById: el, createElement: (t) => el(`${t}_${elements.size}`), addEventListener() {}, removeEventListener() {} },
    Image: class { constructor() { this.complete = true; this.naturalWidth = 1536; this.naturalHeight = 1024; this.src = ''; } },
    Audio: class { constructor() { this.paused = true; } addEventListener() {} removeEventListener() {} play() { return Promise.resolve(); } pause() {} load() {} },
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
  const context = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(bundlePath, 'utf8'), context);
  // These can differ between JavaScript engines, so gameplay must use DetMath.ts instead (rendering never runs here)
  if (strictMath) {
    vm.runInContext(`for (const fn of ['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'sinh', 'cosh', 'tanh', 'exp', 'expm1', 'log', 'log2', 'log10', 'log1p', 'pow', 'cbrt', 'hypot']) {
      Math[fn] = () => { throw new Error('gameplay used engine-dependent Math.' + fn); };
    }`, context);
  }
  const frame = (ms) => { nowMs += ms; const q = raf; raf = []; q.forEach((cb) => cb(nowMs)); };
  return { app: sandbox.window.dwarfKiiApp, frame, evaluate: (code) => vm.runInContext(code, context) };
}

const isCount = (v, max) => Number.isSafeInteger(v) && v >= 0 && v <= max;

/** Returns an error string, or null if the log is well formed. */
export function validateLog(log) {
  if (!log || typeof log !== 'object' || !log.header || !Array.isArray(log.inputs)) return 'malformed log';
  const h = log.header;
  if (h.version !== REPLAY_VERSION) return `unsupported replay version ${h.version}`;
  if (!isCount(h.seed, 0xffffffff)) return 'bad seed';
  if (typeof h.startBalanceRaw !== 'string' || !/^\d{1,39}$/.test(h.startBalanceRaw)) return 'bad start balance';
  if (!isCount(h.freeLobs, 1_000_000)) return 'bad free lobs';
  if (!h.bossEncounters || !isCount(h.bossEncounters.dog, 1_000_000) || !isCount(h.bossEncounters.son, 1_000_000)) return 'bad boss encounters';
  if (!h.aim || !isCount(h.aim.angle, 80) || h.aim.angle < 15 || !isCount(h.aim.power, 100) || h.aim.power < 25) return 'bad aim';
  if (!isCount(log.ticks, LIMITS.maxTicks)) return 'bad tick count';
  if (log.inputs.length > LIMITS.maxInputs) return 'too many inputs';
  let previous = 0;
  for (const input of log.inputs) {
    if (!Array.isArray(input)) return 'bad input';
    const [tick, code, ...args] = input;
    if (!isCount(tick, log.ticks) || tick < previous) return 'inputs out of order';
    previous = tick;
    if (code === 's') {
      if (args.length !== 1 || (args[0] !== 1 && args[0] !== -1)) return 'bad step';
    } else if (code === 'a') {
      if (args.length !== 2 || !isCount(args[0], 80) || args[0] < 15 || !isCount(args[1], 100) || args[1] < 25) return 'bad aim input';
    } else if (code === 'j' || code === 'l' || code === 'c' || code === 'd') {
      if (args.length !== 0) return 'bad input args';
    } else return 'unknown input';
  }
  return null;
}

/**
 * Plays a log back and returns the outcome from the simulation itself.
 * `matches` says whether the player's copy agreed; payouts must use `cashOuts` only, never log values.
 */
export function replayRun(log, game = makeGame({ strictMath: true })) {
  const problem = validateLog(log);
  if (problem) return { ok: false, error: problem };
  const c = game.app.controller;
  const h = log.header;
  const debug = h.debug && typeof h.debug === 'object'
    ? { ...(isCount(h.debug.stage, 1_000_000) ? { stage: h.debug.stage } : {}), ...(h.debug.boss === 'dog' || h.debug.boss === 'son' ? { boss: h.debug.boss } : {}) }
    : undefined;
  c.beginRun({
    seed: h.seed,
    startBalanceRaw: BigInt(h.startBalanceRaw),
    freeLobs: h.freeLobs,
    bossEncounters: { dog: h.bossEncounters.dog, son: h.bossEncounters.son },
    aim: h.aim,
    debug
  });
  const runTo = (target) => {
    while (c.simTick < target) {
      if (c.cashOutOfferOpen) return false; // the live game can't advance past an open offer
      c.simStep();
    }
    return true;
  };
  for (const [tick, code, ...args] of log.inputs) {
    if (!runTo(tick)) return { ok: false, error: `run advanced past an open cash-out offer at tick ${c.simTick}` };
    if (code === 's') c.stepDwarf(args[0]);
    else if (code === 'j') c.arenaJump();
    else if (code === 'a') c.setAim(args[0], args[1]);
    else if (code === 'l') c.lobPickaxe();
    else if (code === 'c') c.acceptCashOut();
    else if (code === 'd') c.declineCashOut();
  }
  if (!runTo(log.ticks)) return { ok: false, error: `run advanced past an open cash-out offer at tick ${c.simTick}` };
  const replayed = c.getRunLog();
  const snap = game.app.kiiLedger.getSnapshot();
  const claimed = Array.isArray(log.checkpoints) ? log.checkpoints : [];
  const firstDesync = replayed.checkpoints.findIndex((point, i) => JSON.stringify(point) !== JSON.stringify(claimed[i]));
  return {
    ok: true,
    matches: replayed.digest === log.digest && firstDesync === -1 && claimed.length === replayed.checkpoints.length,
    firstDesyncStage: firstDesync === -1 ? null : replayed.checkpoints[firstDesync][0],
    digest: replayed.digest,
    seed: h.seed,
    debug: h.debug ?? null,
    startBalanceRaw: h.startBalanceRaw,
    ticks: c.simTick,
    stage: c.stage,
    gameOver: c.gameOver,
    balanceRaw: snap.totalKiiRaw.toString(),
    bossEncounters: c.bossEncounters,
    cashOuts: c.runCashOuts
  };
}
