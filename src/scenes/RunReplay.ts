/**
 * RunReplay.ts
 *
 * The run log format. A run is reproduced from its header and player inputs in the real game
 * code, so the server works out what a run earned instead of trusting the player's balance.
 * Bump REPLAY_VERSION whenever a gameplay change would alter how an old log plays back.
 */

import type { BossKind } from './BossFight.ts';

export const REPLAY_VERSION = 1;
export const SIM_STEP_SECONDS = 1 / 60;
export const MAX_FRAME_CATCH_UP_SECONDS = 0.25;

/** s = step dwarf, j = jump, a = set aim, l = lob, c = accept cash-out, d = decline cash-out */
export type RunInputCode = 's' | 'j' | 'a' | 'l' | 'c' | 'd';
/** [tick the input landed on, code, ...args] */
export type RunInput = [number, RunInputCode, ...number[]];
/** [stage reached, tick, simulation digest] */
export type RunCheckpoint = [number, number, string];

export interface RunCashOut {
  stage: number;
  tick: number;
  amountRaw: string;
}

/** Test-only starting points. The server must reject any log that has them. */
export interface RunDebugStart {
  stage?: number;
  boss?: BossKind;
}

export interface RunStartOptions {
  seed?: number;
  startBalanceRaw?: bigint;
  freeLobs?: number;
  bossEncounters?: Record<BossKind, number>;
  aim?: { angle: number; power: number };
  debug?: RunDebugStart;
}

export interface RunLogHeader {
  version: number;
  seed: number;
  startBalanceRaw: string;
  freeLobs: number;
  bossEncounters: Record<BossKind, number>;
  aim: { angle: number; power: number };
  debug?: RunDebugStart;
}

export interface RunLog {
  header: RunLogHeader;
  ticks: number;
  inputs: RunInput[];
  checkpoints: RunCheckpoint[];
  digest: string;
}

/** Non-cryptographic state hash (two FNV-1a passes): detects desyncs, proves nothing about authorship. */
export function hashText(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x811c9dc5) + 0x9e3779b9;
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}
