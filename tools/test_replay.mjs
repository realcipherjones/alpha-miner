// Plays runs with an aiming bot on uneven frame timing, then replays each log in a fresh game.
// Any gameplay dependency on frame timing, Math.random or rendering shows up as a digest mismatch.
import assert from 'node:assert';
import { makeGame, replayRun } from './replay_lib.mjs';
import { playBot } from './replay_bot.mjs';

const RAW = 100_000_000_000_000_000n;

const scenarios = [
  { name: 'stage 1 from a clean start', start: { seed: 11, startBalanceRaw: 0n }, seconds: 150, botSeed: 1 },
  { name: 'pay-to-play with birds', start: { seed: 22, startBalanceRaw: 300n * RAW, debug: { stage: 12 } }, seconds: 150, botSeed: 2 },
  { name: 'cash-out at stage 50', start: { seed: 33, startBalanceRaw: 500n * RAW, debug: { stage: 49 } }, seconds: 120, botSeed: 3 },
  { name: 'Bone Crusher, no birds', start: { seed: 44, startBalanceRaw: 50n * RAW, freeLobs: 0, debug: { stage: 12, boss: 'dog' } }, seconds: 100, botSeed: 4 },
  { name: 'YesChef with birds at stage 100', start: { seed: 55, startBalanceRaw: 900n * RAW, bossEncounters: { dog: 3, son: 3 }, debug: { stage: 100, boss: 'son' } }, seconds: 150, botSeed: 5 },
  { name: 'late game after 150, paid boss lobs', start: { seed: 66, startBalanceRaw: 2000n * RAW, bossEncounters: { dog: 3, son: 3 }, debug: { stage: 151, boss: 'son' } }, seconds: 80, botSeed: 6 }
];

const coverage = { bosses: new Set(), cashOuts: 0, hits: 0, deflects: 0, birds: 0 };
for (const s of scenarios) {
  const live = makeGame();
  // Leave old state behind on purpose: the replay starts from a brand new game
  live.app.controller.setAim(70, 90);
  for (let i = 0; i < 300; i++) live.frame(16.7);
  live.app.controller.beginRun(s.start);
  const seen = playBot(live, s);
  const log = JSON.parse(JSON.stringify(live.app.controller.getRunLog()));
  const result = replayRun(log);
  assert.ok(result.ok, `${s.name}: ${result.error}`);
  assert.ok(result.matches, `${s.name}: replay desynced at stage ${result.firstDesyncStage} (live ${log.digest}, replay ${result.digest})`);
  assert.equal(result.balanceRaw, live.app.kiiLedger.getTotalKiiRaw().toString(), `${s.name}: balance`);
  assert.deepEqual(result.cashOuts, JSON.parse(JSON.stringify(live.app.controller.runCashOuts)), `${s.name}: cash-outs`);
  seen.bosses.forEach((b) => coverage.bosses.add(b));
  coverage.cashOuts += seen.cashOuts;
  coverage.hits += seen.hits;
  coverage.deflects += seen.deflects;
  coverage.birds = Math.max(coverage.birds, seen.birds);
  console.log(`ok  ${s.name}: ${log.ticks} ticks, ${log.inputs.length} inputs, ${seen.lobs} lob tries, ${seen.hits} node hits, stages ${[...seen.stages].join(',')}, cash-outs ${seen.cashOuts}, deflects ${seen.deflects}, balance ${BigInt(result.balanceRaw) / RAW}`);
}
assert.ok(coverage.hits > 0, 'bot should hit the node');
assert.ok(coverage.cashOuts >= 1, 'bot should reach a cash-out');
assert.deepEqual([...coverage.bosses].sort(), ['dog', 'son'], 'both bosses should be fought');
assert.ok(coverage.deflects > 0, 'should see a deflect');
assert.ok(coverage.birds > 0, 'should see birds');

// DetMath stays close to the real functions, so swapping it in didn't change how the game plays
{
  const { detSin, detCos, detTan, detHypot } = await import('./test_detmath_shim.mjs');
  for (let i = 0; i < 200000; i++) {
    const x = (i - 100000) * 0.00613;
    assert.ok(Math.abs(detSin(x) - Math.sin(x)) < 1e-11, `sin ${x}`);
    assert.ok(Math.abs(detCos(x) - Math.cos(x)) < 1e-11, `cos ${x}`);
  }
  assert.ok(Math.abs(detTan(1) - Math.tan(1)) < 1e-12);
  assert.equal(detHypot(3, 4), 5);
}

// The guard works: gameplay calling engine-dependent math would fail loudly, not quietly reject players
{
  const strict = makeGame({ strictMath: true });
  assert.throws(() => strict.evaluate('Math.sin(1)'), /engine-dependent/, 'Strict mode blocks Math.sin');
  assert.equal(strict.evaluate('Math.sqrt(16)'), 4, 'Exact operations stay available');
  strict.app.controller.beginRun({ seed: 5 });
  for (let i = 0; i < 600; i++) strict.app.controller.simStep();
}

// A second run in the same session replays just like a first one
{
  const live = makeGame();
  live.app.controller.beginRun({ seed: 7, startBalanceRaw: 100n * RAW, debug: { stage: 20 } });
  playBot(live, { seconds: 40, botSeed: 7 });
  live.app.controller.restartRun();
  playBot(live, { seconds: 40, botSeed: 8 });
  const result = replayRun(JSON.parse(JSON.stringify(live.app.controller.getRunLog())));
  assert.ok(result.ok && result.matches, 'Second run in a session should replay');
}

