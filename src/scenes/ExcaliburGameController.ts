/**
 * ExcaliburGameController.ts
 *
 * Master game engine controller integrating with Excalibur.js v0.29.3.
 * Manages both game modes across all 10 maps:
 * - Mode 1: "MANUAL_FAUCET" (Arena Tosser Mode, Maps 1–10)
 *   Original physics, stepped stance tiers, destructible blocks, falling physics
 *   objects (+2 KII DOUBLE), patrolling and shielded birds, overhead rebound free lob,
 *   and Level 5+ Pay-to-Play 1-KII lob fee.
 * - Mode 2: "SIDE_SCROLLER" (Platformer Mode, Maps 1–10)
 *   Wide 2800px–3600px courses, smooth camera tracking, parallax scrolling backgrounds,
 *   running/jumping/coyote time, HALF GRAVITY in Space (bg6–bg10: 490 px/s^2),
 *   aim & throw pickaxes while platforming, checkpoints, hazards, intermediate ore veins,
 *   and top-of-screen minimap progress bar.
 *
 * Compatible with Node v24 `--experimental-strip-types` (no enums, no parameter properties).
 */

import { SoundEngine } from '../audio/SoundEngine.ts';
import { KiiLedgerService, RAW_PER_KII } from '../kii/KiiLedgerService.ts';
import {
  GraphicsFactory,
  DwarfAnimation,
  drawDwarf,
  drawPickaxeGraphic,
  drawBlock,
  drawFallingObject,
  drawBird,
  drawMiningNode,
  loadDwarfSprites,
  loadNodeSprites,
  loadPickaxeSprites,
  loadBirdSprites,
  loadFallingObjectSprites,
  loadBlockSprites,
  drawGarrisonStep,
  drawBirdShatter,
  birdShatterDuration,
  setExcalibur
} from '../actors/GraphicsFactory.ts';
import {
  getAllMaps,
  getMapById,
  getPlatformerLevel,
  isSpaceMap,
  MapDefinition,
  PlatformerLevel,
  BlockDef,
  FallingObjectDef,
  BirdDef,
  MovingPlatformDef,
  HazardDef,
  MiningNodeDef,
  HazardType,
  BIRD_RADIUS
} from './LevelData.ts';
import { generateArenaLevel, GeneratedArenaLevel } from './ArenaGenerator.ts';
import {
  BossKind,
  BossState,
  BossProjectile,
  BOSS_DEFS,
  BOSS_FREE_LOBS_MAX_STAGE,
  BOSS_DEFLECT_ANIM_SEC,
  BOSS_HITS_TO_DEFEAT,
  BOSS_PROJECTILE_SPECS,
  bossForOverkill,
  bossHitbox,
  bossThrowOrigin,
  solveBossLob,
  drawBoss,
  loadBossSprites,
  BOSS_THROW_ANIM_SEC,
  drawBossHealthBar
} from './BossFight.ts';

// Boss-fight hop: ~140 px apex at 980 gravity
const ARENA_JUMP_VELOCITY = 520;

// How long the throw pose plays after a lob (shorter than the 0.42 s lob cooldown)
const DWARF_THROW_DURATION = 0.36;
// How long the tosser target shows its cracked/pulsing hit state
const NODE_HIT_FLASH_DURATION = 0.3;

// ---------------------------------------------------------------------------
// Interfaces & Types
// ---------------------------------------------------------------------------

export type GameModeType = 'MANUAL_FAUCET' | 'SIDE_SCROLLER';

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  color: string;
  alpha: number;
  life: number;
  maxLife: number;
}

export interface FloatingText {
  x: number;
  y: number;
  text: string;
  color: string;
  alpha: number;
  vy: number;
}

export interface FloatingCoin {
  x: number;
  y: number;
  vx: number;
  vy: number;
  alpha: number;
  spin: number;
}

export interface ActivePickaxe {
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  spinSpeed: number;
  radius: number;
  bounces: number;
  maxBounces: number;
  hitShieldedBird: boolean;
  awardedFreeLob: boolean;
  hitNodeCooldown: number;
  birdBounceCooldown?: number;
  life: number;
  trail: Array<{ x: number; y: number }>;
}

export interface GameControllerCallbacks {
  onScoreUpdate?: (score: number, target: number, totalCoins: number, freeLob: boolean) => void;
  onDwarfStanceUpdate?: (stanceLabel: string) => void;
  onAimUpdate?: (angle: number, power: number) => void;
  onVictoryCountdown?: (secondsLeft: number, nextMapId: number) => void;
  onGameOver?: (reason: string, stats: { totalThrows: number; directHits: number; crushHits: number }) => void;
  onModeChange?: (mode: GameModeType) => void;
  onMapChange?: (mapDef: MapDefinition) => void;
  onPlatformerMilestone?: (label: string, kiiAwarded: number) => void;
  onCashOutOffer?: (stage: number, freeLobs: number, balanceKii: number) => void;
  /** Boss fight started (state) or ended (null). */
  onBossFight?: (boss: BossState | null) => void;
}

// ---------------------------------------------------------------------------
// ExcaliburGameController Class
// ---------------------------------------------------------------------------

export class ExcaliburGameController {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private exEngine: any = null;

  public soundEngine: SoundEngine;
  public kiiLedger: KiiLedgerService;
  public callbacks: GameControllerCallbacks = {};

  // Game Mode & Progression. Maps play in a shuffled order; difficulty follows the
  // stage number (how many maps deep the player is), not which map was drawn.
  public mode: GameModeType = 'MANUAL_FAUCET';
  public currentMapId: number = 1;
  public stage: number = 1;
  private mapOrder: number[] = [];
  // Arena layout is generated fresh each stage; currentMapId only picks its background
  private arenaLevel: GeneratedArenaLevel | null = null;

  // Viewport dimensions
  public readonly viewportWidth: number = 1280;
  public readonly viewportHeight: number = 645;

  // State: Score & Mechanics
  public score: number = 0;
  public readonly targetScore: number = 7;
  /** Banked free lobs (gift system). Capped at 1 before stage 49, uncapped from 49 on. */
  public freeLobs: number = 0;
  /** Active boss fight (null outside fights). */
  public boss: BossState | null = null;
  public bossProjectiles: BossProjectile[] = [];
  /** Times each boss has been faced; persisted so "first encounter = no birds" survives restarts. */
  public bossEncounters: Record<BossKind, number> = { dog: 0, son: 0 };
  /** True while the cash-out pop-up is waiting on the player; the game is frozen. */
  public cashOutOfferOpen: boolean = false;
  public levelTransitioning: boolean = false;
  public transitionCountdown: number = 0;
  public gameOver: boolean = false;

  // Aiming parameters
  public aimAngleDeg: number = 52;
  public aimPowerPct: number = 74;
  public isDraggingAim: boolean = false;
  public dragStartPos: { x: number; y: number } | null = null;
  public dragCurrentPos: { x: number; y: number } | null = null;
  public showAimGuide: boolean = true;

  // Performance stats
  public totalThrows: number = 0;
  public directHits: number = 0;
  public crushHits: number = 0;

  // Active Entities (Arena & Platformer)
  private pickaxes: ActivePickaxe[] = [];
  private particles: Particle[] = [];
  private floatingTexts: FloatingText[] = [];
  private floatingCoins: FloatingCoin[] = [];

  // Arena Tosser Entities
  private arenaBlocks: BlockDef[] = [];
  private arenaFallingObjects: FallingObjectDef[] = [];
  private arenaBirds: BirdDef[] = [];
  private birdSpawnTimer: number = 2.5;
  private arenaNodeHitTimer: number = 0;
  // Killed birds playing their shatter animation
  private birdShatters: Array<{ x: number; y: number; vx: number; vy: number; plane: 'horizontal' | 'vertical'; age: number }> = [];

  // Dwarf Arena State
  private dwarfArena = {
    x: 129,
    y: 481,
    minX: 58,
    maxX: 200,
    cheerTimer: 0,
    throwTimer: 0,
    lastThrowTime: 0,
    // Boss-fight hop (reuses the platformer jump art); offset is <= 0 while airborne
    jumpOffset: 0,
    jumpVy: 0
  };

  // Platformer State
  private dwarfPlatformer = {
    x: 120,
    y: 560,
    vx: 0,
    vy: 0,
    grounded: false,
    coyoteTimer: 0,
    jumpBufferTimer: 0,
    facing: 'right' as 'left' | 'right',
    animation: DwarfAnimation.Idle as string,
    animTime: 0,
    invulnerableTimer: 0,
    activeCheckpoint: { x: 120, y: 560 },
    currentPlatform: null as MovingPlatformDef | null,
    stepSoundTimer: 0,
    cheerTimer: 0,
    throwTimer: 0,
    lastThrowTime: 0
  };

  private platBlocks: BlockDef[] = [];
  private platFallingObjects: FallingObjectDef[] = [];
  private platBirds: BirdDef[] = [];
  private platMovingPlatforms: MovingPlatformDef[] = [];
  private platMovingPlatformDirs: number[] = [];
  private platHazards: HazardDef[] = [];
  private platIntermediateNodes: MiningNodeDef[] = [];
  private platGrandNode: MiningNodeDef = { x: 2650, y: 580, radius: 50, isGrandNode: true, value: 5 };
  private platCheckpoints: Array<{ x: number; y: number }> = [];

  // Input states for platformer
  public platInputLeft: boolean = false;
  public platInputRight: boolean = false;
  public platInputJump: boolean = false;

  // Camera (platformer worlds are taller than the viewport, so Y is pinned to show the floor)
  private cameraX: number = 0;
  private cameraY: number = 0;

  // Background Image Cache
  private bgImages: Map<number, HTMLImageElement> = new Map();

  // Animation frame request handle
  private animFrameId: number | null = null;
  private lastTimestamp: number = 0;

  constructor(options: {
    canvasId?: string;
    soundEngine: SoundEngine;
    kiiLedger: KiiLedgerService;
    callbacks?: GameControllerCallbacks;
  }) {
    this.soundEngine = options.soundEngine;
    this.kiiLedger = options.kiiLedger;
    if (options.callbacks) {
      this.callbacks = options.callbacks;
    }

    const canvasId = options.canvasId || 'gameCanvas';
    const el = document.getElementById(canvasId) as HTMLCanvasElement;
    if (!el) {
      throw new Error(`ExcaliburGameController: Canvas with id '${canvasId}' not found.`);
    }
    this.canvas = el;
    this.canvas.width = this.viewportWidth;
    this.canvas.height = this.viewportHeight;

    const ctx = this.canvas.getContext('2d');
    if (!ctx) {
      throw new Error('ExcaliburGameController: Failed to acquire 2D canvas rendering context.');
    }
    this.ctx = ctx;

    // Hook Excalibur if present globally
    if (typeof (window as any).ex !== 'undefined') {
      setExcalibur((window as any).ex);
    }

    this.preloadBackgrounds();
    loadDwarfSprites();
    loadBossSprites();
    loadNodeSprites();
    loadPickaxeSprites();
    loadBirdSprites();
    this.loadBossEncounters();
    loadFallingObjectSprites();
    loadBlockSprites();
    this.setupPointerListeners();
    this.setupKeyboardListeners();
    this.mapOrder = this.shuffleMaps();
    this.currentMapId = this.mapOrder[0];
    this.generateArenaForStage();
    this.loadMap(this.currentMapId);
    this.initExcaliburEngine();
    this.startLoop();
  }

  // =========================================================================
  // 1. Asset Preloading & Excalibur Engine Hook
  // =========================================================================

  private preloadBackgrounds(): void {
    for (let i = 1; i <= 10; i++) {
      const img = new Image();
      img.src = `../bg${i}.png`;
      this.bgImages.set(i, img);
    }
  }

  private initExcaliburEngine(): void {
    const ex = (window as any).ex;
    if (!ex) return;

    // Register Excalibur namespace with GraphicsFactory so ex.Canvas / ex.Color / ex.Vector
    // primitives are available alongside our deterministic 2D Canvas simulation loop.
    this.exEngine = {
      version: ex.EX_VERSION || '0.29.3',
      ready: true
    };
  }

  // =========================================================================
  // 2. Mode & Map Initialization
  // =========================================================================

  public setMode(newMode: GameModeType): void {
    this.mode = newMode;
    this.loadMap(this.currentMapId);
    if (this.callbacks.onModeChange) {
      this.callbacks.onModeChange(this.mode);
    }
  }

