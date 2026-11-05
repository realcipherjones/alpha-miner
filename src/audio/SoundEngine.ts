/**
 * SoundEngine.ts
 *
 * Web Audio API procedural synthesizer & gameplay music player for the Dwarf KII Platformer.
 *
 * Zero-dependency Web Audio synthesizers faithfully ported from
 * dwarf_pickaxe_tosser_maps_1_2_3.html with added platformer sound effects
 * (jump, land, step).
 *
 * Gameplay music (stage, boss, credits .ogg cues) plays on one HTML5 audio element, so a cue
 * replaces whatever is playing and two songs can never overlap. Cues are presentation only:
 * nothing here may touch the simulation or its seeded RNG, or replays stop verifying.
 */

import type { BossKind } from '../scenes/BossFight.ts';

export interface TrackInfo {
  index: number;
  id: string;
  trackNo: number;
  title: string;
  artist: string;
  album: string;
  year: string;
  durationSec: number;
  fileName: string;
  relativePath: string;
}

export interface SoundEngineOptions {
  musicBasePath?: string;
  initialMusicVolume?: number;
  initialSfxVolume?: number;
  startMuted?: boolean;
}

export type TrackChangeCallback = (title: string, isPlaying: boolean) => void;

export type GameMusicCue = 'stage' | 'boss' | 'credits';

interface GameTrack {
  trackNo: number;
  id: string;
  title: string;
  durationSec: number;
  fileName: string;
  cue: GameMusicCue;
}

const GAME_MUSIC_ARTIST = 'Alpha Miner';
const GAME_MUSIC_ALBUM = 'Game Soundtrack';
const GAME_MUSIC_YEAR = '2026';

export const STAGE_TRACKS: ReadonlyArray<GameTrack> = [
  { trackNo: 1, id: '12-bit-concrete', title: '12-Bit Concrete', durationSec: 135.65, fileName: '12-bit-concrete.ogg', cue: 'stage' },
  { trackNo: 2, id: 'cathedral-of-echoes', title: 'Cathedral of Echoes', durationSec: 132, fileName: 'cathedral-of-echoes.ogg', cue: 'stage' },
  { trackNo: 3, id: 'children-of-the-obsidian-sun', title: 'Children of the Obsidian Sun', durationSec: 90, fileName: 'children-of-the-obsidian-sun.ogg', cue: 'stage' },
  { trackNo: 4, id: 'chrome-cranium', title: 'Chrome Cranium', durationSec: 210, fileName: 'chrome-cranium.ogg', cue: 'stage' },
  { trackNo: 5, id: 'crenshaw-slauson', title: 'Crenshaw Slauson', durationSec: 90, fileName: 'crenshaw-slauson.ogg', cue: 'stage' },
  { trackNo: 6, id: 'flashtime-in-queens', title: 'Flashtime in Queens', durationSec: 162, fileName: 'flashtime-in-queens.ogg', cue: 'stage' }
];

export const BOSS_TRACKS: Readonly<Record<BossKind, GameTrack>> = {
  dog: { trackNo: 7, id: 'sector-7', title: 'Sector 7', durationSec: 90, fileName: 'sector-7.ogg', cue: 'boss' },
  son: { trackNo: 8, id: 'yes-chef', title: 'Yes Chef', durationSec: 85.03, fileName: 'yes-chef.ogg', cue: 'boss' }
};

export const CREDITS_TRACK: GameTrack = {
  trackNo: 9, id: 'twin-valkyrie', title: 'Twin Valkyrie', durationSec: 252, fileName: 'twin-valkyrie.ogg', cue: 'credits'
};

export class SoundEngine {
  private audioCtx: AudioContext | null = null;
  private sfxGainNode: GainNode | null = null;

  public isSfxMuted: boolean = false;
  public isMusicMuted: boolean = false;

  private sfxVolumeLevel: number = 1.0;
  private musicVolumeLevel: number = 0.7;

  private musicBasePath: string = '../GameMusic/ogg';
  private audioElement: HTMLAudioElement | null = null;
  private isPlayingMusicState: boolean = false;

  private currentGameTrack: GameTrack | null = null;
  private pendingGameTrack: GameTrack | null = null;
  private lastStageTrack: GameTrack | null = null;

