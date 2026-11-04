#!/usr/bin/env node
// Verifier entry point for the payout service: run log JSON on stdin, outcome JSON on stdout.
import { replayRun } from './replay_lib.mjs';

let text = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) text += chunk;
let result;
try {
  result = replayRun(JSON.parse(text));
} catch (err) {
  result = { ok: false, error: `replay failed: ${err.message}` };
}
process.stdout.write(JSON.stringify(result) + '\n');
process.exitCode = result.ok ? 0 : 1;
