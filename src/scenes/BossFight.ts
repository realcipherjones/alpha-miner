/**
 * BossFight.ts
 *
 * Boss fight definitions, state, aim solver, and placeholder rendering.
 *
 * Triggers (decided by ExcaliburGameController when a stage's clear countdown ends):
 * - Overkill badge GREEN (+10 past the 7 KII goal)  -> Dog boss
 * - Overkill badge PURPLE (+15 past the 7 KII goal) -> Son boss
 *
 * Rules:
 * - Boss stands in the bottom-right corner, oversized (dog 2x, son 3x the dwarf), and can jump.
 * - Boss lobs collideables at the dwarf using the player's lob mechanics (no trajectory shown).
 *   Dog: boulders only ("fetch"). Son: any of anvil / boulder / cart / barrel.
 * - A collideable hitting the dwarf knocks 1 KII out of the bank.
 * - Lobs are free in boss fights through stage 150 (gift lobs aren't spent); normal fees after.
 * - 10 axe hits defeat the boss. Deflects (son 15% hair whip, dog 7.55% tail whip) bounce the
 *   axe back with the bird-shield physics; a deflected axe that hits the dwarf knocks out 1 KII.
 * - First encounter with a given boss: no birds. Later encounters: birds with the stage's mechanics.
 *
 * Art: bitmap strips from tools/slice_boss_sheet.py when present, otherwise placeholder vector
 * (coloured from the reference photos in assets/reference/).
 */

import type { FallingObjectDef } from './LevelData.ts';
import { BOSS_SPRITE_META } from './BossSpriteMeta.ts';

export type BossKind = 'dog' | 'son';
export type BossProjectileKind = FallingObjectDef['kind'];

export const BOSS_HITS_TO_DEFEAT = 10;
export const BOSS_OVERKILL_DOG = 10; // green overkill badge
export const BOSS_OVERKILL_SON = 15; // purple overkill badge
/** Boss-fight lobs cost nothing through this stage (3 cash-out chances: 50, 100, 150); fees return after. */
export const BOSS_FREE_LOBS_MAX_STAGE = 150;

export interface BossDef {
  kind: BossKind;
  name: string;
  /** Size relative to the dwarf. */
  scale: number;
  /** Hitbox in px (feet-anchored, centred on x). */
  width: number;
  height: number;
  /** Distance of the hitbox centre from the right screen edge. */
  rightInset: number;
  projectiles: BossProjectileKind[];
  throwInterval: { min: number; max: number };
  deflectChance: number;
  /** Chance to hop when a player axe closes in. */
  dodgeChance: number;
  jumpSpeed: number;
  /** Aim error, so the boss is beatable: +/- degrees and +/- power percent. */
  aimErrorDeg: number;
  aimErrorPowerPct: number;
  color: string;
  accent: string;
}

// The dwarf sprite is roughly 56 x 86 px on screen
export const BOSS_DEFS: Record<BossKind, BossDef> = {
  dog: {
    kind: 'dog',
    name: 'Bone Crusher',
    scale: 2,
    width: 150,
    height: 120,
    rightInset: 100,
    projectiles: ['boulder'],
    throwInterval: { min: 2.2, max: 3.2 },
    deflectChance: 0.0755,
    dodgeChance: 0.3,
    jumpSpeed: 560,
    aimErrorDeg: 5,
    aimErrorPowerPct: 6,
    color: '#34d399',
    accent: '#065f46'
  },
  son: {
    kind: 'son',
    name: 'YesChef',
    scale: 3,
    width: 150,
    height: 258,
    rightInset: 110,
    projectiles: ['anvil', 'boulder', 'cart', 'barrel'],
    throwInterval: { min: 1.9, max: 2.8 },
    deflectChance: 0.15,
    dodgeChance: 0.2,
    jumpSpeed: 520,
    aimErrorDeg: 4,
    aimErrorPowerPct: 5,
    color: '#a78bfa',
    accent: '#4c1d95'
  }
};

export const BOSS_PROJECTILE_SPECS: Record<BossProjectileKind, { radius: number; color: string; accent: string }> = {
  anvil: { radius: 22, color: '#1e293b', accent: '#38bdf8' },
  boulder: { radius: 23, color: '#78716c', accent: '#d6d3d1' },
  cart: { radius: 22, color: '#b45309', accent: '#fbbf24' },
  barrel: { radius: 20, color: '#991b1b', accent: '#fca5a5' }
};