  /** Debug/test hook only (no UI): load a specific map without changing the stage. */
  public setMap(mapId: number): void {
    if (mapId < 1) mapId = 1;
    if (mapId > 10) mapId = 10;
    this.currentMapId = mapId;
    this.generateArenaForStage();
    this.loadMap(this.currentMapId);
  }

  private generateArenaForStage(): void {
    this.arenaLevel = generateArenaLevel({
      stage: this.stage,
      avoidArchetype: this.arenaLevel ? this.arenaLevel.archetypeId : undefined
    });
  }

  private getArenaLevel(): GeneratedArenaLevel {
    if (!this.arenaLevel) this.generateArenaForStage();
    return this.arenaLevel!;
  }

  /** Archetype name of the current arena layout (null in side-scroller mode). */
  public getLayoutName(): string | null {
    return this.mode === 'MANUAL_FAUCET' ? this.getArenaLevel().archetypeName : null;
  }

  // Stage rules: 1 = no birds, 2 = explodable birds, 3+ = shielded birds,
  // 5+ = pay-to-play lobs, 6+ = shielded birds reverse or change plane when struck.
  public birdsEnabled(): boolean {
    return this.stage >= 2;
  }

  public birdsShielded(): boolean {
    return this.stage >= 3;
  }

  public birdsReversible(): boolean {
    return this.stage >= 6;
  }

  public isPayToPlay(): boolean {
    return this.stage >= 5 && !this.bossLobsFree();
  }

  /** Boss fights through stage 150 cost no lob fees. */
  public bossLobsFree(): boolean {
    return !!this.boss && !this.boss.defeated && this.stage <= BOSS_FREE_LOBS_MAX_STAGE;
  }

  /** Bird spawn-rate multiplier: +1% per stage from 50 through 75 (50 = 1.01x, 75+ = 1.26x). */
  public birdSpawnRateMultiplier(): number {
    if (this.stage < 50) return 1;
    return 1 + 0.01 * (Math.min(this.stage, 75) - 49);
  }

  /** Per-bird random speed swing in percent: +/-1% per stage from 76 through 100 (76 = 1%, 100+ = 25%). */
  public birdSpeedJitterPct(): number {
    if (this.stage < 76) return 0;
    return Math.min(this.stage, 100) - 75;
  }

  /** Birds fly unless this is the player's first encounter with the current boss. */
  public birdsActive(): boolean {
    if (this.boss && !this.boss.birds) return false;
    return this.birdsEnabled();
  }

  /** Overkill badge tier reached this stage decides the boss: green (+10) dog, purple (+15) son. */
  public pendingBossKind(): BossKind | null {
    if (this.boss) return null;
    return bossForOverkill(this.score - this.targetScore);
  }

  /** Stage 100+: the first axe hit strips a bird's shield (still redirecting it); the second kills. */
  public birdShieldsBreakable(): boolean {
    return this.stage >= 100;
  }

  private applyBirdSpeedJitter<T extends BirdDef>(bird: T): T {
    const pct = this.birdSpeedJitterPct();
    if (pct === 0) return bird;
    const factor = 1 + ((Math.random() * 2 - 1) * pct) / 100;
    bird.vx = (bird.vx || 0) * factor;
    bird.vy = (bird.vy || 0) * factor;
    return bird;
  }

  public get freeNextLob(): boolean {
    return this.freeLobs > 0;
  }

  /** Max banked free lobs: 1 until stage 49, then unlimited. */
  public freeLobCap(): number {
    return this.stage >= 49 ? Infinity : 1;
  }

  /** Free lobs granted for cashing out: 7 x the current lob fee multiplier. */
  public cashOutLobCount(): number {
    return 7 * this.getLobFeeKii();
  }

  public acceptCashOut(): void {
    if (!this.cashOutOfferOpen) return;
    this.cashOutOfferOpen = false;
    const lobs = this.cashOutLobCount();
    this.kiiLedger.burnAllForCashOut(this.stage, this.mode);
    this.freeLobs += lobs;
    this.kiiLedger.recordFreeLobAwarded(this.stage, {
      mode: this.mode,
      count: lobs,
      note: `Level ${this.stage} Cash-Out: ${lobs} Free Lobs Awarded!`
    });
    const dwarf = this.mode === 'MANUAL_FAUCET' ? this.dwarfArena : this.dwarfPlatformer;
    this.soundEngine.playFreeLobSound();
    this.spawnParticleBurst(dwarf.x, dwarf.y - 36, '#34d399', 28, 220);
    this.spawnFloatingText(dwarf.x + 10, dwarf.y - 56, `🎁 +${lobs} FREE LOBS!`, '#34d399');
    this.notifyScoreUpdate();
  }

  public declineCashOut(): void {
    if (!this.cashOutOfferOpen) return;
    this.cashOutOfferOpen = false;
    this.notifyScoreUpdate();
  }

  /** Whole-KII lob fee for the current stage (0 when lobs are free). */
  public getLobFeeKii(): number {
    return Number(this.kiiLedger.calculateLobFeeForLevel(this.stage) / RAW_PER_KII);
  }

  private shuffleMaps(avoidFirst?: number): number[] {
    const ids = getAllMaps().map((m) => m.mapId);
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    // Don't repeat the map just played when a new lap of the shuffle begins
    if (avoidFirst !== undefined && ids[0] === avoidFirst && ids.length > 1) {
      [ids[0], ids[1]] = [ids[1], ids[0]];
    }
    return ids;
  }

  /** Map that the next stage will use (reshuffling after every full lap of all maps). */
  private peekNextMapId(): number {
    const idx = this.stage % this.mapOrder.length;
    if (idx === 0) {
      this.mapOrder = this.shuffleMaps(this.currentMapId);
    }
    return this.mapOrder[idx];
  }

  public advanceStage(): void {
    const nextMapId = this.peekNextMapId();
    this.stage += 1;
    this.generateArenaForStage();
    this.loadMap(nextMapId);

    // Every 50th stage: offer to cash out (burn) the KII balance for free lobs
    const balanceKii = this.kiiLedger.getTotalKiiCoins();
    if (this.stage % 50 === 0 && balanceKii > 0) {
      this.cashOutOfferOpen = true;
      if (this.callbacks.onCashOutOffer) {
        this.callbacks.onCashOutOffer(this.stage, this.cashOutLobCount(), balanceKii);
      }
    }
  }

  /** Fresh run: new shuffle, back to stage 1. */
  /** PLAYTEST ONLY: stages worth jumping to when testing late-game rules. */
  private static readonly PLAYTEST_MILESTONES = [49, 50, 75, 76, 100];

  /** PLAYTEST ONLY: jump to the next late-game milestone stage (then +10 past 100). */
  public skipToNextMilestone(): void {
    if (this.cashOutOfferOpen) return;
    const next =
      ExcaliburGameController.PLAYTEST_MILESTONES.find((s) => s > this.stage) ?? this.stage + 10;
    this.pickaxes = [];
    this.levelTransitioning = false;
    this.stage = next - 1;
    this.advanceStage(); // goes through the normal path, so stage 50 still offers the cash-out
  }

  public restartRun(): void {
    this.stage = 1;
    this.cashOutOfferOpen = false;
    this.freeLobs = Math.min(this.freeLobs, this.freeLobCap());
    this.mapOrder = this.shuffleMaps(this.currentMapId);
    this.generateArenaForStage();
    this.loadMap(this.mapOrder[0]);
  }

  public loadMap(mapId: number): void {
    const mapDef = getMapById(mapId) || getAllMaps()[0];
    this.currentMapId = mapDef.mapId;
    this.score = 0;
    this.levelTransitioning = false;
    this.transitionCountdown = 0;
    this.gameOver = false;
    this.pickaxes = [];
    this.particles = [];
    this.floatingTexts = [];
    this.floatingCoins = [];
    this.birdShatters = [];
    this.bossProjectiles = [];
    if (this.boss) {
      this.boss = null;
      if (this.callbacks.onBossFight) this.callbacks.onBossFight(null);
    }

    if (this.mode === 'MANUAL_FAUCET') {
      const level = this.getArenaLevel();
      this.arenaBlocks = level.blocks.map((b) => ({ ...b }));
      this.arenaFallingObjects = level.fallingObjects.map((f) => ({ ...f, vy: 0 }));
      this.arenaBirds = this.birdsEnabled()
        ? level.initialBirds.map((b) => this.applyBirdSpeedJitter({ ...b, shielded: this.birdsShielded() }))
        : [];
      this.birdSpawnTimer =
        (level.birdSpawnInterval.min < 100 ? level.birdSpawnInterval.min : 2.5) / this.birdSpawnRateMultiplier();

      this.dwarfArena.x = level.dwarfSpawn.x;
      this.dwarfArena.y = level.dwarfSpawn.y;
      this.dwarfArena.minX = level.dwarfSpawn.minX || 58;
      this.dwarfArena.maxX = level.dwarfSpawn.maxX || 200;
      this.dwarfArena.jumpOffset = 0;
      this.dwarfArena.jumpVy = 0;
      this.syncArenaDwarfElevation();
    } else {
      const plat = getPlatformerLevel(mapId);
      this.platBlocks = plat.blocks.map((b) => ({ ...b }));
      this.platFallingObjects = plat.fallingObjects.map((f) => ({ ...f, vy: 0 }));
      this.platBirds = this.birdsEnabled()
        ? plat.patrolBirds.map((b) => this.applyBirdSpeedJitter({ ...b, shielded: this.birdsShielded() }))
        : [];
      this.platMovingPlatforms = plat.movingPlatforms.map((p) => ({ ...p }));
      this.platMovingPlatformDirs = plat.movingPlatforms.map(() => 1);
      this.platHazards = plat.hazards.map((h) => ({ ...h }));
      this.platIntermediateNodes = plat.intermediateNodes.map((n) => ({ ...n }));
      this.platGrandNode = { ...plat.grandMiningNode };
      this.platCheckpoints = plat.checkpoints.map((c) => ({ ...c }));

      this.dwarfPlatformer.x = plat.dwarfSpawn.x;
      this.dwarfPlatformer.y = plat.dwarfSpawn.y;
      this.dwarfPlatformer.vx = 0;
      this.dwarfPlatformer.vy = 0;
      this.dwarfPlatformer.grounded = true;
      this.dwarfPlatformer.coyoteTimer = 0;
      this.dwarfPlatformer.activeCheckpoint = { x: plat.dwarfSpawn.x, y: plat.dwarfSpawn.y };
      this.dwarfPlatformer.animation = DwarfAnimation.Idle;
      this.dwarfPlatformer.currentPlatform = null;
      this.dwarfPlatformer.invulnerableTimer = 0;
      this.cameraX = 0;
      this.cameraY = Math.max(0, plat.worldHeight - this.viewportHeight);
    }

    this.notifyScoreUpdate();
    this.updateDwarfStanceLabel();

    if (this.callbacks.onMapChange) {
      this.callbacks.onMapChange(mapDef);
    }
  }

  public resetStage(): void {
    const bossKind = this.boss && !this.boss.defeated ? this.boss.def.kind : null;
    this.loadMap(this.currentMapId);
    if (bossKind) this.startBossFight(bossKind, false);
  }

  // =========================================================================
  // Boss Fights (see BossFight.ts for the rules)
  // =========================================================================

  private loadBossEncounters(): void {
    try {
      const saved = JSON.parse(localStorage.getItem('alphaMiner.bossEncounters') || '{}');
      this.bossEncounters = { dog: Number(saved.dog) || 0, son: Number(saved.son) || 0 };
    } catch {}
  }

  private saveBossEncounters(): void {
    try {
      localStorage.setItem('alphaMiner.bossEncounters', JSON.stringify(this.bossEncounters));
    } catch {}
  }

