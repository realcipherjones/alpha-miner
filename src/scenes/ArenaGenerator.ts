/**
 * ArenaGenerator.ts
 *
 * Procedural layouts for the Manual Faucet arena, ported from the original
 * dwarf_pickaxe_tosser_maps_1_2_3.html generator. Every stage rolls one of five
 * structural archetypes (never the same one twice in a row) with randomized
 * tower heights, shelves, block materials, node position/pedestal, dwarf
 * staircase, crystals, falling objects and birds.
 *
 * Each roll is validated (no overlapping blocks, nothing buried in the node or
 * the dwarf's ledge) and checked for solvability by simulating a sweep of real
 * pickaxe throws; layouts with too few clean shots at the node are rerolled.
 *
 * Compatible with Node v24 `--experimental-strip-types` (no enums, no parameter properties).
 */

import type {
  TosserArenaLevel,
  BlockDef,
  FallingObjectDef,
  BirdDef,
  BackgroundCrystalDef
} from './LevelData.ts';
import { BIRD_RADIUS } from './LevelData.ts';

const WORLD_W = 1280;
const WORLD_H = 645;
const FLOOR_Y = 641;
const BW = 52;
const BH = 36;
const NODE_RADIUS = 50;

// Dwarf ledge occupies x 24..234; its three stances are 71 px apart
const LEDGE_RIGHT = 234;
const DWARF_STANCES_X = [58, 129, 200];

// Pickaxe physics (must match ExcaliburGameController.getLaunchVelocity / updateGeneralPhysics)
const PICK_RADIUS = 15;
const PICK_GRAVITY = 980;

export const ARENA_ARCHETYPE_NAMES = [
  'Twin Towers',
  'Domino Staircase',
  'Fortress Wall',
  'Sky Bridges',
  'Canyon Chute'
];

export interface GeneratedArenaLevel extends TosserArenaLevel {
  archetypeId: number;
  archetypeName: string;
  seed: number;
  /** Clean direct-hit throws found by the solvability sweep (for debugging/tuning). */
  directShots: number;
}

export interface ArenaGeneratorOptions {
  stage: number;
  seed?: number;
  avoidArchetype?: number;
}

/** Small fast seeded PRNG so any layout can be reproduced from its seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type BlockType = BlockDef['type'];

const STEP_PRESETS: Array<[number, number, number]> = [
  [467, 515, 563], // High-Mid-Low (classic)
  [455, 515, 568], // High-Mid-Low (steep)
  [568, 510, 452], // Low-Mid-High (inverted)
  [460, 555, 475], // Valley center, high flanks
  [555, 455, 555], // Raised center spire
  [485, 445, 565] // Mid-High-Low
];

const CRYSTAL_PALETTES = [
  ['#0369a1', '#1d4ed8', '#0284c7', '#38bdf8'],
  ['#9f1239', '#be123c', '#e11d48', '#fb7185'],
  ['#065f46', '#047857', '#10b981', '#34d399'],
  ['#581c87', '#7e22ce', '#9333ea', '#c084fc'],
  ['#92400e', '#b45309', '#d97706', '#fbbf24']
];

const OBJ_SPECS: Array<{ kind: FallingObjectDef['kind']; name: string; radius: number; color: string; accent: string }> = [
  { kind: 'anvil', name: 'Iron Anvil', radius: 22, color: '#1e293b', accent: '#38bdf8' },
  { kind: 'boulder', name: 'Granite Boulder', radius: 23, color: '#64748b', accent: '#cbd5e1' },
  { kind: 'cart', name: 'Loaded Ore Cart', radius: 22, color: '#b45309', accent: '#fbbf24' },
  { kind: 'barrel', name: 'Powder Keg', radius: 20, color: '#991b1b', accent: '#fca5a5' }
];

/** Minimum clean direct shots (out of the sweep) for a layout to count as fair. */
const MIN_DIRECT_SHOTS = 6;
const MAX_ATTEMPTS = 40;

