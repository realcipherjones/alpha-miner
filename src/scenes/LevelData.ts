/**
 * LevelData.ts
 * Complete level definitions for all 10 Maps across BOTH game modes:
 * - Mode 1: "Manual Faucet" (Arena Tosser Mode) - 1280x645 arena with original physics,
 *   archetypes (Twin Towers, Domino Staircase, Fortress Wall, Sky Bridges, Canyon Chute),
 *   stepped stance tiers, shielded birds, and Level 5+ Pay-to-Play 1-KII lob cost.
 * - Mode 2: "Side-Scroller" (Platformer Mode) - Wide side-scrolling stages (2800px to 3600px)
 *   with ledges, destructible blocks, perched physics objects, moving platforms, hazards,
 *   intermediate ore veins, and Grand Mining Node goal (7+ KII).
 *   Maps 6–10 feature HALF GRAVITY (490 px/s^2) for low-g moon-jumps!
 *
 * Compatible with Node v24 `--experimental-strip-types` (no enums, no parameter properties).
 */

// ---------------------------------------------------------------------------
// Core Types & Constants
// ---------------------------------------------------------------------------

export const GameMode = {
  Tosser: 'tosser',
  Platformer: 'platformer'
} as const;
export type GameModeType = (typeof GameMode)[keyof typeof GameMode];

export const BiomeCategory = {
  Fantasy: 'fantasy',
  Space: 'space'
} as const;
export type BiomeCategoryType = (typeof BiomeCategory)[keyof typeof BiomeCategory];

export const HazardType = {
  Spikes: 'spikes',
  Lava: 'lava',
  Void: 'void',
  Acid: 'acid',
  CosmicRadiation: 'cosmic_radiation'
} as const;
export type HazardKind = (typeof HazardType)[keyof typeof HazardType];

export interface BlockDef {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  type: 'dirt' | 'wood' | 'clay' | 'stone';
  hp: number;
  maxHp: number;
}

export interface FallingObjectDef {
  id: string;
  kind: 'anvil' | 'boulder' | 'cart' | 'barrel';
  name: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  color: string;
  accent: string;
  nodeHitsRemaining: number;
  roll?: number; // horizontal distance travelled (drives sprite rotation)
  moving?: boolean; // moved this frame (keg fuse burns)
}

// Hit radius of a bird (pseudodragon), sized to its body plus wing roots
export const BIRD_RADIUS = 23;

export interface BirdDef {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  plane: 'horizontal' | 'vertical';
  radius: number;
  waveAmp: number;
  waveFreq: number;
  shielded: boolean;
  isInterceptor?: boolean;
}

export interface MovingPlatformDef {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  speed: number;
}

export interface HazardDef {
  id: string;
  type: HazardKind;
  x: number;
  y: number;
  w: number;
  h: number;
  damage?: number;
}

export interface MiningNodeDef {
  id?: string;
  x: number;
  y: number;
  radius: number;
  isGrandNode?: boolean;
  value?: number; // KII coins rewarded
}

export interface DwarfSpawnDef {
  x: number;
  y: number;
  minX?: number;
  maxX?: number;
  ledgeTop?: number;
  leftStepTop?: number;
  centerStepTop?: number;
  rightStepTop?: number;
}

export interface BackgroundCrystalDef {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
}

export interface TosserArenaLevel {
  worldWidth: number;
  worldHeight: number;
  floorY: number;
  gravity: number;
  targetScore: number;
  lobCost: number; // 0 for maps 1-4, 1 for maps 5+
  dwarfSpawn: DwarfSpawnDef;
  miningNode: MiningNodeDef;
  blocks: BlockDef[];
  fallingObjects: FallingObjectDef[];
  initialBirds: BirdDef[];
  birdSpawnInterval: { min: number; max: number };
  bgCrystals: BackgroundCrystalDef[];
  archetypeId?: number;
}

export interface PlatformerLevel {
  worldWidth: number;
  worldHeight: number;
  floorY: number;
  gravity: number; // 980 for maps 1-5, 490 for maps 6-10 (Half Gravity!)
  jumpVelocity: number; // sized per map so the tallest wall is jumpable: v = sqrt(2 * g * (wallHeight + ~30))
  runSpeed: number;
  dwarfSpawn: DwarfSpawnDef;
  grandMiningNode: MiningNodeDef;
  intermediateNodes: MiningNodeDef[];
  blocks: BlockDef[];
  fallingObjects: FallingObjectDef[];
  patrolBirds: BirdDef[];
  movingPlatforms: MovingPlatformDef[];
  hazards: HazardDef[];
  checkpoints: Array<{ x: number; y: number }>;
  goalKII: number;
}

export interface MapDefinition {
  mapId: number;
  name: string;
  subtitle: string;
  bgImagePath: string;
  isSpace: boolean;
  biome: BiomeCategoryType;
  themeName: string;
  arenaLevel: TosserArenaLevel;
  platformerLevel: PlatformerLevel;
}

// ---------------------------------------------------------------------------
// Helpers to Build Level Blocks & Objects
// ---------------------------------------------------------------------------

const BW = 52;
const BH = 36;
const FLOOR_Y = 641;

function makeBlock(
  id: string,
  colX: number,
  rowY: number,
  type: 'dirt' | 'wood' | 'clay' | 'stone'
): BlockDef {
  const hp = type === 'clay' || type === 'stone' ? 2 : 1;
  return {
    id,
    x: colX,
    y: rowY,
    w: BW,
    h: BH,
    type,
    hp,
    maxHp: hp
  };
}

function makeFallingObj(
  id: string,
  kind: 'anvil' | 'boulder' | 'cart' | 'barrel',
  x: number,
  y: number,
  vx: number = 0,
  name?: string
): FallingObjectDef {
  const specs = {
    anvil: { name: name || 'Iron Anvil', radius: 22, color: '#1e293b', accent: '#38bdf8' },
    boulder: { name: name || 'Granite Boulder', radius: 23, color: '#78716c', accent: '#d6d3d1' },
    cart: { name: name || 'Loaded Ore Cart', radius: 22, color: '#b45309', accent: '#fbbf24' },
    barrel: { name: name || 'Powder Keg', radius: 20, color: '#991b1b', accent: '#fca5a5' }
  };
  const sp = specs[kind];
  return {
    id,
    kind,
    name: sp.name,
    x,
    y,
    vx,
    vy: 0,
    radius: sp.radius,
    color: sp.color,
    accent: sp.accent,
    nodeHitsRemaining: 2
  };
}

// ---------------------------------------------------------------------------
// 10 MAP DEFINITIONS
// ---------------------------------------------------------------------------

