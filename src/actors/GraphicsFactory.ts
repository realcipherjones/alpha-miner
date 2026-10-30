/**
 * GraphicsFactory.ts
 * High-detail HTML5 Canvas and Excalibur.js `ex.Canvas` sprite generators for all actors:
 * - Dwarf Sprite Renderer (idle, walk/run, jump, throw, cheer, and Space Astronaut Bubble Helmet)
 * - Pickaxe Projectile Sprite (steel/golden head, oak handle, spark trail)
 * - Destructible Block Sprites (Dirt, Wood, Clay, Stone with procedural grain and damage cracks)
 * - Heavy Falling Physics Objects (Iron Anvil, Granite Boulder, Mining Ore Cart, Powder Keg)
 * - Patrolling & Shielded Birds/Eagles (animated flapping wings, sharp beak, cyan energy shield)
 * - Mining Node Target Ore Vein (glowing crystal cluster, pulsing emerald/gold veins, hit flash, sparkles)
 *
 * Compatible with Node v24 `--experimental-strip-types` (no enums, no parameter properties).
 */

import {
  DWARF_SPRITE_FRAME_SIZE,
  DWARF_SPRITE_ANCHOR_Y,
  DWARF_SPRITE_FRAME_COUNTS,
  DWARF_SPRITE_HEADS
} from './DwarfSpriteMeta.ts';
import { CART_WHEEL_CENTERS, CART_WHEEL_SIZE } from './FallingObjectSpriteMeta.ts';
import { GARRISON_WALK_ROW, GARRISON_LABELS } from './BlockSpriteMeta.ts';

// ---------------------------------------------------------------------------
// Type Definitions & Enums-as-Const
// ---------------------------------------------------------------------------

export const DwarfAnimation = {
  Idle: 'idle',
  Walk: 'walk',
  Run: 'run',
  Jump: 'jump',
  Throw: 'throw',
  Cheer: 'cheer'
} as const;
export type DwarfAnimationType = (typeof DwarfAnimation)[keyof typeof DwarfAnimation];

export const BlockType = {
  Dirt: 'dirt',
  Wood: 'wood',
  Clay: 'clay',
  Stone: 'stone'
} as const;
export type BlockTypeKind = (typeof BlockType)[keyof typeof BlockType];

export const FallingObjectKind = {
  Anvil: 'anvil',
  Boulder: 'boulder',
  Cart: 'cart',
  Barrel: 'barrel'
} as const;
export type FallingObjectKindType = (typeof FallingObjectKind)[keyof typeof FallingObjectKind];

export interface DwarfRenderOptions {
  animation?: DwarfAnimationType;
  frameTime?: number;
  facing?: 'left' | 'right' | number;
  isSpaceMap?: boolean;
  aimAngleDeg?: number;
  aimPowerPct?: number;
  throwProgress?: number; // 0 (start) to 1 (full follow-through)
  verticalVelocity?: number; // picks the rising vs falling jump sprite
  isHoldingPickaxe?: boolean;
  cheerTimer?: number;
  scale?: number;
}

export interface PickaxeRenderOptions {
  angle?: number;
  scale?: number;
  lightning?: boolean; // in-flight electric crackle
  sparkIntensity?: number;
  time?: number;
}

export interface BlockRenderOptions {
  type: BlockTypeKind;
  hp?: number;
  maxHp?: number;
  width?: number;
  height?: number;
  shake?: number;
  alpha?: number;
  dissipating?: boolean;
}

export interface FallingObjectRenderOptions {
  kind: FallingObjectKindType;
  radius?: number;
  angle?: number;
  name?: string;
  color?: string;
  accent?: string;
  scale?: number;
  roll?: number; // horizontal distance travelled; spins the boulder and cart wheels
  lit?: boolean; // powder keg shows its burning fuse
}

export interface BirdRenderOptions {
  flapPhase?: number;
  isInterceptor?: boolean;
  shielded?: boolean;
  shieldPulse?: number;
  vx?: number;
  vy?: number;
  plane?: 'horizontal' | 'vertical';
  scale?: number;
  age?: number;
}

export interface MiningNodeRenderOptions {
  radius?: number;
  hitPulse?: number;
  time?: number;
  scoreText?: string;
  bankText?: string;
  sparkles?: Array<{ rx: number; ry: number; phase: number; size: number }>;
  scale?: number;
}

// ---------------------------------------------------------------------------
// Excalibur Canvas Wrapper
// ---------------------------------------------------------------------------

let injectedExcalibur: any = null;

export function setExcalibur(ex: any): void {
  injectedExcalibur = ex;
}

export function getExcalibur(): any {
  if (injectedExcalibur) return injectedExcalibur;
  if (typeof (globalThis as any).ex !== 'undefined') {
    return (globalThis as any).ex;
  }
  return null;
}

/**
 * Creates an Excalibur Graphic or falls back to an ex-compatible Canvas object.
 */
export function createExCanvas(options: {
  width: number;
  height: number;
  draw: (ctx: CanvasRenderingContext2D) => void;
  cache?: boolean;
}): any {
  const ex = getExcalibur();
  if (ex && ex.Canvas) {
    return new ex.Canvas(options);
  }
  // Standalone mock Graphic for headless/test environments
  return {
    width: options.width,
    height: options.height,
    draw: (ctx: CanvasRenderingContext2D) => options.draw(ctx),
    flagDirty: () => {}
  };
}