export interface BossState {
  def: BossDef;
  /** 1 = first time facing this boss. */
  encounter: number;
  birds: boolean;
  x: number;
  /** Feet y. */
  y: number;
  vy: number;
  grounded: boolean;
  hits: number;
  deflections: number;
  throws: number;
  jumps: number;
  coinsKnocked: number;
  /** Coins lost to the player's own deflected axes. */
  deflectHits: number;
  throwTimer: number;
  jumpTimer: number;
  hurtTimer: number;
  throwAnimTimer: number;
  /** Hair whip (son) / tail whip (dog) while deflecting. */
  deflectAnimTimer: number;
  defeated: boolean;
}

export interface BossProjectile {
  kind: BossProjectileKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  color: string;
  accent: string;
  roll: number;
  bounces: number;
}

export function bossForOverkill(overkill: number): BossKind | null {
  if (overkill >= BOSS_OVERKILL_SON) return 'son';
  if (overkill >= BOSS_OVERKILL_DOG) return 'dog';
  return null;
}

export function bossHitbox(boss: BossState): { x: number; y: number; w: number; h: number } {
  return { x: boss.x - boss.def.width / 2, y: boss.y - boss.def.height, w: boss.def.width, h: boss.def.height };
}

/** Where the boss releases its throw: the dog's mouth, the son's raised hand. */
export function bossThrowOrigin(boss: BossState): { x: number; y: number } {
  const box = bossHitbox(boss);
  return boss.def.kind === 'dog'
    ? { x: box.x + 10, y: box.y + 64 }
    : { x: box.x + 6, y: box.y + box.h * 0.3 };
}

/**
 * Solve the player's lob mechanics (speed = 440 + power% * 8, launched left) to land on
 * the target, then add aim error. Returns angle (deg) and power (%).
 */
export function solveBossLob(
  origin: { x: number; y: number },
  target: { x: number; y: number },
  gravity: number,
  def: BossDef,
  rand: () => number = Math.random
): { angleDeg: number; powerPct: number } {
  const dx = Math.max(40, origin.x - target.x);
  const dy = target.y - origin.y; // +down
  let best = { angleDeg: 45, powerPct: 100 };
  // Prefer a random arc in a natural range; fall back to whatever angle is reachable
  const start = 30 + Math.floor(rand() * 30);
  for (let k = 0; k <= 50; k++) {
    const angleDeg = 20 + ((start - 20 + k) % 51);
    const rad = (angleDeg * Math.PI) / 180;
    const denom = 2 * Math.cos(rad) ** 2 * (dy + dx * Math.tan(rad));
    if (denom <= 0) continue;
    const speed = Math.sqrt((gravity * dx * dx) / denom);
    const powerPct = ((speed - 440) / 800) * 100;
    if (powerPct < 0 || powerPct > 100) continue;
    best = { angleDeg, powerPct };
    break;
  }
  const angleDeg = best.angleDeg + (rand() * 2 - 1) * def.aimErrorDeg;
  const powerPct = Math.max(0, Math.min(100, best.powerPct + (rand() * 2 - 1) * def.aimErrorPowerPct));
  return { angleDeg, powerPct };
}

// ---------------------------------------------------------------------------
// Placeholder art (replace with sprites)
// ---------------------------------------------------------------------------

export const BOSS_DEFLECT_ANIM_SEC = 0.4;
export const BOSS_THROW_ANIM_SEC = 0.35;

/** Motion streak along a whipping tail / ponytail. */
function drawWhipStreak(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number, len: number, color: string): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.45;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(x, y, len + 8, angle - 0.1, angle + 0.9);
  ctx.stroke();
  ctx.restore();
}

// Colours taken from the reference photos (assets/reference/)
const DOG_PALETTE = {
  coat: '#1d1e23', // black staffy coat
  edge: '#000000',
  sheen: '#3a3d46',
  white: '#f1f5f9', // chest blaze + toes
  collar: '#db2777',
  tongue: '#f472b6',
  eye: '#fbbf24'
};
const SON_PALETTE = {
  jacket: '#f8fafc', // white chef whites
  jacketEdge: '#94a3b8',
  buttons: '#1e293b',
  pants: '#111827',
  cap: '#f8fafc', // modern skull-cap chef hat
  skin: '#f0c4a0',
  hair: '#6b4423', // long braided ponytail
  beard: '#5a381c',
  teeth: '#ffffff'
};

