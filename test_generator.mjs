/**
 * test_generator.mjs
 *
 * Stress test for the procedural arena generator: generates thousands of layouts
 * and checks validity, solvability, archetype rotation, determinism and speed.
 *
 * Usage:
 *   node test_generator.mjs [count]
 */

import assert from 'node:assert';
import { generateArenaLevel, ARENA_ARCHETYPE_NAMES } from './src/scenes/ArenaGenerator.ts';

const COUNT = Number(process.argv[2] || 3000);
const LEDGE_RIGHT = 234;

const archetypeCounts = new Array(ARENA_ARCHETYPE_NAMES.length).fill(0);
let minShots = Infinity;
let totalShots = 0;
let lowShotLayouts = 0;
let prevArchetype;
let maxMs = 0;
const t0 = performance.now();

for (let i = 0; i < COUNT; i++) {
  const stage = 1 + (i % 12);
  const start = performance.now();
  const level = generateArenaLevel({ stage, avoidArchetype: prevArchetype });
  maxMs = Math.max(maxMs, performance.now() - start);

  assert.notEqual(level.archetypeId, prevArchetype, 'archetype must not repeat back-to-back');
  prevArchetype = level.archetypeId;
  archetypeCounts[level.archetypeId]++;

  const node = level.miningNode;
  for (let a = 0; a < level.blocks.length; a++) {
    const b = level.blocks[a];
    assert.ok(b.x >= LEDGE_RIGHT + 20 && b.x + b.w <= 1276 && b.y >= 70 && b.y + b.h <= level.floorY, `block out of bounds (seed ${level.seed})`);
    for (let c = a + 1; c < level.blocks.length; c++) {
      const o = level.blocks[c];
      const overlap = b.x < o.x + o.w && b.x + b.w > o.x && b.y < o.y + o.h && b.y + b.h > o.y;
      assert.ok(!overlap, `overlapping blocks (seed ${level.seed})`);
    }
  }
  assert.ok(node.x >= 900 && node.x <= 1150 && node.y + node.radius <= level.floorY, `node out of place (seed ${level.seed})`);
  assert.equal(level.fallingObjects.length, 7, 'seven falling objects');
  assert.equal(level.initialBirds.length, stage < 2 ? 0 : Math.min(5, 3 + Math.floor(Math.max(0, stage - 3) / 2)), 'bird count by stage');

  minShots = Math.min(minShots, level.directShots);
  totalShots += level.directShots;
  if (level.directShots < 6) lowShotLayouts++;
}

// Same seed + options => identical layout
const a = generateArenaLevel({ stage: 4, seed: 12345 });
const b = generateArenaLevel({ stage: 4, seed: 12345 });
assert.deepEqual(a, b, 'generation must be deterministic for a given seed');

const elapsed = performance.now() - t0;
console.log(`layouts: ${COUNT} in ${elapsed.toFixed(0)} ms (avg ${(elapsed / COUNT).toFixed(1)} ms, worst ${maxMs.toFixed(1)} ms)`);
console.log('archetypes: ' + ARENA_ARCHETYPE_NAMES.map((n, i) => `${n} ${archetypeCounts[i]}`).join(', '));
console.log(`clean shots at node (of 1512 swept): min ${minShots}, avg ${(totalShots / COUNT).toFixed(0)}, layouts under 6: ${lowShotLayouts}`);
assert.equal(lowShotLayouts, 0, 'every layout must have at least 6 clean shots at the node');
console.log('✅ PASS: generator produced only valid, solvable, non-repeating layouts');