// ---------------------------------------------------------------------------
// Canvas Drawing Helpers
// ---------------------------------------------------------------------------

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number
): void {
  const r = Math.min(radius, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ---------------------------------------------------------------------------
// 1. Dwarf Sprite Renderer
// ---------------------------------------------------------------------------

// Bitmap sprite strips (assets/sprites/dwarf/dwarf_<anim>.png, regenerated by
// tools/slice_dwarf_atlas.py). Frames are stored at 2x game resolution. Until
// they load, or if they fail to, drawDwarf falls back to the vector dwarf.
const DWARF_SPRITE_SCALE = 0.5;
const DWARF_FEET_OFFSET = 34; // origin -> boot soles, matches the collision box
const DWARF_SPRITE_FPS: Record<string, number> = { idle: 5, walk: 8, run: 12, cheer: 9 };
const dwarfSpriteImages: Record<string, HTMLImageElement> = {};

function isSpriteReady(img: HTMLImageElement | undefined): img is HTMLImageElement {
  return !!img && img.complete && img.naturalWidth > 0;
}

export function loadDwarfSprites(basePath: string = 'assets/sprites/dwarf/'): void {
  if (typeof Image === 'undefined') return;
  for (const key of Object.keys(DWARF_SPRITE_FRAME_COUNTS)) {
    const img = new Image();
    img.src = `${basePath}dwarf_${key}.png`;
    dwarfSpriteImages[key] = img;
  }
}

function pickDwarfSpriteFrame(
  anim: DwarfAnimationType,
  options: DwarfRenderOptions
): { key: string; index: number } {
  const timeSec = options.frameTime || 0;
  const loop = (key: string, fps: number) => ({
    key,
    index: Math.floor(timeSec * fps) % DWARF_SPRITE_FRAME_COUNTS[key]
  });

  if (anim === DwarfAnimation.Throw) {
    const count = DWARF_SPRITE_FRAME_COUNTS.throw;
    return { key: 'throw', index: Math.min(count - 1, Math.floor((options.throwProgress ?? 0) * count)) };
  }
  if (anim === DwarfAnimation.Jump) {
    // Frame 0 is a crouch wind-up; in the air we only need rising (1) / falling (2)
    return { key: 'jump', index: (options.verticalVelocity ?? 0) < 0 ? 1 : 2 };
  }
  if (anim === DwarfAnimation.Walk || anim === DwarfAnimation.Run) {
    return loop('run', DWARF_SPRITE_FPS[anim]);
  }
  if (anim === DwarfAnimation.Cheer || (options.cheerTimer ?? 0) > 0) {
    return loop('cheer', DWARF_SPRITE_FPS.cheer);
  }
  return loop('idle', DWARF_SPRITE_FPS.idle);
}

/** Draws the bitmap dwarf; returns false if that strip isn't loaded yet. */
function drawDwarfSprite(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  anim: DwarfAnimationType,
  options: DwarfRenderOptions
): boolean {
  const { key, index } = pickDwarfSpriteFrame(anim, options);
  const img = dwarfSpriteImages[key];
  if (!isSpriteReady(img)) return false;

  const scale = options.scale ?? 1.0;
  const facingRight = !(options.facing === 'left' || options.facing === -1);
  const size = DWARF_SPRITE_FRAME_SIZE;
  const s = DWARF_SPRITE_SCALE * scale;

  ctx.save();
  ctx.translate(x, y + DWARF_FEET_OFFSET * scale);
  ctx.scale(facingRight ? 1 : -1, 1);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, index * size, 0, size, size, (-size / 2) * s, -DWARF_SPRITE_ANCHOR_Y * s, size * s, size * s);

  if (options.isSpaceMap) {
    // Head centres are measured at the beard line; the bubble sits a little higher
    const head = DWARF_SPRITE_HEADS[key][index];
    ctx.translate(head[0] * scale, (head[1] - 5) * scale);
    ctx.scale(scale, scale);
    ctx.translate(0, 21); // drawSpaceHelmet is centred on the vector dwarf's head (0, -21)
    drawSpaceHelmet(ctx, options.frameTime || 0);
  }
  ctx.restore();
  return true;
}

function drawSpaceHelmet(ctx: CanvasRenderingContext2D, timeSec: number): void {
  ctx.save();
  // Space Antenna
  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.moveTo(-4, -45);
  ctx.lineTo(-4, -55);
  ctx.stroke();

  // Blinking antenna beacon
  const beaconPulse = 0.5 + 0.5 * Math.sin(timeSec * 8);
  ctx.fillStyle = beaconPulse > 0.5 ? '#38bdf8' : '#f43f5e';
  ctx.beginPath();
  ctx.arc(-4, -57, 3.5, 0, Math.PI * 2);
  ctx.fill();

  // Pressurized Metallic Neck Ring Collar
  ctx.fillStyle = '#94a3b8';
  ctx.strokeStyle = '#334155';
  ctx.lineWidth = 1.8;
  drawRoundedRect(ctx, -21, -4, 42, 7, 3.5);
  ctx.fill();
  ctx.stroke();

  // Rivets
  ctx.fillStyle = '#e2e8f0';
  [-14, -7, 0, 7, 14].forEach((rx) => {
    ctx.beginPath();
    ctx.arc(rx, -0.5, 1.3, 0, Math.PI * 2);
    ctx.fill();
  });

  // Translucent glass dome
  const domeGrad = ctx.createRadialGradient(-5, -26, 6, 0, -21, 25);
  domeGrad.addColorStop(0, 'rgba(224, 242, 254, 0.08)');
  domeGrad.addColorStop(0.65, 'rgba(56, 189, 248, 0.18)');
  domeGrad.addColorStop(1, 'rgba(125, 211, 252, 0.45)');
  ctx.fillStyle = domeGrad;
  ctx.strokeStyle = '#bae6fd';
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.arc(0, -21, 24.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Curved visor specular highlight
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.78)';
  ctx.lineWidth = 2.8;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(0, -21, 20, -Math.PI * 0.78, -Math.PI * 0.32);
  ctx.stroke();

  // Small secondary glint
  ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
  ctx.beginPath();
  ctx.arc(14, -12, 2.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

export function drawDwarf(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  options: DwarfRenderOptions = {}
): void {
  const anim = options.animation || DwarfAnimation.Idle;
  if (drawDwarfSprite(ctx, x, y, anim, options)) return;

  const timeSec = options.frameTime || 0;
  const facingRight = options.facing === 'left' || options.facing === -1 ? false : true;
  const isSpace = !!options.isSpaceMap;
  const aimAngle = options.aimAngleDeg ?? 52;
  const throwProg = options.throwProgress ?? 0;
  const isHoldingPick = options.isHoldingPickaxe ?? true;
  const cheerTimer = options.cheerTimer ?? 0;
  const scale = options.scale ?? 1.0;

  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale * (facingRight ? 1 : -1), scale);

  // Vertical bounce calculation per animation mode
  let bounceY = 0;
  let legSwingL = 0;
  let legSwingR = 0;
  let bodyTilt = 0;
  let beardSway = 0;

  if (anim === DwarfAnimation.Cheer || cheerTimer > 0) {
    bounceY = Math.abs(Math.sin(timeSec * 16)) * 10;
  } else if (anim === DwarfAnimation.Walk || anim === DwarfAnimation.Run) {
    const cycleSpeed = anim === DwarfAnimation.Run ? 12 : 8;
    bounceY = Math.abs(Math.sin(timeSec * cycleSpeed)) * 3.5;
    legSwingL = Math.sin(timeSec * cycleSpeed) * 12;
    legSwingR = Math.sin(timeSec * cycleSpeed + Math.PI) * 12;
    bodyTilt = 0.08;
    beardSway = Math.sin(timeSec * cycleSpeed) * 2;
  } else if (anim === DwarfAnimation.Jump) {
    bounceY = -4;
    legSwingL = -8;
    legSwingR = -6;
    bodyTilt = -0.05;
  } else {
    // Idle breathing
    bounceY = Math.sin(timeSec * 3.2) * 2;
  }

  ctx.translate(0, -bounceY);
  ctx.rotate(bodyTilt);

  // 1) Boots
  ctx.fillStyle = '#451a03';
  ctx.strokeStyle = '#270e02';
  ctx.lineWidth = 1.5;

  if (anim === DwarfAnimation.Jump) {
    // Tucked airborne legs
    drawRoundedRect(ctx, -20 + legSwingL, 16, 16, 12, 4);
    ctx.fill();
    ctx.stroke();
    drawRoundedRect(ctx, 4 + legSwingR, 14, 16, 12, 4);
    ctx.fill();
    ctx.stroke();
  } else {
    // Normal / walking feet
    drawRoundedRect(ctx, -20 + legSwingL, 22, 16, 12, 4);
    ctx.fill();
    ctx.stroke();
    drawRoundedRect(ctx, 4 + legSwingR, 22, 16, 12, 4);
    ctx.fill();
    ctx.stroke();
  }

  // 2) Sturdy Tunic / Armor
  ctx.fillStyle = '#1d4ed8';
  ctx.strokeStyle = '#fbbf24';
  ctx.lineWidth = 2;
  drawRoundedRect(ctx, -22, -10, 44, 34, 8);
  ctx.fill();
  ctx.stroke();

  // Belt & Golden Buckle
  ctx.fillStyle = '#78350f';
  ctx.fillRect(-22, 10, 44, 7);
  ctx.fillStyle = '#facc15';
  ctx.strokeStyle = '#ca8a04';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(-6, 9, 12, 9);
  ctx.fillRect(-5, 10, 10, 7);

  // 3) Head & Face
  ctx.fillStyle = '#fed7aa';
  ctx.beginPath();
  ctx.arc(0, -20, 15, 0, Math.PI * 2);
  ctx.fill();

  // Expressive Eye
  ctx.fillStyle = '#0f172a';
  ctx.beginPath();
  if (anim === DwarfAnimation.Cheer || cheerTimer > 0) {
    // Happy closed squint eye
    ctx.arc(5, -22, 2.5, 0, Math.PI);
    ctx.stroke();
  } else {
    ctx.arc(5, -22, 2.3, 0, Math.PI * 2);
    ctx.fill();
  }

  // Button Nose
  ctx.fillStyle = '#fb923c';
  ctx.beginPath();
  ctx.arc(10, -18, 4.5, 0, Math.PI * 2);
  ctx.fill();

  // 4) Braided Dwarf Beard (Orange-Red with dual braid curve)
  ctx.save();
  ctx.translate(beardSway, 0);
  ctx.fillStyle = '#ea580c';
  ctx.strokeStyle = '#9a3412';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-14, -15);
  ctx.quadraticCurveTo(-22, 10, -6, 22);
  ctx.quadraticCurveTo(4, 28, 16, 18);
  ctx.quadraticCurveTo(22, 4, 12, -14);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Braid bands
  ctx.fillStyle = '#facc15';
  ctx.fillRect(-4, 16, 8, 3);
  ctx.fillRect(2, 10, 8, 3);
  ctx.restore();

  // 5) Miner Helmet with Glowing Headlamp
  ctx.fillStyle = '#f59e0b';
  ctx.strokeStyle = '#b45309';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(0, -25, 17, Math.PI, 0);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Helmet brim
  ctx.fillStyle = '#78350f';
  ctx.fillRect(-19, -26, 38, 4);

  // Glowing Headlamp
  const headlampGlow = ctx.createRadialGradient(12, -32, 1, 12, -32, 14);
  headlampGlow.addColorStop(0, 'rgba(254, 240, 138, 0.9)');
  headlampGlow.addColorStop(0.5, 'rgba(251, 191, 36, 0.4)');
  headlampGlow.addColorStop(1, 'rgba(251, 191, 36, 0)');
  ctx.fillStyle = headlampGlow;
  ctx.beginPath();
  ctx.arc(12, -32, 14, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#fef08a';
  ctx.beginPath();
  ctx.arc(12, -32, 5, 0, Math.PI * 2);
  ctx.fill();

  // 6) Space Astronaut Bubble Helmet (if Space Map)
  if (isSpace) {
    drawSpaceHelmet(ctx, timeSec);
  }

  // 7) Arms & Held Pickaxe
  if (anim === DwarfAnimation.Cheer || cheerTimer > 0) {
    // Both arms raised high overhead in victory celebration!
    ctx.save();
    ctx.fillStyle = '#fed7aa';
    ctx.strokeStyle = '#d97706';
    ctx.lineWidth = 1.5;

    // Left arm up
    ctx.save();
    ctx.translate(-14, -8);
    ctx.rotate(-Math.PI * 0.65);
    drawRoundedRect(ctx, 0, -5, 20, 10, 4);
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // Right arm up with pickaxe held high
    ctx.save();
    ctx.translate(14, -8);
    ctx.rotate(Math.PI * 0.65);
    drawRoundedRect(ctx, 0, -5, 20, 10, 4);
    ctx.fill();
    ctx.stroke();
    if (isHoldingPick) {
      drawPickaxeGraphic(ctx, 22, 0, 0.95);
    }
    ctx.restore();

    ctx.restore();
  } else if (anim === DwarfAnimation.Throw) {
    // Throwing motion with follow-through
    const aimRad = (aimAngle * Math.PI) / 180;
    const followAngle = throwProg * 1.2;

    ctx.save();
    ctx.translate(10, -8);
    ctx.rotate(-aimRad + followAngle + 0.35);

    ctx.fillStyle = '#fed7aa';
    drawRoundedRect(ctx, 0, -5, 18, 10, 4);
    ctx.fill();

    if (isHoldingPick && throwProg < 0.35) {
      drawPickaxeGraphic(ctx, 18, 0, 0.85);
    }
    ctx.restore();
  } else {
    // Standard / walking / ready arm
    const aimRad = (aimAngle * Math.PI) / 180;
    ctx.save();
    ctx.translate(10, -8);
    ctx.rotate(-aimRad + 0.35);

    ctx.fillStyle = '#fed7aa';
    drawRoundedRect(ctx, 0, -5, 18, 10, 4);
    ctx.fill();

    if (isHoldingPick) {
      drawPickaxeGraphic(ctx, 18, 0, 0.85);
    }
    ctx.restore();
  }

  ctx.restore();
}

// ---------------------------------------------------------------------------
// 2. Pickaxe Projectile Sprite
// ---------------------------------------------------------------------------

// Bitmap pickaxe (assets/sprites/pickaxe/, regenerated by tools/slice_pickaxe_sheet.py).
// 128x128 at 2x, head up, canvas centre = spin point. The glint copy flashes once
// per turn while flying, wrapped in the magenta lightning strip (additive blend).
// Falls back to the vector pickaxe until loaded.
const PICKAXE_SPRITE_DRAW_SIZE = 52; // head ~39 px across at scale 1 (old vector head was 36)
const PICKAXE_LIGHTNING_FPS = 14;
const pickaxeSpriteImages: Record<string, HTMLImageElement> = {};

export function loadPickaxeSprites(basePath: string = 'assets/sprites/pickaxe/'): void {
  if (typeof Image === 'undefined') return;
  for (const key of ['pickaxe', 'pickaxe_glint', 'pickaxe_lightning']) {
    const img = new Image();
    img.src = `${basePath}${key}.png`;
    pickaxeSpriteImages[key] = img;
  }
}

export function drawPickaxeGraphic(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  scale: number = 1.0,
  options: PickaxeRenderOptions = {}
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  if (options.angle) {
    ctx.rotate(options.angle);
  }

  const showGlint = !!options.lightning && Math.cos(options.angle || 0) > 0.92;
  const pickImg = showGlint && isSpriteReady(pickaxeSpriteImages.pickaxe_glint)
    ? pickaxeSpriteImages.pickaxe_glint
    : pickaxeSpriteImages.pickaxe;
  if (isSpriteReady(pickImg)) {
    const half = PICKAXE_SPRITE_DRAW_SIZE / 2;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(pickImg, -half, -half, PICKAXE_SPRITE_DRAW_SIZE, PICKAXE_SPRITE_DRAW_SIZE);
  } else {
    // Wooden Oak Handle
    ctx.fillStyle = '#b45309';
    ctx.strokeStyle = '#78350f';
    ctx.lineWidth = 1.5;
    drawRoundedRect(ctx, -3, -15, 6, 30, 3);
    ctx.fill();
    ctx.stroke();

    // Steel/Iron Pickaxe Curved Head
    ctx.fillStyle = '#e2e8f0';
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-18, -7);
    ctx.quadraticCurveTo(0, -19, 18, -7);
    ctx.quadraticCurveTo(0, -11, -18, -7);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Gold Collar Mount Bracket
    ctx.fillStyle = '#fbbf24';
    ctx.strokeStyle = '#d97706';
    ctx.lineWidth = 1;
    ctx.fillRect(-4, -15, 8, 6);
    ctx.strokeRect(-4, -15, 8, 6);

  }

  // Magenta lightning crackle (spins with the pickaxe)
  const bolt = pickaxeSpriteImages.pickaxe_lightning;
  if (options.lightning && isSpriteReady(bolt)) {
    const frameSize = bolt.naturalHeight;
    const frames = Math.max(1, Math.round(bolt.naturalWidth / frameSize));
    const frame = Math.floor((options.time || 0) * PICKAXE_LIGHTNING_FPS) % frames;
    const half = PICKAXE_SPRITE_DRAW_SIZE / 2;
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.9;
    ctx.drawImage(bolt, frame * frameSize, 0, frameSize, frameSize, -half, -half, PICKAXE_SPRITE_DRAW_SIZE, PICKAXE_SPRITE_DRAW_SIZE);
  }

  ctx.restore();
}

// ---------------------------------------------------------------------------
// 3. Destructible Block Sprites
// ---------------------------------------------------------------------------

// Bitmap blocks and garrison towers (assets/sprites/blocks/, regenerated by
// tools/slice_fortress_sheet.py). Blocks are full-bleed 2x tiles stretched to the
// block rect; clay/stone swap to a cracked tile once damaged. Garrison towers are
// 2x art with the walkway on GARRISON_WALK_ROW, clipped at the floor.
const blockSpriteImages: Record<string, HTMLImageElement> = {};

export function loadBlockSprites(basePath: string = 'assets/sprites/blocks/'): void {
  if (typeof Image === 'undefined') return;
  const keys = [
    'block_dirt', 'block_wood', 'block_clay', 'block_clay_cracked', 'block_stone', 'block_stone_cracked',
    'garrison_tower', 'garrison_keep', 'garrison_tower_right'
  ];
  for (const key of keys) {
    const img = new Image();
    img.src = `${basePath}${key}.png`;
    blockSpriteImages[key] = img;
  }
}

export type GarrisonArt = 'garrison_tower' | 'garrison_keep' | 'garrison_tower_right';

/** Draws one tosser-mode step as a garrison tower; false if its art isn't loaded. */
export function drawGarrisonStep(
  ctx: CanvasRenderingContext2D,
  art: GarrisonArt,
  centerX: number,
  top: number,
  floorY: number,
  label: string
): boolean {
  const img = blockSpriteImages[art];
  if (!isSpriteReady(img)) return false;
  const w = img.naturalWidth / 2;
  const h = img.naturalHeight / 2;
  const walk = GARRISON_WALK_ROW / 2;

  ctx.save();
  ctx.beginPath();
  ctx.rect(centerX - w, top - walk - 4, w * 2, floorY - (top - walk - 4));
  ctx.clip();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, centerX - w / 2, top - walk, w, h);

  // LOW / MID / HIGH on the tower's banner (the keep's sits on the wall above its arch)
  const [lx, ly] = GARRISON_LABELS[art];
  if (label && top + ly < floorY - 6) {
    ctx.font = '800 9px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (art === 'garrison_keep') {
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(15, 23, 42, 0.85)';
      ctx.strokeText(label, centerX + lx, top + ly);
      ctx.fillStyle = '#fde68a';
    } else {
      ctx.fillStyle = '#7f1d1d';
    }
    ctx.fillText(label, centerX + lx, top + ly);
  }
  ctx.restore();
  return true;
}