// --- MAP 1: Mining Cavern ---
function buildMap1(): MapDefinition {
  // Tosser blocks
  const blocks: BlockDef[] = [];
  let bId = 0;

  // Central barrier ridge (x: 510, 564, 618)
  for (let r = 0; r < 6; r++) {
    const y = FLOOR_Y - (r + 1) * BH;
    blocks.push(makeBlock(`m1_c1_${bId++}`, 510, y, r < 2 ? 'stone' : r < 4 ? 'clay' : 'dirt'));
    blocks.push(makeBlock(`m1_c2_${bId++}`, 564, y, r < 2 ? 'clay' : 'dirt'));
  }
  blocks.push(makeBlock(`m1_c3_${bId++}`, 618, FLOOR_Y - 4 * BH, 'wood'));
  blocks.push(makeBlock(`m1_c4_${bId++}`, 618, FLOOR_Y - 5 * BH, 'dirt'));

  // Front guard wall in front of node (x: 875, 929)
  for (let r = 0; r < 4; r++) {
    const y = FLOOR_Y - (r + 1) * BH;
    blocks.push(makeBlock(`m1_g1_${bId++}`, 875, y, r === 0 ? 'stone' : 'dirt'));
    if (r < 3) blocks.push(makeBlock(`m1_g2_${bId++}`, 929, y, 'dirt'));
  }

  // Suspended wood & dirt shelf above node (x: 965..1127 at y=310, 274)
  [965, 1019, 1073, 1127].forEach((cx, idx) => {
    blocks.push(makeBlock(`m1_sh1_${bId++}`, cx, 310, idx === 0 || idx === 3 ? 'wood' : 'dirt'));
    blocks.push(makeBlock(`m1_sh2_${bId++}`, cx, 274, 'dirt'));
  });

  // Upper bonus double-tier overhang
  blocks.push(makeBlock(`m1_top1_${bId++}`, 1019, 165, 'wood'));
  blocks.push(makeBlock(`m1_top2_${bId++}`, 1073, 165, 'wood'));

  // Upper mid sky-bridge holding ore cart
  blocks.push(makeBlock(`m1_br1_${bId++}`, 735, 350, 'wood'));
  blocks.push(makeBlock(`m1_br2_${bId++}`, 789, 350, 'wood'));
  blocks.push(makeBlock(`m1_br3_${bId++}`, 735, 314, 'dirt'));
  blocks.push(makeBlock(`m1_br4_${bId++}`, 789, 314, 'dirt'));

  const fallingObjects: FallingObjectDef[] = [
    makeFallingObj('m1_anvil_1', 'anvil', 1015, 274 - 22, 10, 'Iron Anvil'),
    makeFallingObj('m1_boulder_1', 'boulder', 1078, 274 - 24, -8, 'Granite Boulder'),
    makeFallingObj('m1_boulder_2', 'boulder', 1138, 274 - 21, -28, 'Heavy Geode'),
    makeFallingObj('m1_anvil_top', 'anvil', 1052, 165 - 22, 0, 'Crown Anvil'),
    makeFallingObj('m1_cart_1', 'cart', 785, 314 - 22, 95, 'Loaded Ore Cart'),
    makeFallingObj('m1_boulder_ridge', 'boulder', 576, FLOOR_Y - 6 * BH - 22, 95, 'Ridge Boulder'),
    makeFallingObj('m1_barrel_1', 'barrel', 948, FLOOR_Y - 3 * BH - 20, 75, 'Mining Keg')
  ];

  // Platformer level layout for Map 1
  const platBlocks: BlockDef[] = [];
  let pbId = 0;
  // Introductory ledge barrier (x: 600)
  for (let r = 0; r < 4; r++) platBlocks.push(makeBlock(`p1_w1_${pbId++}`, 600, 680 - (r + 1) * BH, r === 0 ? 'wood' : 'dirt'));
  // High shelf with perched boulder before the dirt wall guarding Ore Vein 1 (ends short of the wall so it can be jumped)
  [1120, 1172, 1224].forEach(cx => platBlocks.push(makeBlock(`p1_sh1_${pbId++}`, cx, 420, 'wood')));
  for (let r = 0; r < 5; r++) platBlocks.push(makeBlock(`p1_w2_${pbId++}`, 1350, 680 - (r + 1) * BH, r < 2 ? 'stone' : 'clay'));
  // Chasm bridge over spikes guarding Ore Vein 2
  [1900, 1952, 2004, 2056].forEach(cx => platBlocks.push(makeBlock(`p1_sh2_${pbId++}`, cx, 360, 'dirt')));
  for (let r = 0; r < 6; r++) platBlocks.push(makeBlock(`p1_w3_${pbId++}`, 2250, 680 - (r + 1) * BH, r < 2 ? 'stone' : 'wood'));

  return {
    mapId: 1,
    name: 'Mining Cavern',
    subtitle: 'Strike rich in the deep earthen cavern. Lob pickaxes and collapse high shelves for +2 double hits!',
    bgImagePath: '../bg1.png',
    isSpace: false,
    biome: BiomeCategory.Fantasy,
    themeName: 'Cavern Earth',
    arenaLevel: {
      worldWidth: 1280,
      worldHeight: 645,
      floorY: FLOOR_Y,
      gravity: 980,
      targetScore: 7,
      lobCost: 0,
      dwarfSpawn: { x: 129, y: 481, minX: 58, maxX: 200, ledgeTop: 515 },
      miningNode: { x: 1075, y: 582, radius: 50, value: 1 },
      blocks,
      fallingObjects,
      initialBirds: [],
      birdSpawnInterval: { min: 999, max: 999 }, // No birds on Map 1
      bgCrystals: [
        { x: 310, y: FLOOR_Y - 2, w: 26, h: 58, color: '#312e81' },
        { x: 335, y: FLOOR_Y - 2, w: 18, h: 38, color: '#4338ca' },
        { x: 780, y: FLOOR_Y - 2, w: 30, h: 64, color: '#1e3a8a' },
        { x: 1205, y: FLOOR_Y - 2, w: 28, h: 72, color: '#3b0764' }
      ]
    },
    platformerLevel: {
      worldWidth: 2800,
      worldHeight: 720,
      floorY: 680,
      gravity: 980,
      jumpVelocity: -700, // clears 6-block walls (216px) with ~30px spare
      runSpeed: 260,
      dwarfSpawn: { x: 120, y: 560 },
      grandMiningNode: { x: 2650, y: 580, radius: 50, isGrandNode: true, value: 5 },
      intermediateNodes: [
        { id: 'p1_node_1', x: 1400, y: 530, radius: 32, value: 2 },
        { id: 'p1_node_2', x: 2150, y: 420, radius: 32, value: 2 }
      ],
      blocks: platBlocks,
      fallingObjects: [
        makeFallingObj('p1_boulder_1', 'boulder', 1170, 420 - 24, 60, 'Trap Boulder'),
        makeFallingObj('p1_anvil_1', 'anvil', 1980, 360 - 22, 45, 'Chasm Anvil')
      ],
      patrolBirds: [],
      movingPlatforms: [
        { id: 'p1_plat_1', x: 1650, y: 500, w: 90, h: 18, startX: 1600, startY: 500, endX: 1800, endY: 500, speed: 70 }
      ],
      hazards: [
        { id: 'p1_spikes_1', type: HazardType.Spikes, x: 1550, y: 660, w: 280, h: 20, damage: 1 }
      ],
      checkpoints: [{ x: 1000, y: 580 }, { x: 1850, y: 580 }],
      goalKII: 7
    }
  };
}

// --- MAP 2: Sky Cavern Roost ---
function buildMap2(): MapDefinition {
  const blocks: BlockDef[] = [];
  let bId = 0;

  // Stepped twin pillars in mid-field (x: 480, 680)
  for (let r = 0; r < 5; r++) blocks.push(makeBlock(`m2_p1_${bId++}`, 480, FLOOR_Y - (r + 1) * BH, r < 2 ? 'stone' : 'dirt'));
  for (let r = 0; r < 4; r++) blocks.push(makeBlock(`m2_p2_${bId++}`, 680, FLOOR_Y - (r + 1) * BH, r === 0 ? 'stone' : 'wood'));

  // Front tunneled bastion (x: 885, 939)
  for (let r = 0; r < 4; r++) {
    blocks.push(makeBlock(`m2_b1_${bId++}`, 885, FLOOR_Y - (r + 1) * BH, r === 0 ? 'clay' : 'dirt'));
    if (r < 2) blocks.push(makeBlock(`m2_b2_${bId++}`, 939, FLOOR_Y - (r + 1) * BH, 'dirt'));
  }

  // Three cascading shelves above Node (y=340, 235, 130)
  [975, 1029, 1083, 1137].forEach(cx => blocks.push(makeBlock(`m2_s1_${bId++}`, cx, 340, 'wood')));
  [1002, 1056, 1110].forEach(cx => blocks.push(makeBlock(`m2_s2_${bId++}`, cx, 235, 'dirt')));
  [1029, 1083].forEach(cx => blocks.push(makeBlock(`m2_s3_${bId++}`, cx, 130, 'wood')));

  const fallingObjects: FallingObjectDef[] = [
    makeFallingObj('m2_anvil_low', 'anvil', 1025, 340 - 22, 20, 'Forged Anvil'),
    makeFallingObj('m2_boulder_low', 'boulder', 1115, 340 - 23, -20, 'Cavern Boulder'),
    makeFallingObj('m2_cart_mid', 'cart', 1045, 235 - 22, 15, 'Gold Ore Cart'),
    makeFallingObj('m2_barrel_mid', 'barrel', 1110, 235 - 20, -18, 'Powder Keg'),
    makeFallingObj('m2_anvil_high', 'anvil', 1075, 130 - 22, 0, 'Sky Anvil'),
    makeFallingObj('m2_cart_pillar', 'cart', 705, FLOOR_Y - 4 * BH - 22, 110, 'Ridge Cart')
  ];

  const initialBirds: BirdDef[] = [
    { id: 'b2_1', x: 820, y: 175, vx: -140, vy: 0, plane: 'horizontal', radius: BIRD_RADIUS, waveAmp: 14, waveFreq: 2.5, shielded: false },
    { id: 'b2_2', x: 1080, y: 295, vx: -160, vy: 0, plane: 'horizontal', radius: BIRD_RADIUS, waveAmp: 12, waveFreq: 2.8, shielded: false },
    { id: 'b2_3', x: 1240, y: 115, vx: -130, vy: 0, plane: 'horizontal', radius: BIRD_RADIUS, waveAmp: 16, waveFreq: 2.2, shielded: false }
  ];

  // Platformer blocks
  const platBlocks: BlockDef[] = [];
  let pbId = 0;
  for (let r = 0; r < 5; r++) platBlocks.push(makeBlock(`p2_w1_${pbId++}`, 750, 680 - (r + 1) * BH, 'wood'));
  [1300, 1352, 1404].forEach(cx => platBlocks.push(makeBlock(`p2_sh1_${pbId++}`, cx, 400, 'dirt')));
  for (let r = 0; r < 6; r++) platBlocks.push(makeBlock(`p2_w2_${pbId++}`, 1750, 680 - (r + 1) * BH, r < 2 ? 'stone' : 'clay'));
  [2150, 2202, 2254].forEach(cx => platBlocks.push(makeBlock(`p2_sh2_${pbId++}`, cx, 340, 'wood')));

  return {
    mapId: 2,
    name: 'Sky Cavern Roost',
    subtitle: 'Blue patrol eagles soar across the high roost! Time your lobs past them or trigger cascading combos.',
    bgImagePath: '../bg2.png',
    isSpace: false,
    biome: BiomeCategory.Fantasy,
    themeName: 'Eagle Roost',
    arenaLevel: {
      worldWidth: 1280,
      worldHeight: 645,
      floorY: FLOOR_Y,
      gravity: 980,
      targetScore: 7,
      lobCost: 0,
      dwarfSpawn: { x: 129, y: 481, minX: 58, maxX: 200, ledgeTop: 515 },
      miningNode: { x: 1085, y: 582, radius: 50, value: 1 },
      blocks,
      fallingObjects,
      initialBirds,
      birdSpawnInterval: { min: 2.4, max: 4.0 },
      bgCrystals: [
        { x: 310, y: FLOOR_Y - 2, w: 26, h: 58, color: '#064e3b' },
        { x: 335, y: FLOOR_Y - 2, w: 18, h: 38, color: '#047857' },
        { x: 780, y: FLOOR_Y - 2, w: 30, h: 64, color: '#115e59' },
        { x: 1205, y: FLOOR_Y - 2, w: 28, h: 72, color: '#134e4a' }
      ]
    },
    platformerLevel: {
      worldWidth: 2900,
      worldHeight: 720,
      floorY: 680,
      gravity: 980,
      jumpVelocity: -700, // clears 6-block walls
      runSpeed: 260,
      dwarfSpawn: { x: 120, y: 560 },
      grandMiningNode: { x: 2750, y: 580, radius: 50, isGrandNode: true, value: 5 },
      intermediateNodes: [
        { id: 'p2_node_1', x: 1100, y: 500, radius: 32, value: 2 },
        { id: 'p2_node_2', x: 1950, y: 420, radius: 32, value: 2 }
      ],
      blocks: platBlocks,
      fallingObjects: [
        makeFallingObj('p2_keg_1', 'barrel', 1350, 400 - 20, 50, 'Roost Powder Keg'),
        makeFallingObj('p2_anvil_1', 'anvil', 2200, 340 - 22, -40, 'Crown Anvil')
      ],
      patrolBirds: [
        { id: 'p2_bird_1', x: 1000, y: 280, vx: -120, vy: 0, plane: 'horizontal', radius: BIRD_RADIUS, waveAmp: 16, waveFreq: 2.5, shielded: false },
        { id: 'p2_bird_2', x: 2100, y: 260, vx: -140, vy: 0, plane: 'horizontal', radius: BIRD_RADIUS, waveAmp: 18, waveFreq: 2.8, shielded: false }
      ],
      movingPlatforms: [
        { id: 'p2_plat_1', x: 1450, y: 480, w: 90, h: 18, startX: 1400, startY: 480, endX: 1650, endY: 480, speed: 75 }
      ],
      hazards: [
        { id: 'p2_spikes_1', type: HazardType.Spikes, x: 1400, y: 660, w: 300, h: 20, damage: 1 }
      ],
      checkpoints: [{ x: 950, y: 580 }, { x: 1850, y: 580 }],
      goalKII: 7
    }
  };
}

