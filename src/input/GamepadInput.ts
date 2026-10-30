/**
 * GamepadInput.ts
 *
 * Polls the browser Gamepad API (Xbox / PlayStation / generic "standard" mapping)
 * every animation frame and drives the game controller with it.
 *
 * Layout (Xbox names):
 * - Left stick / D-pad left-right: step (arena) or run (platformer)
 * - D-pad up/down: aim angle
 * - Right stick: aim (up/down = angle, left/right = power)
 * - A: jump (platformer and boss fights) or lob (arena)
 * - X / B / RT: lob pickaxe
 * - LB / RB: aim presets (High Shelf / Ore Arch)
 * - Y: toggle aim guide
 * - Back/View: PLAYTEST skip to next late-game milestone stage (49, 50, 75, 76, 100, then +10)
 * - Start/Menu: reset stage
 * - Victory/game-over screen: A = play again, Start = new run
 * - Cash-out pop-up: A = keep KII, Start = cash out
 */

import type { ExcaliburGameController } from '../scenes/ExcaliburGameController.ts';

export interface GamepadHooks {
  isModalOpen: () => boolean;
  onModalPlayAgain: () => void;
  onModalNewRun: () => void;
  onToggleAimGuide: () => void;
  onPlaytestSkip: () => void;
  onConnectionChange?: (connected: boolean, name: string) => void;
}

// Standard mapping button indices
const BTN_A = 0;
const BTN_B = 1;
const BTN_X = 2;
const BTN_Y = 3;
const BTN_LB = 4;
const BTN_RB = 5;
const BTN_RT = 7;
const BTN_BACK = 8;
const BTN_START = 9;
const BTN_DPAD_UP = 12;
const BTN_DPAD_DOWN = 13;
const BTN_DPAD_LEFT = 14;
const BTN_DPAD_RIGHT = 15;

const STICK_DIGITAL_DEADZONE = 0.5;
const STICK_ANALOG_DEADZONE = 0.18;
const TRIGGER_THRESHOLD = 0.5;
const REPEAT_DELAY = 0.35;
const REPEAT_INTERVAL = 0.12;
const AIM_ANGLE_RATE = 55; // degrees per second at full tilt
const AIM_POWER_RATE = 70; // percent per second at full tilt

export class GamepadInput {
  private controller: ExcaliburGameController;
  private hooks: GamepadHooks;
  private prevButtons: boolean[] = [];
  private prevRunDir: -1 | 0 | 1 = 0;
  private prevMode: string;
  private repeatTimers: Record<string, number> = {};
  private angleAccum: number = 0;
  private powerAccum: number = 0;
  private lastTimestamp: number = 0;
  private connectedIndex: number | null = null;