export function drawBlock(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  options: BlockRenderOptions
): void {
  const w = options.width || 52;
  const h = options.height || 36;
  const hp = options.hp ?? 1;
  const maxHp = options.maxHp ?? (options.type === 'clay' || options.type === 'stone' ? 2 : 1);
  const shake = options.shake || 0;
  const alpha = options.alpha ?? 1.0;

  const palette = {
    dirt: { fill: '#854d0e', border: '#a16207', top: '#65a30d' },
    wood: { fill: '#9a3412', border: '#c2410c', top: '#b45309' },
    clay: { fill: '#7c2d12', border: '#9a3412', top: '#b45309' },
    stone: { fill: '#475569', border: '#64748b', top: '#94a3b8' }
  };
  const spec = palette[options.type] || palette.dirt;

  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));

  const ox = shake > 0 ? (Math.random() - 0.5) * 5 : 0;
  const oy = shake > 0 ? (Math.random() - 0.5) * 5 : 0;
  const bx = x + ox;
  const by = y + oy;

  const intact = blockSpriteImages[`block_${options.type}`];
  const cracked = blockSpriteImages[`block_${options.type}_cracked`];
  const tile = hp < maxHp && isSpriteReady(cracked) ? cracked : intact;
  if (isSpriteReady(tile)) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(tile, bx, by, w, h);
    ctx.restore();
    return;
  }

  // Block Body
  ctx.fillStyle = spec.fill;
  ctx.strokeStyle = spec.border;
  ctx.lineWidth = 2;
  drawRoundedRect(ctx, bx, by, w, h, 5);
  ctx.fill();
  ctx.stroke();

  // Top Cap Accent (e.g. grass for dirt, reinforced stone/timber lip)
  ctx.fillStyle = spec.top;
  ctx.fillRect(bx + 2, by + 2, w - 4, 5);

  // Procedural Grain Details per Type
  if (options.type === 'wood') {
    // Horizontal wood plank lines
    ctx.strokeStyle = '#7c2d12';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(bx + 6, by + h / 2);
    ctx.lineTo(bx + w - 6, by + h / 2);
    ctx.stroke();

    // Plank nail studs
    ctx.fillStyle = '#451a03';
    ctx.beginPath();
    ctx.arc(bx + 8, by + h / 2, 1.5, 0, Math.PI * 2);
    ctx.arc(bx + w - 8, by + h / 2, 1.5, 0, Math.PI * 2);
    ctx.fill();
  } else if (options.type === 'stone') {
    // Chiseled rock bevels
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(bx + 8, by + 10);
    ctx.lineTo(bx + 20, by + 22);
    ctx.lineTo(bx + 42, by + 16);
    ctx.stroke();
  } else if (options.type === 'clay') {
    // Clay sediment striations
    ctx.strokeStyle = '#9a3412';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(bx + 5, by + 14);
    ctx.lineTo(bx + w - 6, by + 18);
    ctx.moveTo(bx + 8, by + 25);
    ctx.lineTo(bx + w - 10, by + 23);
    ctx.stroke();
  } else if (options.type === 'dirt') {
    // Earthy speckles
    ctx.fillStyle = '#543007';
    ctx.beginPath();
    ctx.arc(bx + 12, by + 16, 1.8, 0, Math.PI * 2);
    ctx.arc(bx + 28, by + 24, 1.5, 0, Math.PI * 2);
    ctx.arc(bx + 40, by + 14, 2.0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Damage Cracks Overlay if HP < MaxHP
  if (hp < maxHp) {
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(bx + 10, by + 6);
    ctx.lineTo(bx + 22, by + 17);
    ctx.lineTo(bx + 16, by + 28);
    ctx.moveTo(bx + 22, by + 17);
    ctx.lineTo(bx + 34, by + 23);
    ctx.stroke();
  }

  ctx.restore();
}

// ---------------------------------------------------------------------------
// 4. Heavy Falling Physics Objects
// ---------------------------------------------------------------------------

// Bitmap falling objects (assets/sprites/objects/, regenerated by
// tools/slice_falling_objects.py). 128x128 at 2x, object centre = canvas centre,
// base on the bottom of the hit circle. The boulder and the cart's wheel overlays
// turn with distance rolled; the keg's fuse burns while it's moving.
const OBJECT_SPRITE_DRAW_SIZE = 64;
const FALLING_OBJECT_SPRITES: Record<string, string> = {
  anvil: 'anvil',
  boulder: 'boulder',
  cart: 'cart',
  barrel: 'keg'
};
const objectSpriteImages: Record<string, HTMLImageElement> = {};

export function loadFallingObjectSprites(basePath: string = 'assets/sprites/objects/'): void {
  if (typeof Image === 'undefined') return;
  for (const key of ['anvil', 'boulder', 'cart', 'cart_wheel', 'keg', 'keg_lit']) {
    const img = new Image();
    img.src = `${basePath}${key}.png`;
    objectSpriteImages[key] = img;
  }
}

export function drawFallingObject(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  options: FallingObjectRenderOptions
): void {
  const kind = options.kind;
  const radius = options.radius || 22;
  const angle = options.angle || 0;
  const scale = options.scale || 1.0;

  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  ctx.rotate(angle);

  const img = objectSpriteImages[kind === FallingObjectKind.Barrel && options.lit ? 'keg_lit' : FALLING_OBJECT_SPRITES[kind]];
  if (isSpriteReady(img)) {
    const roll = options.roll || 0;
    const half = OBJECT_SPRITE_DRAW_SIZE / 2;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.save();
    if (kind === FallingObjectKind.Boulder) ctx.rotate(roll / radius);
    ctx.drawImage(img, -half, -half, OBJECT_SPRITE_DRAW_SIZE, OBJECT_SPRITE_DRAW_SIZE);
    ctx.restore();

    const wheel = objectSpriteImages.cart_wheel;
    if (kind === FallingObjectKind.Cart && isSpriteReady(wheel)) {
      for (const [wx, wy] of CART_WHEEL_CENTERS) {
        ctx.save();
        ctx.translate(wx, wy);
        ctx.rotate(roll / (CART_WHEEL_SIZE / 2));
        ctx.drawImage(wheel, -CART_WHEEL_SIZE / 2, -CART_WHEEL_SIZE / 2, CART_WHEEL_SIZE, CART_WHEEL_SIZE);
        ctx.restore();
      }
    }
  } else {
    if (kind === FallingObjectKind.Anvil) {
      // Heavy Forged Iron Anvil
      ctx.fillStyle = '#1e293b';
      ctx.strokeStyle = '#94a3b8';
      ctx.lineWidth = 2;
      drawRoundedRect(ctx, -20, -14, 40, 14, 4);
      ctx.fill();
      ctx.stroke();

      // Waist and base
      ctx.fillStyle = '#475569';
      ctx.fillRect(-12, 0, 24, 14);

      // Beveled horn point
      ctx.fillStyle = '#1e293b';
      ctx.beginPath();
      ctx.moveTo(20, -14);
      ctx.lineTo(26, -9);
      ctx.lineTo(20, -4);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      // 2x Multiplier Badge
      ctx.fillStyle = '#38bdf8';
      ctx.font = 'bold 9px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('2x ANVIL', 0, -4);
    } else if (kind === FallingObjectKind.Cart) {
      // Mining Ore Cart with Heaped Golden Chunks
      ctx.fillStyle = '#fbbf24';
      ctx.beginPath();
      ctx.arc(-6, -8, 8, 0, Math.PI * 2);
      ctx.arc(6, -8, 8, 0, Math.PI * 2);
      ctx.fill();

      // Cart Hopper Body
      ctx.fillStyle = '#78350f';
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 2;
      drawRoundedRect(ctx, -19, -8, 38, 20, 5);
      ctx.fill();
      ctx.stroke();

      // Wheels
      ctx.fillStyle = '#cbd5e1';
      ctx.strokeStyle = '#475569';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(-11, 14, 6, 0, Math.PI * 2);
      ctx.arc(11, 14, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    } else if (kind === FallingObjectKind.Barrel) {
      // Red Powder Keg with Golden Brass Hoops
      ctx.fillStyle = options.color || '#991b1b';
      ctx.strokeStyle = options.accent || '#fca5a5';
      ctx.lineWidth = 2;
      drawRoundedRect(ctx, -16, -18, 32, 36, 8);
      ctx.fill();
      ctx.stroke();

      // Brass hoops
      ctx.fillStyle = '#fbbf24';
      ctx.fillRect(-16, -7, 32, 4);
      ctx.fillRect(-16, 5, 32, 4);

      // Fuse cap on top
      ctx.fillStyle = '#fde047';
      ctx.beginPath();
      ctx.arc(0, -18, 2.5, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // Granite / Meteor Boulder with Rugged Craters
      ctx.fillStyle = options.color || '#78716c';
      ctx.strokeStyle = options.accent || '#a8a29e';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // Shaded crater accents
      ctx.fillStyle = options.accent || '#d6d3d1';
      ctx.beginPath();
      ctx.arc(-6, -6, radius * 0.32, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(8, 6, radius * 0.22, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.restore();
}

// ---------------------------------------------------------------------------
// 5. Patrolling & Shielded Birds/Eagles
// ---------------------------------------------------------------------------

// Bitmap pseudodragon (assets/sprites/bird/, regenerated by tools/slice_dragon_sheets.py).
// 192x192 frames at 2x, facing left, canvas centre = hit centre. bird_flap is the
// wingbeat loop; bird_shatter plays once where a bird is killed. The shield stays
// in code (it reacts to hits). Falls back to the vector bird until loaded.
const BIRD_SPRITE_DRAW_SIZE = 80; // ~46 px snout to tail
const BIRD_SHATTER_FPS = 12;
const birdSpriteImages: Record<string, HTMLImageElement> = {};

export function loadBirdSprites(basePath: string = 'assets/sprites/bird/'): void {
  if (typeof Image === 'undefined') return;
  for (const key of ['bird_flap', 'bird_shatter']) {
    const img = new Image();
    img.src = `${basePath}${key}.png`;
    birdSpriteImages[key] = img;
  }
}

function stripFrameCount(img: HTMLImageElement): number {
  return Math.max(1, Math.round(img.naturalWidth / img.naturalHeight));
}

function drawStripFrame(ctx: CanvasRenderingContext2D, img: HTMLImageElement, index: number, size: number): void {
  const frameSize = img.naturalHeight;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, index * frameSize, 0, frameSize, frameSize, -size / 2, -size / 2, size, size);
}

/** Applies the same facing as drawBird: mirrored when flying right, rotated on the vertical plane. */
function orientBird(ctx: CanvasRenderingContext2D, plane: 'horizontal' | 'vertical', vx: number, vy: number): void {
  if (plane === 'vertical') {
    ctx.rotate(vy < 0 ? Math.PI * 0.5 : -Math.PI * 0.5);
  } else if (vx > 0) {
    ctx.scale(-1, 1);
  }
}

export function birdShatterDuration(): number {
  const img = birdSpriteImages.bird_shatter;
  return isSpriteReady(img) ? stripFrameCount(img) / BIRD_SHATTER_FPS : 0;
}

/** Draws the kill animation `age` seconds in; false once it has finished or isn't loaded. */
export function drawBirdShatter(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  options: { age: number; plane?: 'horizontal' | 'vertical'; vx?: number; vy?: number; scale?: number }
): boolean {
  const img = birdSpriteImages.bird_shatter;
  if (!isSpriteReady(img)) return false;
  const index = Math.floor(options.age * BIRD_SHATTER_FPS);
  if (index >= stripFrameCount(img)) return false;
  const scale = options.scale || 1.0;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  orientBird(ctx, options.plane || 'horizontal', options.vx ?? -120, options.vy ?? 0);
  drawStripFrame(ctx, img, index, BIRD_SPRITE_DRAW_SIZE);
  ctx.restore();
  return true;
}

export function drawBird(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  options: BirdRenderOptions = {}
): void {
  const flapPhase = options.flapPhase || 0;
  const isInterceptor = !!options.isInterceptor;
  const shielded = !!options.shielded;
  const shieldPulse = options.shieldPulse || 0;
  const plane = options.plane || 'horizontal';
  const vx = options.vx ?? -120;
  const vy = options.vy ?? 0;
  const age = options.age || 0;
  const scale = options.scale || 1.0;

  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);

  // Directional orientation
  orientBird(ctx, plane, vx, vy);

  const flapImg = birdSpriteImages.bird_flap;
  const useSprite = isSpriteReady(flapImg);

  if (useSprite) {
    const count = stripFrameCount(flapImg);
    const index = Math.floor((flapPhase / (Math.PI * 2)) * count) % count;
    drawStripFrame(ctx, flapImg, index, BIRD_SPRITE_DRAW_SIZE);
  } else {
    const wingY = Math.sin(flapPhase) * 14;
    const bodyColor = isInterceptor ? '#e11d48' : '#0284c7';
    const wingColor = isInterceptor ? '#fb7185' : '#38bdf8';

    // Tail feathers
    ctx.fillStyle = bodyColor;
    ctx.beginPath();
    ctx.moveTo(14, 0);
    ctx.lineTo(26, -7);
    ctx.lineTo(24, 6);
    ctx.closePath();
    ctx.fill();

    // Raptor Body
    ctx.fillStyle = bodyColor;
    ctx.strokeStyle = '#f8fafc';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(0, 0, 17, 11, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Sharp Golden Beak
    ctx.fillStyle = '#fbbf24';
    ctx.beginPath();
    ctx.moveTo(-16, -3);
    ctx.lineTo(-27, 1);
    ctx.lineTo(-16, 5);
    ctx.closePath();
    ctx.fill();

    // Fierce Eye
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(-9, -3, 3.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#0f172a';
    ctx.beginPath();
    ctx.arc(-10, -3, 1.6, 0, Math.PI * 2);
    ctx.fill();

    // Flapping Wing
    ctx.fillStyle = wingColor;
    ctx.beginPath();
    ctx.moveTo(-4, -2);
    ctx.quadraticCurveTo(4, -18 + wingY, 12, -2);
    ctx.closePath();
    ctx.fill();
  }

  // Translucent Cyan Spaceship Energy Shield
  if (shielded) {
    const shimmer = 0.55 + 0.25 * Math.sin(age * 9);
    // The dragon (wings included) is much bigger than the vector bird
    const rx = useSprite ? 32 : 22;
    const ry = useSprite ? 29 : 15;
    ctx.save();
    const grad = ctx.createRadialGradient(0, 0, ry * 0.7, 0, 0, rx + shieldPulse * 3);
    grad.addColorStop(0, 'rgba(56, 189, 248, 0.02)');
    grad.addColorStop(0.72, `rgba(56, 189, 248, ${0.22 + shieldPulse * 0.35})`);
    grad.addColorStop(1, `rgba(125, 211, 252, ${0.65 + shieldPulse * 0.3})`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.ellipse(-1, 0, rx + shieldPulse * 2, ry + shieldPulse * 2, 0, 0, Math.PI * 2);
    ctx.fill();

    // Crisp energy shield rim
    ctx.strokeStyle = shieldPulse > 0.1 ? '#e0f2fe' : `rgba(56, 189, 248, ${shimmer + 0.25})`;
    ctx.lineWidth = 1.6 + shieldPulse * 1.4;
    ctx.beginPath();
    ctx.ellipse(-1, 0, rx + shieldPulse * 2, ry + shieldPulse * 2, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  ctx.restore();
}

// ---------------------------------------------------------------------------
// 6. Mining Node (Target Ore Vein)
// ---------------------------------------------------------------------------

// Bitmap node (assets/sprites/node/, regenerated by tools/slice_ore_sheet.py).
// node/node_hit are 256x256 at 2x game resolution, centred on the node; the aura
// and sparkle twinkle stay in code. Falls back to the vector rock until loaded.
const NODE_SPRITE_DRAW_SIZE = 128;
const nodeSpriteImages: Record<string, HTMLImageElement> = {};

export function loadNodeSprites(basePath: string = 'assets/sprites/node/'): void {
  if (typeof Image === 'undefined') return;
  for (const key of ['node', 'node_hit', 'sparkle']) {
    const img = new Image();
    img.src = `${basePath}${key}.png`;
    nodeSpriteImages[key] = img;
  }
}

export function drawMiningNode(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  options: MiningNodeRenderOptions = {}
): void {
  const radius = options.radius || 50;
  const hitPulse = options.hitPulse || 0;
  const timeSec = options.time || 0;
  const scale = options.scale || 1.0;
  const sparkles = options.sparkles || [
    { rx: -22, ry: -18, phase: 0.0, size: 7 },
    { rx: 18, ry: -24, phase: 1.3, size: 8 },
    { rx: 25, ry: 6, phase: 2.5, size: 6 },
    { rx: -10, ry: 16, phase: 3.8, size: 7.5 },
    { rx: 4, ry: -4, phase: 5.1, size: 9 }
  ];

  ctx.save();
  ctx.translate(x, y);
  const pulseScale = scale * (1 + hitPulse * 0.18);
  ctx.scale(pulseScale, pulseScale);

  // Radiant ambient aura
  const aura = ctx.createRadialGradient(0, 0, 15, 0, 0, radius + 26);
  aura.addColorStop(0, hitPulse > 0.1 ? 'rgba(254, 240, 138, 0.65)' : 'rgba(250, 204, 21, 0.45)');
  aura.addColorStop(1, 'rgba(250, 204, 21, 0)');
  ctx.fillStyle = aura;
  ctx.beginPath();
  ctx.arc(0, 0, radius + 26, 0, Math.PI * 2);
  ctx.fill();

  const nodeImg = hitPulse > 0.2 && isSpriteReady(nodeSpriteImages.node_hit)
    ? nodeSpriteImages.node_hit
    : nodeSpriteImages.node;
  if (isSpriteReady(nodeImg)) {
    const half = NODE_SPRITE_DRAW_SIZE / 2;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(nodeImg, -half, -half, NODE_SPRITE_DRAW_SIZE, NODE_SPRITE_DRAW_SIZE);
  } else {
    // Pedestal Faceted Crystal Boulder
    ctx.fillStyle = hitPulse > 0.2 ? '#fef08a' : '#334155';
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.moveTo(-44, 34);
    ctx.lineTo(-48, -6);
    ctx.lineTo(-26, -38);
    ctx.lineTo(6, -46);
    ctx.lineTo(36, -28);
    ctx.lineTo(48, 4);
    ctx.lineTo(40, 36);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Pulsing Emerald & Gold Crystal Vein Prisms
    ctx.fillStyle = '#f59e0b';
    ctx.beginPath();
    ctx.moveTo(-24, -12);
    ctx.lineTo(-6, -28);
    ctx.lineTo(4, -10);
    ctx.lineTo(-14, 4);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#facc15';
    ctx.beginPath();
    ctx.moveTo(8, -16);
    ctx.lineTo(28, -8);
    ctx.lineTo(22, 16);
    ctx.lineTo(2, 10);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#fde047';
    ctx.beginPath();
    ctx.arc(-16, 18, 9, 0, Math.PI * 2);
    ctx.fill();

    // Emerald Gem Facet
    ctx.fillStyle = '#10b981';
    ctx.strokeStyle = '#34d399';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-10, -8);
    ctx.lineTo(2, -22);
    ctx.lineTo(14, -8);
    ctx.lineTo(2, 6);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

  }

  // Twinkling Star Sparkles
  sparkles.forEach((sp) => {
    const twinkle = 0.45 + 0.55 * Math.abs(Math.sin(timeSec * 4.2 + sp.phase));
    const sz = sp.size * twinkle;
    ctx.save();
    ctx.translate(sp.rx, sp.ry);
    if (isSpriteReady(nodeSpriteImages.sparkle)) {
      // The glint fills ~44 of its 48 px, so this matches the vector star's reach
      const d = sz * 2.4;
      ctx.drawImage(nodeSpriteImages.sparkle, -d / 2, -d / 2, d, d);
      ctx.restore();
      return;
    }
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(0, -sz);
    ctx.quadraticCurveTo(sz * 0.22, -sz * 0.22, sz, 0);
    ctx.quadraticCurveTo(sz * 0.22, sz * 0.22, 0, sz);
    ctx.quadraticCurveTo(-sz * 0.22, sz * 0.22, -sz, 0);
    ctx.quadraticCurveTo(-sz * 0.22, -sz * 0.22, 0, -sz);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  });

  ctx.restore();
}

// ---------------------------------------------------------------------------
// 7. Excalibur.js High-Level Graphic Creators
// ---------------------------------------------------------------------------

export const GraphicsFactory = {
  // Direct render functions
  drawDwarf,
  loadDwarfSprites,
  loadNodeSprites,
  loadPickaxeSprites,
  loadBirdSprites,
  loadFallingObjectSprites,
  loadBlockSprites,
  drawGarrisonStep,
  drawPickaxe: drawPickaxeGraphic,
  drawBlock,
  drawFallingObject,
  drawBird,
  drawMiningNode,
  setExcalibur,

  // Excalibur Graphic / ex.Canvas creators
  createDwarfCanvas(options: DwarfRenderOptions = {}): any {
    const width = 120;
    const height = 120;
    return createExCanvas({
      width,
      height,
      draw: (ctx: CanvasRenderingContext2D) => {
        drawDwarf(ctx, width / 2, height / 2 + 10, options);
      }
    });
  },

  createPickaxeCanvas(options: PickaxeRenderOptions = {}): any {
    const size = 64;
    return createExCanvas({
      width: size,
      height: size,
      draw: (ctx: CanvasRenderingContext2D) => {
        drawPickaxeGraphic(ctx, size / 2, size / 2, 1.2, options);
      }
    });
  },

  createBlockCanvas(
    type: BlockTypeKind,
    damaged: boolean = false,
    options: Partial<BlockRenderOptions> = {}
  ): any {
    const w = options.width || 52;
    const h = options.height || 36;
    const maxHp = type === 'clay' || type === 'stone' ? 2 : 1;
    const hp = damaged ? 1 : maxHp;

    return createExCanvas({
      width: w,
      height: h,
      cache: true,
      draw: (ctx: CanvasRenderingContext2D) => {
        drawBlock(ctx, 0, 0, {
          type,
          hp,
          maxHp,
          width: w,
          height: h,
          shake: options.shake || 0,
          alpha: options.alpha ?? 1.0
        });
      }
    });
  },

  createFallingObjectCanvas(
    kind: FallingObjectKindType,
    options: Partial<FallingObjectRenderOptions> = {}
  ): any {
    const radius = options.radius || 24;
    const size = radius * 2 + 16;
    return createExCanvas({
      width: size,
      height: size,
      cache: false,
      draw: (ctx: CanvasRenderingContext2D) => {
        drawFallingObject(ctx, size / 2, size / 2, {
          kind,
          radius,
          angle: options.angle || 0,
          color: options.color,
          accent: options.accent,
          scale: options.scale || 1.0
        });
      }
    });
  },

  createBirdCanvas(options: BirdRenderOptions = {}): any {
    const size = 64;
    return createExCanvas({
      width: size,
      height: size,
      cache: false,
      draw: (ctx: CanvasRenderingContext2D) => {
        drawBird(ctx, size / 2, size / 2, options);
      }
    });
  },

  createMiningNodeCanvas(options: MiningNodeRenderOptions = {}): any {
    const radius = options.radius || 50;
    const size = (radius + 28) * 2;
    return createExCanvas({
      width: size,
      height: size,
      cache: false,
      draw: (ctx: CanvasRenderingContext2D) => {
        drawMiningNode(ctx, size / 2, size / 2, {
          ...options,
          radius
        });
      }
    });
  }
};
