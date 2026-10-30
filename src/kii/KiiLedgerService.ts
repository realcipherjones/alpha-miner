/**
 * KiiLedgerService.ts
 *
 * Implements the KII cryptocurrency off-chain dual-ledger state based on the
 * KII White Paper (Murderface Records / @Cipher Jones, Oct 18, 2026).
 *
 * Specifications:
 * - 1 KII = 10^17 raw units (1 raw = 10^-17 KII)
 * - Total Genesis Ceiling: 616 quintillion KII = 616_000_000_000_000_000_000 KII
 * - Raw Genesis Amount: 6.16 * 10^37 raw (fits cleanly within Nano's 128-bit unsigned integer ceiling)
 * - Bad-First Spending Rule: Spending / lob fees deduct from quarantined balance FIRST before clean balance
 * - Deterministic RunActionEvent log for anti-cheat verification and Operational Payout Wallet withdrawal proofs
 * - Persists to localStorage ('dwarf_kii_ledger_v1') and syncs legacy 'dwarfOreToss_totalCoins'
 *
 * Standard TypeScript compatible with Node v24 --experimental-strip-types (no enums or constructor parameter properties).
 */

export const RAW_PER_KII: bigint = 100_000_000_000_000_000n; // 10^17
export const GENESIS_CEILING_KII: bigint = 616_000_000_000_000_000_000n; // 616 quintillion
export const GENESIS_CEILING_RAW: bigint = GENESIS_CEILING_KII * RAW_PER_KII; // 6.16 * 10^37 raw

export const STORAGE_KEY_V1 = 'dwarf_kii_ledger_v1';
export const LEGACY_STORAGE_KEY = 'dwarfOreToss_totalCoins';

export type GameMode = 'MANUAL_FAUCET' | 'SIDE_SCROLLER';
export type ActionType = 'LOB' | 'JUMP' | 'HIT_DIRECT' | 'HIT_INDIRECT' | 'FREE_LOB' | 'CASH_OUT' | 'BOSS_HIT';

export interface RunActionEvent {
  id: string;
  sequenceNumber: number;
  timestamp: number;
  mode: GameMode;
  mapId: number;
  actionType: ActionType;
  angle?: number;
  power?: number;
  x?: number;
  y?: number;
  deltaKiiRaw: string; // stringified bigint
  deltaKiiCoins: number;
  balanceCleanRawAfter: string;
  balanceQuarantinedRawAfter: string;
  note?: string;
}

export interface KiiLedgerConfig {
  /**
   * Future-ready roadmap hook: When true, enables in-game store to cash out KII
   * to player-owned self-custodied blockchain wallets.
   * Clearly disabled for now per user roadmap.
   */
  cashOutStoreEnabled: boolean;

  /**
   * Level interval for escalating lob fees (+1 KII at every multiple of N).
   * Default: 50 (Level 50 = 2 KII, Level 100 = 3 KII, ...).
   */
  escalatingFeeEveryNLevels: number;

  /**
   * When true, lob fees escalate by +1 KII every escalatingFeeEveryNLevels levels.
   */
  enableEscalatingFees: boolean;

  /**
   * Level at which pay-to-play lob fees begin. Default: Level 5.
   */
  payToPlayStartLevel: number;

  /**
   * Base fee per lob in Level 5+ pay-to-play mode. Default: 1 KII.
   */
  baseLobFeeKii: bigint;

  /**
   * Maximum action events stored in memory & localStorage.
   */
  maxEventLogLength: number;
}

export const DEFAULT_CONFIG: Readonly<KiiLedgerConfig> = {
  cashOutStoreEnabled: false,
  escalatingFeeEveryNLevels: 50,
  enableEscalatingFees: true,
  payToPlayStartLevel: 5,
  baseLobFeeKii: 1n,
  maxEventLogLength: 2000
};

export interface SerializedLedgerState {
  version: number;
  cleanKiiRaw: string;
  quarantinedKiiRaw: string;
  totalEarnedRaw: string;
  totalSpentRaw: string;
  totalThrows: number;
  totalDirectHits: number;
  totalIndirectHits: number;
  freeLobsAwarded: number;
  freeLobsUsed: number;
  totalCashedOutRaw?: string;
  cashOutCount?: number;
  actionEvents: RunActionEvent[];
  config: KiiLedgerConfig;
  lastUpdated: number;
}