/** Hurt flash: red tint every other 1/20 s. */
function hurtFlash(boss: BossState, timeSec: number): boolean {
  return boss.hurtTimer > 0 && Math.floor(timeSec * 20) % 2 === 0;
}

export function drawBossPlaceholder(ctx: CanvasRenderingContext2D, boss: BossState, timeSec: number): void {
  const box = bossHitbox(boss);
  const def = boss.def;
  const hurt = hurtFlash(boss, timeSec);
  const bob = boss.grounded ? Math.sin(timeSec * 4) * 2 : 0;
  // 0 -> 1 -> 0 over the deflect: the whip sweeps out and back
  const whip = boss.deflectAnimTimer > 0 ? Math.sin(Math.PI * (1 - boss.deflectAnimTimer / BOSS_DEFLECT_ANIM_SEC)) : 0;

  ctx.save();
  ctx.translate(0, bob);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  if (def.kind === 'dog') {
    const P = DOG_PALETTE;
    const coat = hurt ? '#7f1d1d' : P.coat;
    // Play bow: front paws down, butt in the air, facing left toward the dwarf
    const hipX = box.x + box.w - 30;
    const hipY = box.y + 44;
    const ground = box.y + box.h;
    ctx.fillStyle = coat;
    ctx.strokeStyle = P.edge;
    ctx.lineWidth = 3;
    // Tail behind the body: wags upright; on a deflect it whips forward over the back
    const tailAngle = -1.25 + Math.sin(timeSec * 14) * 0.25 * (1 - whip) - whip * 1.7;
    const tailLen = 58 + whip * 22;
    const tx = hipX + 14;
    const ty = hipY - 6;
    ctx.strokeStyle = coat;
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.quadraticCurveTo(
      tx + Math.cos(tailAngle + 0.5) * tailLen * 0.6,
      ty + Math.sin(tailAngle + 0.5) * tailLen * 0.6,
      tx + Math.cos(tailAngle) * tailLen,
      ty + Math.sin(tailAngle) * tailLen
    );
    ctx.stroke();
    if (whip > 0.2) drawWhipStreak(ctx, tx, ty, tailAngle, tailLen, def.color);
    ctx.strokeStyle = P.edge;
    ctx.lineWidth = 3;
    // Rear legs (straight up to the raised hips), white toes
    for (const lx of [hipX - 14, hipX + 4]) {
      ctx.fillStyle = coat;
      ctx.fillRect(lx, hipY, 14, ground - hipY);
      ctx.strokeRect(lx, hipY, 14, ground - hipY);
      ctx.fillStyle = P.white;
      ctx.fillRect(lx, ground - 6, 14, 6);
    }
    // Forearms flat on the ground, reaching forward, white toes at the front
    ctx.fillStyle = coat;
    ctx.beginPath();
    ctx.roundRect(box.x + 8, ground - 14, 64, 14, 7);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = P.white;
    ctx.fillRect(box.x + 8, ground - 7, 10, 7);
    // Muscular body slopes from the low chest up to the hips
    const chestX = box.x + 52;
    const chestY = ground - 34;
    ctx.save();
    ctx.translate((chestX + hipX) / 2, (chestY + hipY) / 2);
    ctx.rotate(Math.atan2(hipY - chestY, hipX - chestX));
    ctx.fillStyle = coat;
    ctx.beginPath();
    ctx.ellipse(0, 0, Math.hypot(hipX - chestX, hipY - chestY) / 2 + 22, 27, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = P.sheen;
    ctx.beginPath();
    ctx.ellipse(0, -8, Math.hypot(hipX - chestX, hipY - chestY) / 2, 12, 0, Math.PI * 1.15, Math.PI * 1.85);
    ctx.stroke();
    ctx.restore();
    // White chest blaze
    ctx.fillStyle = P.white;
    ctx.beginPath();
    ctx.ellipse(chestX - 6, chestY + 10, 9, 14, 0.4, 0, Math.PI * 2);
    ctx.fill();
    // Broad staffy head low between the paws, rose ears, short snout
    const hx = box.x + 30;
    const hy = ground - 46;
    ctx.fillStyle = coat;
    ctx.strokeStyle = P.edge;
    ctx.beginPath();
    ctx.ellipse(hx, hy, 29, 25, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(hx - 22, hy + 6, 14, 12, 0, 0, Math.PI * 2); // muzzle
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(hx + 14, hy - 22, 7, 10, 0.9, 0, Math.PI * 2); // rose ear
    ctx.fill();
    ctx.stroke();
    // Pink collar
    ctx.strokeStyle = P.collar;
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(hx + 10, hy + 6, 22, 0.2, 1.6);
    ctx.stroke();
    ctx.fillStyle = P.edge;
    ctx.beginPath();
    ctx.arc(hx - 32, hy + 2, 5, 0, Math.PI * 2); // nose
    ctx.fill();
    ctx.fillStyle = P.eye;
    ctx.beginPath();
    ctx.arc(hx - 10, hy - 8, 3.5, 0, Math.PI * 2);
    ctx.fill();
    // Tongue out; mouth opens wide to spit the boulder ("fetch")
    ctx.fillStyle = boss.throwAnimTimer > 0 ? '#7f1d1d' : P.tongue;
    ctx.beginPath();
    if (boss.throwAnimTimer > 0) ctx.ellipse(hx - 22, hy + 18, 13, 8, 0, 0, Math.PI * 2);
    else ctx.ellipse(hx - 18, hy + 20, 6, 9, 0.3, 0, Math.PI * 2);
    ctx.fill();
  } else {
    const P = SON_PALETTE;
    const jacket = hurt ? '#fca5a5' : P.jacket;
    const cx = box.x + box.w / 2;
    const ground = box.y + box.h;
    const headY = box.y + 44;
    ctx.strokeStyle = P.jacketEdge;
    ctx.lineWidth = 3;
    // Wide, planted stance in black chef pants
    ctx.fillStyle = P.pants;
    for (const [lx, rot] of [[cx - 22, 0.22], [cx + 22, -0.22]] as const) {
      ctx.save();
      ctx.translate(lx, ground - 96);
      ctx.rotate(rot);
      ctx.fillRect(-14, 0, 28, 98);
      ctx.restore();
    }
    // Chef jacket: double-breasted, two rows of buttons
    ctx.fillStyle = jacket;
    ctx.beginPath();
    ctx.roundRect(cx - 54, box.y + 82, 108, box.h - 172, 20);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = P.buttons;
    for (let r = 0; r < 4; r++) {
      ctx.beginPath();
      ctx.arc(cx - 16, box.y + 104 + r * 20, 3, 0, Math.PI * 2);
      ctx.arc(cx + 16, box.y + 104 + r * 20, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    // Braided ponytail: hangs behind the shoulder, whips around the front on a deflect
    const tieX = cx + 26;
    const tieY = headY - 10;
    const tipX = cx + 44 - whip * 170;
    const tipY = box.y + 150 - whip * 140;
    ctx.strokeStyle = P.hair;
    ctx.lineWidth = 13;
    ctx.beginPath();
    ctx.moveTo(tieX, tieY);
    ctx.quadraticCurveTo(cx + 70 - whip * 40, headY + 30 - whip * 120, tipX, tipY);
    ctx.stroke();
    ctx.strokeStyle = P.beard; // braid crossings
    ctx.lineWidth = 2;
    for (let k = 1; k < 6; k++) {
      const t = k / 6;
      const bx = (1 - t) ** 2 * tieX + 2 * (1 - t) * t * (cx + 70 - whip * 40) + t * t * tipX;
      const by = (1 - t) ** 2 * tieY + 2 * (1 - t) * t * (headY + 30 - whip * 120) + t * t * tipY;
      ctx.beginPath();
      ctx.moveTo(bx - 5, by - 3);
      ctx.lineTo(bx + 5, by + 3);
      ctx.stroke();
    }
    if (whip > 0.2) drawWhipStreak(ctx, tieX, tieY, Math.atan2(tipY - tieY, tipX - tieX), Math.hypot(tipX - tieX, tipY - tieY), def.color);
    // Head, hair swept back under the cap, full beard
    ctx.fillStyle = P.skin;
    ctx.strokeStyle = '#7c4a2a';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx, headY, 36, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = P.beard;
    ctx.beginPath();
    ctx.moveTo(cx - 36, headY + 2);
    ctx.quadraticCurveTo(cx - 30, headY + 52, cx, headY + 50);
    ctx.quadraticCurveTo(cx + 30, headY + 52, cx + 36, headY + 2);
    ctx.quadraticCurveTo(cx, headY + 22, cx - 36, headY + 2);
    ctx.fill();
    // Cocky grin with teeth, one brow cocked
    ctx.fillStyle = P.teeth;
    ctx.beginPath();
    ctx.moveTo(cx - 18, headY + 16);
    ctx.quadraticCurveTo(cx - 2, headY + 30, cx + 16, headY + 12);
    ctx.quadraticCurveTo(cx - 2, headY + 20, cx - 18, headY + 16);
    ctx.fill();
    ctx.fillStyle = '#0f172a';
    ctx.beginPath();
    ctx.arc(cx - 15, headY - 6, 4, 0, Math.PI * 2);
    ctx.arc(cx + 9, headY - 6, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = P.beard;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx - 23, headY - 15);
    ctx.lineTo(cx - 9, headY - 18);
    ctx.moveTo(cx + 2, headY - 18);
    ctx.lineTo(cx + 17, headY - 26);
    ctx.stroke();
    // Modern skull-cap chef hat: snug, squared-off beanie with a band
    ctx.fillStyle = P.cap;
    ctx.strokeStyle = P.jacketEdge;
    ctx.beginPath();
    ctx.roundRect(cx - 38, headY - 58, 76, 36, [16, 16, 4, 4]);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - 38, headY - 30);
    ctx.lineTo(cx + 38, headY - 30);
    ctx.stroke();
    // Arms crossed over the chest; the front arm uncrosses to throw
    const arm = (y: number) => {
      ctx.fillStyle = jacket;
      ctx.strokeStyle = P.jacketEdge;
      ctx.beginPath();
      ctx.roundRect(cx - 50, y, 100, 24, 12);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = P.skin;
      ctx.beginPath();
      ctx.arc(y < box.y + 130 ? cx + 46 : cx - 46, y + 12, 10, 0, Math.PI * 2);
      ctx.fill();
    };
    arm(box.y + 118);
    if (boss.throwAnimTimer > 0) {
      ctx.save();
      ctx.translate(cx - 46, box.y + 102);
      ctx.rotate(-2.2);
      ctx.fillStyle = jacket;
      ctx.fillRect(-11, 0, 22, 80);
      ctx.fillStyle = P.skin;
      ctx.beginPath();
      ctx.arc(0, 84, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    } else {
      arm(box.y + 134);
    }
  }

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Bitmap sprites (assets/sprites/boss/<kind>_<anim>.png, from tools/slice_boss_sheet.py)
// ---------------------------------------------------------------------------

const BOSS_SPRITE_SCALE = 0.5; // stored at 2x game resolution
const BOSS_SPRITE_FPS: Record<string, number> = { idle: 5 };
const bossSpriteImages: Record<string, HTMLImageElement> = {};

function spriteReady(img: HTMLImageElement | undefined): img is HTMLImageElement {
  return !!img && img.complete && img.naturalWidth > 0;
}

export function loadBossSprites(basePath: string = 'assets/sprites/boss/'): void {
  if (typeof Image === 'undefined') return;
  for (const [kind, meta] of Object.entries(BOSS_SPRITE_META)) {
    for (const anim of Object.keys(meta.counts)) {
      const img = new Image();
      img.src = `${basePath}${kind}_${anim}.png`;
      bossSpriteImages[`${kind}_${anim}`] = img;
    }
  }
}

/** Picks the strip + frame for the boss's current state; falls back to idle for missing strips. */
export function pickBossSpriteFrame(boss: BossState, timeSec: number): { anim: string; index: number } | null {
  const meta = BOSS_SPRITE_META[boss.def.kind];
  if (!meta || !meta.counts.idle) return null;
  const has = (a: string) => (meta.counts[a] || 0) > 0;
  const progress = (timer: number, total: number, count: number) =>
    Math.min(count - 1, Math.floor((1 - timer / total) * count));

  if (boss.defeated && has('defeat')) return { anim: 'defeat', index: meta.counts.defeat - 1 };
  if (boss.deflectAnimTimer > 0 && has('deflect')) {
    return { anim: 'deflect', index: progress(boss.deflectAnimTimer, BOSS_DEFLECT_ANIM_SEC, meta.counts.deflect) };
  }
  if (boss.hurtTimer > 0 && has('hurt')) return { anim: 'hurt', index: Math.floor(timeSec * 10) % meta.counts.hurt };
  if (boss.throwAnimTimer > 0 && has('throw')) {
    return { anim: 'throw', index: progress(boss.throwAnimTimer, BOSS_THROW_ANIM_SEC, meta.counts.throw) };
  }
  if (!boss.grounded && has('jump')) {
    // Frame 0 is the crouch; rising uses the middle frame, falling the last
    const n = meta.counts.jump;
    return { anim: 'jump', index: n === 1 ? 0 : boss.vy < 0 ? Math.min(1, n - 1) : n - 1 };
  }
  return { anim: 'idle', index: Math.floor(timeSec * BOSS_SPRITE_FPS.idle) % meta.counts.idle };
}

/** Draws the boss sprite if its sheet is loaded, otherwise the placeholder; then the name tag. */
export function drawBoss(ctx: CanvasRenderingContext2D, boss: BossState, timeSec: number): void {
  const pick = pickBossSpriteFrame(boss, timeSec);
  const img = pick ? bossSpriteImages[`${boss.def.kind}_${pick.anim}`] : undefined;
  if (pick && spriteReady(img)) {
    const meta = BOSS_SPRITE_META[boss.def.kind];
    const size = meta.frame;
    const s = BOSS_SPRITE_SCALE;
    ctx.save();
    ctx.translate(boss.x, boss.y);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, pick.index * size, 0, size, size, (-size / 2) * s, -meta.anchorY * s, size * s, size * s);
    if (hurtFlash(boss, timeSec)) {
      // Red flash over the sprite only
      ctx.globalCompositeOperation = 'source-atop';
      ctx.globalAlpha = 0.45;
      ctx.fillStyle = '#ef4444';
      ctx.fillRect((-size / 2) * s, -meta.anchorY * s, size * s, size * s);
    }
    ctx.restore();
  } else {
    drawBossPlaceholder(ctx, boss, timeSec);
  }
  drawBossNameTag(ctx, boss);
}

function drawBossNameTag(ctx: CanvasRenderingContext2D, boss: BossState): void {
  const box = bossHitbox(boss);
  ctx.save();
  ctx.font = '900 14px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#0f172a';
  ctx.lineWidth = 4;
  ctx.strokeText(boss.def.name, box.x + box.w / 2, box.y - 12);
  ctx.fillText(boss.def.name, box.x + box.w / 2, box.y - 12);
  ctx.restore();
}

/** Top-centre health bar: one pip per remaining hit. */
export function drawBossHealthBar(ctx: CanvasRenderingContext2D, boss: BossState, viewportWidth: number): void {
  const pips = BOSS_HITS_TO_DEFEAT;
  const pipW = 26;
  const gap = 4;
  const barW = pips * pipW + (pips - 1) * gap;
  const x0 = (viewportWidth - barW) / 2;
  const y0 = 18;

  ctx.save();
  ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
  ctx.beginPath();
  ctx.roundRect(x0 - 12, y0 - 8, barW + 24, 44, 10);
  ctx.fill();
  ctx.font = '900 12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = boss.def.color;
  const tag = boss.birds ? '' : ' · NO BIRDS (1ST ENCOUNTER)';
  ctx.fillText(`${boss.def.name} · ${boss.hits}/${BOSS_HITS_TO_DEFEAT} HITS${tag}`, viewportWidth / 2, y0 + 6);
  for (let i = 0; i < pips; i++) {
    ctx.fillStyle = i < pips - boss.hits ? boss.def.color : '#334155';
    ctx.fillRect(x0 + i * (pipW + gap), y0 + 14, pipW, 12);
  }
  ctx.restore();
}