  /** Start a boss fight on the current stage. countEncounter=false for a stage reset mid-fight. */
  public startBossFight(kind: BossKind, countEncounter: boolean = true): void {
    if (this.mode !== 'MANUAL_FAUCET') this.setMode('MANUAL_FAUCET');
    if (this.boss || this.score > 0) this.loadMap(this.currentMapId);
    if (countEncounter) {
      this.bossEncounters[kind] += 1;
      this.saveBossEncounters();
    }
    const def = BOSS_DEFS[kind];
    const encounter = Math.max(1, this.bossEncounters[kind]);
    const floorY = this.getArenaLevel().floorY;
    this.boss = {
      def,
      encounter,
      birds: encounter > 1,
      x: this.viewportWidth - def.rightInset,
      y: floorY,
      vy: 0,
      grounded: true,
      hits: 0,
      deflections: 0,
      throws: 0,
      jumps: 0,
      coinsKnocked: 0,
      deflectHits: 0,
      throwTimer: 1.6,
      jumpTimer: 2.5 + Math.random() * 2.5,
      hurtTimer: 0,
      throwAnimTimer: 0,
      deflectAnimTimer: 0,
      defeated: false
    };
    // Clear the arena: no node, blocks, or falling objects in a boss fight
    this.arenaBlocks = [];
    this.arenaFallingObjects = [];
    this.arenaBirds = [];
    this.bossProjectiles = [];
    this.birdSpawnTimer = 3.0 / this.birdSpawnRateMultiplier();
    this.score = 0;
    this.soundEngine.playVictoryFanfare();
    this.spawnFloatingText(
      this.viewportWidth / 2,
      150,
      `⚔️ ${def.name} APPEARS!${this.boss.birds ? '' : ' (NO BIRDS)'}`,
      def.color
    );
    if (this.callbacks.onBossFight) this.callbacks.onBossFight(this.boss);
    this.notifyScoreUpdate();
  }

  private bossThrow(boss: BossState, grav: number): void {
    const def = boss.def;
    const kind = def.projectiles[Math.floor(Math.random() * def.projectiles.length)];
    const spec = BOSS_PROJECTILE_SPECS[kind];
    const origin = bossThrowOrigin(boss);
    const target = { x: this.dwarfArena.x, y: this.dwarfArena.y - 8 };
    const aim = solveBossLob(origin, target, grav, def);
    const vel = this.getLaunchVelocity(aim.angleDeg, aim.powerPct, false);
    this.bossProjectiles.push({
      kind,
      x: origin.x,
      y: origin.y,
      vx: vel.vx,
      vy: vel.vy,
      radius: spec.radius,
      color: spec.color,
      accent: spec.accent,
      roll: 0,
      bounces: 0
    });
    boss.throws += 1;
    boss.throwAnimTimer = BOSS_THROW_ANIM_SEC;
    this.soundEngine.playThrowSound();
    if (def.kind === 'dog' && boss.throws === 1) {
      this.spawnFloatingText(origin.x, origin.y - 30, '🐕 FETCH!', def.color);
    }
  }

  private updateBossFight(dt: number, grav: number, floorY: number): void {
    const boss = this.boss;
    if (!boss) return;
    const def = boss.def;
    boss.hurtTimer = Math.max(0, boss.hurtTimer - dt);
    boss.throwAnimTimer = Math.max(0, boss.throwAnimTimer - dt);
    boss.deflectAnimTimer = Math.max(0, boss.deflectAnimTimer - dt);

    // Jumping (random hops, plus the odd dodge below)
    if (!boss.grounded) {
      boss.vy += grav * dt;
      boss.y += boss.vy * dt;
      if (boss.y >= floorY) {
        boss.y = floorY;
        boss.vy = 0;
        boss.grounded = true;
      }
    }
    const fighting = !boss.defeated && !this.gameOver;
    if (fighting) {
      boss.jumpTimer -= dt;
      if (boss.jumpTimer <= 0 && boss.grounded) {
        this.bossJump(boss);
        boss.jumpTimer = 3 + Math.random() * 3;
      }
      for (const p of this.pickaxes) {
        const pa = p as any;
        if (pa.bossDodgeChecked || p.vx <= 0 || boss.x - p.x > 320 || p.x > boss.x) continue;
        pa.bossDodgeChecked = true;
        if (boss.grounded && Math.random() < def.dodgeChance) this.bossJump(boss);
      }
      boss.throwTimer -= dt;
      if (boss.throwTimer <= 0) {
        this.bossThrow(boss, grav);
        boss.throwTimer = def.throwInterval.min + Math.random() * (def.throwInterval.max - def.throwInterval.min);
      }
    }

    // Boss collideables: same lob physics as the player's axe
    const dwarf = this.dwarfArena;
    for (let i = this.bossProjectiles.length - 1; i >= 0; i--) {
      const o = this.bossProjectiles[i];
      o.vy += grav * dt;
      o.x += o.vx * dt;
      o.y += o.vy * dt;
      o.roll += o.vx * dt;

      if (Math.hypot(o.x - dwarf.x, o.y - (dwarf.y - 8)) < o.radius + 30) {
        const knocked = this.kiiLedger.knockOutCoin(this.stage, { x: dwarf.x, y: dwarf.y, mode: this.mode, boss: def.name });
        if (knocked) {
          boss.coinsKnocked += 1;
          this.floatingCoins.push({ x: dwarf.x, y: dwarf.y - 40, vx: -120, vy: -260, alpha: 1, spin: 0 });
        }
        this.soundEngine.playTerrainHitSound(true);
        this.spawnParticleBurst(o.x, o.y, o.accent, 16, 200);
        this.spawnFloatingText(dwarf.x + 20, dwarf.y - 60, knocked ? '💥 -1 KII KNOCKED OUT!' : '💥 BANK EMPTY!', '#fb7185');
        this.bossProjectiles.splice(i, 1);
        this.notifyScoreUpdate();
        continue;
      }

      if (o.y + o.radius >= floorY) {
        o.y = floorY - o.radius;
        o.vy = -o.vy * 0.35;
        o.vx *= 0.75;
        o.bounces += 1;
      }
      if (o.bounces > 2 || o.x < -60 || o.x > this.viewportWidth + 60) {
        this.spawnParticleBurst(o.x, o.y, '#94a3b8', 6, 80);
        this.bossProjectiles.splice(i, 1);
      }
    }
  }

  private bossJump(boss: BossState): void {
    boss.vy = -boss.def.jumpSpeed;
    boss.grounded = false;
    boss.jumps += 1;
  }

  /** A boss-deflected axe that comes back into the dwarf knocks out 1 KII. */
  private checkDeflectedAxeHitsDwarf(p: ActivePickaxe): boolean {
    const boss = this.boss;
    if (!boss || boss.defeated) return false;
    const dwarf = this.dwarfArena;
    if (Math.hypot(p.x - dwarf.x, p.y - (dwarf.y - 8)) >= p.radius + 30) return false;
    const knocked = this.kiiLedger.knockOutCoin(this.stage, { x: dwarf.x, y: dwarf.y, mode: this.mode, boss: boss.def.name });
    if (knocked) {
      boss.coinsKnocked += 1;
      boss.deflectHits += 1;
      this.floatingCoins.push({ x: dwarf.x, y: dwarf.y - 40, vx: -120, vy: -260, alpha: 1, spin: 0 });
    }
    this.soundEngine.playTerrainHitSound(true);
    this.spawnParticleBurst(p.x, p.y, '#cbd5e1', 14, 190);
    this.spawnFloatingText(dwarf.x + 20, dwarf.y - 60, knocked ? '🪓 OWN AXE! -1 KII' : '🪓 OWN AXE! BANK EMPTY', '#fb7185');
    this.notifyScoreUpdate();
    return true;
  }

  /** Player axe vs boss. Returns true when the axe was consumed. */
  private checkAxeHitsBoss(p: ActivePickaxe): boolean {
    const boss = this.boss;
    if (!boss || boss.defeated) return false;
    const pa = p as any;
    if (pa.bossCooldown > 0) return false;
    const box = bossHitbox(boss);
    const cx = Math.max(box.x, Math.min(p.x, box.x + box.w));
    const cy = Math.max(box.y, Math.min(p.y, box.y + box.h));
    if ((p.x - cx) ** 2 + (p.y - cy) ** 2 > p.radius * p.radius) return false;

    if (Math.random() < boss.def.deflectChance) {
      // Hair whip / tail whip: reflect off the boss like a bird shield (same physics)
      boss.deflections += 1;
      boss.deflectAnimTimer = BOSS_DEFLECT_ANIM_SEC;
      pa.bossCooldown = 0.4;
      pa.bossDeflected = true;
      p.awardedFreeLob = true; // a swatted axe never pays the overhead free lob
      const ccx = box.x + box.w / 2;
      const ccy = box.y + box.h / 2;
      const dist = Math.hypot(p.x - ccx, p.y - ccy) || 1;
      const nx = (p.x - ccx) / dist;
      const ny = (p.y - ccy) / dist;
      const speed = Math.max(480, Math.hypot(p.vx, p.vy) * 0.92);
      p.vx = nx * speed;
      p.vy = ny * speed - 95 + boss.vy * 0.28;
      p.x = cx + nx * (p.radius + 3);
      p.y = cy + ny * (p.radius + 3);
      p.bounces += 1;
      p.life = Math.max(p.life, 3);
      this.soundEngine.playShieldBounceSound();
      this.spawnParticleBurst(p.x, p.y, boss.def.color, 14, 180);
      const whipLabel = boss.def.kind === 'son' ? '💇 HAIR WHIP!' : '🐕 TAIL WHIP!';
      this.spawnFloatingText(box.x + box.w / 2, box.y - 34, whipLabel, boss.def.color);
      return false;
    }

    boss.hits += 1;
    boss.hurtTimer = 0.35;
    this.soundEngine.playBirdExplodeSound();
    this.spawnParticleBurst(p.x, p.y, '#fde047', 18, 220);
    this.spawnFloatingText(box.x + box.w / 2, box.y - 34, `💥 HIT ${boss.hits}/${BOSS_HITS_TO_DEFEAT}`, '#fde047');
    if (boss.hits >= BOSS_HITS_TO_DEFEAT) {
      boss.defeated = true;
      this.bossProjectiles = [];
      this.levelTransitioning = true;
      this.transitionCountdown = 3.0;
      this.isDraggingAim = false;
      this.dwarfArena.cheerTimer = 2.0;
      this.soundEngine.playVictoryFanfare();
      this.spawnParticleBurst(box.x + box.w / 2, box.y + box.h / 2, boss.def.color, 40, 320);
      this.spawnFloatingText(this.viewportWidth / 2, 160, `🏆 ${boss.def.name} DEFEATED! ADVANCING...`, '#4ade80');
    }
    return true;
  }

  // =========================================================================
  // 3. Stance, Aiming & Lob Calculations
  // =========================================================================

  public stepDwarf(deltaTier: -1 | 1): void {
    if (this.gameOver || this.levelTransitioning) return;
    if (this.mode === 'MANUAL_FAUCET') {
      const stepDist = 71;
      this.dwarfArena.x = Math.max(
        this.dwarfArena.minX,
        Math.min(this.dwarfArena.maxX, this.dwarfArena.x + deltaTier * stepDist)
      );
      this.syncArenaDwarfElevation();
      this.updateDwarfStanceLabel();
    }
  }

  /** Boss fights only: the arena dwarf can hop to dodge thrown collideables. */
  public arenaJump(): boolean {
    const d = this.dwarfArena;
    if (!this.boss || this.boss.defeated || this.gameOver || this.cashOutOfferOpen || d.jumpOffset < 0) return false;
    d.jumpVy = -ARENA_JUMP_VELOCITY;
    d.jumpOffset = -0.01;
    this.soundEngine.playJumpSound(isSpaceMap(this.currentMapId));
    return true;
  }

  private updateArenaJump(dt: number, grav: number): void {
    const d = this.dwarfArena;
    if (d.jumpOffset >= 0 && d.jumpVy >= 0) return;
    d.jumpVy += grav * dt;
    const next = d.jumpOffset + d.jumpVy * dt;
    if (next >= 0) {
      d.jumpOffset = 0;
      d.jumpVy = 0;
      this.syncArenaDwarfElevation(); // land exactly on the ledge
      return;
    }
    d.y += next - d.jumpOffset;
    d.jumpOffset = next;
  }

  private syncArenaDwarfElevation(): void {
    const level = this.getArenaLevel();
    const spawn = level.dwarfSpawn;

    let surfaceY = spawn.ledgeTop || 515;
    if (spawn.leftStepTop && spawn.centerStepTop && spawn.rightStepTop) {
      if (this.dwarfArena.x < 98) {
        surfaceY = spawn.leftStepTop;
      } else if (this.dwarfArena.x > 160) {
        surfaceY = spawn.rightStepTop;
      } else {
        surfaceY = spawn.centerStepTop;
      }
    }
    this.dwarfArena.y = surfaceY - 34 + this.dwarfArena.jumpOffset;
  }