// --- MAP 3: Astral Cobalt Caverns ---
function buildMap3(): MapDefinition {
  const blocks: BlockDef[] = [];
  let bId = 0;
  // Archetype 0: Twin Mid Towers + Pyramid Overhang
  for (let r = 0; r < 5; r++) blocks.push(makeBlock(`m3_t1_${bId++}`, 440, FLOOR_Y - (r + 1) * BH, r === 0 ? 'stone' : 'clay'));
  for (let r = 0; r < 4; r++) blocks.push(makeBlock(`m3_t2_${bId++}`, 640, FLOOR_Y - (r + 1) * BH, 'wood'));
  for (let r = 0; r < 3; r++) blocks.push(makeBlock(`m3_b1_${bId++}`, 880, FLOOR_Y - (r + 1) * BH, 'stone'));
  // 3-Tier Pyramid over Node (x: 1060)
  [0, 1, 2, 3].forEach(i => blocks.push(makeBlock(`m3_pyr_l1_${bId++}`, 950 + i * (BW + 2), 340, i % 2 === 0 ? 'wood' : 'dirt')));
  [0, 1, 2].forEach(i => blocks.push(makeBlock(`m3_pyr_l2_${bId++}`, 976 + i * (BW + 2), 245, 'dirt')));
  [0, 1].forEach(i => blocks.push(makeBlock(`m3_pyr_l3_${bId++}`, 1002 + i * (BW + 2), 150, 'wood')));

  const fallingObjects: FallingObjectDef[] = [
    makeFallingObj('m3_anvil_low', 'anvil', 998, 340 - 22, 22, 'Astral Anvil'),
    makeFallingObj('m3_boulder_low', 'boulder', 1102, 340 - 23, -22, 'Cobalt Boulder'),
    makeFallingObj('m3_cart_mid', 'cart', 1018, 245 - 22, 18, 'Starlight Cart'),
    makeFallingObj('m3_barrel_mid', 'barrel', 1084, 245 - 20, -18, 'Plasma Keg'),
    makeFallingObj('m3_anvil_high', 'anvil', 1048, 150 - 22, 0, 'Crown Anvil'),
    makeFallingObj('m3_tower_cart', 'cart', 466, FLOOR_Y - 5 * BH - 22, 110, 'Tower Cart'),
    makeFallingObj('m3_bastion_keg', 'barrel', 666, FLOOR_Y - 4 * BH - 20, 105, 'Bastion Keg')
  ];

  const initialBirds: BirdDef[] = [
    { id: 'b3_1', x: 740, y: 160, vx: -130, vy: 0, plane: 'horizontal', radius: BIRD_RADIUS, waveAmp: 14, waveFreq: 2.4, shielded: true },
    { id: 'b3_2', x: 960, y: 260, vx: -150, vy: 0, plane: 'horizontal', radius: BIRD_RADIUS, waveAmp: 16, waveFreq: 2.7, shielded: true },
    { id: 'b3_3', x: 1180, y: 120, vx: -135, vy: 0, plane: 'horizontal', radius: BIRD_RADIUS, waveAmp: 18, waveFreq: 2.2, shielded: true }
  ];

  // Platformer blocks
  const platBlocks: BlockDef[] = [];
  let pbId = 0;
  for (let r = 0; r < 6; r++) platBlocks.push(makeBlock(`p3_w1_${pbId++}`, 800, 680 - (r + 1) * BH, r < 2 ? 'stone' : 'clay'));
  [1250, 1302, 1354, 1406].forEach(cx => platBlocks.push(makeBlock(`p3_sh1_${pbId++}`, cx, 380, 'wood')));
  for (let r = 0; r < 5; r++) platBlocks.push(makeBlock(`p3_w2_${pbId++}`, 1800, 680 - (r + 1) * BH, 'dirt'));
  [2200, 2252, 2304].forEach(cx => platBlocks.push(makeBlock(`p3_sh2_${pbId++}`, cx, 320, 'dirt')));

  return {
    mapId: 3,
    name: 'Astral Cobalt Caverns',
    subtitle: 'Stepped elevation staircase & glowing shielded eagles! Bounced axes supercharge into infinite rebounds.',
    bgImagePath: '../bg3.png',
    isSpace: false,
    biome: BiomeCategory.Fantasy,
    themeName: 'Cobalt Crystal',
    arenaLevel: {
      worldWidth: 1280,
      worldHeight: 645,
      floorY: FLOOR_Y,
      gravity: 980,
      targetScore: 7,
      lobCost: 0,
      dwarfSpawn: {
        x: 129,
        y: 481,
        minX: 58,
        maxX: 200,
        leftStepTop: 467,
        centerStepTop: 515,
        rightStepTop: 563
      },
      miningNode: { x: 1060, y: 582, radius: 50, value: 1 },
      blocks,
      fallingObjects,
      initialBirds,
      birdSpawnInterval: { min: 2.2, max: 3.8 },
      bgCrystals: [
        { x: 320, y: FLOOR_Y - 2, w: 26, h: 62, color: '#0369a1' },
        { x: 580, y: FLOOR_Y - 2, w: 24, h: 54, color: '#1d4ed8' },
        { x: 840, y: FLOOR_Y - 2, w: 32, h: 72, color: '#0284c7' },
        { x: 1190, y: FLOOR_Y - 2, w: 28, h: 68, color: '#38bdf8' }
      ],
      archetypeId: 0
    },
    platformerLevel: {
      worldWidth: 3000,
      worldHeight: 720,
      floorY: 680,
      gravity: 980,
      jumpVelocity: -700, // clears 6-block walls
      runSpeed: 260,
      dwarfSpawn: { x: 120, y: 560 },
      grandMiningNode: { x: 2850, y: 580, radius: 50, isGrandNode: true, value: 5 },
      intermediateNodes: [
        { id: 'p3_node_1', x: 1000, y: 520, radius: 32, value: 2 },
        { id: 'p3_node_2', x: 1850, y: 440, radius: 32, value: 2 }
      ],
      blocks: platBlocks,
      fallingObjects: [
        makeFallingObj('p3_anv_1', 'anvil', 1330, 380 - 22, 60, 'Cobalt Anvil'),
        makeFallingObj('p3_bld_1', 'boulder', 2250, 320 - 23, -50, 'Craggy Boulder')
      ],
      patrolBirds: [
        { id: 'p3_bird_1', x: 1100, y: 260, vx: -125, vy: 0, plane: 'horizontal', radius: BIRD_RADIUS, waveAmp: 16, waveFreq: 2.6, shielded: true },
        { id: 'p3_bird_2', x: 2000, y: 220, vx: -140, vy: 0, plane: 'horizontal', radius: BIRD_RADIUS, waveAmp: 18, waveFreq: 2.8, shielded: true }
      ],
      movingPlatforms: [
        { id: 'p3_plat_1', x: 1550, y: 480, w: 90, h: 18, startX: 1500, startY: 480, endX: 1720, endY: 480, speed: 80 }
      ],
      hazards: [
        { id: 'p3_acid_1', type: HazardType.Acid, x: 1500, y: 660, w: 280, h: 20, damage: 1 }
      ],
      checkpoints: [{ x: 1050, y: 580 }, { x: 1950, y: 580 }],
      goalKII: 7
    }
  };
}