export function generateArenaLevel(options: ArenaGeneratorOptions): GeneratedArenaLevel {
  const baseSeed = options.seed ?? Math.floor(Math.random() * 0x7fffffff);
  // Choose the archetype once and reroll only its details, so archetypes that
  // fail checks more often (e.g. Fortress Wall) still come up as often as the rest.
  const candidates = [0, 1, 2, 3, 4].filter((a) => a !== options.avoidArchetype);
  const archetype = candidates[Math.floor(mulberry32(baseSeed)() * candidates.length)];
  let best: GeneratedArenaLevel | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const seed = (baseSeed + (attempt + 1) * 7919) >>> 0;
    const level = rollArenaLevel(options.stage, seed, archetype);
    if (!isLayoutValid(level)) continue;
    level.directShots = countDirectShots(level);
    if (level.directShots >= MIN_DIRECT_SHOTS) return level;
    if (!best || level.directShots > best.directShots) best = level;
  }
  // Extremely unlikely; fall back to the most open valid roll we saw
  return best || rollArenaLevel(options.stage, baseSeed + 7919, archetype);
}

function rollArenaLevel(stage: number, seed: number, archetype: number): GeneratedArenaLevel {
  const rand = mulberry32(seed);
  const randInt = (min: number, max: number) => Math.floor(min + rand() * (max - min + 1));
  const pick = <T>(items: T[]): T => items[Math.floor(rand() * items.length)];

  // Dwarf staircase
  const steps = pick(STEP_PRESETS);

  // Mining node position + pedestal
  const node = { x: randInt(900, 1150), y: 582, radius: NODE_RADIUS, value: 1 };
  const pedestalRows = randInt(0, 3);
  node.y = 582 - pedestalRows * BH;

  const blocks: BlockDef[] = [];
  const addBlock = (x: number, y: number, type: BlockType) => {
    const hp = type === 'clay' || type === 'stone' ? 2 : 1;
    blocks.push({ id: `g${seed}_${blocks.length}`, x, y, w: BW, h: BH, type, hp, maxHp: hp });
  };
  for (let r = 0; r < pedestalRows; r++) {
    const py = FLOOR_Y - (r + 1) * BH;
    addBlock(node.x - 52, py, 'stone');
    addBlock(node.x + 2, py, 'stone');
  }

  const pal = pick(CRYSTAL_PALETTES);
  const bgCrystals: BackgroundCrystalDef[] = [
    { x: randInt(270, 390), y: FLOOR_Y - 2, w: randInt(20, 34), h: randInt(42, 82), color: pal[0] },
    { x: randInt(510, 670), y: FLOOR_Y - 2, w: randInt(18, 30), h: randInt(38, 74), color: pal[1] },
    { x: randInt(760, 920), y: FLOOR_Y - 2, w: randInt(22, 36), h: randInt(48, 86), color: pal[2] },
    { x: randInt(1140, 1245), y: FLOOR_Y - 2, w: randInt(20, 32), h: randInt(46, 84), color: pal[3] }
  ];

  const mounts: Array<{ x: number; y: number; vx: number }> = [];

  if (archetype === 0) {
    // Twin mid towers + 3-tier pyramid overhang above the node
    const p1X = randInt(390, 480);
    const p1H = randInt(3, 6);
    for (let r = 0; r < p1H; r++) addBlock(p1X, FLOOR_Y - (r + 1) * BH, r === 0 ? 'stone' : pick(['dirt', 'clay', 'wood']));
    mounts.push({ x: p1X + 26, y: FLOOR_Y - p1H * BH, vx: 110 });

    const p2X = randInt(580, 680);
    const p2H = randInt(3, 5);
    for (let r = 0; r < p2H; r++) addBlock(p2X, FLOOR_Y - (r + 1) * BH, pick(['clay', 'wood', 'dirt']));
    mounts.push({ x: p2X + 26, y: FLOOR_Y - p2H * BH, vx: 115 });

    const bastionX = node.x - randInt(165, 200);
    const bastionH = randInt(2, 4);
    for (let r = 0; r < bastionH; r++) addBlock(bastionX, FLOOR_Y - (r + 1) * BH, pick(['stone', 'dirt', 'wood']));

    const lowY = Math.min(node.y - 170, randInt(310, 360));
    const midY = lowY - randInt(92, 110);
    const highY = midY - randInt(86, 100);
    const bx = node.x - 108;
    [0, 1, 2, 3].forEach((i) => addBlock(bx + i * (BW + 2), lowY, pick(['wood', 'dirt'])));
    [0, 1, 2].forEach((i) => addBlock(bx + 26 + i * (BW + 2), midY, pick(['dirt', 'wood', 'clay'])));
    [0, 1].forEach((i) => addBlock(bx + 52 + i * (BW + 2), highY, 'wood'));

    mounts.push({ x: bx + 48, y: lowY, vx: 22 });
    mounts.push({ x: bx + 152, y: lowY, vx: -22 });
    mounts.push({ x: bx + 68, y: midY, vx: 18 });
    mounts.push({ x: bx + 134, y: midY, vx: -18 });
    mounts.push({ x: bx + 98, y: highY, vx: 0 });
  } else if (archetype === 1) {
    // Staggered domino staircase descending toward the node + overhang above it
    const stepsCount = 4;
    const startX = randInt(430, 490);
    const stepSpanX = Math.floor((node.x - startX - 40) / stepsCount);
    const startY = randInt(150, 190);
    for (let s = 0; s < stepsCount; s++) {
      const sx = startX + s * stepSpanX;
      const sy = startY + s * randInt(68, 82);
      addBlock(sx, sy, pick(['wood', 'dirt']));
      addBlock(sx + BW + 2, sy, pick(['dirt', 'clay', 'wood']));
      mounts.push({ x: sx + 28, y: sy, vx: 95 });
      if (s >= 1) mounts.push({ x: sx + BW + 26, y: sy, vx: 75 });
    }
    const topY = randInt(140, 185);
    addBlock(node.x - 54, topY, 'wood');
    addBlock(node.x, topY, 'dirt');
    addBlock(node.x + 54, topY, 'wood');
    mounts.push({ x: node.x - 24, y: topY, vx: 15 });
    mounts.push({ x: node.x + 32, y: topY, vx: -15 });
  } else if (archetype === 2) {
    // Fortress wall with a weak window + twin sky islands
    const wallX = node.x - randInt(190, 240);
    for (let r = 0; r < 7; r++) {
      const wy = FLOOR_Y - (r + 1) * BH;
      const bType: BlockType = r === 3 || r === 4 ? 'dirt' : r < 2 ? 'stone' : 'clay';
      addBlock(wallX, wy, bType);
      if (r < 5 && r !== 3) addBlock(wallX + BW + 2, wy, pick(['dirt', 'wood']));
    }
    mounts.push({ x: wallX + 26, y: FLOOR_Y - 7 * BH, vx: 105 });

    const isl1X = randInt(460, 560);
    const isl1Y = randInt(230, 290);
    [0, 1, 2].forEach((i) => addBlock(isl1X + i * (BW + 2), isl1Y, pick(['wood', 'dirt'])));
    mounts.push({ x: isl1X + 40, y: isl1Y, vx: 115 });
    mounts.push({ x: isl1X + 110, y: isl1Y, vx: 95 });

    const isl2X = node.x - 130;
    const isl2LowY = Math.min(node.y - 155, randInt(300, 350));
    const isl2HighY = isl2LowY - randInt(110, 135);
    [0, 1, 2, 3, 4].forEach((i) => addBlock(isl2X + i * (BW + 2), isl2LowY, i % 2 === 0 ? 'wood' : 'dirt'));
    [1, 2, 3].forEach((i) => addBlock(isl2X + i * (BW + 2), isl2HighY, 'wood'));
    mounts.push({ x: isl2X + 55, y: isl2LowY, vx: 28 });
    mounts.push({ x: isl2X + 195, y: isl2LowY, vx: -28 });
    mounts.push({ x: isl2X + 95, y: isl2HighY, vx: 12 });
    mounts.push({ x: isl2X + 160, y: isl2HighY, vx: -12 });
  } else if (archetype === 3) {
    // Three floating sky bridges + low guard bunker
    const b1X = randInt(380, 450);
    const b1Y = randInt(320, 380);
    [0, 1].forEach((i) => addBlock(b1X + i * (BW + 2), b1Y, 'wood'));
    mounts.push({ x: b1X + 52, y: b1Y, vx: 120 });

    const b2X = randInt(610, 690);
    const b2Y = randInt(220, 275);
    [0, 1, 2].forEach((i) => addBlock(b2X + i * (BW + 2), b2Y, pick(['dirt', 'wood'])));
    mounts.push({ x: b2X + 45, y: b2Y, vx: 105 });
    mounts.push({ x: b2X + 115, y: b2Y, vx: 90 });

    const bunkX = node.x - 155;
    for (let r = 0; r < 3; r++) addBlock(bunkX, FLOOR_Y - (r + 1) * BH, r === 0 ? 'stone' : 'dirt');
    mounts.push({ x: bunkX + 26, y: FLOOR_Y - 3 * BH, vx: 80 });

    const leftWingX = node.x - 135;
    const rightWingX = node.x + 15;
    const wingY = Math.min(node.y - 175, randInt(250, 310));
    [0, 1].forEach((i) => addBlock(leftWingX + i * (BW + 2), wingY, 'dirt'));
    [0, 1].forEach((i) => addBlock(rightWingX + i * (BW + 2), wingY - 36, 'wood'));
    addBlock(node.x - 26, wingY - 115, 'wood');
    addBlock(node.x + 28, wingY - 115, 'wood');
    mounts.push({ x: leftWingX + 54, y: wingY, vx: 38 });
    mounts.push({ x: rightWingX + 48, y: wingY - 36, vx: -35 });
    mounts.push({ x: node.x + 2, y: wingY - 115, vx: 0 });
  } else {
    // Canyon valley pillars + ceiling drop-chute above the node
    const cols = [randInt(360, 410), randInt(520, 575), randInt(690, 745)];
    cols.forEach((cx, idx) => {
      const ch = randInt(2, 5);
      for (let r = 0; r < ch; r++) addBlock(cx, FLOOR_Y - (r + 1) * BH, r === 0 ? 'stone' : pick(['clay', 'dirt', 'wood']));
      if (idx > 0) mounts.push({ x: cx + 26, y: FLOOR_Y - ch * BH, vx: 105 });
    });

    const chuteLeftX = node.x - 112;
    const chuteRightX = node.x + 60;
    const chuteBaseY = Math.min(node.y - 150, randInt(320, 365));
    for (let r = 0; r < 3; r++) {
      addBlock(chuteLeftX, chuteBaseY - r * BH, r === 0 ? 'wood' : 'dirt');
      addBlock(chuteRightX, chuteBaseY - r * BH, r === 0 ? 'wood' : 'dirt');
    }
    addBlock(node.x - 56, chuteBaseY, 'dirt');
    addBlock(node.x, chuteBaseY, 'dirt');
    addBlock(node.x - 56, chuteBaseY - 3 * BH, 'wood');
    addBlock(node.x, chuteBaseY - 3 * BH, 'wood');
    mounts.push({ x: node.x - 32, y: chuteBaseY, vx: 12 });
    mounts.push({ x: node.x + 28, y: chuteBaseY, vx: -12 });
    mounts.push({ x: node.x - 28, y: chuteBaseY - 3 * BH, vx: 15 });
    mounts.push({ x: node.x + 26, y: chuteBaseY - 3 * BH, vx: -15 });
    mounts.push({ x: chuteLeftX + 26, y: chuteBaseY - 3 * BH, vx: 45 });
  }

  // Seven falling objects (+2 crush hits) perched on the generated mount points
  const fallingObjects: FallingObjectDef[] = [];
  for (let i = 0; i < 7; i++) {
    const mp = mounts[i % mounts.length];
    const sp = OBJ_SPECS[(i + archetype + randInt(0, 3)) % OBJ_SPECS.length];
    fallingObjects.push({
      id: `g${seed}_obj${i}`,
      kind: sp.kind,
      name: sp.name,
      x: mp.x,
      y: mp.y - sp.radius,
      vx: mp.vx,
      vy: 0,
      radius: sp.radius,
      color: sp.color,
      accent: sp.accent,
      nodeHitsRemaining: 2
    });
  }

  // Opening birds (stage 1 has none; shielding is applied by the controller per stage rules)
  const birdCount = stage < 2 ? 0 : Math.min(5, 3 + Math.floor(Math.max(0, stage - 3) / 2));
  const initialBirds: BirdDef[] = [];
  for (let b = 0; b < birdCount; b++) {
    initialBirds.push({
      id: `g${seed}_bird${b}`,
      x: 720 + b * randInt(160, 220),
      y: randInt(85, 340),
      vx: -(130 + rand() * 35),
      vy: 0,
      plane: 'horizontal',
      radius: BIRD_RADIUS,
      waveAmp: 10 + rand() * 12,
      waveFreq: 2.3 + rand() * 1.6,
      shielded: false
    });
  }

  return {
    worldWidth: WORLD_W,
    worldHeight: WORLD_H,
    floorY: FLOOR_Y,
    gravity: 980,
    targetScore: 7,
    lobCost: stage >= 5 ? 1 : 0,
    dwarfSpawn: {
      x: 129,
      y: steps[1] - 34,
      minX: DWARF_STANCES_X[0],
      maxX: DWARF_STANCES_X[2],
      ledgeTop: steps[1],
      leftStepTop: steps[0],
      centerStepTop: steps[1],
      rightStepTop: steps[2]
    },
    miningNode: node,
    blocks,
    fallingObjects,
    initialBirds,
    birdSpawnInterval: { min: 2.2, max: 4.0 },
    bgCrystals,
    archetypeId: archetype,
    archetypeName: ARENA_ARCHETYPE_NAMES[archetype],
    seed,
    directShots: 0
  };
}