  private updateDwarfStanceLabel(): void {
    let label = 'Center';
    if (this.mode === 'MANUAL_FAUCET') {
      if (this.dwarfArena.x < 98) {
        label = 'Left Step';
      } else if (this.dwarfArena.x > 160) {
        label = 'Right Step';
      } else {
        label = 'Center';
      }
    } else {
      label = this.dwarfPlatformer.facing === 'left' ? 'Facing Left' : 'Facing Right';
    }

    if (this.callbacks.onDwarfStanceUpdate) {
      this.callbacks.onDwarfStanceUpdate(label);
    }
  }

  public setAim(angle: number, power: number): void {
    this.aimAngleDeg = Math.max(15, Math.min(80, Math.round(angle)));
    this.aimPowerPct = Math.max(25, Math.min(100, Math.round(power)));
    if (this.callbacks.onAimUpdate) {
      this.callbacks.onAimUpdate(this.aimAngleDeg, this.aimPowerPct);
    }
  }

  public setAimPreset(preset: 'high' | 'ore'): void {
    if (preset === 'high') {
      this.setAim(58, 82);
    } else {
      this.setAim(46, 76);
    }
  }

  private getLaunchOrigin(): { x: number; y: number } {
    if (this.mode === 'MANUAL_FAUCET') {
      return {
        x: this.dwarfArena.x + 24,
        y: this.dwarfArena.y - 14
      };
    } else {
      const facingSign = this.dwarfPlatformer.facing === 'right' ? 1 : -1;
      return {
        x: this.dwarfPlatformer.x + facingSign * 24,
        y: this.dwarfPlatformer.y - 14
      };
    }
  }

  private getLaunchVelocity(angleDeg: number, powerPct: number, facingRight: boolean = true): { vx: number; vy: number } {
    const rad = (angleDeg * Math.PI) / 180;
    const speed = 440 + (powerPct / 100) * 800;
    const dir = facingRight ? 1 : -1;
    return {
      vx: Math.cos(rad) * speed * dir,
      vy: -Math.sin(rad) * speed
    };
  }

  // =========================================================================
  // 4. Lobbing & KII Pay-to-Play Economics
  // =========================================================================

  public lobPickaxe(): void {
    if (this.gameOver || this.levelTransitioning || this.cashOutOfferOpen) return;
    const nowSec = performance.now() * 0.001;
    const dwarf = this.mode === 'MANUAL_FAUCET' ? this.dwarfArena : this.dwarfPlatformer;

    if (nowSec - dwarf.lastThrowTime < 0.42) return;
    this.soundEngine.ensureAudio();

    // Check Free Lob or Level 5+ Pay-to-Play Fee (boss fights through 150 are free; gift lobs stay banked)
    if (this.bossLobsFree()) {
      // no fee
    } else if (this.freeLobs > 0) {
      this.freeLobs -= 1;
      this.kiiLedger.recordFreeLobUsed();
      this.spawnFloatingText(dwarf.x + 18, dwarf.y - 44, this.freeLobs > 0 ? `🎁 FREE LOB USED! (${this.freeLobs} left)` : '🎁 FREE LOB USED! (0 🪙)', '#34d399');
    } else if (this.isPayToPlay()) {
      if (!this.kiiLedger.canAffordLob(this.stage)) {
        if (this.pickaxes.length === 0) {
          this.triggerGameOver('Out of KII coins in Level 5+ Pay-to-Play!');
        } else {
          this.spawnFloatingText(dwarf.x + 20, dwarf.y - 45, '⚠️ 0 KII LEFT! WAIT FOR AXE!', '#fb7185');
        }
        return;
      }
      const success = this.kiiLedger.spendLobFee(this.stage, {
        angle: this.aimAngleDeg,
        power: this.aimPowerPct,
        x: dwarf.x,
        y: dwarf.y,
        mode: this.mode
      });
      if (!success) {
        this.triggerGameOver('Insufficient KII balance.');
        return;
      }
      this.spawnFloatingText(dwarf.x + 18, dwarf.y - 42, `-${this.getLobFeeKii()} KII LOB FEE`, '#fda4af');
    }

    const facingRight = this.mode === 'MANUAL_FAUCET' ? true : this.dwarfPlatformer.facing === 'right';
    const origin = this.getLaunchOrigin();
    const vel = this.getLaunchVelocity(this.aimAngleDeg, this.aimPowerPct, facingRight);

    this.pickaxes.push({
      x: origin.x,
      y: origin.y,
      vx: vel.vx,
      vy: vel.vy,
      angle: -0.4,
      spinSpeed: 11.5 * (facingRight ? 1 : -1),
      radius: 15,
      bounces: 0,
      maxBounces: 2,
      hitShieldedBird: false,
      awardedFreeLob: false,
      hitNodeCooldown: 0,
      life: 6.0,
      trail: []
    });

    this.totalThrows += 1;
    dwarf.lastThrowTime = nowSec;
    dwarf.throwTimer = DWARF_THROW_DURATION;
    this.soundEngine.playThrowSound();
    this.notifyScoreUpdate();
  }

  // =========================================================================
  // 5. Score Hits, Doubles & Victory Transitions
  // =========================================================================

  private awardScoreHit(sourceX: number, sourceY: number, isIndirect: boolean, customValue?: number): void {
    if (this.gameOver) return;

    const points = customValue !== undefined ? customValue : (isIndirect ? 2 : 1);
    this.score += points;

    if (isIndirect) {
      this.crushHits += 1;
    } else {
      this.directHits += 1;
    }

    this.kiiLedger.recordHit(isIndirect, this.currentMapId, {
      x: sourceX,
      y: sourceY,
      mode: this.mode
    });

    if (this.mode === 'MANUAL_FAUCET') {
      this.dwarfArena.cheerTimer = 0.9;
    } else {
      this.dwarfPlatformer.cheerTimer = 0.9;
    }

    this.soundEngine.playCoinDing(isIndirect);

    // Floating Coins
    for (let c = 0; c < points; c++) {
      this.floatingCoins.push({
        x: sourceX + (c === 0 ? -10 : 12),
        y: sourceY - 25 - c * 14,
        vx: (Math.random() - 0.5) * 110 + (c === 0 ? -25 : 25),
        vy: -255 - c * 40,
        alpha: 1,
        spin: c * 1.4
      });
    }

    const badgeText = isIndirect
      ? '🪙🪙 +2 DOUBLE! (CRUSH/RICOCHET)'
      : (points > 1 ? `💎 +${points} KII GRAND NODE!` : '🪙 +1 COIN! (DIRECT)');

    this.spawnFloatingText(sourceX, sourceY - 48, badgeText, isIndirect ? '#38bdf8' : '#fde047');
    this.spawnParticleBurst(sourceX, sourceY, '#fbbf24', isIndirect ? 24 : 16, 220);

    this.notifyScoreUpdate();

    // Check Victory Threshold (7+ KII)
    if (this.score >= this.targetScore && !this.levelTransitioning) {
      this.levelTransitioning = true;
      this.transitionCountdown = 5.0;
      this.isDraggingAim = false;
      this.soundEngine.playVictoryFanfare();
      const isTosser = this.mode === 'MANUAL_FAUCET';
      const centerX = isTosser ? this.viewportWidth / 2 : this.cameraX + this.viewportWidth / 2;
      const centerY = isTosser ? 160 : this.cameraY + 160;
      this.spawnFloatingText(centerX, centerY,`🎉 STAGE ${this.stage} CLEARED! ADVANCING...`, '#4ade80');
    }
  }

  private triggerGameOver(reason: string): void {
    if (this.gameOver || this.levelTransitioning) return;
    this.gameOver = true;
    this.soundEngine.playGameOverSound();
    if (this.callbacks.onGameOver) {
      this.callbacks.onGameOver(reason, {
        totalThrows: this.totalThrows,
        directHits: this.directHits,
        crushHits: this.crushHits
      });
    }
  }

  private notifyScoreUpdate(): void {
    if (this.callbacks.onScoreUpdate) {
      this.callbacks.onScoreUpdate(
        this.score,
        this.targetScore,
        this.kiiLedger.getTotalKiiCoins(),
        this.freeNextLob
      );
    }
  }

  // =========================================================================
  // 6. Platformer Controls & Physics Updates
  // =========================================================================

  public platformerRun(direction: -1 | 0 | 1): void {
    if (direction < 0) {
      this.platInputLeft = true;
      this.platInputRight = false;
    } else if (direction > 0) {
      this.platInputRight = true;
      this.platInputLeft = false;
    } else {
      this.platInputLeft = false;
      this.platInputRight = false;
    }
  }

  public platformerJump(start: boolean): void {
    if (start) {
      this.platInputJump = true;
      this.dwarfPlatformer.jumpBufferTimer = 0.12;
    } else {
      this.platInputJump = false;
      // Variable jump height cut
      if (this.dwarfPlatformer.vy < -150) {
        this.dwarfPlatformer.vy = -150;
      }
    }
  }