// --- MAP 4: Magma Forge & Domino Steps ---
function buildMap4(): MapDefinition {
  const blocks: BlockDef[] = [];
  let bId = 0;
  // Archetype 1: Staggered Domino Staircase
  const startX = 460;
  const startY = 170;
  for (let s = 0; s < 4; s++) {
    const sx = startX + s * 135;
    const sy = startY + s * 74;
    blocks.push(makeBlock(`m4_st1_${bId++}`, sx, sy, 'wood'));
    blocks.push(makeBlock(`m4_st2_${bId++}`, sx + BW + 2, sy, 'clay'));
  }
  // High overhang directly over Node (x: 1060)
  [1006, 1060, 1114].forEach(cx => blocks.push(makeBlock(`m4_ov_${bId++}`, cx, 160, 'wood')));

  const fallingObjects: FallingObjectDef[] = [
    makeFallingObj('m4_stair_1', 'boulder', 488, 170 - 23, 95, 'Domino Boulder 1'),
    makeFallingObj('m4_stair_2', 'cart', 623, 244 - 22, 90, 'Domino Cart'),
    makeFallingObj('m4_stair_3', 'barrel', 758, 318 - 20, 85, 'Domino Keg'),
    makeFallingObj('m4_stair_4', 'anvil', 893, 392 - 22, 80, 'Domino Anvil'),
    makeFallingObj('m4_top_anvil', 'anvil', 1036, 160 - 22, 15, 'Crown Anvil'),
    makeFallingObj('m4_top_boulder', 'boulder', 1092, 160 - 23, -15, 'Crown Boulder')
  ];

  const initialBirds: BirdDef[] = [
    { id: 'b4_1', x: 760, y: 140, vx: -140, vy: 0, plane: 'horizontal', radius: BIRD_RADIUS, waveAmp: 15, waveFreq: 2.6, shielded: true },
    { id: 'b4_2', x: 1020, y: 280, vx: -160, vy: 0, plane: 'horizontal', radius: BIRD_RADIUS, waveAmp: 18, waveFreq: 2.9, shielded: true },
    { id: 'b4_3', x: 1200, y: 190, vx: -130, vy: 0, plane: 'horizontal', radius: BIRD_RADIUS, waveAmp: 14, waveFreq: 2.3, shielded: true }
  ];

  // Platformer blocks
  const platBlocks: BlockDef[] = [];
  let pbId = 0;
  for (let r = 0; r < 6; r++) platBlocks.push(makeBlock(`p4_w1_${pbId++}`, 850, 680 - (r + 1) * BH, r < 2 ? 'stone' : 'clay'));
  [1350, 1402, 1454].forEach(cx => platBlocks.push(makeBlock(`p4_sh1_${pbId++}`, cx, 360, 'clay')));
  for (let r = 0; r < 5; r++) platBlocks.push(makeBlock(`p4_w2_${pbId++}`, 1950, 680 - (r + 1) * BH, 'wood'));
  [2300, 2352, 2404].forEach(cx => platBlocks.push(makeBlock(`p4_sh2_${pbId++}`, cx, 300, 'wood')));

  return {
    mapId: 4,
    name: 'Magma Forge & Domino Steps',
    subtitle: 'Cascading domino shelves over bubbling magma. Trigger boulder chains to crash through clay barriers!',
    bgImagePath: '../bg4.png',
    isSpace: false,
    biome: BiomeCategory.Fantasy,
    themeName: 'Magma Forge',
    arenaLevel: {
      worldWidth: 1280,
      worldHeight: 645,
      floorY: FLOOR_Y,
      gravity: 980,
      targetScore: 7,
      lobCost: 0,
      dwarfSpawn: {
        x: 129,
        y: 481,
        minX: 58,
        maxX: 200,
        leftStepTop: 568,
        centerStepTop: 510,
        rightStepTop: 452
      },
      miningNode: { x: 1060, y: 582, radius: 50, value: 1 },
      blocks,
      fallingObjects,
      initialBirds,
      birdSpawnInterval: { min: 2.0, max: 3.5 },
      bgCrystals: [
        { x: 330, y: FLOOR_Y - 2, w: 28, h: 64, color: '#9f1239' },
        { x: 610, y: FLOOR_Y - 2, w: 26, h: 58, color: '#be123c' },
        { x: 880, y: FLOOR_Y - 2, w: 34, h: 76, color: '#e11d48' },
        { x: 1210, y: FLOOR_Y - 2, w: 30, h: 70, color: '#fb7185' }
      ],
      archetypeId: 1
    },
    platformerLevel: {
      worldWidth: 3100,
      worldHeight: 720,
      floorY: 680,
      gravity: 980,
      jumpVelocity: -700, // clears 6-block walls
      runSpeed: 260,
      dwarfSpawn: { x: 120, y: 560 },
      grandMiningNode: { x: 2950, y: 580, radius: 50, isGrandNode: true, value: 5 },
      intermediateNodes: [
        { id: 'p4_node_1', x: 1050, y: 520, radius: 32, value: 2 },
        { id: 'p4_node_2', x: 2050, y: 440, radius: 32, value: 2 }
      ],
      blocks: platBlocks,
      fallingObjects: [
        makeFallingObj('p4_keg_1', 'barrel', 1402, 360 - 20, 60, 'Forge Keg'),
        makeFallingObj('p4_anv_1', 'anvil', 2352, 300 - 22, -45, 'Magma Anvil')
      ],
      patrolBirds: [
        { id: 'p4_bird_1', x: 1200, y: 240, vx: -130, vy: 0, plane: 'horizontal', radius: BIRD_RADIUS, waveAmp: 16, waveFreq: 2.7, shielded: true },
        { id: 'p4_bird_2', x: 2150, y: 200, vx: -145, vy: 0, plane: 'horizontal', radius: BIRD_RADIUS, waveAmp: 18, waveFreq: 3.0, shielded: true }
      ],
      movingPlatforms: [
        { id: 'p4_plat_1', x: 1650, y: 480, w: 90, h: 18, startX: 1600, startY: 480, endX: 1820, endY: 480, speed: 85 }
      ],
      hazards: [
        { id: 'p4_lava_1', type: HazardType.Lava, x: 1550, y: 660, w: 320, h: 20, damage: 2 }
      ],
      checkpoints: [{ x: 1100, y: 580 }, { x: 2050, y: 580 }],
      goalKII: 7
    }
  };
}

// --- MAP 5: Fortress Vault of the Ancients ---
function buildMap5(): MapDefinition {
  const blocks: BlockDef[] = [];
  let bId = 0;
  // Archetype 2: Fortress Wall with Weak Window + Twin Sky Islands
  const wallX = 840;
  for (let r = 0; r < 7; r++) {
    const wy = FLOOR_Y - (r + 1) * BH;
    const bType = r === 3 || r === 4 ? 'dirt' : r < 2 ? 'stone' : 'clay';
    blocks.push(makeBlock(`m5_w1_${bId++}`, wallX, wy, bType));
    if (r < 5 && r !== 3) blocks.push(makeBlock(`m5_w2_${bId++}`, wallX + BW + 2, wy, 'dirt'));
  }
  // Floating Sky Island 1 (Mid-Left)
  [0, 1, 2].forEach(i => blocks.push(makeBlock(`m5_isl1_${bId++}`, 500 + i * (BW + 2), 260, 'wood')));
  // Wide Double-Decker Rack over Node (x: 1060)
  const isl2X = 930;
  [0, 1, 2, 3, 4].forEach(i => blocks.push(makeBlock(`m5_isl2_low_${bId++}`, isl2X + i * (BW + 2), 330, i % 2 === 0 ? 'wood' : 'dirt')));
  [1, 2, 3].forEach(i => blocks.push(makeBlock(`m5_isl2_hi_${bId++}`, isl2X + i * (BW + 2), 210, 'wood')));

  const fallingObjects: FallingObjectDef[] = [
    makeFallingObj('m5_wall_anv', 'anvil', wallX + 26, FLOOR_Y - 7 * BH - 22, 105, 'Fortress Anvil'),
    makeFallingObj('m5_isl1_cart', 'cart', 540, 260 - 22, 115, 'Sky Cart'),
    makeFallingObj('m5_isl1_bld', 'boulder', 610, 260 - 23, 95, 'Sky Boulder'),
    makeFallingObj('m5_rack_low1', 'anvil', isl2X + 55, 330 - 22, 28, 'Bastion Anvil'),
    makeFallingObj('m5_rack_low2', 'cart', isl2X + 195, 330 - 22, -28, 'Bastion Cart'),
    makeFallingObj('m5_rack_hi1', 'boulder', isl2X + 95, 210 - 23, 12, 'High Boulder'),
    makeFallingObj('m5_rack_hi2', 'barrel', isl2X + 160, 210 - 20, -12, 'High Keg')
  ];

  const initialBirds: BirdDef[] = [
    { id: 'b5_1', x: 740, y: 150, vx: -130, vy: 0, plane: 'horizontal', radius: BIRD_RADIUS, waveAmp: 14, waveFreq: 2.5, shielded: true },
    { id: 'b5_2', x: 920, y: 290, vx: -150, vy: 0, plane: 'horizontal', radius: BIRD_RADIUS, waveAmp: 16, waveFreq: 2.8, shielded: true },
    { id: 'b5_3', x: 1100, y: 130, vx: -135, vy: 0, plane: 'horizontal', radius: BIRD_RADIUS, waveAmp: 18, waveFreq: 2.2, shielded: true },
    { id: 'b5_4', x: 1220, y: 250, vx: -160, vy: 0, plane: 'horizontal', radius: BIRD_RADIUS, waveAmp: 15, waveFreq: 2.6, shielded: true }
  ];

  // Platformer blocks
  const platBlocks: BlockDef[] = [];
  let pbId = 0;
  for (let r = 0; r < 7; r++) platBlocks.push(makeBlock(`p5_w1_${pbId++}`, 900, 710 - (r + 1) * BH, r === 3 ? 'dirt' : 'stone'));
  [1450, 1502, 1554, 1606].forEach(cx => platBlocks.push(makeBlock(`p5_sh1_${pbId++}`, cx, 360, 'wood')));
  for (let r = 0; r < 7; r++) platBlocks.push(makeBlock(`p5_w2_${pbId++}`, 2050, 710 - (r + 1) * BH, r === 4 ? 'dirt' : 'stone'));
  [2450, 2502, 2554].forEach(cx => platBlocks.push(makeBlock(`p5_sh2_${pbId++}`, cx, 320, 'clay')));

  return {
    mapId: 5,
    name: 'Fortress Vault of the Ancients',
    subtitle: 'PAY-TO-PLAY ACTIVATED: Each lob costs 1 Coin! Breach the weak window or drop double-anvils.',
    bgImagePath: '../bg5.png',
    isSpace: false,
    biome: BiomeCategory.Fantasy,
    themeName: 'Ancient Fortress',
    arenaLevel: {
      worldWidth: 1280,
      worldHeight: 645,
      floorY: FLOOR_Y,
      gravity: 980,
      targetScore: 7,
      lobCost: 1, // PAY-TO-PLAY!
      dwarfSpawn: {
        x: 129,
        y: 481,
        minX: 58,
        maxX: 200,
        leftStepTop: 460,
        centerStepTop: 555,
        rightStepTop: 475
      },
      miningNode: { x: 1060, y: 582, radius: 50, value: 1 },
      blocks,
      fallingObjects,
      initialBirds,
      birdSpawnInterval: { min: 2.0, max: 3.2 },
      bgCrystals: [
        { x: 310, y: FLOOR_Y - 2, w: 26, h: 62, color: '#92400e' },
        { x: 590, y: FLOOR_Y - 2, w: 24, h: 56, color: '#b45309' },
        { x: 860, y: FLOOR_Y - 2, w: 32, h: 74, color: '#d97706' },
        { x: 1200, y: FLOOR_Y - 2, w: 28, h: 70, color: '#fbbf24' }
      ],
      archetypeId: 2
    },
    platformerLevel: {
      worldWidth: 3200,
      worldHeight: 750,
      floorY: 710,
      gravity: 980,
      jumpVelocity: -745, // clears 7-block walls (252px)
      runSpeed: 260,
      dwarfSpawn: { x: 120, y: 590 },
      grandMiningNode: { x: 3050, y: 600, radius: 50, isGrandNode: true, value: 5 },
      intermediateNodes: [
        { id: 'p5_node_1', x: 1150, y: 540, radius: 32, value: 2 },
        { id: 'p5_node_2', x: 2150, y: 460, radius: 32, value: 2 }
      ],
      blocks: platBlocks,
      fallingObjects: [
        makeFallingObj('p5_anv_1', 'anvil', 1528, 360 - 22, 55, 'Vault Anvil 1'),
        makeFallingObj('p5_anv_2', 'anvil', 2502, 320 - 22, -50, 'Vault Anvil 2')
      ],
      patrolBirds: [
        { id: 'p5_bird_1', x: 1300, y: 220, vx: -130, vy: 0, plane: 'horizontal', radius: BIRD_RADIUS, waveAmp: 16, waveFreq: 2.8, shielded: true },
        { id: 'p5_bird_2', x: 2300, y: 200, vx: -150, vy: 0, plane: 'horizontal', radius: BIRD_RADIUS, waveAmp: 18, waveFreq: 3.1, shielded: true }
      ],
      movingPlatforms: [
        { id: 'p5_plat_1', x: 1750, y: 500, w: 90, h: 18, startX: 1700, startY: 500, endX: 1950, endY: 500, speed: 85 }
      ],
      hazards: [
        { id: 'p5_spikes_1', type: HazardType.Spikes, x: 1680, y: 690, w: 320, h: 20, damage: 2 }
      ],
      checkpoints: [{ x: 1200, y: 600 }, { x: 2200, y: 600 }],
      goalKII: 7
    }
  };
}