function rectsOverlap(a: BlockDef, b: BlockDef): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function circleHitsRect(cx: number, cy: number, r: number, b: BlockDef): boolean {
  const nx = Math.max(b.x, Math.min(cx, b.x + b.w));
  const ny = Math.max(b.y, Math.min(cy, b.y + b.h));
  const dx = cx - nx;
  const dy = cy - ny;
  return dx * dx + dy * dy <= r * r;
}

function isLayoutValid(level: GeneratedArenaLevel): boolean {
  const node = level.miningNode;
  const blocks = level.blocks;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    // Inside the arena, clear of the dwarf's ledge and the ceiling stalactites
    if (b.x < LEDGE_RIGHT + 20 || b.x + b.w > WORLD_W - 4 || b.y < 70 || b.y + b.h > FLOOR_Y) return false;
    for (let j = i + 1; j < blocks.length; j++) {
      if (rectsOverlap(b, blocks[j])) return false;
    }
    // Nothing may intrude into the node (pedestal blocks sit just below it)
    if (circleHitsRect(node.x, node.y, node.radius - 6, b)) return false;
  }
  return true;
}

/**
 * Sweeps throws from all three stances (angles 15-80, power 25-100) with the game's
 * launch/gravity model and counts trajectories that reach the node without touching
 * a block. Blocks are destructible, so this measures "fair from the first throw",
 * not "possible at all".
 */