  private updatePlatformerPhysics(dt: number): void {
    const dwarf = this.dwarfPlatformer;
    const level = getPlatformerLevel(this.currentMapId);
    const isSpace = isSpaceMap(this.currentMapId);
    const grav = level.gravity; // 980 for Cavern, 490 for Space Moon-Jumps!
    const jumpVel = level.jumpVelocity; // per map, sized to clear that map's tallest wall
    const runSpeed = level.runSpeed;

    // Timers
    if (dwarf.invulnerableTimer > 0) dwarf.invulnerableTimer = Math.max(0, dwarf.invulnerableTimer - dt);
    if (dwarf.jumpBufferTimer > 0) dwarf.jumpBufferTimer = Math.max(0, dwarf.jumpBufferTimer - dt);
    if (dwarf.coyoteTimer > 0) dwarf.coyoteTimer = Math.max(0, dwarf.coyoteTimer - dt);

    // 1. Horizontal Movement
    let targetVx = 0;
    if (this.platInputLeft) {
      targetVx = -runSpeed;
      dwarf.facing = 'left';
    } else if (this.platInputRight) {
      targetVx = runSpeed;
      dwarf.facing = 'right';
    }
    // Frame-rate independent easing (tuned at 60 fps)
    const accel = dwarf.grounded ? 0.35 : 0.18;
    dwarf.vx += (targetVx - dwarf.vx) * (1 - Math.pow(1 - accel, dt * 60));

    // 2. Jump Handling (Coyote time & Jump buffer)
    const canJump = dwarf.grounded || dwarf.coyoteTimer > 0;
    if (this.platInputJump && dwarf.jumpBufferTimer > 0 && canJump) {
      dwarf.vy = jumpVel;
      dwarf.grounded = false;
      dwarf.coyoteTimer = 0;
      dwarf.jumpBufferTimer = 0;
      dwarf.animation = DwarfAnimation.Jump;
      this.soundEngine.playJumpSound(isSpace);
      this.kiiLedger.recordJump(this.currentMapId, {
        x: dwarf.x,
        y: dwarf.y,
        isSpaceHalfGrav: isSpace,
        mode: 'SIDE_SCROLLER'
      });
    }

    // 3. Gravity
    dwarf.vy += grav * dt;

    // 4. Move platforms first, then carry the dwarf by exactly the distance its platform moved
    const platformDeltas: number[] = [];
    for (let pIdx = 0; pIdx < this.platMovingPlatforms.length; pIdx++) {
      const p = this.platMovingPlatforms[pIdx];
      const oldX = p.x;
      const dir = this.platMovingPlatformDirs[pIdx] || 1;
      p.x += dir * p.speed * dt;
      if (p.x >= p.endX) {
        p.x = p.endX;
        this.platMovingPlatformDirs[pIdx] = -1;
      } else if (p.x <= p.startX) {
        p.x = p.startX;
        this.platMovingPlatformDirs[pIdx] = 1;
      }
      platformDeltas.push(p.x - oldX);
    }
    if (dwarf.currentPlatform) {
      const idx = this.platMovingPlatforms.indexOf(dwarf.currentPlatform);
      if (idx !== -1) dwarf.x += platformDeltas[idx];
    }
    dwarf.currentPlatform = null;

    // Dwarf collision box: 36 wide, feet at y+34, head at y-20
    const halfW = 18;
    const feetOff = 34;
    const headOff = 20;
    let landedThisFrame = false;

    // 5a. Horizontal move, resolved against block sides (walls are solid until mined out)
    let nextX = dwarf.x + dwarf.vx * dt;
    nextX = Math.max(30, Math.min(level.worldWidth - 30, nextX));
    for (const blk of this.platBlocks) {
      if ((blk as any).dissipating) continue;
      const overlapY = dwarf.y + feetOff > blk.y + 1 && dwarf.y - headOff < blk.y + blk.h;
      const overlapX = nextX + halfW > blk.x && nextX - halfW < blk.x + blk.w;
      if (overlapY && overlapX) {
        nextX = dwarf.x <= blk.x + blk.w / 2 ? blk.x - halfW : blk.x + blk.w + halfW;
        dwarf.vx = 0;
      }
    }

    // 5b. Vertical move, resolved against block tops (landing) and bottoms (head bonk)
    let nextY = dwarf.y + dwarf.vy * dt;
    for (const blk of this.platBlocks) {
      if ((blk as any).dissipating) continue;
      const overlapX = nextX + halfW > blk.x && nextX - halfW < blk.x + blk.w;
      if (!overlapX) continue;
      if (dwarf.vy >= 0 && dwarf.y + feetOff <= blk.y + 4 && nextY + feetOff >= blk.y) {
        nextY = blk.y - feetOff;
        dwarf.vy = 0;
        landedThisFrame = true;
      } else if (dwarf.vy < 0 && dwarf.y - headOff >= blk.y + blk.h - 4 && nextY - headOff <= blk.y + blk.h) {
        nextY = blk.y + blk.h + headOff;
        dwarf.vy = 0;
      }
    }

    // 6. Moving Platforms (one-way: land from above only)
    for (const p of this.platMovingPlatforms) {
      const overlapX = nextX + halfW > p.x && nextX - halfW < p.x + p.w;
      if (overlapX && dwarf.vy >= 0 && dwarf.y + feetOff <= p.y + 4 && nextY + feetOff >= p.y) {
        nextY = p.y - feetOff;
        dwarf.vy = 0;
        landedThisFrame = true;
        dwarf.currentPlatform = p;
      }
    }

    // 7. Ground Floor Collision
    if (nextY + feetOff >= level.floorY) {
      nextY = level.floorY - feetOff;
      dwarf.vy = 0;
      landedThisFrame = true;
    }

    if (landedThisFrame) {
      if (!dwarf.grounded) {
        this.soundEngine.playLandSound();
      }
      dwarf.grounded = true;
      dwarf.coyoteTimer = 0.12;
    } else {
      dwarf.grounded = false;
    }

    dwarf.x = nextX;
    dwarf.y = nextY;

    // Footstep audio when running on ground
    if (dwarf.grounded && Math.abs(dwarf.vx) > 30) {
      dwarf.stepSoundTimer += dt;
      if (dwarf.stepSoundTimer >= 0.28) {
        dwarf.stepSoundTimer = 0;
        this.soundEngine.playStepSound();
      }
    }

    // Animation state
    dwarf.animTime += dt;
    if (dwarf.throwTimer > 0) dwarf.throwTimer = Math.max(0, dwarf.throwTimer - dt);
    if (dwarf.cheerTimer > 0) dwarf.cheerTimer = Math.max(0, dwarf.cheerTimer - dt);
    if (dwarf.throwTimer > 0) {
      dwarf.animation = DwarfAnimation.Throw;
    } else if (!dwarf.grounded) {
      dwarf.animation = DwarfAnimation.Jump;
    } else if (Math.abs(dwarf.vx) > 40) {
      dwarf.animation = DwarfAnimation.Run;
    } else if (dwarf.cheerTimer > 0) {
      dwarf.animation = DwarfAnimation.Cheer;
    } else {
      dwarf.animation = DwarfAnimation.Idle;
    }

    // 8. Hazard Collisions
    for (const haz of this.platHazards) {
      if (
        dwarf.x + 18 > haz.x &&
        dwarf.x - 18 < haz.x + haz.w &&
        dwarf.y + 30 > haz.y &&
        dwarf.y - 20 < haz.y + haz.h
      ) {
        if (dwarf.invulnerableTimer <= 0) {
          this.respawnAtCheckpoint();
          break;
        }
      }
    }

    // 9. Checkpoint Activation
    for (const cp of this.platCheckpoints) {
      if (Math.abs(dwarf.x - cp.x) < 45 && Math.abs(dwarf.y - cp.y) < 70) {
        if (dwarf.activeCheckpoint.x !== cp.x) {
          dwarf.activeCheckpoint = { ...cp };
          this.soundEngine.playFreeLobSound();
          this.spawnFloatingText(cp.x, cp.y - 40, '🚩 CHECKPOINT ACTIVATED!', '#38bdf8');
        }
      }
    }

    // 10. Intermediate Mining Nodes Collision
    for (let i = this.platIntermediateNodes.length - 1; i >= 0; i--) {
      const node = this.platIntermediateNodes[i];
      const dist = Math.hypot(dwarf.x - node.x, dwarf.y - node.y);
      if (dist < 42 + (node.radius || 32)) {
        this.awardScoreHit(node.x, node.y, false, node.value || 2);
        this.platIntermediateNodes.splice(i, 1);
      }
    }

    // 11. Grand Mining Node Collision
    const gDist = Math.hypot(dwarf.x - this.platGrandNode.x, dwarf.y - this.platGrandNode.y);
    if (gDist < 45 + this.platGrandNode.radius) {
      this.awardScoreHit(this.platGrandNode.x, this.platGrandNode.y, false, this.platGrandNode.value || 5);
      this.platGrandNode.x = 99999; // Cleared
    }

    // 12. Camera Follow (frame-rate independent)
    const targetCamX = dwarf.x - this.viewportWidth * 0.4;
    const maxCamX = Math.max(0, level.worldWidth - this.viewportWidth);
    const camEase = 1 - Math.pow(1 - 0.14, dt * 60);
    this.cameraX += (Math.max(0, Math.min(maxCamX, targetCamX)) - this.cameraX) * camEase;
  }

  private respawnAtCheckpoint(): void {
    const dwarf = this.dwarfPlatformer;
    dwarf.x = dwarf.activeCheckpoint.x;
    dwarf.y = dwarf.activeCheckpoint.y;
    dwarf.vx = 0;
    dwarf.vy = 0;
    dwarf.invulnerableTimer = 1.6;
    this.soundEngine.playTerrainHitSound(true);
    this.spawnParticleBurst(dwarf.x, dwarf.y, '#f43f5e', 18, 160);
    this.spawnFloatingText(dwarf.x, dwarf.y - 45, '⚠️ RESPAWNED AT CHECKPOINT!', '#f87171');
  }

  // =========================================================================
  // 7. General Physics & Projectiles Simulation
  // =========================================================================