// Tampering: forged logs must not produce the claimed outcome
const base = makeGame();
base.app.controller.beginRun({ seed: 99, startBalanceRaw: 500n * RAW, debug: { stage: 49 } });
playBot(base, { seconds: 90, botSeed: 9 });
const good = JSON.parse(JSON.stringify(base.app.controller.getRunLog()));
const honest = replayRun(good);
assert.ok(honest.ok && honest.matches, 'Honest log replays');
const forged = (edit) => { const log = JSON.parse(JSON.stringify(good)); edit(log); return replayRun(log); };

assert.notEqual(forged((l) => { l.header.seed += 1; }).matches, true, 'Changed seed desyncs');
assert.notEqual(forged((l) => { l.inputs = l.inputs.filter((x) => x[1] !== 'l'); }).matches, true, 'Removing the lobs desyncs');
assert.notEqual(forged((l) => { l.header.startBalanceRaw = (BigInt(l.header.startBalanceRaw) + RAW).toString(); }).matches, true, 'Changed start balance desyncs');
assert.notEqual(forged((l) => { l.digest = '0'.repeat(16); }).matches, true, 'Wrong digest is flagged');
{
  // A cheater's forged log can agree with itself, but the amount still comes from the simulation
  const inflated = forged((l) => { l.cashOuts = [{ stage: 50, tick: 1, amountRaw: (10n ** 30n).toString() }]; });
  assert.deepEqual(inflated.cashOuts, honest.cashOuts, 'Claimed cash-outs are ignored');
}
for (const [why, edit] of [
  ['non-number tick', (l) => { l.inputs[0][0] = '1'; }],
  ['out-of-order tick', (l) => { l.inputs.push([0, 'l']); }],
  ['tick past the end', (l) => { l.inputs.push([l.ticks + 1, 'l']); }],
  ['unknown input', (l) => { l.inputs.push([l.ticks, 'x']); }],
  ['code injection attempt', (l) => { l.inputs.push([l.ticks, 'constructor']); }],
  ['bad step', (l) => { l.inputs.push([l.ticks, 's', 71]); }],
  ['aim out of range', (l) => { l.inputs.push([l.ticks, 'a', 500, 500]); }],
  ['extra args', (l) => { l.inputs.push([l.ticks, 'l', 1]); }],
  ['bad version', (l) => { l.header.version = 0; }],
  ['huge tick count', (l) => { l.ticks = 1e15; }],
  ['negative seed', (l) => { l.header.seed = -1; }],
  ['non-numeric start balance', (l) => { l.header.startBalanceRaw = '1e50'; }]
]) {
  const r = forged(edit);
  assert.equal(r.ok, false, `Rejected: ${why}`);
}
// Skipping past an open cash-out offer can't be replayed
if (honest.cashOuts.length) {
  const r = forged((l) => {
    const i = l.inputs.findIndex((x) => x[1] === 'c');
    l.inputs[i][0] = Math.min(l.ticks, l.inputs[i][0] + 5);
    l.inputs.sort((a, b) => a[0] - b[0]);
  });
  assert.equal(r.ok, false, 'Time cannot pass during an open offer');
}

// The game-over callback sends the log, so a log taken inside it has to include the lob that ended the run
{
  const live = makeGame();
  const c = live.app.controller;
  let sent = null;
  c.callbacks = { onGameOver: () => { sent = JSON.parse(JSON.stringify(c.getRunLog())); } };
  c.beginRun({ seed: 55, startBalanceRaw: 0n, freeLobs: 0, bossEncounters: { dog: 0, son: 0 }, aim: { angle: 45, power: 60 }, debug: { stage: 6 } });
  for (let i = 0; i < 120; i++) c.simStep();
  c.lobPickaxe();
  assert.ok(sent, 'Lobbing with an empty bank should end the run');
  const result = replayRun(sent);
  assert.ok(result.ok && result.matches, `Log sent at game over should replay (desync stage ${result.firstDesyncStage})`);
  assert.equal(result.gameOver, true, 'Replay should reach the same game over');
}

// Fixed fingerprints of fresh stages. A change here means old run logs stop replaying: if the change
// to gameplay is intended, bump REPLAY_VERSION (see RunReplay.ts) and update this list.
{
  const expected = ['6c59521a4a0bdcfd', '6d2ac369b91b6fbf', 'd122e4550fe2be41', '51422a0f16d9ee34', 'fef0d59e021f89a7', 'b0d413637cb756cf', 'f6e92d6845ab166f', '820a937c70ca25da'];
  const starts = [[1, 1], [2, 7], [3, 23], [4, 49], [5, 50], [6, 99], [7, 150], [8, 201]];
  starts.forEach(([seed, stage], i) => {
    const c = makeGame({ strictMath: true }).app.controller;
    c.beginRun({ seed, startBalanceRaw: 0n, freeLobs: 0, bossEncounters: { dog: 0, son: 0 }, aim: { angle: 45, power: 60 }, debug: { stage } });
    for (let tick = 0; tick < 300; tick++) c.simStep();
    assert.equal(c.simDigest(), expected[i], `Stage ${stage} changed from the fixed fingerprint`);
  });
}

// Debug starts are reported so the server can reject them; speed check for server sizing
assert.deepEqual(honest.debug, { stage: 49 }, 'Debug start is visible to the server');
const speed = makeGame();
const t0 = performance.now();
speed.app.controller.beginRun({ seed: 1, startBalanceRaw: 0n });
for (let i = 0; i < 60 * 60 * 10; i++) speed.app.controller.simStep();
console.log(`speed: 10 game-minutes of idle stage simulated in ${Math.round(performance.now() - t0)} ms`);

console.log('✅ PASS: replay matches live play across frame timings, and forged logs are caught');
