/**
 * PayoutClient.ts
 *
 * Talks to the payout server (server/app.py). The address comes from the apiBaseMeta tag in index.html:
 * blank means no server, and the game makes no network requests at all.
 * The token only proves who is asking. A player's wallet can't be changed with it, so a stolen token
 * can't redirect payouts.
 */

import type { BossKind } from '../scenes/BossFight.ts';
import type { RunLog } from '../scenes/RunReplay.ts';

const ACCOUNT_KEY = 'alphaMiner.account';
const SKIP_KEY = 'alphaMiner.registrationSkipped';
const REQUEST_TIMEOUT_MS = 8000;
const SUBMIT_TIMEOUT_MS = 60000;

export interface PayoutAccount {
  ign: string;
  wallet: string;
  token: string;
}

export interface StartedRun {
  runId: string;
  seed: number;
  bossEncounters: Record<BossKind, number>;
  debugStart?: { stage: number; startBalanceRaw?: string };
}

export interface PayoutStatus {
  ign: string;
  wallet: string;
  bestStage: number;
  cashOuts: Array<{ stage: number; amountRaw: string; paidRaw: string; verifiedAt: number }>;
  lastRejection: string | null;
  mode: string | null;
}

export class PayoutError extends Error {
  public readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class PayoutClient {
  private readonly apiBase: string;
  public account: PayoutAccount | null = null;

  constructor(apiBase: string) {
    this.apiBase = apiBase.trim().replace(/\/+$/, '');
    try {
      const saved = JSON.parse(localStorage.getItem(ACCOUNT_KEY) || 'null');
      if (saved && typeof saved.token === 'string') this.account = saved;
    } catch {}
  }

  public get enabled(): boolean {
    return this.apiBase !== '';
  }

  public get skippedRegistration(): boolean {
    try {
      return localStorage.getItem(SKIP_KEY) === '1';
    } catch {
      return false;
    }
  }

  public rememberSkippedRegistration(): void {
    try {
      localStorage.setItem(SKIP_KEY, '1');
    } catch {}
  }

  private async request<T>(method: string, path: string, body?: unknown, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<T> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = {};
      if (this.account) headers.Authorization = `Bearer ${this.account.token}`;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      let response: Response;
      try {
        response = await fetch(`${this.apiBase}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: abort.signal
        });
      } catch {
        throw new PayoutError(503, "Couldn't reach the server.");
      }
      const reply = await response.json().catch(() => ({}));
      if (!response.ok) throw new PayoutError(response.status, reply.error || 'Server error.');
      return reply as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /** The server doesn't know this login any more, so the player has to claim an IGN again. */
  public forgetAccount(): void {
    this.account = null;
    try {
      localStorage.removeItem(ACCOUNT_KEY);
    } catch {}
  }

  public async register(ign: string, wallet: string): Promise<void> {
    const reply = await this.request<PayoutAccount>('POST', '/api/register', { ign, wallet });
    this.account = { ign: reply.ign, wallet: reply.wallet, token: reply.token };
    try {
      localStorage.setItem(ACCOUNT_KEY, JSON.stringify(this.account));
    } catch {}
  }

  public startRun(): Promise<StartedRun> {
    return this.request<StartedRun>('POST', '/api/runs');
  }

  public submitRun(runId: string, log: RunLog): Promise<unknown> {
    return this.request('POST', `/api/runs/${encodeURIComponent(runId)}/submit`, { log }, SUBMIT_TIMEOUT_MS);
  }

  public me(): Promise<PayoutStatus> {
    return this.request<PayoutStatus>('GET', '/api/me');
  }
}
