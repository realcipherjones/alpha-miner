// Records a run in real headless Chrome (real rendering, real frame timing), then replays it in Node.
// This is the production path: the player's browser records, the server's Node verifies.
// Chrome and Node carry different V8 versions, which is the point of the test.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeGame, replayRun } from './replay_lib.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME || 'google-chrome';

const probe = (start, seconds) => `<script>
window.addEventListener('load', () => {
  const app = window.dwarfKiiApp;
  const c = app.controller;
  c.beginRun(${start});
  const digests = [];
  const step = c.simStep.bind(c);
  c.simStep = () => { step(); digests.push(c.simDigest()); };
  let state = 1;
  const rand = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  const bot = setInterval(() => {
    if (c.cashOutOfferOpen) c.acceptCashOut();
    const r = rand();
    if (r < 0.1) c.stepDwarf(rand() < 0.5 ? -1 : 1);
    else if (r < 0.2) c.arenaJump();
    else { c.setAim(15 + Math.floor(rand() * 66), 25 + Math.floor(rand() * 76)); c.lobPickaxe(); }
  }, 40);
  const started = performance.now();
  const finish = setInterval(() => {
    if (c.simTick < ${seconds} * 60 && performance.now() - started < ${seconds} * 3000) return;
    clearInterval(bot); clearInterval(finish);
    fetch('/_result', { method: 'POST', body: JSON.stringify({ log: c.getRunLog(), digests, balance: app.kiiLedger.getTotalKiiRaw().toString(), version: navigator.userAgent }) });
  }, 200);
});
</script>`;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png' };

/** Serves the game with the probe added (loopback only) and waits for Chrome to post the recording. */
function recordInChrome(start, seconds) {
  return new Promise((resolve, reject) => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-chrome-'));
    let chrome = null;
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/_result') {
        let body = '';
        req.on('data', (d) => (body += d));
        req.on('end', () => { res.end('ok'); done(null, JSON.parse(body)); });
        return;
      }
      if (url.pathname === '/') {
        res.setHeader('content-type', 'text/html');
        return res.end(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace('</body>', `${probe(start, seconds)}</body>`));
      }
      const file = path.join(ROOT, path.normalize(url.pathname));
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; return res.end(); }
      res.setHeader('content-type', TYPES[path.extname(file)] || 'application/octet-stream');
      res.end(fs.readFileSync(file));
    });
    const timer = setTimeout(() => done(new Error('Chrome did not finish the recording')), (seconds * 3 + 30) * 1000);
    function done(err, value) {
      clearTimeout(timer);
      server.close();
      server.closeAllConnections();
      if (chrome) chrome.kill('SIGKILL');
      setTimeout(() => fs.rmSync(profile, { recursive: true, force: true }), 500);
      err ? reject(err) : resolve(value);
    }
    server.listen(0, '127.0.0.1', () => {
      chrome = spawn(CHROME, [
        '--headless=new', '--disable-gpu', '--mute-audio', '--no-first-run', `--user-data-dir=${profile}`,
        '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
        '--autoplay-policy=no-user-gesture-required', `http://127.0.0.1:${server.address().port}/`
      ], { stdio: 'ignore' });
      chrome.on('error', done);
    });
  });
}

const RAW = '100000000000000000n';
const scenarios = [
  ['normal stage with birds', `{ seed: 101, startBalanceRaw: 300n * ${RAW}, debug: { stage: 60 } }`],
  ['YesChef at stage 100', `{ seed: 202, startBalanceRaw: 300n * ${RAW}, bossEncounters: { dog: 3, son: 3 }, debug: { stage: 100, boss: 'son' } }`]
];
for (let round = 0; round < 3; round++) for (const [name, start] of scenarios) {
  const { log, digests, balance, version } = await recordInChrome(start, 25);
  assert.ok(log.ticks > 300, `${name}: Chrome should really simulate (got ${log.ticks} ticks)`);
  // Every tick has to match, not only the last: small differences can fade away and still reject a later run
  const game = makeGame({ strictMath: true });
  const nodeDigests = [];
  const step = game.app.controller.simStep.bind(game.app.controller);
  game.app.controller.simStep = () => { step(); nodeDigests.push(game.app.controller.simDigest()); };
  const result = replayRun(log, game);
  const firstDifferent = digests.findIndex((digest, i) => digest !== nodeDigests[i]);
  assert.equal(firstDifferent, -1, `${name}: Chrome and Node differ at tick ${firstDifferent + 1}`);
  assert.equal(digests.length, nodeDigests.length, `${name}: tick counts`);
  assert.ok(result.ok, `${name}: ${result.error}`);
  assert.ok(result.matches, `${name}: Chrome and Node disagree at stage ${result.firstDesyncStage}`);
  assert.equal(result.balanceRaw, balance, `${name}: balance`);
  console.log(`ok  ${name}: ${log.ticks} ticks, ${log.inputs.length} inputs, balance ${BigInt(balance) / 100000000000000000n} (${version.match(/Chrome\/[\d.]+/)?.[0]} vs Node ${process.versions.v8})`);
}
console.log('✅ PASS: runs recorded in Chrome replay identically in Node');