// --- MAP 6: Lunar Outpost Base (SPACE BIOME - HALF GRAVITY 490 px/s^2) ---
function buildMap6(): MapDefinition {
  const blocks: BlockDef[] = [];
  let bId = 0;
  // Archetype 3: Floating Sky Bridges + Low Guard Bunker
  [0, 1].forEach(i => blocks.push(makeBlock(`m6_br1_${bId++}`, 410 + i * (BW + 2), 350, 'wood')));
  [0, 1, 2].forEach(i => blocks.push(makeBlock(`m6_br2_${bId++}`, 650 + i * (BW + 2), 245, 'dirt')));
  // Low guard bunker in front of Node (x: 1060)
  for (let r = 0; r < 3; r++) blocks.push(makeBlock(`m6_bk_${bId++}`, 910, FLOOR_Y - (r + 1) * BH, r === 0 ? 'stone' : 'dirt'));
  // Split wings above Node
  [0, 1].forEach(i => blocks.push(makeBlock(`m6_w_l_${bId++}`, 925 + i * (BW + 2), 280, 'dirt')));
  [0, 1].forEach(i => blocks.push(makeBlock(`m6_w_r_${bId++}`, 1075 + i * (BW + 2), 244, 'wood')));
  blocks.push(makeBlock(`m6_w_top1_${bId++}`, 1034, 165, 'wood'));
  blocks.push(makeBlock(`m6_w_top2_${bId++}`, 1088, 165, 'wood'));

  const fallingObjects: FallingObjectDef[] = [
    makeFallingObj('m6_anv_br1', 'anvil', 462, 350 - 22, 120, 'Lunar Anvil'),
    makeFallingObj('m6_cart_br2', 'cart', 695, 245 - 22, 105, 'Starlight Cart'),
    makeFallingObj('m6_keg_br2', 'barrel', 765, 245 - 20, 90, 'Plasma Keg'),
    makeFallingObj('m6_bld_bunk', 'boulder', 936, FLOOR_Y - 3 * BH - 23, 80, 'Moon Boulder'),
    makeFallingObj('m6_wing_l', 'anvil', 979, 280 - 22, 38, 'Wing Anvil'),
    makeFallingObj('m6_wing_r', 'boulder', 1123, 244 - 23, -35, 'Wing Boulder'),
    makeFallingObj('m6_wing_top', 'cart', 1062, 165 - 22, 0, 'Orbit Cart')
  ];

  const initialBirds: BirdDef[] = [
    { id: 'b6_1', x: 720, y: 150, vx: -120, vy: 0, plane: 'horizontal', radius: BIRD_RADIUS, waveAmp: 14, waveFreq: 2.2, shielded: true },
    { id: 'b6_2', x: 940, y: 270, vx: -140, vy: 0, plane: 'horizontal', radius: BIRD_RADIUS, waveAmp: 16, waveFreq: 2.5, shielded: true },
    { id: 'b6_3', x: 1120, y: 110, vx: -130, vy: 0, plane: 'horizontal', radius: BIRD_RADIUS, waveAmp: 18, waveFreq: 2.0, shielded: true }
  ];

  // Platformer blocks (wide moon-jump gaps, floating lunar stepping stones)
  const platBlocks: BlockDef[] = [];
  let pbId = 0;
  for (let r = 0; r < 5; r++) platBlocks.push(makeBlock(`p6_w1_${pbId++}`, 950, 710 - (r + 1) * BH, 'stone'));
  [1450, 1502, 1554].forEach(cx => platBlocks.push(makeBlock(`p6_sh1_${pbId++}`, cx, 420, 'wood')));
  [1750, 1802].forEach(cx => platBlocks.push(makeBlock(`p6_step_${pbId++}`, cx, 320, 'dirt')));
  for (let r = 0; r < 6; r++) platBlocks.push(makeBlock(`p6_w2_${pbId++}`, 2200, 710 - (r + 1) * BH, 'clay'));
  [2550, 2602, 2654].forEach(cx => platBlocks.push(makeBlock(`p6_sh2_${pbId++}`, cx, 360, 'wood')));

  return {
    mapId: 6,
    name: 'Lunar Outpost Base',
    subtitle: 'SPACE BIOME: Astronaut Bubble Helmet & HALF GRAVITY (490 px/s^2)! Moon-jump across crater voids.',
    bgImagePath: '../bg6.png',
    isSpace: true,
    biome: BiomeCategory.Space,
    themeName: 'Lunar Low-G',
    arenaLevel: {
      worldWidth: 1280,
      worldHeight: 645,
      floorY: FLOOR_Y,
      gravity: 980,
      targetScore: 7,
      lobCost: 1,
      dwarfSpawn: {
        x: 129,
        y: 481,
        minX: 58,
        maxX: 200,
        leftStepTop: 485,
        centerStepTop: 445,
        rightStepTop: 565
      },
      miningNode: { x: 1060, y: 582, radius: 50, value: 1 },
      blocks,
      fallingObjects,
      initialBirds,
      birdSpawnInterval: { min: 2.0, max: 3.5 },
      bgCrystals: [
        { x: 300, y: FLOOR_Y - 2, w: 26, h: 58, color: '#0284c7' },
        { x: 570, y: FLOOR_Y - 2, w: 22, h: 50, color: '#38bdf8' },
        { x: 860, y: FLOOR_Y - 2, w: 30, h: 70, color: '#7dd3fc' },
        { x: 1210, y: FLOOR_Y - 2, w: 26, h: 64, color: '#bae6fd' }
      ],
      archetypeId: 3
    },
    platformerLevel: {
      worldWidth: 3300,
      worldHeight: 750,
      floorY: 710,
      gravity: 490, // HALF GRAVITY!
      jumpVelocity: -495, // High floaty moon-jumps! Clears 6-block walls
      runSpeed: 250,
      dwarfSpawn: { x: 120, y: 590 },
      grandMiningNode: { x: 3150, y: 600, radius: 50, isGrandNode: true, value: 5 },
      intermediateNodes: [
        { id: 'p6_node_1', x: 1200, y: 530, radius: 32, value: 2 },
        { id: 'p6_node_2', x: 2200, y: 440, radius: 32, value: 2 }
      ],
      blocks: platBlocks,
      fallingObjects: [
        makeFallingObj('p6_anv_1', 'anvil', 1502, 420 - 22, 40, 'Lunar Anvil'),
        makeFallingObj('p6_bld_1', 'boulder', 2602, 360 - 23, -40, 'Meteor Boulder')
      ],
      patrolBirds: [
        { id: 'p6_bird_1', x: 1350, y: 220, vx: -110, vy: 0, plane: 'horizontal', radius: BIRD_RADIUS, waveAmp: 18, waveFreq: 2.2, shielded: true },
        { id: 'p6_bird_2', x: 2350, y: 200, vx: -125, vy: 0, plane: 'horizontal', radius: BIRD_RADIUS, waveAmp: 20, waveFreq: 2.5, shielded: true }
      ],
      movingPlatforms: [
        { id: 'p6_plat_1', x: 1900, y: 460, w: 100, h: 18, startX: 1850, startY: 460, endX: 2100, endY: 460, speed: 70 }
      ],
      hazards: [
        { id: 'p6_void_1', type: HazardType.Void, x: 1850, y: 690, w: 280, h: 30, damage: 99 }
      ],
      checkpoints: [{ x: 1250, y: 600 }, { x: 2250, y: 600 }],
      goalKII: 7
    }
  };
}