export interface KiiLedgerSnapshot {
  cleanKiiRaw: bigint;
  quarantinedKiiRaw: bigint;
  totalKiiRaw: bigint;
  cleanKiiCoins: number;
  quarantinedKiiCoins: number;
  totalKiiCoins: number;
  totalThrows: number;
  totalDirectHits: number;
  totalIndirectHits: number;
  freeLobsAwarded: number;
  freeLobsUsed: number;
  /** Lifetime KII cashed out. Burned until the KII network/shop is live. */
  totalCashedOutRaw: bigint;
  cashOutCount: number;
}

export type LedgerChangeListener = (snapshot: KiiLedgerSnapshot) => void;

export class KiiLedgerService {
  private cleanKiiRaw: bigint = 0n;
  private quarantinedKiiRaw: bigint = 0n;
  private totalEarnedRaw: bigint = 0n;
  private totalSpentRaw: bigint = 0n;

  private totalThrowsCount: number = 0;
  private totalDirectHitsCount: number = 0;
  private totalIndirectHitsCount: number = 0;
  private freeLobsAwardedCount: number = 0;
  private freeLobsUsedCount: number = 0;
  private totalCashedOutRaw: bigint = 0n;
  private cashOutCount: number = 0;

  private actionEvents: RunActionEvent[] = [];
  private eventSequence: number = 0;

  private config: KiiLedgerConfig = { ...DEFAULT_CONFIG };
  private listeners: LedgerChangeListener[] = [];

  constructor(customConfig?: Partial<KiiLedgerConfig>) {
    if (customConfig) {
      this.config = { ...DEFAULT_CONFIG, ...customConfig };
    }
    this.loadState();
  }

  // =========================================================================
  // 1. Persistence & Legacy Synchronization
  // =========================================================================