  private trackChangeListeners: TrackChangeCallback[] = [];
  private interactionListenersAttached: boolean = false;
  private consecutiveTrackErrors: number = 0;

  constructor(options?: SoundEngineOptions) {
    if (options?.musicBasePath !== undefined) {
      this.musicBasePath = options.musicBasePath;
    }
    if (options?.initialMusicVolume !== undefined) {
      this.musicVolumeLevel = Math.max(0, Math.min(1, options.initialMusicVolume));
    }
    if (options?.initialSfxVolume !== undefined) {
      this.sfxVolumeLevel = Math.max(0, Math.min(1, options.initialSfxVolume));
    }
    if (options?.startMuted) {
      this.isSfxMuted = true;
      this.isMusicMuted = true;
    }

    this.initAudioElement();
    this.setupAutoplayUnblocker();
  }

  // =========================================================================
  // 1. AudioContext Initialization & Safe Browser Unlocking
  // =========================================================================

  private getAudioContextClass(): typeof AudioContext | null {
    if (typeof window === 'undefined') return null;
    const win = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
    return win.AudioContext || win.webkitAudioContext || null;
  }

  public ensureAudio(): AudioContext | null {
    if (this.isSfxMuted) return null;
    const AudioContextClass = this.getAudioContextClass();
    if (!AudioContextClass) return null;

    if (!this.audioCtx) {
      try {
        this.audioCtx = new AudioContextClass();
        this.sfxGainNode = this.audioCtx.createGain();
        this.sfxGainNode.gain.value = this.sfxVolumeLevel;
        this.sfxGainNode.connect(this.audioCtx.destination);
      } catch {
        return null;
      }
    }

    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch(() => {});
    }