// --- MAP 7: Asteroid Mining Belt (SPACE BIOME - HALF GRAVITY 490 px/s^2) ---
function buildMap7(): MapDefinition {
  const blocks: BlockDef[] = [];
  let bId = 0;
  // Archetype 4: Canyon Valley Pillars + Ceiling Drop-Chute
  [380, 540, 710].forEach((cx, idx) => {
    const ch = 3 + idx;
    for (let r = 0; r < ch; r++) blocks.push(makeBlock(`m7_cp_${bId++}`, cx, FLOOR_Y - (r + 1) * BH, r === 0 ? 'stone' : 'clay'));
  });
  // Drop-chute funnel above Node (x: 1060)
  const cLeftX = 948;
  const cRightX = 1120;
  const cBaseY = 340;
  for (let r = 0; r < 3; r++) {
    blocks.push(makeBlock(`m7_chl_${bId++}`, cLeftX, cBaseY - r * BH, r === 0 ? 'wood' : 'dirt'));
    blocks.push(makeBlock(`m7_chr_${bId++}`, cRightX, cBaseY - r * BH, r === 0 ? 'wood' : 'dirt'));
  }
  blocks.push(makeBlock(`m7_ch_m1_${bId++}`, 1004, cBaseY, 'dirt'));
  blocks.push(makeBlock(`m7_ch_m2_${bId++}`, 1060, cBaseY, 'dirt'));
  blocks.push(makeBlock(`m7_ch_top1_${bId++}`, 1004, cBaseY - 3 * BH, 'wood'));
  blocks.push(makeBlock(`m7_ch_top2_${bId++}`, 1060, cBaseY - 3 * BH, 'wood'));

  const fallingObjects: FallingObjectDef[] = [
    makeFallingObj('m7_col_anv', 'anvil', 566, FLOOR_Y - 4 * BH - 22, 105, 'Meteor Anvil'),
    makeFallingObj('m7_col_cart', 'cart', 736, FLOOR_Y - 5 * BH - 22, 100, 'Titanium Cart'),
    makeFallingObj('m7_chute_l', 'anvil', 1028, cBaseY - 22, 12, 'Chute Anvil L'),
    makeFallingObj('m7_chute_r', 'boulder', 1088, cBaseY - 23, -12, 'Chute Boulder R'),
    makeFallingObj('m7_chute_top1', 'boulder', 1032, cBaseY - 3 * BH - 23, 15, 'Top Meteor 1'),
    makeFallingObj('m7_chute_top2', 'barrel', 1086, cBaseY - 3 * BH - 20, -15, 'Fusion Keg'),
    makeFallingObj('m7_chute_rim', 'cart', cLeftX + 26, cBaseY - 3 * BH - 22, 45, 'Chute Rim Cart')
  ];

  const initialBirds: BirdDef[] = [
    { id: 'b7_1', x: 700, y: 130, vx: -125, vy: 0, plane: 'horizontal', radius: BIRD_RADIUS, waveAmp: 16, waveFreq: 2.3, shielded: true },
    { id: 'b7_2', x: 920, y: 250, vx: -145, vy: 0, plane: 'horizontal', radius: BIRD_RADIUS, waveAmp: 18, waveFreq: 2.6, shielded: true },
    { id: 'b7_3', x: 1140, y: 100, vx: -130, vy: 0, plane: 'horizontal', radius: BIRD_RADIUS, waveAmp: 15, waveFreq: 2.1, shielded: true },
    { id: 'b7_4', x: 1240, y: 220, vx: -155, vy: 0, plane: 'horizontal', radius: BIRD_RADIUS, waveAmp: 17, waveFreq: 2.7, shielded: true }
  ];

  // Platformer blocks (vertical asteroid launch shafts)
  const platBlocks: BlockDef[] = [];
  let pbId = 0;
  for (let r = 0; r < 7; r++) platBlocks.push(makeBlock(`p7_w1_${pbId++}`, 1000, 710 - (r + 1) * BH, 'stone'));
  [1400, 1452, 1504, 1556].forEach(cx => platBlocks.push(makeBlock(`p7_sh1_${pbId++}`, cx, 380, 'clay')));
  for (let r = 0; r < 6; r++) platBlocks.push(makeBlock(`p7_w2_${pbId++}`, 2150, 710 - (r + 1) * BH, 'dirt'));
  [2500, 2552, 2604].forEach(cx => platBlocks.push(makeBlock(`p7_sh2_${pbId++}`, cx, 340, 'wood')));

  return {
    mapId: 7,
    name: 'Asteroid Mining Belt',
    subtitle: 'SPACE BIOME: Deep asteroid canyon & vertical drop-chute funnel. Half-gravity enables soaring vertical launches!',
    bgImagePath: '../bg7.png',
    isSpace: true,
    biome: BiomeCategory.Space,
    themeName: 'Asteroid Belt',
    arenaLevel: {
      worldWidth: 1280,
      worldHeight: 645,
      floorY: FLOOR_Y,
      gravity: 980,
      targetScore: 7,
      lobCost: 1,
      dwarfSpawn: {
        x: 129,
        y: 481,
        minX: 58,
        maxX: 200,
        leftStepTop: 455,
        centerStepTop: 515,
        rightStepTop: 568
      },
      miningNode: { x: 1060, y: 582, radius: 50, value: 1 },
      blocks,
      fallingObjects,
      initialBirds,
      birdSpawnInterval: { min: 1.8, max: 3.2 },
      bgCrystals: [
        { x: 310, y: FLOOR_Y - 2, w: 26, h: 60, color: '#38bdf8' },
        { x: 580, y: FLOOR_Y - 2, w: 24, h: 54, color: '#0ea5e9' },
        { x: 860, y: FLOOR_Y - 2, w: 32, h: 72, color: '#0284c7' },
        { x: 1200, y: FLOOR_Y - 2, w: 28, h: 66, color: '#e0f2fe' }
      ],
      archetypeId: 4
    },
    platformerLevel: {
      worldWidth: 3400,
      worldHeight: 750,
      floorY: 710,
      gravity: 490, // HALF GRAVITY!
      jumpVelocity: -530, // clears 7-block walls
      runSpeed: 250,
      dwarfSpawn: { x: 120, y: 590 },
      grandMiningNode: { x: 3250, y: 600, radius: 50, isGrandNode: true, value: 5 },
      intermediateNodes: [
        { id: 'p7_node_1', x: 1250, y: 530, radius: 32, value: 2 },
        { id: 'p7_node_2', x: 2300, y: 440, radius: 32, value: 2 }
      ],
      blocks: platBlocks,
      fallingObjects: [
        makeFallingObj('p7_bld_1', 'boulder', 1478, 380 - 23, 45, 'Asteroid Boulder'),
        makeFallingObj('p7_keg_1', 'barrel', 2552, 340 - 20, -50, 'Cosmic Keg')
      ],
      patrolBirds: [
        { id: 'p7_bird_1', x: 1300, y: 220, vx: -120, vy: 0, plane: 'horizontal', radius: BIRD_RADIUS, waveAmp: 18, waveFreq: 2.3, shielded: true },
        { id: 'p7_bird_2', x: 2400, y: 180, vx: -135, vy: 0, plane: 'horizontal', radius: BIRD_RADIUS, waveAmp: 20, waveFreq: 2.6, shielded: true }
      ],
      movingPlatforms: [
        { id: 'p7_plat_1', x: 1800, y: 460, w: 90, h: 18, startX: 1750, startY: 460, endX: 2000, endY: 460, speed: 75 }
      ],
      hazards: [
        { id: 'p7_rad_1', type: HazardType.CosmicRadiation, x: 1750, y: 690, w: 260, h: 25, damage: 2 }
      ],
      checkpoints: [{ x: 1300, y: 600 }, { x: 2350, y: 600 }],
      goalKII: 7
    }
  };
}