  private isLocalStorageAvailable(): boolean {
    if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
      return false;
    }
    try {
      const testKey = '__kii_test__';
      localStorage.setItem(testKey, '1');
      localStorage.removeItem(testKey);
      return true;
    } catch {
      return false;
    }
  }

  private loadState(): void {
    if (!this.isLocalStorageAvailable()) return;

    try {
      const savedJson = localStorage.getItem(STORAGE_KEY_V1);
      if (savedJson) {
        const parsed: SerializedLedgerState = JSON.parse(savedJson);
        this.cleanKiiRaw = BigInt(parsed.cleanKiiRaw || '0');
        this.quarantinedKiiRaw = BigInt(parsed.quarantinedKiiRaw || '0');
        this.totalEarnedRaw = BigInt(parsed.totalEarnedRaw || '0');
        this.totalSpentRaw = BigInt(parsed.totalSpentRaw || '0');
        this.totalThrowsCount = parsed.totalThrows || 0;
        this.totalDirectHitsCount = parsed.totalDirectHits || 0;
        this.totalIndirectHitsCount = parsed.totalIndirectHits || 0;
        this.freeLobsAwardedCount = parsed.freeLobsAwarded || 0;
        this.freeLobsUsedCount = parsed.freeLobsUsed || 0;
        this.totalCashedOutRaw = BigInt(parsed.totalCashedOutRaw || '0');
        this.cashOutCount = parsed.cashOutCount || 0;
        this.actionEvents = Array.isArray(parsed.actionEvents) ? parsed.actionEvents : [];
        this.eventSequence = this.actionEvents.length;

        if (parsed.config) {
          this.config = { ...this.config, ...parsed.config };
        }
        return;
      }

      // Check legacy dwarfOreToss_totalCoins for seamless progress migration
      const legacyCoinsStr = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (legacyCoinsStr) {
        const legacyCoins = parseInt(legacyCoinsStr, 10);
        if (!isNaN(legacyCoins) && legacyCoins > 0) {
          this.cleanKiiRaw = BigInt(legacyCoins) * RAW_PER_KII;
          this.totalEarnedRaw = this.cleanKiiRaw;
          this.saveState();
        }
      }
    } catch {
      // In case of corrupt localStorage, fall back to fresh ledger
      this.cleanKiiRaw = 0n;
      this.quarantinedKiiRaw = 0n;
    }
  }

  public saveState(): void {
    if (!this.isLocalStorageAvailable()) return;

    try {
      const serialized: SerializedLedgerState = {
        version: 1,
        cleanKiiRaw: this.cleanKiiRaw.toString(),
        quarantinedKiiRaw: this.quarantinedKiiRaw.toString(),
        totalEarnedRaw: this.totalEarnedRaw.toString(),
        totalSpentRaw: this.totalSpentRaw.toString(),
        totalThrows: this.totalThrowsCount,
        totalDirectHits: this.totalDirectHitsCount,
        totalIndirectHits: this.totalIndirectHitsCount,
        freeLobsAwarded: this.freeLobsAwardedCount,
        freeLobsUsed: this.freeLobsUsedCount,
        totalCashedOutRaw: this.totalCashedOutRaw.toString(),
        cashOutCount: this.cashOutCount,
        actionEvents: this.actionEvents.slice(-this.config.maxEventLogLength),
        config: this.config,
        lastUpdated: Date.now()
      };

      localStorage.setItem(STORAGE_KEY_V1, JSON.stringify(serialized));

      // Mirror total human-readable coins back to legacy key for compatibility
      const totalCoins = this.getTotalKiiCoins();
      localStorage.setItem(LEGACY_STORAGE_KEY, totalCoins.toString());
    } catch {}

    this.notifyListeners();
  }

  // =========================================================================
  // 2. Unit Conversions & Balances
  // =========================================================================

  public static rawToKiiNumber(raw: bigint): number {
    return Number(raw / RAW_PER_KII);
  }

  public static kiiNumberToRaw(coins: number | bigint): bigint {
    return BigInt(coins) * RAW_PER_KII;
  }

  public static formatKiiBalance(raw: bigint, decimals: number = 2): string {
    const whole = raw / RAW_PER_KII;
    const remainder = raw % RAW_PER_KII;
    if (remainder === 0n || decimals === 0) {
      return whole.toString();
    }
    const remStr = remainder.toString().padStart(17, '0');
    const frac = remStr.slice(0, decimals).replace(/0+$/, '');
    return frac.length > 0 ? `${whole}.${frac}` : whole.toString();
  }

  public getCleanKiiRaw(): bigint {
    return this.cleanKiiRaw;
  }

  public getQuarantinedKiiRaw(): bigint {
    return this.quarantinedKiiRaw;
  }

  public getTotalKiiRaw(): bigint {
    return this.cleanKiiRaw + this.quarantinedKiiRaw;
  }

  public getCleanKiiCoins(): number {
    return Number(this.cleanKiiRaw / RAW_PER_KII);
  }

  public getQuarantinedKiiCoins(): number {
    return Number(this.quarantinedKiiRaw / RAW_PER_KII);
  }

  public getTotalKiiCoins(): number {
    return Number((this.cleanKiiRaw + this.quarantinedKiiRaw) / RAW_PER_KII);
  }

  public getSnapshot(): KiiLedgerSnapshot {
    const cleanRaw = this.cleanKiiRaw;
    const quarantinedRaw = this.quarantinedKiiRaw;
    const totalRaw = cleanRaw + quarantinedRaw;

    return {
      cleanKiiRaw: cleanRaw,
      quarantinedKiiRaw: quarantinedRaw,
      totalKiiRaw: totalRaw,
      cleanKiiCoins: Number(cleanRaw / RAW_PER_KII),
      quarantinedKiiCoins: Number(quarantinedRaw / RAW_PER_KII),
      totalKiiCoins: Number(totalRaw / RAW_PER_KII),
      totalThrows: this.totalThrowsCount,
      totalDirectHits: this.totalDirectHitsCount,
      totalIndirectHits: this.totalIndirectHitsCount,
      freeLobsAwarded: this.freeLobsAwardedCount,
      freeLobsUsed: this.freeLobsUsedCount,
      totalCashedOutRaw: this.totalCashedOutRaw,
      cashOutCount: this.cashOutCount
    };
  }

  // =========================================================================
  // 3. Bad-First Spending Rule & Lob Fee Calculations
  // =========================================================================

  /**
   * Calculates the lob fee for a given level.
   * If level < 5: free (0n).
   * If enableEscalatingFees is false: returns base fee (1 KII = 10^17 raw).
   * If enableEscalatingFees is true: +1 KII at every multiple of escalatingFeeEveryNLevels
   * (default 50: levels 5-49 = 1 KII, 50-99 = 2 KII, 100-149 = 3 KII, ...).
   */
  public calculateLobFeeForLevel(level: number): bigint {
    if (level < this.config.payToPlayStartLevel) {
      return 0n;
    }

    if (!this.config.enableEscalatingFees) {
      return this.config.baseLobFeeKii * RAW_PER_KII;
    }

    const tier = Math.floor(level / this.config.escalatingFeeEveryNLevels);
    const escalatedKii = this.config.baseLobFeeKii + BigInt(tier);
    return escalatedKii * RAW_PER_KII;
  }

  public canAffordLob(level: number): boolean {
    const feeRaw = this.calculateLobFeeForLevel(level);
    if (feeRaw === 0n) return true;
    return this.getTotalKiiRaw() >= feeRaw;
  }

  /**
   * Implements the KII White Paper Bad-First spending rule:
   * Fees deduct from quarantined balance FIRST before clean balance.
   */
  public spendKiiRaw(amountRaw: bigint, note: string = 'SPEND'): boolean {
    if (amountRaw <= 0n) return true;
    const totalAvail = this.getTotalKiiRaw();
    if (totalAvail < amountRaw) {
      return false; // Insufficient balance
    }

    // Bad-First deduction
    if (this.quarantinedKiiRaw >= amountRaw) {
      this.quarantinedKiiRaw -= amountRaw;
    } else {
      const remainingNeeded = amountRaw - this.quarantinedKiiRaw;
      this.quarantinedKiiRaw = 0n;
      this.cleanKiiRaw -= remainingNeeded;
    }

    this.totalSpentRaw += amountRaw;
    this.saveState();
    return true;
  }

  /**
   * Deducts the lob fee for a throw on a specific level and records the event.
   */
  public spendLobFee(
    level: number,
    details?: { angle?: number; power?: number; x?: number; y?: number; mode?: GameMode }
  ): boolean {
    const feeRaw = this.calculateLobFeeForLevel(level);
    this.totalThrowsCount += 1;

    if (feeRaw > 0n) {
      const success = this.spendKiiRaw(feeRaw, `LOB_FEE_LVL_${level}`);
      if (!success) {
        return false;
      }
    }

    this.recordAction({
      mode: details?.mode || 'MANUAL_FAUCET',
      mapId: level,
      actionType: 'LOB',
      angle: details?.angle,
      power: details?.power,
      x: details?.x,
      y: details?.y,
      deltaKiiRaw: (-feeRaw).toString(),
      deltaKiiCoins: -Number(feeRaw / RAW_PER_KII),
      note: feeRaw > 0n ? `Level ${level} Lob Fee (-${Number(feeRaw / RAW_PER_KII)} KII)` : `Level ${level} Free Lob`
    });

    return true;
  }

  // =========================================================================
  // 4. Crediting & In-Game Earnings
  // =========================================================================

  public creditKiiCoins(
    coins: number | bigint,
    isQuarantined: boolean = false,
    note: string = 'EARNED_COINS'
  ): void {
    const raw = BigInt(coins) * RAW_PER_KII;
    this.creditKiiRaw(raw, isQuarantined, note);
  }

  public creditKiiRaw(
    amountRaw: bigint,
    isQuarantined: boolean = false,
    note: string = 'EARNED_RAW'
  ): void {
    if (amountRaw <= 0n) return;

    if (isQuarantined) {
      this.quarantinedKiiRaw += amountRaw;
    } else {
      this.cleanKiiRaw += amountRaw;
    }

    this.totalEarnedRaw += amountRaw;
    this.saveState();
  }

  /**
   * Records a direct (+1 KII) or indirect (+2 KII) ore node strike.
   */
  public recordHit(
    isIndirect: boolean,
    level: number,
    details?: { x?: number; y?: number; mode?: GameMode }
  ): void {
    const coins = isIndirect ? 2 : 1;
    const raw = BigInt(coins) * RAW_PER_KII;

    if (isIndirect) {
      this.totalIndirectHitsCount += 1;
    } else {
      this.totalDirectHitsCount += 1;
    }

    // In gameplay faucet, rewards are credited directly
    this.creditKiiRaw(raw, false, isIndirect ? 'HIT_INDIRECT' : 'HIT_DIRECT');

    this.recordAction({
      mode: details?.mode || 'MANUAL_FAUCET',
      mapId: level,
      actionType: isIndirect ? 'HIT_INDIRECT' : 'HIT_DIRECT',
      x: details?.x,
      y: details?.y,
      deltaKiiRaw: raw.toString(),
      deltaKiiCoins: coins,
      note: isIndirect ? 'Indirect Crush/Ricochet Strike (+2 KII)' : 'Direct Pickaxe Strike (+1 KII)'
    });
  }

  public recordFreeLobAwarded(
    level: number,
    details?: { x?: number; y?: number; mode?: GameMode; count?: number; note?: string }
  ): void {
    const count = details?.count ?? 1;
    this.freeLobsAwardedCount += count;
    this.recordAction({
      mode: details?.mode || 'MANUAL_FAUCET',
      mapId: level,
      actionType: 'FREE_LOB',
      x: details?.x,
      y: details?.y,
      deltaKiiRaw: '0',
      deltaKiiCoins: 0,
      note: details?.note || 'Rebound Over Dwarf: Free Next Lob Awarded!'
    });
  }

  /**
   * A boss collideable struck the dwarf: knock 1 KII out of the bank (Bad-First, like any spend).
   * Returns false when there was nothing left to knock out.
   */
  public knockOutCoin(level: number, details?: { x?: number; y?: number; mode?: GameMode; boss?: string }): boolean {
    const knocked = this.spendKiiRaw(RAW_PER_KII, `BOSS_HIT_LVL_${level}`);
    this.recordAction({
      mode: details?.mode || 'MANUAL_FAUCET',
      mapId: level,
      actionType: 'BOSS_HIT',
      x: details?.x,
      y: details?.y,
      deltaKiiRaw: knocked ? (-RAW_PER_KII).toString() : '0',
      deltaKiiCoins: knocked ? -1 : 0,
      note: `${details?.boss || 'Boss'} hit the dwarf${knocked ? ': 1 KII knocked out' : ' (bank empty)'}`
    });
    if (knocked) this.saveState();
    return knocked;
  }

  /**
   * Cash-out stand-in until the KII network is live: there is no shop or payout
   * wallet yet, so the player's entire balance (quarantined + clean) is burned.
   * Returns the raw amount burned.
   */
  public burnAllForCashOut(level: number, mode: GameMode = 'MANUAL_FAUCET'): bigint {
    const burnedRaw = this.getTotalKiiRaw();
    if (burnedRaw <= 0n) return 0n;
    this.spendKiiRaw(burnedRaw, `CASH_OUT_BURN_LVL_${level}`);
    this.totalCashedOutRaw += burnedRaw;
    this.cashOutCount += 1;
    this.recordAction({
      mode,
      mapId: level,
      actionType: 'CASH_OUT',
      deltaKiiRaw: (-burnedRaw).toString(),
      deltaKiiCoins: -Number(burnedRaw / RAW_PER_KII),
      note: `Level ${level} Cash-Out: burned ${KiiLedgerService.formatKiiBalance(burnedRaw, 2)} KII (no shop yet)`
    });
    this.saveState();
    return burnedRaw;
  }

  public recordFreeLobUsed(): void {
    this.freeLobsUsedCount += 1;
  }

  public recordJump(
    level: number,
    details?: { x?: number; y?: number; isSpaceHalfGrav?: boolean; mode?: GameMode }
  ): void {
    this.recordAction({
      mode: details?.mode || 'SIDE_SCROLLER',
      mapId: level,
      actionType: 'JUMP',
      x: details?.x,
      y: details?.y,
      deltaKiiRaw: '0',
      deltaKiiCoins: 0,
      note: details?.isSpaceHalfGrav ? 'Space Half-Gravity Jump' : 'Standard Jump'
    });
  }

  // =========================================================================
  // 5. Fraud Quarantine & White Paper Governance
  // =========================================================================

  public quarantineCleanBalance(amountRaw: bigint): void {
    if (amountRaw <= 0n) return;
    const toQuarantine = amountRaw > this.cleanKiiRaw ? this.cleanKiiRaw : amountRaw;
    this.cleanKiiRaw -= toQuarantine;
    this.quarantinedKiiRaw += toQuarantine;
    this.saveState();
  }

  public unquarantineBalance(amountRaw: bigint): void {
    if (amountRaw <= 0n) return;
    const toRelease = amountRaw > this.quarantinedKiiRaw ? this.quarantinedKiiRaw : amountRaw;
    this.quarantinedKiiRaw -= toRelease;
    this.cleanKiiRaw += toRelease;
    this.saveState();
  }

  // =========================================================================
  // 6. Deterministic Action Logging & Audit Verification
  // =========================================================================

  public recordAction(
    event: Omit<RunActionEvent, 'id' | 'sequenceNumber' | 'timestamp' | 'balanceCleanRawAfter' | 'balanceQuarantinedRawAfter'>
  ): RunActionEvent {
    this.eventSequence += 1;
    const fullEvent: RunActionEvent = {
      id: `act_${Date.now()}_${this.eventSequence}`,
      sequenceNumber: this.eventSequence,
      timestamp: Date.now(),
      mode: event.mode,
      mapId: event.mapId,
      actionType: event.actionType,
      angle: event.angle,
      power: event.power,
      x: event.x,
      y: event.y,
      deltaKiiRaw: event.deltaKiiRaw,
      deltaKiiCoins: event.deltaKiiCoins,
      balanceCleanRawAfter: this.cleanKiiRaw.toString(),
      balanceQuarantinedRawAfter: this.quarantinedKiiRaw.toString(),
      note: event.note
    };

    this.actionEvents.push(fullEvent);
    if (this.actionEvents.length > this.config.maxEventLogLength) {
      this.actionEvents.shift();
    }

    return fullEvent;
  }

  public getActionHistory(): ReadonlyArray<RunActionEvent> {
    return this.actionEvents;
  }

  public clearActionHistory(): void {
    this.actionEvents = [];
    this.saveState();
  }

  /**
   * Generates a verifiable audit proof for future Operational Payout Wallet settlement.
   */
  public generateAuditProof(): {
    timestamp: number;
    totalEarnedRaw: string;
    totalSpentRaw: string;
    cleanKiiRaw: string;
    quarantinedKiiRaw: string;
    totalThrows: number;
    directHits: number;
    indirectHits: number;
    actionCount: number;
    checksum: string;
  } {
    let hashAccumulator = 0;
    for (const evt of this.actionEvents) {
      hashAccumulator = (hashAccumulator * 31 + evt.actionType.charCodeAt(0) + (evt.x || 0) + (evt.y || 0)) | 0;
    }

    return {
      timestamp: Date.now(),
      totalEarnedRaw: this.totalEarnedRaw.toString(),
      totalSpentRaw: this.totalSpentRaw.toString(),
      cleanKiiRaw: this.cleanKiiRaw.toString(),
      quarantinedKiiRaw: this.quarantinedKiiRaw.toString(),
      totalThrows: this.totalThrowsCount,
      directHits: this.totalDirectHitsCount,
      indirectHits: this.totalIndirectHitsCount,
      actionCount: this.actionEvents.length,
      checksum: (hashAccumulator >>> 0).toString(16)
    };
  }

  // =========================================================================
  // 7. Config & Event Subscriptions
  // =========================================================================

  public getConfig(): Readonly<KiiLedgerConfig> {
    return this.config;
  }

  public updateConfig(newConfig: Partial<KiiLedgerConfig>): void {
    this.config = { ...this.config, ...newConfig };
    this.saveState();
  }

  public subscribe(listener: LedgerChangeListener): () => void {
    this.listeners.push(listener);
    try {
      listener(this.getSnapshot());
    } catch {}

    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  private notifyListeners(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {}
    }
  }

  public resetLedger(preserveLegacyCoins: boolean = false): void {
    let legacyRaw = 0n;
    if (preserveLegacyCoins && this.isLocalStorageAvailable()) {
      const legacyCoinsStr = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (legacyCoinsStr) {
        const legacyCoins = parseInt(legacyCoinsStr, 10);
        if (!isNaN(legacyCoins)) {
          legacyRaw = BigInt(legacyCoins) * RAW_PER_KII;
        }
      }
    }

    this.cleanKiiRaw = legacyRaw;
    this.quarantinedKiiRaw = 0n;
    this.totalEarnedRaw = legacyRaw;
    this.totalSpentRaw = 0n;
    this.totalThrowsCount = 0;
    this.totalDirectHitsCount = 0;
    this.totalIndirectHitsCount = 0;
    this.freeLobsAwardedCount = 0;
    this.freeLobsUsedCount = 0;
    this.totalCashedOutRaw = 0n;
    this.cashOutCount = 0;
    this.actionEvents = [];
    this.eventSequence = 0;
    this.saveState();
  }
}