  private updateGeneralPhysics(dt: number): void {
    const isTosser = this.mode === 'MANUAL_FAUCET';
    const dwarf = isTosser ? this.dwarfArena : this.dwarfPlatformer;
    const grav = (this.mode === 'SIDE_SCROLLER' && isSpaceMap(this.currentMapId)) ? 490 : 980;
    const floorY = isTosser ? this.getArenaLevel().floorY : getPlatformerLevel(this.currentMapId).floorY;
    const blocks = isTosser ? this.arenaBlocks : this.platBlocks;
    const fallingObjs = isTosser ? this.arenaFallingObjects : this.platFallingObjects;
    const birds = isTosser ? this.arenaBirds : this.platBirds;

    if (isTosser) this.updateArenaJump(dt, grav);
    if (isTosser && this.boss) this.updateBossFight(dt, grav, floorY);

    // 1. Spawner & Active Birds
    if (isTosser && this.birdsActive() && !this.gameOver) {
      this.birdSpawnTimer -= dt;
      if (this.birdSpawnTimer <= 0) {
        this.spawnTosserPatrolBird();
        this.birdSpawnTimer = (2.2 + Math.random() * 1.8) / this.birdSpawnRateMultiplier();
      }
    }

    const shatterDuration = birdShatterDuration();
    for (let s = this.birdShatters.length - 1; s >= 0; s--) {
      this.birdShatters[s].age += dt;
      if (this.birdShatters[s].age >= shatterDuration) this.birdShatters.splice(s, 1);
    }

    for (let b = birds.length - 1; b >= 0; b--) {
      const bird = birds[b];
      (bird as any).age = ((bird as any).age || 0) + dt;
      (bird as any).flapPhase = ((bird as any).flapPhase || 0) + dt * 15;
      if ((bird as any).shieldPulse > 0) {
        (bird as any).shieldPulse = Math.max(0, (bird as any).shieldPulse - dt * 4);
      }

      // Wave flight along the bird's plane, as in the original
      const bAny = bird as any;
      if (bAny.baseX === undefined) {
        bAny.baseX = bird.x;
        bAny.baseY = bird.y;
        bAny.homeX = bird.x;
      }
      const wave = Math.sin(bAny.age * (bird.waveFreq || 2.5)) * (bird.waveAmp || 0);
      const ceilingY = (isTosser ? 0 : this.cameraY) + 36;
      if (bird.plane === 'vertical') {
        bird.y += (bird.vy || 0) * dt;
        bird.x = bAny.baseX + wave;
        // Traverse between ceiling and floor; arena birds leave through the top after 3 passes
        if (bird.vy > 0 && bird.y + bird.radius >= floorY - 6) {
          bird.y = floorY - 6 - bird.radius;
          bird.vy = -Math.abs(bird.vy);
          bAny.verticalBounces = (bAny.verticalBounces || 0) + 1;
        } else if (bird.vy < 0 && bird.y - bird.radius <= ceilingY) {
          if (!isTosser || (bAny.verticalBounces || 0) < 3) {
            bird.y = ceilingY + bird.radius;
            bird.vy = Math.abs(bird.vy);
            bAny.verticalBounces = (bAny.verticalBounces || 0) + 1;
          }
        }
      } else {
        bird.x += bird.vx * dt;
        bird.y = bAny.baseY + wave;
        // Platformer birds patrol around their home instead of flying off forever
        if (!isTosser) {
          const offX = bird.x - bAny.homeX;
          if ((offX > 360 && bird.vx > 0) || (offX < -360 && bird.vx < 0)) bird.vx = -bird.vx;
        }
      }

      if (isTosser && (bird.x < -80 || bird.x > this.viewportWidth + 80 || bird.y < -80 || bird.y > this.viewportHeight + 80)) {
        birds.splice(b, 1);
      }
    }

    if (isTosser && this.dwarfArena.cheerTimer > 0) {
      this.dwarfArena.cheerTimer = Math.max(0, this.dwarfArena.cheerTimer - dt);
    }
    if (isTosser && this.dwarfArena.throwTimer > 0) {
      this.dwarfArena.throwTimer = Math.max(0, this.dwarfArena.throwTimer - dt);
    }
    if (isTosser && this.arenaNodeHitTimer > 0) {
      this.arenaNodeHitTimer = Math.max(0, this.arenaNodeHitTimer - dt);
    }

    // 2. Pickaxe Projectiles
    for (let i = this.pickaxes.length - 1; i >= 0; i--) {
      const p = this.pickaxes[i];
      if (!p.hitShieldedBird) {
        p.life -= dt;
      }
      if (p.hitNodeCooldown > 0) p.hitNodeCooldown -= dt;
      if (p.birdBounceCooldown && p.birdBounceCooldown > 0) p.birdBounceCooldown -= dt;

      p.trail.push({ x: p.x, y: p.y });
      if (p.trail.length > 12) p.trail.shift();

      const prevX = p.x;
      p.vy += grav * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.angle += p.spinSpeed * dt;

      // Overhead Rebound Free Lob trigger
      if (p.bounces > 0 && !p.awardedFreeLob && p.y <= dwarf.y + 42) {
        const crossedDwarf = (prevX >= dwarf.x - 40 && p.x <= dwarf.x + 40) || Math.abs(p.x - dwarf.x) <= 40;
        if (crossedDwarf) {
          p.awardedFreeLob = true;
          this.freeLobs = Math.min(this.freeLobs + 1, this.freeLobCap());
          if (isTosser) this.dwarfArena.cheerTimer = 0.9;
          this.soundEngine.playFreeLobSound();
          this.kiiLedger.recordFreeLobAwarded(this.currentMapId, { x: dwarf.x, y: dwarf.y, mode: this.mode });
          this.spawnParticleBurst(dwarf.x, dwarf.y - 36, '#34d399', 16, 170);
          this.spawnFloatingText(dwarf.x + 10, dwarf.y - 56, '🎁 FREE NEXT LOB!', '#34d399');
          this.notifyScoreUpdate();
        }
      }

      // Boss Collision
      if ((p as any).bossCooldown > 0) (p as any).bossCooldown -= dt;
      if (isTosser && this.boss && !(p as any).bossDeflected && this.checkAxeHitsBoss(p)) {
        this.pickaxes.splice(i, 1);
        continue;
      }
      if (isTosser && this.boss && (p as any).bossDeflected && this.checkDeflectedAxeHitsDwarf(p)) {
        this.pickaxes.splice(i, 1);
        continue;
      }

      // Bird Collisions
      let axeDestroyed = false;
      for (let b = birds.length - 1; b >= 0; b--) {
        const bird = birds[b];
        const distBird = Math.hypot(p.x - bird.x, p.y - bird.y);
        if (distBird < p.radius + bird.radius) {
          if (bird.shielded) {
            if ((p.birdBounceCooldown || 0) <= 0) {
              this.soundEngine.playShieldBounceSound();
              (bird as any).shieldPulse = 1.0;
              p.birdBounceCooldown = 0.16;
              p.hitShieldedBird = true;
              p.life = Infinity;
              p.maxBounces = Infinity;

              const nx = (p.x - bird.x) / (distBird || 1);
              const ny = (p.y - bird.y) / (distBird || 1);
              const incomingVx = p.vx;
              const incomingVy = p.vy;
              const speed = Math.max(480, Math.hypot(p.vx, p.vy) * 0.92);
              p.vx = nx * speed + (bird.vx || 0) * 0.28;
              p.vy = ny * speed - 95 + (bird.vy || 0) * 0.28;
              p.x = bird.x + nx * (p.radius + bird.radius + 3);
              p.y = bird.y + ny * (p.radius + bird.radius + 3);
              p.bounces += 1;

              const bounceLabel = this.reactBirdToShieldHit(bird, nx, ny, incomingVx, incomingVy, floorY);
              this.spawnParticleBurst(p.x, p.y, '#38bdf8', 12, 175);
              if (this.birdShieldsBreakable()) {
                // Shield shatters but the redirect above still applies; next hit kills
                bird.shielded = false;
                this.spawnParticleBurst(bird.x, bird.y, '#7dd3fc', 18, 200);
                this.spawnFloatingText(bird.x, bird.y - 24, bounceLabel.replace('🛡️', '💔 SHIELD BROKEN!'), '#7dd3fc');
              } else {
                this.spawnFloatingText(bird.x, bird.y - 24, bounceLabel, '#38bdf8');
              }
            }
            break;
          } else {
            // Same axe that just broke the shield can't instantly kill on overlap
            if ((p.birdBounceCooldown || 0) > 0) break;
            this.soundEngine.playBirdExplodeSound();
            if (birdShatterDuration() > 0) {
              this.birdShatters.push({ x: bird.x, y: bird.y, vx: bird.vx, vy: bird.vy, plane: bird.plane, age: 0 });
            } else {
              this.spawnParticleBurst(bird.x, bird.y, '#f43f5e', 20, 220);
            }
            this.spawnParticleBurst(p.x, p.y, '#cbd5e1', 12, 160);
            this.spawnFloatingText(bird.x, bird.y - 20, '💥 BIRD SHATTERED!', '#fb7185');
            birds.splice(b, 1);
            this.pickaxes.splice(i, 1);
            axeDestroyed = true;
            break;
          }
        }
      }
      if (axeDestroyed) continue;

      // Destructible Blocks Collision
      for (let j = 0; j < blocks.length; j++) {
        const blk = blocks[j];
        if ((blk as any).dissipating) continue;

        const closestX = Math.max(blk.x, Math.min(p.x, blk.x + blk.w));
        const closestY = Math.max(blk.y, Math.min(p.y, blk.y + blk.h));
        const dx = p.x - closestX;
        const dy = p.y - closestY;
        if (dx * dx + dy * dy <= p.radius * p.radius) {
          blk.hp -= 1;
          (blk as any).shake = 0.18;
          if (blk.hp <= 0) {
            (blk as any).dissipating = true;
            this.soundEngine.playTerrainHitSound(true);
            this.spawnParticleBurst(blk.x + blk.w / 2, blk.y + blk.h / 2, '#854d0e', 16, 200);
          } else {
            this.soundEngine.playTerrainHitSound(false);
          }

          if (Math.abs(dx) > Math.abs(dy)) {
            p.vx = -p.vx * 0.55;
          } else {
            p.vy = -p.vy * 0.58;
          }
          p.bounces += 1;
          break;
        }
      }

      // Falling Objects Collision
      for (let k = 0; k < fallingObjs.length; k++) {
        const obj = fallingObjs[k];
        const distObj = Math.hypot(p.x - obj.x, p.y - obj.y);
        if (distObj < p.radius + obj.radius) {
          obj.vx += p.vx * 0.32;
          obj.vy += Math.min(-80, p.vy * 0.28);
          this.soundEngine.playTerrainHitSound(false);
          this.spawnParticleBurst(p.x, p.y, obj.accent || '#38bdf8', 10, 140);
          p.vx = -p.vx * 0.5;
          p.vy = -180;
          p.bounces += 1;
          break;
        }
      }

      // Mining Node Collision (Tosser Mode; no node during boss fights)
      if (isTosser && !this.boss) {
        const node = this.getArenaLevel().miningNode;
        const distNode = Math.hypot(p.x - node.x, p.y - node.y);
        if (distNode < p.radius + node.radius - 4 && p.hitNodeCooldown <= 0) {
          const isIndirect = p.bounces > 0;
          this.awardScoreHit(p.x, p.y, isIndirect);
          this.arenaNodeHitTimer = NODE_HIT_FLASH_DURATION;
          p.hitNodeCooldown = 0.35;
          p.vx = -p.vx * 0.45;
          p.vy = -240;
          p.bounces += 2;
        }
      }

      // Floor Collision
      if (p.y + p.radius >= floorY) {
        p.y = floorY - p.radius;
        p.vy = -p.vy * (p.hitShieldedBird ? 0.66 : 0.38);
        p.vx *= (p.hitShieldedBird ? 0.84 : 0.68);
        p.bounces += 1;
        this.spawnParticleBurst(p.x, floorY, '#64748b', 6, 90);
      }

      const settled = p.hitShieldedBird && p.y + p.radius >= floorY - 2 && Math.hypot(p.vx, p.vy) < 24;
      const worldW = isTosser ? this.viewportWidth : getPlatformerLevel(this.currentMapId).worldWidth;
      if (
        (!p.hitShieldedBird && (p.bounces > p.maxBounces || p.life <= 0)) ||
        settled ||
        p.x > worldW + 80 ||
        p.x < -80
      ) {
        this.spawnParticleBurst(p.x, p.y, '#cbd5e1', 6, 80);
        this.pickaxes.splice(i, 1);
      }
    }

    // 3. Falling Physics Objects (+2 KII Crush hits!)
    for (let i = fallingObjs.length - 1; i >= 0; i--) {
      const obj = fallingObjs[i];
      obj.vy += grav * dt;
      const startX = obj.x;
      const startY = obj.y;
      let nextX = obj.x + obj.vx * dt;
      let nextY = obj.y + obj.vy * dt;
      let supported = false;

      for (const blk of blocks) {
        if ((blk as any).dissipating) continue;
        const closestX = Math.max(blk.x, Math.min(nextX, blk.x + blk.w));
        const closestY = Math.max(blk.y, Math.min(nextY, blk.y + blk.h));
        const dx = nextX - closestX;
        const dy = nextY - closestY;
        if (dx * dx + dy * dy <= obj.radius * obj.radius) {
          if (obj.y <= blk.y && obj.vy >= 0) {
            nextY = blk.y - obj.radius;
            if (obj.vy > 320) {
              blk.hp -= 1;
              if (blk.hp <= 0) (blk as any).dissipating = true;
              obj.vy = obj.vy * 0.35;
            } else {
              obj.vy = 0;
              supported = true;
            }
          } else {
            obj.vx = -obj.vx * 0.45;
          }
        }
      }

      if (supported) {
        obj.y = nextY;
      } else {
        obj.x = nextX;
        obj.y = nextY;
      }
      // Resting objects keep a stale vx, so sprite motion follows actual displacement
      obj.roll = (obj.roll || 0) + (obj.x - startX);
      obj.moving = Math.hypot(obj.x - startX, obj.y - startY) > 20 * dt;

      // Check rolling/crushing into Mining Node for +2 KII DOUBLE!
      if (isTosser) {
        const node = this.getArenaLevel().miningNode;
        const dNode = Math.hypot(obj.x - node.x, obj.y - node.y);
        if (dNode < obj.radius + node.radius && obj.nodeHitsRemaining > 0) {
          obj.nodeHitsRemaining -= 1;
          this.awardScoreHit(obj.x, obj.y, true);
          this.arenaNodeHitTimer = NODE_HIT_FLASH_DURATION;
          obj.vx = -obj.vx * 0.45;
          obj.vy = -180;
        }
      }

      if (obj.y + obj.radius >= floorY) {
        obj.y = floorY - obj.radius;
        obj.vy = -obj.vy * 0.28;
        obj.vx *= 0.88;
      }
    }

    // 4. Dissipating blocks
    for (let b = blocks.length - 1; b >= 0; b--) {
      const blk = blocks[b];
      if ((blk as any).shake > 0) (blk as any).shake = Math.max(0, (blk as any).shake - dt);
      if ((blk as any).dissipating) {
        (blk as any).alpha = ((blk as any).alpha ?? 1.0) - dt * 4.5;
        blk.y += dt * 18;
        if ((blk as any).alpha <= 0) {
          blocks.splice(b, 1);
        }
      }
    }

    // 5. Particles & Floating Texts
    for (let p = this.particles.length - 1; p >= 0; p--) {
      const pt = this.particles[p];
      pt.life -= dt;
      pt.x += pt.vx * dt;
      pt.y += pt.vy * dt;
      pt.alpha = pt.life / pt.maxLife;
      if (pt.life <= 0) this.particles.splice(p, 1);
    }

    for (let t = this.floatingTexts.length - 1; t >= 0; t--) {
      const ft = this.floatingTexts[t];
      ft.y += ft.vy * dt;
      ft.alpha -= dt * 0.65;
      if (ft.alpha <= 0) this.floatingTexts.splice(t, 1);
    }

    for (let c = this.floatingCoins.length - 1; c >= 0; c--) {
      const fc = this.floatingCoins[c];
      fc.vy += 800 * dt;
      fc.x += fc.vx * dt;
      fc.y += fc.vy * dt;
      fc.alpha -= dt * 0.75;
      fc.spin += dt * 8;
      if (fc.alpha <= 0) this.floatingCoins.splice(c, 1);
    }

    // 6. Victory Countdown
    if (this.levelTransitioning) {
      this.transitionCountdown -= dt;
      const secLeft = Math.max(1, Math.ceil(this.transitionCountdown));
      if (this.callbacks.onVictoryCountdown) {
        this.callbacks.onVictoryCountdown(secLeft, this.stage + 1);
      }
      if (this.transitionCountdown <= 0) {
        this.levelTransitioning = false;
        const bossKind = this.pendingBossKind();
        if (bossKind && this.mode === 'MANUAL_FAUCET') {
          this.startBossFight(bossKind);
        } else {
          this.advanceStage();
        }
      }
    }
  }

  /**
   * Stage 6+: a pickaxe striking a shielded bird is 50/50 to either reverse the bird along
   * its current plane, or flip its plane (horizontal <-> vertical) in the direction the hit pushed it.
   * Returns the floating label to show.
   */
  private reactBirdToShieldHit(
    bird: BirdDef,
    nx: number,
    ny: number,
    incomingVx: number,
    incomingVy: number,
    floorY: number
  ): string {
    if (!this.birdsReversible()) return '🛡️ SHIELD BOUNCE!';
    const bAny = bird as any;
    const birdSpeed = Math.max(125, Math.hypot(bird.vx || 0, bird.vy || 0));

    if (Math.random() < 0.5) {
      if (bird.plane === 'vertical') {
        bird.vy = -bird.vy;
        return bird.vy < 0 ? '🛡️ REVERSE UP! ⬆️' : '🛡️ REVERSE DOWN! ⬇️';
      }
      bird.vx = -bird.vx;
      return bird.vx > 0 ? '🛡️ REVERSE RIGHT! ➡️' : '🛡️ REVERSE LEFT! ⬅️';
    }

    bAny.age = 0;
    if (bird.plane !== 'vertical') {
      const goDown = -ny * 260 + incomingVy * 0.65 >= 0;
      bird.plane = 'vertical';
      bird.vy = goDown ? birdSpeed : -birdSpeed;
      bird.vx = 0;
      bAny.baseX = bird.x;
      bAny.verticalBounces = 0;
      return goDown ? '🛡️ VERTICAL DIVE! ⬇️' : '🛡️ VERTICAL CLIMB! ⬆️';
    }
    const goRight = -nx * 260 + incomingVx * 0.65 >= 0;
    const topY = (this.mode === 'MANUAL_FAUCET' ? 0 : this.cameraY) + 70;
    bird.plane = 'horizontal';
    bird.vx = goRight ? birdSpeed : -birdSpeed;
    bird.vy = 0;
    bAny.baseY = Math.max(topY, Math.min(floorY - 90, bird.y));
    bAny.homeX = bird.x;
    return goRight ? '🛡️ HORIZONTAL RIGHT! ➡️' : '🛡️ HORIZONTAL LEFT! ⬅️';
  }