    return this.audioCtx;
  }

  public unlockAudio(): void {
    const ctx = this.ensureAudio();
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    if (this.audioElement && this.pendingGameTrack) {
      const track = this.pendingGameTrack;
      this.pendingGameTrack = null;
      this.startGameTrack(track).catch(() => {});
    }
  }

  private setupAutoplayUnblocker(): void {
    if (typeof window === 'undefined' || this.interactionListenersAttached) return;

    // Stay attached until music has actually started; a gesture that arrives before
    // the first autoplay attempt would otherwise be wasted.
    const onUserInteraction = (): void => {
      this.unlockAudio();
      if (!this.isPlayingMusicState) return;
      window.removeEventListener('pointerdown', onUserInteraction);
      window.removeEventListener('keydown', onUserInteraction);
      window.removeEventListener('touchstart', onUserInteraction);
      window.removeEventListener('click', onUserInteraction);
      this.interactionListenersAttached = false;
    };

    window.addEventListener('pointerdown', onUserInteraction, { once: false, passive: true });
    window.addEventListener('keydown', onUserInteraction, { once: false, passive: true });
    window.addEventListener('touchstart', onUserInteraction, { once: false, passive: true });
    window.addEventListener('click', onUserInteraction, { once: false, passive: true });
    this.interactionListenersAttached = true;
  }

  private getSfxDestination(ctx: AudioContext): AudioNode {
    if (this.sfxGainNode) return this.sfxGainNode;
    return ctx.destination;
  }

  // =========================================================================
  // 2. Procedural Web Audio API Synthesizer (Faithfully Ported from Game HTML)
  // =========================================================================

  /**
   * Bright metallic coin ding; plays a rapid double-chime on +2 Indirect hits!
   */
  public playCoinDing(isDouble: boolean = false): void {
    const ctx = this.ensureAudio();
    if (!ctx) return;

    const dest = this.getSfxDestination(ctx);
    const chimes = isDouble ? [0, 0.11] : [0];

    for (let idx = 0; idx < chimes.length; idx++) {
      const offset = chimes[idx];
      const now = ctx.currentTime + offset;
      const pitchMult = idx === 1 ? 1.12246 : 1.0; // Step up a whole tone on second ding

      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(987.77 * pitchMult, now);
      osc1.frequency.setValueAtTime(1318.51 * pitchMult, now + 0.07);
      gain1.gain.setValueAtTime(0.001, now);
      gain1.gain.linearRampToValueAtTime(0.32, now + 0.01);
      gain1.gain.exponentialRampToValueAtTime(0.0008, now + 0.62);
      osc1.connect(gain1);
      gain1.connect(dest);
      osc1.start(now);
      osc1.stop(now + 0.63);

      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.type = 'triangle';
      osc2.frequency.setValueAtTime(1975.53 * pitchMult, now);
      osc2.frequency.setValueAtTime(2637.02 * pitchMult, now + 0.07);
      gain2.gain.setValueAtTime(0.001, now);
      gain2.gain.linearRampToValueAtTime(0.16, now + 0.01);
      gain2.gain.exponentialRampToValueAtTime(0.0008, now + 0.42);
      osc2.connect(gain2);
      gain2.connect(dest);
      osc2.start(now);
      osc2.stop(now + 0.43);
    }
  }

  /**
   * Whistle-whoosh sound when lobbing a pickaxe.
   */
  public playThrowSound(): void {
    const ctx = this.ensureAudio();
    if (!ctx) return;
    const now = ctx.currentTime;
    const dest = this.getSfxDestination(ctx);

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(220, now);
    osc.frequency.exponentialRampToValueAtTime(520, now + 0.14);
    gain.gain.setValueAtTime(0.18, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
    osc.connect(gain);
    gain.connect(dest);
    osc.start(now);
    osc.stop(now + 0.17);
  }

  /**
   * Low crash/clatter when pickaxe or falling rock strikes destructible terrain or cavern floor.
   */
  public playTerrainHitSound(destroyed: boolean = false): void {
    const ctx = this.ensureAudio();
    if (!ctx) return;
    const now = ctx.currentTime;
    const dest = this.getSfxDestination(ctx);

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = destroyed ? 'sawtooth' : 'square';
    osc.frequency.setValueAtTime(destroyed ? 150 : 240, now);
    osc.frequency.exponentialRampToValueAtTime(42, now + (destroyed ? 0.22 : 0.1));
    gain.gain.setValueAtTime(destroyed ? 0.22 : 0.12, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + (destroyed ? 0.23 : 0.11));
    osc.connect(gain);
    gain.connect(dest);
    osc.start(now);
    osc.stop(now + (destroyed ? 0.24 : 0.12));
  }

  /**
   * Bird squawk + explosion poof when hit by a pickaxe.
   */
  public playBirdExplodeSound(): void {
    const ctx = this.ensureAudio();
    if (!ctx) return;
    const now = ctx.currentTime;
    const dest = this.getSfxDestination(ctx);

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(740, now);
    osc.frequency.linearRampToValueAtTime(320, now + 0.12);
    osc.frequency.exponentialRampToValueAtTime(95, now + 0.28);
    gain.gain.setValueAtTime(0.24, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
    osc.connect(gain);
    gain.connect(dest);
    osc.start(now);
    osc.stop(now + 0.31);
  }

  /**
   * Sci-fi spaceship blue aura shield deflection ping when axe bounces off a shielded bird.
   */
  public playShieldBounceSound(): void {
    const ctx = this.ensureAudio();
    if (!ctx) return;
    const now = ctx.currentTime;
    const dest = this.getSfxDestination(ctx);

    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(620, now);
    osc1.frequency.exponentialRampToValueAtTime(1420, now + 0.09);
    osc1.frequency.exponentialRampToValueAtTime(480, now + 0.22);
    gain1.gain.setValueAtTime(0.22, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.23);
    osc1.connect(gain1);
    gain1.connect(dest);
    osc1.start(now);
    osc1.stop(now + 0.24);
  }

  /**
   * Rising melodic chime when an overhead axe rebound grants a Free Next Lob.
   */
  public playFreeLobSound(): void {
    const ctx = this.ensureAudio();
    if (!ctx) return;
    const dest = this.getSfxDestination(ctx);
    const notes = [587.33, 880.0, 1174.66]; // D5, A5, D6

    notes.forEach((freq, idx) => {
      const now = ctx.currentTime + idx * 0.065;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, now);
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
      osc.connect(gain);
      gain.connect(dest);
      osc.start(now);
      osc.stop(now + 0.29);
    });
  }

  /**
   * Subtle chirp when patrol birds spawn into the arena.
   */
  public playBirdSpawnChirp(): void {
    const ctx = this.ensureAudio();
    if (!ctx) return;
    const now = ctx.currentTime;
    const dest = this.getSfxDestination(ctx);

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(920, now);
    osc.frequency.exponentialRampToValueAtTime(1480, now + 0.08);
    osc.frequency.exponentialRampToValueAtTime(860, now + 0.18);
    gain.gain.setValueAtTime(0.15, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.19);
    osc.connect(gain);
    gain.connect(dest);
    osc.start(now);
    osc.stop(now + 0.2);
  }

  /**
   * Melancholic descending tone when out of coins (Game Over).
   */
  public playGameOverSound(): void {
    const ctx = this.ensureAudio();
    if (!ctx) return;
    const dest = this.getSfxDestination(ctx);
    const notes = [392.0, 349.23, 311.13, 261.63]; // G4, F4, Eb4, C4

    notes.forEach((freq, idx) => {
      const now = ctx.currentTime + idx * 0.14;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(freq, now);
      gain.gain.setValueAtTime(0.18, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
      osc.connect(gain);
      gain.connect(dest);
      osc.start(now);
      osc.stop(now + 0.36);
    });
  }

  /**
   * Triumphant ascending fanfare when clearing a map.
   */
  public playVictoryFanfare(): void {
    const ctx = this.ensureAudio();
    if (!ctx) return;
    const dest = this.getSfxDestination(ctx);
    const notes = [523.25, 659.25, 783.99, 1046.5, 1318.5]; // C5, E5, G5, C6, E6

    notes.forEach((freq, idx) => {
      const now = ctx.currentTime + idx * 0.09;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, now);
      gain.gain.setValueAtTime(0.22, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
      osc.connect(gain);
      gain.connect(dest);
      osc.start(now);
      osc.stop(now + 0.46);
    });
  }

  // =========================================================================
  // 3. Platformer Synthesizer Sound Effects
  // =========================================================================

  /**
   * Jump sound effect.
   * If isSpaceHalfGrav is true: floatier, lower-pitched sweep with sci-fi shimmer.
   * If normal gravity: crisp, snappy upward leap.
   */
  public playJumpSound(isSpaceHalfGrav: boolean = false): void {
    const ctx = this.ensureAudio();
    if (!ctx) return;
    const now = ctx.currentTime;
    const dest = this.getSfxDestination(ctx);

    if (isSpaceHalfGrav) {
      // Space Half-Grav: Dreamy, low-gravity sci-fi leap
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gain = ctx.createGain();

      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(140, now);
      osc1.frequency.exponentialRampToValueAtTime(360, now + 0.22);

      osc2.type = 'triangle';
      osc2.frequency.setValueAtTime(280, now);
      osc2.frequency.exponentialRampToValueAtTime(720, now + 0.22);

      gain.gain.setValueAtTime(0.18, now);
      gain.gain.linearRampToValueAtTime(0.22, now + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);

      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(dest);

      osc1.start(now);
      osc2.start(now);
      osc1.stop(now + 0.26);
      osc2.stop(now + 0.26);
    } else {
      // Normal Cavern Gravity: Snappy energetic leap
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(175, now);
      osc.frequency.exponentialRampToValueAtTime(460, now + 0.12);

      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);

      osc.connect(gain);
      gain.connect(dest);

      osc.start(now);
      osc.stop(now + 0.15);
    }
  }

  /**
   * Landing sound effect when dwarf hits platform or cavern ground.
   */
  public playLandSound(): void {
    const ctx = this.ensureAudio();
    if (!ctx) return;
    const now = ctx.currentTime;
    const dest = this.getSfxDestination(ctx);

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(130, now);
    osc.frequency.exponentialRampToValueAtTime(45, now + 0.08);

    gain.gain.setValueAtTime(0.24, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);

    osc.connect(gain);
    gain.connect(dest);

    osc.start(now);
    osc.stop(now + 0.1);
  }

  /**
   * Subtle footstep sound for running across stone/wood platforms.
   */
  public playStepSound(): void {
    const ctx = this.ensureAudio();
    if (!ctx) return;
    const now = ctx.currentTime;
    const dest = this.getSfxDestination(ctx);

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    // Short blip so footsteps remain pleasant and don't overwhelm
    osc.type = 'sine';
    osc.frequency.setValueAtTime(180, now);
    osc.frequency.exponentialRampToValueAtTime(75, now + 0.035);

    gain.gain.setValueAtTime(0.08, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);

    osc.connect(gain);
    gain.connect(dest);

    osc.start(now);
    osc.stop(now + 0.045);
  }

  // =========================================================================
  // 4. Gameplay Music
  // =========================================================================

  private initAudioElement(): void {
    if (typeof window === 'undefined' || typeof Audio === 'undefined') return;

    try {
      this.audioElement = new Audio();
      this.audioElement.preload = 'auto';
      this.audioElement.volume = this.isMusicMuted ? 0 : this.musicVolumeLevel;

      // Song finished: a stage keeps going on another stage song, and credits just end.
      // Boss songs set .loop, so they never fire this.
      this.audioElement.addEventListener('ended', () => {
        if (this.currentGameTrack?.cue === 'stage') {
          this.startGameTrack(this.pickStageTrack()).catch(() => {});
        }
      });

      this.audioElement.addEventListener('playing', () => {
        this.isPlayingMusicState = true;
        this.pendingGameTrack = null;
        this.consecutiveTrackErrors = 0;
        this.notifyTrackChange();
      });

      this.audioElement.addEventListener('pause', () => {
        this.isPlayingMusicState = false;
        this.notifyTrackChange();
      });

      // Drives the elapsed-time readout
      this.audioElement.addEventListener('timeupdate', () => this.notifyTrackChange());

      // Skip unplayable/missing files, but give up after one full lap of failures
      this.audioElement.addEventListener('error', () => {
        this.isPlayingMusicState = false;
        this.consecutiveTrackErrors += 1;
        this.notifyTrackChange();
        // A bad stage song falls through to another one. A boss song has no substitute.
        if (this.currentGameTrack?.cue === 'stage' && !this.hasMusicLoadFailed()) {
          this.startGameTrack(this.pickStageTrack()).catch(() => {});
        }
      });
    } catch {
      this.audioElement = null;
    }
  }

  public getCurrentTrack(): TrackInfo | null {
    const game = this.currentGameTrack;
    if (!game) return null;
    return {
      index: game.trackNo - 1,
      id: game.id,
      trackNo: game.trackNo,
      title: game.title,
      artist: GAME_MUSIC_ARTIST,
      album: GAME_MUSIC_ALBUM,
      year: GAME_MUSIC_YEAR,
      durationSec: game.durationSec,
      fileName: game.fileName,
      relativePath: `${this.musicBasePath.replace(/\/+$/, '')}/${game.fileName}`
    };
  }

  public getCurrentTrackTitle(): string {
    return this.currentGameTrack?.title ?? 'Unknown Track';
  }

  public isPlayingMusic(): boolean {
    return this.isPlayingMusicState;
  }

  /** True while the browser is blocking autoplay and music is waiting for a click/keypress. */
  public isAwaitingGesture(): boolean {
    return this.pendingGameTrack !== null;
  }

  /** True when music has nothing left to try (e.g. the GameMusic folder is missing). */
  public hasMusicLoadFailed(): boolean {
    const attempts = this.currentGameTrack?.cue === 'stage' ? STAGE_TRACKS.length : 1;
    return this.consecutiveTrackErrors >= attempts;
  }

  public getPlaybackTime(): { current: number; duration: number } {
    const fallback = this.currentGameTrack?.durationSec ?? 0;
    if (!this.audioElement) return { current: 0, duration: fallback };
    const d = this.audioElement.duration;
    return {
      current: this.audioElement.currentTime || 0,
      duration: Number.isFinite(d) && d > 0 ? d : fallback
    };
  }

  /** A stage just started: play a stage song, never the same one twice in a row. */
  public playStageMusic(): void {
    this.consecutiveTrackErrors = 0;
    this.startGameTrack(this.pickStageTrack()).catch(() => {});
  }

  /** A boss fight just started: play that boss's song on a loop until the next cue. */
  public playBossMusic(kind: BossKind): void {
    this.consecutiveTrackErrors = 0;
    this.startGameTrack(BOSS_TRACKS[kind]).catch(() => {});
  }

  /** For the credits screen. Nothing calls this yet because the game has no credits. */
  public playCreditsMusic(): void {
    this.consecutiveTrackErrors = 0;
    this.startGameTrack(CREDITS_TRACK).catch(() => {});
  }

  /** Math.random on purpose: this.rng belongs to the simulation and music must not draw from it. */
  private pickStageTrack(): GameTrack {
    const pool = STAGE_TRACKS.filter((t) => t !== this.lastStageTrack);
    const track = pool[Math.floor(Math.random() * pool.length)];
    this.lastStageTrack = track;
    return track;
  }

  private async startGameTrack(track: GameTrack): Promise<void> {
    if (!this.audioElement) {
      this.initAudioElement();
    }
    if (!this.audioElement) return;

    this.currentGameTrack = track;
    this.pendingGameTrack = null;
    this.audioElement.loop = track.cue === 'boss';

    const cleanBase = this.musicBasePath.replace(/\/+$/, '');
    try {
      this.audioElement.src = `${cleanBase}/${encodeURIComponent(track.fileName)}`;
      this.audioElement.volume = this.isMusicMuted ? 0 : this.musicVolumeLevel;
      await this.audioElement.play();
      this.isPlayingMusicState = true;
      this.notifyTrackChange();
    } catch (err) {
      // Only an autoplay block should wait for a gesture. Load failures are handled by the
      // 'error' listener, and AbortError just means a newer cue replaced this one, so queue
      // the current cue rather than the one this call started with.
      if ((err as { name?: string })?.name === 'NotAllowedError') {
        this.pendingGameTrack = this.currentGameTrack;
      }
      this.isPlayingMusicState = false;
      this.notifyTrackChange();
    }
  }

  public pauseMusic(): void {
    if (this.audioElement) {
      this.audioElement.pause();
      this.isPlayingMusicState = false;
      this.notifyTrackChange();
    }
  }

  public async resumeMusic(): Promise<void> {
    if (!this.audioElement) return;
    try {
      await this.audioElement.play();
      this.isPlayingMusicState = true;
      this.notifyTrackChange();
    } catch {
      this.pendingGameTrack = this.currentGameTrack;
    }
  }

  public stopMusic(): void {
    if (this.audioElement) {
      this.audioElement.pause();
      this.audioElement.currentTime = 0;
      this.isPlayingMusicState = false;
      this.notifyTrackChange();
    }
  }

  // =========================================================================
  // 5. Volume & Mute Controls
  // =========================================================================

  public toggleMusicMute(): boolean {
    this.isMusicMuted = !this.isMusicMuted;
    if (this.audioElement) {
      this.audioElement.volume = this.isMusicMuted ? 0 : this.musicVolumeLevel;
    }
    this.notifyTrackChange();
    return this.isMusicMuted;
  }

  public toggleSfxMute(): boolean {
    this.isSfxMuted = !this.isSfxMuted;
    if (this.sfxGainNode && this.audioCtx) {
      this.sfxGainNode.gain.value = this.isSfxMuted ? 0 : this.sfxVolumeLevel;
    }
    return this.isSfxMuted;
  }

  public setMusicVolume(volume: number): void {
    this.musicVolumeLevel = Math.max(0, Math.min(1, volume));
    if (this.audioElement && !this.isMusicMuted) {
      this.audioElement.volume = this.musicVolumeLevel;
    }
    this.notifyTrackChange();
  }

  public setSfxVolume(volume: number): void {
    this.sfxVolumeLevel = Math.max(0, Math.min(1, volume));
    if (this.sfxGainNode && this.audioCtx && !this.isSfxMuted) {
      this.sfxGainNode.gain.value = this.sfxVolumeLevel;
    }
  }

  public getMusicVolume(): number {
    return this.musicVolumeLevel;
  }

  public getSfxVolume(): number {
    return this.sfxVolumeLevel;
  }

  public onTrackChange(callback: TrackChangeCallback): () => void {
    this.trackChangeListeners.push(callback);
    // Send immediate initial state
    try {
      callback(this.getCurrentTrackTitle(), this.isPlayingMusicState);
    } catch {}

    return () => {
      this.trackChangeListeners = this.trackChangeListeners.filter(cb => cb !== callback);
    };
  }

  private notifyTrackChange(): void {
    const title = this.getCurrentTrackTitle();
    const isPlaying = this.isPlayingMusicState && !this.isMusicMuted;
    for (const listener of this.trackChangeListeners) {
      try {
        listener(title, isPlaying);
      } catch {}
    }
  }
}