// --- MAP 8: Orbital Refinery Station (SPACE BIOME - HALF GRAVITY 490 px/s^2) ---
function buildMap8(): MapDefinition {
  const blocks: BlockDef[] = [];
  let bId = 0;
  // Archetype 0 scaled for orbital refinery
  for (let r = 0; r < 5; r++) blocks.push(makeBlock(`m8_t1_${bId++}`, 450, FLOOR_Y - (r + 1) * BH, 'stone'));
  for (let r = 0; r < 4; r++) blocks.push(makeBlock(`m8_t2_${bId++}`, 650, FLOOR_Y - (r + 1) * BH, 'wood'));
  for (let r = 0; r < 3; r++) blocks.push(makeBlock(`m8_b1_${bId++}`, 890, FLOOR_Y - (r + 1) * BH, 'clay'));
  // High refinery rack
  [0, 1, 2, 3].forEach(i => blocks.push(makeBlock(`m8_sh_l1_${bId++}`, 960 + i * (BW + 2), 330, 'wood')));
  [0, 1, 2].forEach(i => blocks.push(makeBlock(`m8_sh_l2_${bId++}`, 986 + i * (BW + 2), 235, 'dirt')));
  [0, 1].forEach(i => blocks.push(makeBlock(`m8_sh_l3_${bId++}`, 1012 + i * (BW + 2), 140, 'wood')));

  const fallingObjects: FallingObjectDef[] = [
    makeFallingObj('m8_anv_1', 'anvil', 1012, 330 - 22, 22, 'Orbital Anvil'),
    makeFallingObj('m8_bld_1', 'boulder', 1116, 330 - 23, -22, 'Refinery Ore'),
    makeFallingObj('m8_cart_1', 'cart', 1038, 235 - 22, 18, 'Gantry Cart'),
    makeFallingObj('m8_keg_1', 'barrel', 1094, 235 - 20, -18, 'Refinery Keg'),
    makeFallingObj('m8_anv_top', 'anvil', 1058, 140 - 22, 0, 'Sky Anvil'),
    makeFallingObj('m8_t1_cart', 'cart', 476, FLOOR_Y - 5 * BH - 22, 110, 'Tower Cart'),
    makeFallingObj('m8_t2_keg', 'barrel', 676, FLOOR_Y - 4 * BH - 20, 100, 'Booster Keg')
  ];

  const initialBirds: BirdDef[] = [
    { id: 'b8_1', x: 740, y: 150, vx: -125, vy: 0, plane: 'horizontal', radius: BIRD_RADIUS, waveAmp: 16, waveFreq: 2.3, shielded: true },
    { id: 'b8_2', x: 960, y: 260, vx: -145, vy: 0, plane: 'horizontal', radius: BIRD_RADIUS, waveAmp: 18, waveFreq: 2.7, shielded: true },
    { id: 'b8_3', x: 1160, y: 110, vx: -130, vy: 0, plane: 'horizontal', radius: BIRD_RADIUS, waveAmp: 15, waveFreq: 2.1, shielded: true },
    { id: 'b8_4', x: 1250, y: 230, vx: -150, vy: 0, plane: 'horizontal', radius: BIRD_RADIUS, waveAmp: 17, waveFreq: 2.8, shielded: true }
  ];

  // Platformer blocks
  const platBlocks: BlockDef[] = [];
  let pbId = 0;
  for (let r = 0; r < 7; r++) platBlocks.push(makeBlock(`p8_w1_${pbId++}`, 1050, 710 - (r + 1) * BH, r < 2 ? 'stone' : 'clay'));
  [1500, 1552, 1604, 1656].forEach(cx => platBlocks.push(makeBlock(`p8_sh1_${pbId++}`, cx, 370, 'wood')));
  for (let r = 0; r < 6; r++) platBlocks.push(makeBlock(`p8_w2_${pbId++}`, 2250, 710 - (r + 1) * BH, 'wood'));
  [2600, 2652, 2704].forEach(cx => platBlocks.push(makeBlock(`p8_sh2_${pbId++}`, cx, 310, 'dirt')));

  return {
    mapId: 8,
    name: 'Orbital Refinery Station',
    subtitle: 'SPACE BIOME: Zero-G scaffolding & magnetic platforms. Half-gravity moon-leaps across orbital chasms!',
    bgImagePath: '../bg8.png',
    isSpace: true,
    biome: BiomeCategory.Space,
    themeName: 'Orbital Refinery',
    arenaLevel: {
      worldWidth: 1280,
      worldHeight: 645,
      floorY: FLOOR_Y,
      gravity: 980,
      targetScore: 7,
      lobCost: 1,
      dwarfSpawn: {
        x: 129,
        y: 481,
        minX: 58,
        maxX: 200,
        leftStepTop: 555,
        centerStepTop: 455,
        rightStepTop: 555
      },
      miningNode: { x: 1070, y: 582, radius: 50, value: 1 },
      blocks,
      fallingObjects,
      initialBirds,
      birdSpawnInterval: { min: 1.8, max: 3.0 },
      bgCrystals: [
        { x: 310, y: FLOOR_Y - 2, w: 26, h: 62, color: '#6366f1' },
        { x: 590, y: FLOOR_Y - 2, w: 24, h: 56, color: '#818cf8' },
        { x: 870, y: FLOOR_Y - 2, w: 32, h: 74, color: '#a5b4fc' },
        { x: 1210, y: FLOOR_Y - 2, w: 28, h: 68, color: '#c7d2fe' }
      ],
      archetypeId: 0
    },
    platformerLevel: {
      worldWidth: 3500,
      worldHeight: 750,
      floorY: 710,
      gravity: 490, // HALF GRAVITY!
      jumpVelocity: -530, // clears 7-block walls
      runSpeed: 250,
      dwarfSpawn: { x: 120, y: 590 },
      grandMiningNode: { x: 3350, y: 600, radius: 50, isGrandNode: true, value: 5 },
      intermediateNodes: [
        { id: 'p8_node_1', x: 1300, y: 530, radius: 32, value: 2 },
        { id: 'p8_node_2', x: 2400, y: 440, radius: 32, value: 2 }
      ],
      blocks: platBlocks,
      fallingObjects: [
        makeFallingObj('p8_anv_1', 'anvil', 1578, 370 - 22, 50, 'Refinery Anvil'),
        makeFallingObj('p8_bld_1', 'boulder', 2652, 310 - 23, -45, 'Cosmic Ore')
      ],
      patrolBirds: [
        { id: 'p8_bird_1', x: 1400, y: 220, vx: -125, vy: 0, plane: 'horizontal', radius: BIRD_RADIUS, waveAmp: 18, waveFreq: 2.4, shielded: true },
        { id: 'p8_bird_2', x: 2500, y: 190, vx: -140, vy: 0, plane: 'horizontal', radius: BIRD_RADIUS, waveAmp: 20, waveFreq: 2.7, shielded: true }
      ],
      movingPlatforms: [
        { id: 'p8_plat_1', x: 1900, y: 460, w: 90, h: 18, startX: 1850, startY: 460, endX: 2100, endY: 460, speed: 80 }
      ],
      hazards: [
        { id: 'p8_void_1', type: HazardType.Void, x: 1850, y: 690, w: 300, h: 30, damage: 99 }
      ],
      checkpoints: [{ x: 1350, y: 600 }, { x: 2450, y: 600 }],
      goalKII: 7
    }
  };
}

// --- MAP 9: Deep Space Void Station (SPACE BIOME - HALF GRAVITY 490 px/s^2) ---
function buildMap9(): MapDefinition {
  const blocks: BlockDef[] = [];
  let bId = 0;
  // Archetype 1 in deep space
  const startX = 470;
  const startY = 160;
  for (let s = 0; s < 4; s++) {
    const sx = startX + s * 140;
    const sy = startY + s * 78;
    blocks.push(makeBlock(`m9_st1_${bId++}`, sx, sy, 'wood'));
    blocks.push(makeBlock(`m9_st2_${bId++}`, sx + BW + 2, sy, 'clay'));
  }
  // Overhead crown shelf over Node (x: 1070)
  [1016, 1070, 1124].forEach(cx => blocks.push(makeBlock(`m9_ov_${bId++}`, cx, 150, 'wood')));

  const fallingObjects: FallingObjectDef[] = [
    makeFallingObj('m9_bld_1', 'boulder', 498, 160 - 23, 95, 'Void Boulder 1'),
    makeFallingObj('m9_cart_1', 'cart', 638, 238 - 22, 90, 'Void Cart'),
    makeFallingObj('m9_keg_1', 'barrel', 778, 316 - 20, 85, 'Dark Matter Keg'),
    makeFallingObj('m9_anv_1', 'anvil', 918, 394 - 22, 80, 'Void Anvil'),
    makeFallingObj('m9_top_anv', 'anvil', 1046, 150 - 22, 15, 'Crown Anvil'),
    makeFallingObj('m9_top_bld', 'boulder', 1102, 150 - 23, -15, 'Crown Boulder')
  ];

  const initialBirds: BirdDef[] = [
    { id: 'b9_1', x: 740, y: 130, vx: -130, vy: 0, plane: 'horizontal', radius: BIRD_RADIUS, waveAmp: 16, waveFreq: 2.4, shielded: true },
    { id: 'b9_2', x: 950, y: 260, vx: -150, vy: 0, plane: 'horizontal', radius: BIRD_RADIUS, waveAmp: 18, waveFreq: 2.8, shielded: true },
    { id: 'b9_3', x: 1140, y: 100, vx: -135, vy: 0, plane: 'horizontal', radius: BIRD_RADIUS, waveAmp: 15, waveFreq: 2.2, shielded: true },
    { id: 'b9_4', x: 1240, y: 230, vx: -160, vy: 0, plane: 'horizontal', radius: BIRD_RADIUS, waveAmp: 19, waveFreq: 2.9, shielded: true }
  ];

  // Platformer blocks
  const platBlocks: BlockDef[] = [];
  let pbId = 0;
  for (let r = 0; r < 7; r++) platBlocks.push(makeBlock(`p9_w1_${pbId++}`, 1100, 740 - (r + 1) * BH, 'stone'));
  [1550, 1602, 1654].forEach(cx => platBlocks.push(makeBlock(`p9_sh1_${pbId++}`, cx, 380, 'wood')));
  for (let r = 0; r < 6; r++) platBlocks.push(makeBlock(`p9_w2_${pbId++}`, 2300, 740 - (r + 1) * BH, 'clay'));
  [2650, 2702, 2754].forEach(cx => platBlocks.push(makeBlock(`p9_sh2_${pbId++}`, cx, 320, 'dirt')));

  return {
    mapId: 9,
    name: 'Deep Space Void Station',
    subtitle: 'SPACE BIOME: Endless cosmic void below. Half-gravity moon-jumps past shielded void eagles!',
    bgImagePath: '../bg9.png',
    isSpace: true,
    biome: BiomeCategory.Space,
    themeName: 'Deep Space Void',
    arenaLevel: {
      worldWidth: 1280,
      worldHeight: 645,
      floorY: FLOOR_Y,
      gravity: 980,
      targetScore: 7,
      lobCost: 1,
      dwarfSpawn: {
        x: 129,
        y: 481,
        minX: 58,
        maxX: 200,
        leftStepTop: 467,
        centerStepTop: 515,
        rightStepTop: 563
      },
      miningNode: { x: 1070, y: 582, radius: 50, value: 1 },
      blocks,
      fallingObjects,
      initialBirds,
      birdSpawnInterval: { min: 1.6, max: 2.8 },
      bgCrystals: [
        { x: 310, y: FLOOR_Y - 2, w: 26, h: 64, color: '#4f46e5' },
        { x: 590, y: FLOOR_Y - 2, w: 24, h: 58, color: '#6366f1' },
        { x: 880, y: FLOOR_Y - 2, w: 32, h: 76, color: '#818cf8' },
        { x: 1210, y: FLOOR_Y - 2, w: 28, h: 70, color: '#a5b4fc' }
      ],
      archetypeId: 1
    },
    platformerLevel: {
      worldWidth: 3500,
      worldHeight: 780,
      floorY: 740,
      gravity: 490, // HALF GRAVITY!
      jumpVelocity: -530, // clears 7-block walls
      runSpeed: 250,
      dwarfSpawn: { x: 120, y: 620 },
      grandMiningNode: { x: 3380, y: 620, radius: 50, isGrandNode: true, value: 5 },
      intermediateNodes: [
        { id: 'p9_node_1', x: 1350, y: 550, radius: 32, value: 2 },
        { id: 'p9_node_2', x: 2450, y: 460, radius: 32, value: 2 }
      ],
      blocks: platBlocks,
      fallingObjects: [
        makeFallingObj('p9_keg_1', 'barrel', 1602, 380 - 20, 50, 'Dark Matter Keg'),
        makeFallingObj('p9_anv_1', 'anvil', 2702, 320 - 22, -45, 'Void Anvil')
      ],
      patrolBirds: [
        { id: 'p9_bird_1', x: 1450, y: 240, vx: -130, vy: 0, plane: 'horizontal', radius: BIRD_RADIUS, waveAmp: 18, waveFreq: 2.5, shielded: true },
        { id: 'p9_bird_2', x: 2550, y: 200, vx: -145, vy: 0, plane: 'horizontal', radius: BIRD_RADIUS, waveAmp: 20, waveFreq: 2.8, shielded: true }
      ],
      movingPlatforms: [
        { id: 'p9_plat_1', x: 1950, y: 480, w: 90, h: 18, startX: 1900, startY: 480, endX: 2150, endY: 480, speed: 85 }
      ],
      hazards: [
        { id: 'p9_void_1', type: HazardType.Void, x: 1900, y: 720, w: 320, h: 30, damage: 99 }
      ],
      checkpoints: [{ x: 1400, y: 630 }, { x: 2500, y: 630 }],
      goalKII: 7
    }
  };
}