  private spawnTosserPatrolBird(): void {
    const yPoss = [120, 190, 260, 310];
    const chosenY = yPoss[Math.floor(Math.random() * yPoss.length)];
    this.arenaBirds.push(this.applyBirdSpeedJitter({
      id: `bird_${Date.now()}`,
      x: this.viewportWidth + 40,
      y: chosenY,
      vx: -130 - Math.random() * 35,
      vy: 0,
      plane: 'horizontal',
      radius: BIRD_RADIUS,
      waveAmp: 14 + Math.random() * 6,
      waveFreq: 2.2 + Math.random() * 0.8,
      shielded: this.birdsShielded()
    }));
    this.soundEngine.playBirdSpawnChirp();
  }

  private spawnParticleBurst(x: number, y: number, color: string, count: number, speed: number): void {
    for (let i = 0; i < count; i++) {
      const ang = Math.random() * Math.PI * 2;
      const sp = 20 + Math.random() * speed;
      const life = 0.3 + Math.random() * 0.4;
      this.particles.push({
        x,
        y,
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp - 30,
        size: 2.5 + Math.random() * 3.5,
        color,
        alpha: 1,
        life,
        maxLife: life
      });
    }
  }

  private spawnFloatingText(x: number, y: number, text: string, color: string): void {
    this.floatingTexts.push({
      x,
      y,
      text,
      color,
      alpha: 1.0,
      vy: -48
    });
  }

  // =========================================================================
  // 8. Main Render Pipeline & HUD Overlay
  // =========================================================================

