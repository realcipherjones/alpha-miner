#!/usr/bin/env node
// Test helper for server/test_server.py: plays a bot run and prints its log.
// stdin: { seed, bossEncounters, debug, startBalanceRaw, seconds, botSeed }
import { makeGame } from './replay_lib.mjs';
import { playBot } from './replay_bot.mjs';

let text = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) text += chunk;
const spec = JSON.parse(text);
const game = makeGame();
game.app.controller.beginRun({
  seed: spec.seed,
  bossEncounters: spec.bossEncounters,
  debug: spec.debug,
  startBalanceRaw: spec.startBalanceRaw ? BigInt(spec.startBalanceRaw) : undefined
});
playBot(game, { seconds: spec.seconds, botSeed: spec.botSeed });
process.stdout.write(JSON.stringify(game.app.controller.getRunLog()) + '\n');