// --- MAP 10: Celestial Core Megalith (SPACE BIOME - HALF GRAVITY 490 px/s^2) ---
function buildMap10(): MapDefinition {
  const blocks: BlockDef[] = [];
  let bId = 0;
  // Archetype 2: Grand Fortress Wall + Twin Sky Islands + Ceiling Drop Chute
  const wallX = 860;
  for (let r = 0; r < 7; r++) {
    const wy = FLOOR_Y - (r + 1) * BH;
    const bType = r === 3 || r === 4 ? 'dirt' : r < 2 ? 'stone' : 'clay';
    blocks.push(makeBlock(`m10_w1_${bId++}`, wallX, wy, bType));
    if (r < 5 && r !== 3) blocks.push(makeBlock(`m10_w2_${bId++}`, wallX + BW + 2, wy, 'dirt'));
  }
  // Floating sky islands
  [0, 1, 2].forEach(i => blocks.push(makeBlock(`m10_isl1_${bId++}`, 520 + i * (BW + 2), 250, 'wood')));
  const isl2X = 940;
  [0, 1, 2, 3, 4].forEach(i => blocks.push(makeBlock(`m10_isl2_low_${bId++}`, isl2X + i * (BW + 2), 320, i % 2 === 0 ? 'wood' : 'dirt')));
  [1, 2, 3].forEach(i => blocks.push(makeBlock(`m10_isl2_hi_${bId++}`, isl2X + i * (BW + 2), 200, 'wood')));

  const fallingObjects: FallingObjectDef[] = [
    makeFallingObj('m10_wall_anv', 'anvil', wallX + 26, FLOOR_Y - 7 * BH - 22, 105, 'Celestial Anvil'),
    makeFallingObj('m10_isl1_cart', 'cart', 560, 250 - 22, 115, 'Core Cart'),
    makeFallingObj('m10_isl1_bld', 'boulder', 630, 250 - 23, 95, 'Core Boulder'),
    makeFallingObj('m10_rack_low1', 'anvil', isl2X + 55, 320 - 22, 28, 'Megalith Anvil'),
    makeFallingObj('m10_rack_low2', 'cart', isl2X + 195, 320 - 22, -28, 'Megalith Cart'),
    makeFallingObj('m10_rack_hi1', 'boulder', isl2X + 95, 200 - 23, 12, 'Celestial Meteor'),
    makeFallingObj('m10_rack_hi2', 'barrel', isl2X + 160, 200 - 20, -12, 'Supernova Keg')
  ];

  const initialBirds: BirdDef[] = [
    { id: 'b10_1', x: 700, y: 140, vx: -130, vy: 0, plane: 'horizontal', radius: BIRD_RADIUS, waveAmp: 16, waveFreq: 2.5, shielded: true },
    { id: 'b10_2', x: 900, y: 280, vx: -155, vy: 0, plane: 'horizontal', radius: BIRD_RADIUS, waveAmp: 18, waveFreq: 2.9, shielded: true },
    { id: 'b10_3', x: 1100, y: 120, vx: -135, vy: 0, plane: 'horizontal', radius: BIRD_RADIUS, waveAmp: 15, waveFreq: 2.3, shielded: true },
    { id: 'b10_4', x: 1220, y: 240, vx: -160, vy: 0, plane: 'horizontal', radius: BIRD_RADIUS, waveAmp: 19, waveFreq: 3.0, shielded: true }
  ];

  // Platformer blocks
  const platBlocks: BlockDef[] = [];
  let pbId = 0;
  for (let r = 0; r < 8; r++) platBlocks.push(makeBlock(`p10_w1_${pbId++}`, 1150, 760 - (r + 1) * BH, r === 4 ? 'dirt' : 'stone'));
  [1600, 1652, 1704, 1756].forEach(cx => platBlocks.push(makeBlock(`p10_sh1_${pbId++}`, cx, 380, 'wood')));
  for (let r = 0; r < 7; r++) platBlocks.push(makeBlock(`p10_w2_${pbId++}`, 2400, 760 - (r + 1) * BH, r === 3 ? 'dirt' : 'stone'));
  [2750, 2802, 2854].forEach(cx => platBlocks.push(makeBlock(`p10_sh2_${pbId++}`, cx, 320, 'clay')));

  return {
    mapId: 10,
    name: 'Celestial Core Megalith',
    subtitle: 'THE ULTIMATE CLIMAX: Ancient alien megaliths & swarm of cosmic shielded eagles. Moon-jump to the Grand Core!',
    bgImagePath: '../bg10.png',
    isSpace: true,
    biome: BiomeCategory.Space,
    themeName: 'Celestial Megalith',
    arenaLevel: {
      worldWidth: 1280,
      worldHeight: 645,
      floorY: FLOOR_Y,
      gravity: 980,
      targetScore: 7,
      lobCost: 1, // PAY-TO-PLAY!
      dwarfSpawn: {
        x: 129,
        y: 481,
        minX: 58,
        maxX: 200,
        leftStepTop: 450,
        centerStepTop: 500,
        rightStepTop: 550
      },
      miningNode: { x: 1060, y: 582, radius: 50, value: 1 },
      blocks,
      fallingObjects,
      initialBirds,
      birdSpawnInterval: { min: 1.5, max: 2.6 },
      bgCrystals: [
        { x: 310, y: FLOOR_Y - 2, w: 28, h: 66, color: '#7c3aed' },
        { x: 590, y: FLOOR_Y - 2, w: 26, h: 60, color: '#8b5cf6' },
        { x: 880, y: FLOOR_Y - 2, w: 34, h: 78, color: '#a78bfa' },
        { x: 1210, y: FLOOR_Y - 2, w: 30, h: 72, color: '#c4b5fd' }
      ],
      archetypeId: 2
    },
    platformerLevel: {
      worldWidth: 3600,
      worldHeight: 800,
      floorY: 760,
      gravity: 490, // HALF GRAVITY!
      jumpVelocity: -560, // clears 8-block walls (288px)
      runSpeed: 250,
      dwarfSpawn: { x: 120, y: 640 },
      grandMiningNode: { x: 3480, y: 640, radius: 52, isGrandNode: true, value: 7 },
      intermediateNodes: [
        { id: 'p10_node_1', x: 1100, y: 560, radius: 32, value: 2 },
        { id: 'p10_node_2', x: 2000, y: 480, radius: 32, value: 2 },
        { id: 'p10_node_3', x: 2800, y: 420, radius: 32, value: 2 }
      ],
      blocks: platBlocks,
      fallingObjects: [
        makeFallingObj('p10_anv_1', 'anvil', 1678, 380 - 22, 50, 'Celestial Anvil'),
        makeFallingObj('p10_keg_1', 'barrel', 2802, 320 - 20, -50, 'Supernova Keg')
      ],
      patrolBirds: [
        { id: 'p10_bird_1', x: 1500, y: 220, vx: -130, vy: 0, plane: 'horizontal', radius: BIRD_RADIUS, waveAmp: 18, waveFreq: 2.6, shielded: true },
        { id: 'p10_bird_2', x: 2600, y: 190, vx: -150, vy: 0, plane: 'horizontal', radius: BIRD_RADIUS, waveAmp: 20, waveFreq: 3.0, shielded: true }
      ],
      movingPlatforms: [
        { id: 'p10_plat_1', x: 2000, y: 500, w: 100, h: 18, startX: 1950, startY: 500, endX: 2250, endY: 500, speed: 90 }
      ],
      hazards: [
        { id: 'p10_void_1', type: HazardType.Void, x: 2000, y: 740, w: 350, h: 30, damage: 99 }
      ],
      checkpoints: [{ x: 1400, y: 650 }, { x: 2500, y: 650 }],
      goalKII: 7
    }
  };
}

// ---------------------------------------------------------------------------
// Master Level Repository & Accessor API
// ---------------------------------------------------------------------------

const allMapsCache: MapDefinition[] = [
  buildMap1(),
  buildMap2(),
  buildMap3(),
  buildMap4(),
  buildMap5(),
  buildMap6(),
  buildMap7(),
  buildMap8(),
  buildMap9(),
  buildMap10()
];

export function getAllMaps(): MapDefinition[] {
  return allMapsCache;
}

export function getMapById(mapId: number): MapDefinition | undefined {
  return allMapsCache.find((m) => m.mapId === mapId);
}

export function getTosserLevel(mapId: number): TosserArenaLevel {
  const map = getMapById(mapId) || allMapsCache[0];
  return map.arenaLevel;
}

export function getPlatformerLevel(mapId: number): PlatformerLevel {
  const map = getMapById(mapId) || allMapsCache[0];
  return map.platformerLevel;
}

export function isSpaceMap(mapId: number): boolean {
  return mapId >= 6 && mapId <= 10;
}

export function getGravityForMode(mapId: number, mode: GameModeType): number {
  if (mode === GameMode.Platformer && isSpaceMap(mapId)) {
    return 490; // Half gravity for space platformer mode!
  }
  return 980; // Normal gravity
}