  private render(): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.viewportWidth, this.viewportHeight);

    const nowSec = performance.now() * 0.001;
    const isTosser = this.mode === 'MANUAL_FAUCET';
    const isSpace = isSpaceMap(this.currentMapId);

    // 1. Background Image (screen space, aspect-preserving; parallax-tiled in platformer)
    const bgImg = this.bgImages.get(this.currentMapId);
    if (bgImg && bgImg.complete && bgImg.naturalWidth > 0) {
      const vw = this.viewportWidth;
      const vh = this.viewportHeight;
      const imgRatio = bgImg.naturalWidth / bgImg.naturalHeight;
      if (isTosser) {
        // Cover-fit, centered (matches original)
        let drawW = vw;
        let drawH = vw / imgRatio;
        if (imgRatio > vw / vh) {
          drawH = vh;
          drawW = vh * imgRatio;
        }
        ctx.drawImage(bgImg, (vw - drawW) * 0.5, (vh - drawH) * 0.5, drawW, drawH);
      } else {
        // Mirror every other tile so the art's edges meet seamlessly
        const tileW = Math.round(vh * imgRatio);
        const scroll = Math.round(this.cameraX * 0.35);
        let tileIdx = Math.floor(scroll / tileW);
        for (let bx = tileIdx * tileW - scroll; bx < vw; bx += tileW, tileIdx++) {
          if (tileIdx % 2 === 0) {
            ctx.drawImage(bgImg, bx, 0, tileW, vh);
          } else {
            ctx.save();
            ctx.translate(bx + tileW, 0);
            ctx.scale(-1, 1);
            ctx.drawImage(bgImg, 0, 0, tileW, vh);
            ctx.restore();
          }
        }
      }
      // Subtle dark overlay so trajectories, blocks, and sparkles stay readable
      ctx.fillStyle = 'rgba(9, 13, 22, 0.28)';
      ctx.fillRect(0, 0, vw, vh);
    } else {
      // Atmospheric fallback gradient
      const grad = ctx.createLinearGradient(0, 0, 0, this.viewportHeight);
      if (isSpace) {
        grad.addColorStop(0, '#090d16');
        grad.addColorStop(1, '#020617');
      } else {
        grad.addColorStop(0, '#1c1917');
        grad.addColorStop(1, '#0c0a09');
      }
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, this.viewportWidth, this.viewportHeight);
    }

    ctx.save();
    if (isTosser) {
      this.drawArenaScenery(ctx);
    } else {
      // Platformer Camera Translation
      ctx.translate(-Math.round(this.cameraX), -Math.round(this.cameraY));
      const plat = getPlatformerLevel(this.currentMapId);
      ctx.fillStyle = isSpace ? '#1e293b' : '#292524';
      ctx.fillRect(0, plat.floorY, plat.worldWidth, plat.worldHeight - plat.floorY);
      ctx.strokeStyle = '#64748b';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(0, plat.floorY);
      ctx.lineTo(plat.worldWidth, plat.floorY);
      ctx.stroke();
    }

    // 2. Destructible Blocks
    const blocks = isTosser ? this.arenaBlocks : this.platBlocks;
    for (const blk of blocks) {
      drawBlock(ctx, blk.x, blk.y, {
        type: blk.type,
        hp: blk.hp,
        maxHp: blk.maxHp,
        width: blk.w,
        height: blk.h,
        shake: (blk as any).shake || 0,
        alpha: (blk as any).alpha ?? 1.0
      });
    }

    // 3. Moving Platforms (Platformer Mode)
    if (!isTosser) {
      for (const p of this.platMovingPlatforms) {
        ctx.fillStyle = '#475569';
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.roundRect(p.x, p.y, p.w, p.h, 6);
        ctx.fill();
        ctx.stroke();

        // High-tech magnetic chevron stripe
        ctx.fillStyle = '#38bdf8';
        ctx.fillRect(p.x + 6, p.y + 4, p.w - 12, 3);
      }

      // Hazards (Spikes, Lava, Acid, Void)
      for (const h of this.platHazards) {
        if (h.type === HazardType.Spikes) {
          ctx.fillStyle = '#cbd5e1';
          const count = Math.floor(h.w / 16);
          for (let s = 0; s < count; s++) {
            ctx.beginPath();
            ctx.moveTo(h.x + s * 16, h.y + h.h);
            ctx.lineTo(h.x + s * 16 + 8, h.y);
            ctx.lineTo(h.x + (s + 1) * 16, h.y + h.h);
            ctx.closePath();
            ctx.fill();
          }
        } else if (h.type === HazardType.Lava) {
          ctx.fillStyle = '#ef4444';
          ctx.fillRect(h.x, h.y, h.w, h.h);
          ctx.fillStyle = '#fde047';
          ctx.fillRect(h.x, h.y, h.w, 4);
        } else {
          ctx.fillStyle = '#10b981';
          ctx.fillRect(h.x, h.y, h.w, h.h);
        }
      }

      // Checkpoints (pole planted in the floor, pennant at the checkpoint height)
      const cpFloorY = getPlatformerLevel(this.currentMapId).floorY;
      for (const cp of this.platCheckpoints) {
        const isActive = this.dwarfPlatformer.activeCheckpoint.x === cp.x;
        ctx.strokeStyle = '#94a3b8';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(cp.x, cpFloorY);
        ctx.lineTo(cp.x, cp.y - 30);
        ctx.stroke();
        ctx.fillStyle = isActive ? '#22c55e' : '#64748b';
        ctx.beginPath();
        ctx.moveTo(cp.x, cp.y - 30);
        ctx.lineTo(cp.x + 22, cp.y - 18);
        ctx.lineTo(cp.x, cp.y - 6);
        ctx.closePath();
        ctx.fill();
      }

      // Intermediate Ore Veins
      for (const node of this.platIntermediateNodes) {
        drawMiningNode(ctx, node.x, node.y, {
          radius: node.radius || 32,
          time: nowSec,
          scale: 0.75
        });
      }

      // Grand Mining Node
      drawMiningNode(ctx, this.platGrandNode.x, this.platGrandNode.y, {
        radius: this.platGrandNode.radius || 50,
        time: nowSec,
        scale: 1.2
      });
    }

    // 4. Mining Node (Arena Mode; replaced by the boss during boss fights)
    if (isTosser && this.boss) {
      drawBoss(ctx, this.boss, nowSec);
      for (const o of this.bossProjectiles) {
        drawFallingObject(ctx, o.x, o.y, {
          kind: o.kind,
          radius: o.radius,
          color: o.color,
          accent: o.accent,
          scale: 1.0,
          roll: o.roll,
          lit: o.kind === 'barrel'
        });
      }
    } else if (isTosser) {
      const node = this.getArenaLevel().miningNode;
      drawMiningNode(ctx, node.x, node.y, {
        radius: node.radius,
        time: nowSec,
        hitPulse: this.arenaNodeHitTimer / NODE_HIT_FLASH_DURATION,
        scale: 1.0
      });
    }

    // 5. Heavy Falling Objects
    const fallingObjs = isTosser ? this.arenaFallingObjects : this.platFallingObjects;
    for (const obj of fallingObjs) {
      drawFallingObject(ctx, obj.x, obj.y, {
        kind: obj.kind,
        radius: obj.radius,
        color: obj.color,
        accent: obj.accent,
        scale: 1.0,
        roll: obj.roll,
        // Fuse burns (and sputters) while the keg is on the move
        lit: !!obj.moving && Math.floor(nowSec * 15) % 7 !== 0
      });
    }

    // 6. Flying Birds
    const birds = isTosser ? this.arenaBirds : this.platBirds;
    for (const bird of birds) {
      drawBird(ctx, bird.x, bird.y, {
        flapPhase: (bird as any).flapPhase || 0,
        shielded: bird.shielded,
        shieldPulse: (bird as any).shieldPulse || 0,
        plane: bird.plane,
        vx: bird.vx,
        vy: bird.vy,
        age: (bird as any).age || 0
      });
    }
    for (const shatter of this.birdShatters) {
      drawBirdShatter(ctx, shatter.x, shatter.y, shatter);
    }

    // 7. Pickaxes & Spark Trails
    for (const p of this.pickaxes) {
      // Dotted Spark Trail
      for (let t = 0; t < p.trail.length; t++) {
        const pt = p.trail[t];
        const alpha = (t + 1) / p.trail.length;
        ctx.fillStyle = p.hitShieldedBird
          ? `rgba(56, 189, 248, ${alpha * 0.8})`
          : `rgba(251, 191, 36, ${alpha * 0.7})`;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 2 + alpha * 2.5, 0, Math.PI * 2);
        ctx.fill();
      }

      drawPickaxeGraphic(ctx, p.x, p.y, 1.1, {
        angle: p.angle,
        lightning: true,
        time: nowSec
      });
    }

    // 8. Dwarf
    if (isTosser) {
      const arena = this.dwarfArena;
      drawDwarf(ctx, arena.x, arena.y, {
        animation: arena.throwTimer > 0
          ? DwarfAnimation.Throw
          : arena.jumpOffset < 0 ? DwarfAnimation.Jump
          : arena.cheerTimer > 0 ? DwarfAnimation.Cheer : DwarfAnimation.Idle,
        frameTime: nowSec,
        facing: 'right',
        isSpaceMap: isSpace,
        aimAngleDeg: this.aimAngleDeg,
        aimPowerPct: this.aimPowerPct,
        throwProgress: 1 - arena.throwTimer / DWARF_THROW_DURATION,
        cheerTimer: arena.cheerTimer,
        verticalVelocity: arena.jumpVy
      });
    } else {
      const dwarf = this.dwarfPlatformer;
      const isBlinking = dwarf.invulnerableTimer > 0 && Math.floor(nowSec * 14) % 2 === 0;
      if (!isBlinking) {
        drawDwarf(ctx, dwarf.x, dwarf.y, {
          animation: dwarf.animation as any,
          frameTime: dwarf.animTime,
          facing: dwarf.facing,
          isSpaceMap: isSpace,
          aimAngleDeg: this.aimAngleDeg,
          aimPowerPct: this.aimPowerPct,
          throwProgress: 1 - dwarf.throwTimer / DWARF_THROW_DURATION,
          verticalVelocity: dwarf.vy,
          cheerTimer: dwarf.cheerTimer
        });
      }
    }

    // 9. Parabolic Aim Guide (Trajectory Preview)
    if (this.showAimGuide && !this.gameOver && !this.levelTransitioning) {
      this.drawTrajectoryPreview(ctx);
    }

    // 10. Floating Particle Bursts & Score Texts
    for (const pt of this.particles) {
      ctx.fillStyle = pt.color;
      ctx.globalAlpha = Math.max(0, pt.alpha);
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, pt.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1.0;
    }

    for (const fc of this.floatingCoins) {
      ctx.save();
      ctx.translate(fc.x, fc.y);
      ctx.globalAlpha = Math.max(0, fc.alpha);
      ctx.scale(Math.cos(fc.spin), 1);
      ctx.fillStyle = '#fbbf24';
      ctx.strokeStyle = '#ca8a04';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(0, 0, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    for (const ft of this.floatingTexts) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, ft.alpha);
      ctx.font = 'bold 15px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#0f172a';
      ctx.fillText(ft.text, ft.x + 1, ft.y + 1);
      ctx.fillStyle = ft.color;
      ctx.fillText(ft.text, ft.x, ft.y);
      ctx.restore();
    }

    ctx.restore();

    // 11. Screen-Space Overlays (Platformer Progress Minimap Bar, Boss Health)
    if (!isTosser) {
      this.drawPlatformerMinimap(ctx);
    }
    if (isTosser && this.boss && !this.boss.defeated) {
      drawBossHealthBar(ctx, this.boss, this.viewportWidth);
    }
  }

  /**
   * Arena scenery from the original: ceiling stalactites, background crystals,
   * the dwarf's stone ledge (flat on Maps 1-2, 3-step staircase on Map 3+), and the ground line.
   */
  private drawArenaScenery(ctx: CanvasRenderingContext2D): void {
    const level = this.getArenaLevel();
    const spawn = level.dwarfSpawn;
    const floorY = level.floorY;

    ctx.fillStyle = '#0f172a';
    for (let i = 0; i < 15; i++) {
      const sx = i * 92;
      const sh = 32 + (i % 3) * 20;
      ctx.beginPath();
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx + 48, sh);
      ctx.lineTo(sx + 96, 0);
      ctx.closePath();
      ctx.fill();
    }

    for (const c of level.bgCrystals) {
      ctx.fillStyle = c.color;
      ctx.beginPath();
      ctx.moveTo(c.x - c.w / 2, c.y);
      ctx.lineTo(c.x, c.y - c.h);
      ctx.lineTo(c.x + c.w / 2, c.y);
      ctx.closePath();
      ctx.fill();
    }

    if (spawn.leftStepTop && spawn.centerStepTop && spawn.rightStepTop) {
      const getStepLabel = (topY: number) => (topY < 480 ? 'HIGH' : topY > 540 ? 'LOW' : 'MID');
      const steps = [
        { x: 24, w: 74, top: spawn.leftStepTop, art: 'garrison_tower' as const },
        { x: 98, w: 62, top: spawn.centerStepTop, art: 'garrison_keep' as const },
        { x: 160, w: 74, top: spawn.rightStepTop, art: 'garrison_tower_right' as const }
      ];
      // The keep's art is wider than its step, so it goes behind the side towers
      for (const st of [steps[1], steps[0], steps[2]]) {
        if (drawGarrisonStep(ctx, st.art, st.x + st.w / 2, st.top, floorY, getStepLabel(st.top))) continue;
        ctx.fillStyle = '#334155';
        ctx.beginPath();
        ctx.roundRect(st.x, st.top, st.w, floorY - st.top, [8, 8, 0, 0]);
        ctx.fill();
        ctx.fillStyle = '#475569';
        ctx.fillRect(st.x, st.top, st.w, 10);
        ctx.strokeStyle = '#1e293b';
        ctx.lineWidth = 2;
        ctx.strokeRect(st.x, st.top, st.w, floorY - st.top);

        ctx.fillStyle = '#94a3b8';
        ctx.font = '700 9px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(getStepLabel(st.top), st.x + st.w / 2, st.top + 24);
      }
    } else {
      const ledgeTop = spawn.ledgeTop || 515;
      ctx.fillStyle = '#334155';
      ctx.beginPath();
      ctx.roundRect(24, ledgeTop, 210, floorY - ledgeTop, [12, 12, 0, 0]);
      ctx.fill();
      ctx.fillStyle = '#475569';
      ctx.fillRect(24, ledgeTop, 210, 12);
    }

    ctx.strokeStyle = '#64748b';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(0, floorY);
    ctx.lineTo(this.viewportWidth, floorY);
    ctx.stroke();
  }

  private drawTrajectoryPreview(ctx: CanvasRenderingContext2D): void {
    const isTosser = this.mode === 'MANUAL_FAUCET';
    const origin = this.getLaunchOrigin();
    const facingRight = isTosser ? true : this.dwarfPlatformer.facing === 'right';
    const vel = this.getLaunchVelocity(this.aimAngleDeg, this.aimPowerPct, facingRight);
    const grav = (this.mode === 'SIDE_SCROLLER' && isSpaceMap(this.currentMapId)) ? 490 : 980;
    const dt = 0.038;

    let px = origin.x;
    let py = origin.y;
    let pvx = vel.vx;
    let pvy = vel.vy;

    for (let s = 0; s < 30; s++) {
      pvx *= 0.999;
      pvy += grav * dt;
      px += pvx * dt;
      py += pvy * dt;

      const alpha = 1.0 - (s / 30) * 0.75;
      // Aim path dots are intentionally WHITE — do not recolor (keep them distinct from gold ore/coins).
      ctx.fillStyle = s % 2 === 0 ? `rgba(255, 255, 255, ${alpha})` : `rgba(226, 232, 240, ${alpha})`;
      ctx.beginPath();
      ctx.arc(px, py, 2.8 - (s / 30) * 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawPlatformerMinimap(ctx: CanvasRenderingContext2D): void {
    const barW = 380;
    const barH = 16;
    const barX = (this.viewportWidth - barW) / 2;
    const barY = 16;
    const level = getPlatformerLevel(this.currentMapId);
    const worldW = level.worldWidth;

    ctx.save();
    // Glassy dark backdrop
    ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
    ctx.strokeStyle = 'rgba(251, 191, 36, 0.45)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(barX, barY, barW, barH, 8);
    ctx.fill();
    ctx.stroke();

    // Checkpoints icons
    for (const cp of this.platCheckpoints) {
      const cx = barX + (cp.x / worldW) * barW;
      ctx.fillStyle = '#38bdf8';
      ctx.font = '10px sans-serif';
      ctx.fillText('🚩', cx - 5, barY + 12);
    }

    // Grand Node Icon
    const gx = barX + (this.platGrandNode.x / worldW) * barW;
    ctx.fillStyle = '#fbbf24';
    ctx.font = '11px sans-serif';
    ctx.fillText('💎', Math.min(barX + barW - 14, gx - 5), barY + 12);

    // Dwarf pin
    const dx = barX + Math.max(0, Math.min(1, this.dwarfPlatformer.x / worldW)) * barW;
    ctx.fillStyle = isSpaceMap(this.currentMapId) ? '#38bdf8' : '#f59e0b';
    ctx.beginPath();
    ctx.arc(dx, barY + barH / 2, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.restore();
  }

  // =========================================================================
  // 9. Input & Pointer Handlers
  // =========================================================================

  private setupPointerListeners(): void {
    const canvas = this.canvas;

    canvas.addEventListener('pointerdown', (e) => {
      this.soundEngine.unlockAudio();
      const rect = canvas.getBoundingClientRect();
      const scaleX = this.viewportWidth / rect.width;
      const scaleY = this.viewportHeight / rect.height;
      const x = (e.clientX - rect.left) * scaleX;
      const y = (e.clientY - rect.top) * scaleY;

      this.isDraggingAim = true;
      this.dragStartPos = { x, y };
      this.dragCurrentPos = { x, y };
    });

    window.addEventListener('pointermove', (e) => {
      if (!this.isDraggingAim || !this.dragStartPos) return;
      const rect = canvas.getBoundingClientRect();
      const scaleX = this.viewportWidth / rect.width;
      const scaleY = this.viewportHeight / rect.height;
      const x = (e.clientX - rect.left) * scaleX;
      const y = (e.clientY - rect.top) * scaleY;
      this.dragCurrentPos = { x, y };

      // Calculate Angle & Power from pull vector
      const dx = this.dragStartPos.x - x;
      const dy = y - this.dragStartPos.y;
      const pullDist = Math.hypot(dx, dy);

      if (pullDist > 10) {
        const angleRad = Math.atan2(dy, Math.max(0, dx));
        const deg = (angleRad * 180) / Math.PI;
        const power = Math.min(100, Math.max(25, (pullDist / 180) * 100));
        this.setAim(Math.max(15, Math.min(80, deg)), power);
      }
    });

    window.addEventListener('pointerup', () => {
      if (this.isDraggingAim) {
        this.isDraggingAim = false;
        this.lobPickaxe();
      }
      this.dragStartPos = null;
      this.dragCurrentPos = null;
    });
  }

  public adjustAim(deltaAngle: number, deltaPower: number): void {
    this.setAim(this.aimAngleDeg + deltaAngle, this.aimPowerPct + deltaPower);
  }

  /**
   * Keyboard: WASD moves (A/D step or run, W jumps), arrows aim
   * (Up/Down = angle, Left/Right = power), Space jumps (platformer) or lobs (arena),
   * F/Enter lobs, R resets.
   */
  private setupKeyboardListeners(): void {
    let heldLeft = false;
    let heldRight = false;
    const syncRun = () => this.platformerRun(heldLeft === heldRight ? 0 : heldLeft ? -1 : 1);

    window.addEventListener('keydown', (e) => {
      this.soundEngine.unlockAudio();
      const key = e.key.toLowerCase();

      if (key === 'a' || key === 'd') {
        if (this.mode === 'MANUAL_FAUCET') {
          if (!e.repeat) this.stepDwarf(key === 'a' ? -1 : 1);
        } else {
          if (key === 'a') heldLeft = true;
          else heldRight = true;
          syncRun();
        }
      } else if (key === 'w') {
        if (e.repeat) return;
        if (this.mode === 'SIDE_SCROLLER') this.platformerJump(true);
        else this.arenaJump();
      } else if (key === 'arrowup' || key === 'arrowdown') {
        e.preventDefault();
        this.adjustAim(key === 'arrowup' ? 1 : -1, 0);
      } else if (key === 'arrowleft' || key === 'arrowright') {
        e.preventDefault();
        this.adjustAim(0, key === 'arrowright' ? 1 : -1);
      } else if (key === ' ') {
        e.preventDefault();
        if (e.repeat) return;
        if (this.mode === 'SIDE_SCROLLER') {
          this.platformerJump(true);
        } else {
          this.lobPickaxe();
        }
      } else if (key === 'f' || key === 'enter') {
        e.preventDefault();
        this.lobPickaxe();
      } else if (key === 'r') {
        this.resetStage();
      }
    });

    window.addEventListener('keyup', (e) => {
      const key = e.key.toLowerCase();
      if (key === 'a' || key === 'd') {
        if (key === 'a') heldLeft = false;
        else heldRight = false;
        if (this.mode === 'SIDE_SCROLLER') syncRun();
      } else if (key === 'w' || key === ' ') {
        if (this.mode === 'SIDE_SCROLLER') {
          this.platformerJump(false);
        }
      }
    });

    // Don't keep running if the window loses focus mid-keypress
    window.addEventListener('blur', () => {
      heldLeft = false;
      heldRight = false;
      this.platformerRun(0);
    });
  }

  // =========================================================================
  // 10. Game Loop
  // =========================================================================

  private startLoop(): void {
    this.lastTimestamp = performance.now();
    const frame = (timestamp: number) => {
      const dt = Math.min(0.06, (timestamp - this.lastTimestamp) * 0.001);
      this.lastTimestamp = timestamp;

      if (!this.cashOutOfferOpen) {
        if (this.mode === 'SIDE_SCROLLER') {
          this.updatePlatformerPhysics(dt);
        }
        this.updateGeneralPhysics(dt);
      }
      this.render();

      this.animFrameId = requestAnimationFrame(frame);
    };
    this.animFrameId = requestAnimationFrame(frame);
  }

  public destroy(): void {
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
  }
}