  constructor(controller: ExcaliburGameController, hooks: GamepadHooks) {
    this.controller = controller;
    this.hooks = hooks;
    this.prevMode = controller.mode;

    window.addEventListener('gamepadconnected', (e) => {
      const pad = (e as GamepadEvent).gamepad;
      this.hooks.onConnectionChange?.(true, pad.id);
    });
    window.addEventListener('gamepaddisconnected', (e) => {
      const pad = (e as GamepadEvent).gamepad;
      if (pad.index === this.connectedIndex) this.releaseAll();
      this.hooks.onConnectionChange?.(false, pad.id);
    });

    const frame = (timestamp: number) => {
      const dt = this.lastTimestamp ? Math.min(0.06, (timestamp - this.lastTimestamp) * 0.001) : 0;
      this.lastTimestamp = timestamp;
      this.poll(dt);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  private getPad(): Gamepad | null {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
    for (const pad of navigator.getGamepads()) {
      if (pad && pad.connected) return pad;
    }
    return null;
  }

  /** Let go of anything the pad was holding so the dwarf doesn't keep running. */
  private releaseAll(): void {
    if (this.prevRunDir !== 0) this.controller.platformerRun(0);
    if (this.prevButtons[BTN_A] && this.controller.mode === 'SIDE_SCROLLER') this.controller.platformerJump(false);
    this.prevRunDir = 0;
    this.prevButtons = [];
    this.repeatTimers = {};
    this.connectedIndex = null;
  }

  /** True on the frame held goes down, then auto-repeats while it stays held. */
  private repeatPress(key: string, held: boolean, dt: number): boolean {
    if (!held) {
      delete this.repeatTimers[key];
      return false;
    }
    if (!(key in this.repeatTimers)) {
      this.repeatTimers[key] = REPEAT_DELAY;
      return true;
    }
    this.repeatTimers[key] -= dt;
    if (this.repeatTimers[key] <= 0) {
      this.repeatTimers[key] += REPEAT_INTERVAL;
      return true;
    }
    return false;
  }

  private poll(dt: number): void {
    const pad = this.getPad();
    if (!pad) {
      if (this.connectedIndex !== null) this.releaseAll();
      return;
    }
    this.connectedIndex = pad.index;

    const c = this.controller;
    const buttons = pad.buttons.map((b, i) => (i === BTN_RT ? b.value > TRIGGER_THRESHOLD : b.pressed));
    const pressed = (i: number) => !!buttons[i] && !this.prevButtons[i];
    const released = (i: number) => !buttons[i] && !!this.prevButtons[i];
    const axis = (i: number) => pad.axes[i] ?? 0;

    if (buttons.some(Boolean)) c.soundEngine.unlockAudio();

    // Mode changed under us (e.g. a scripted boss sequence): drop held platformer inputs
    if (c.mode !== this.prevMode) {
      if (this.prevRunDir !== 0) c.platformerRun(0);
      this.prevRunDir = 0;
      this.prevMode = c.mode;
    }

    if (this.hooks.isModalOpen()) {
      if (pressed(BTN_A)) this.hooks.onModalPlayAgain();
      if (pressed(BTN_START)) this.hooks.onModalNewRun();
      this.prevButtons = buttons;
      return;
    }

    // --- Movement ---
    const lx = axis(0);
    const left = !!buttons[BTN_DPAD_LEFT] || lx < -STICK_DIGITAL_DEADZONE;
    const right = !!buttons[BTN_DPAD_RIGHT] || lx > STICK_DIGITAL_DEADZONE;
    const runDir: -1 | 0 | 1 = left === right ? 0 : left ? -1 : 1;

    if (c.mode === 'MANUAL_FAUCET') {
      if (this.repeatPress('stepL', runDir < 0, dt)) c.stepDwarf(-1);
      if (this.repeatPress('stepR', runDir > 0, dt)) c.stepDwarf(1);
    } else if (runDir !== this.prevRunDir) {
      c.platformerRun(runDir);
    }
    this.prevRunDir = c.mode === 'SIDE_SCROLLER' ? runDir : 0;

    // --- Jump / Lob ---
    if (c.mode === 'SIDE_SCROLLER') {
      if (pressed(BTN_A)) c.platformerJump(true);
      else if (released(BTN_A)) c.platformerJump(false);
    } else if (pressed(BTN_A)) {
      if (c.boss) c.arenaJump();
      else c.lobPickaxe();
    }
    if (pressed(BTN_X) || pressed(BTN_B) || pressed(BTN_RT)) c.lobPickaxe();

    // --- Aim ---
    if (this.repeatPress('angleUp', !!buttons[BTN_DPAD_UP], dt)) c.adjustAim(1, 0);
    if (this.repeatPress('angleDown', !!buttons[BTN_DPAD_DOWN], dt)) c.adjustAim(-1, 0);

    const rx = axis(2);
    const ry = axis(3);
    const scaled = (v: number) =>
      Math.abs(v) < STICK_ANALOG_DEADZONE ? 0 : Math.sign(v) * ((Math.abs(v) - STICK_ANALOG_DEADZONE) / (1 - STICK_ANALOG_DEADZONE));
    // setAim rounds to whole numbers, so bank fractional motion until it adds up to a step
    this.angleAccum += -scaled(ry) * AIM_ANGLE_RATE * dt;
    this.powerAccum += scaled(rx) * AIM_POWER_RATE * dt;
    const angleStep = Math.trunc(this.angleAccum);
    const powerStep = Math.trunc(this.powerAccum);
    if (angleStep !== 0 || powerStep !== 0) {
      c.adjustAim(angleStep, powerStep);
      this.angleAccum -= angleStep;
      this.powerAccum -= powerStep;
    }
    if (scaled(ry) === 0) this.angleAccum = 0;
    if (scaled(rx) === 0) this.powerAccum = 0;

    if (pressed(BTN_LB)) c.setAimPreset('high');
    if (pressed(BTN_RB)) c.setAimPreset('ore');

    // --- Menu-ish buttons ---
    if (pressed(BTN_Y)) this.hooks.onToggleAimGuide();
    if (pressed(BTN_BACK)) this.hooks.onPlaytestSkip();
    if (pressed(BTN_START)) c.resetStage();

    this.prevButtons = buttons;
  }
}