function countDirectShots(level: GeneratedArenaLevel): number {
  const node = level.miningNode;
  const hitDist = PICK_RADIUS + node.radius - 4;
  const spawn = level.dwarfSpawn;
  const dt = 1 / 60;
  let hits = 0;

  for (const sx of DWARF_STANCES_X) {
    const surface = sx < 98 ? spawn.leftStepTop! : sx > 160 ? spawn.rightStepTop! : spawn.centerStepTop!;
    const ox = sx + 24;
    const oy = surface - 34 - 14;
    for (let angle = 15; angle <= 80; angle += 3) {
      const rad = (angle * Math.PI) / 180;
      for (let power = 25; power <= 100; power += 5) {
        const speed = 440 + (power / 100) * 800;
        let x = ox;
        let y = oy;
        let vx = Math.cos(rad) * speed;
        let vy = -Math.sin(rad) * speed;
        for (let step = 0; step < 360; step++) {
          vy += PICK_GRAVITY * dt;
          x += vx * dt;
          y += vy * dt;
          if (y + PICK_RADIUS >= FLOOR_Y || x > WORLD_W + 80) break;
          if (Math.hypot(x - node.x, y - node.y) < hitDist) {
            hits++;
            break;
          }
          let blocked = false;
          for (const b of level.blocks) {
            if (circleHitsRect(x, y, PICK_RADIUS, b)) {
              blocked = true;
              break;
            }
          }
          if (blocked) break;
        }
      }
    }
  }
  return hits;
}
