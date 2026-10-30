/**
 * main.ts
 *
 * Application entry point for Alpha Miner (Manual Faucet).
 * Wires together SoundEngine, KiiLedgerService, GraphicsFactory, LevelData,
 * and ExcaliburGameController with the responsive HTML HUD controls:
 * - Manual Faucet (Arena) mode only; SIDE_SCROLLER is kept internally (e.g. boss fights) but not player-selectable
 * - 10 Map Selector Pills with Space astronaut badges and Half-Gravity indicators
 * - KII Ledger Dual-Ledger HUD (Clean, Quarantined, Raw 10^17 units, Mainnet Cash-Out Store)
 * - Murderface Records "Coelestis" Jukebox Bar (Cipher Jones OST)
 * - Bottom Control Deck (Sliders, presets, footwork, and mobile touch platformer buttons)
 *
 * Compatible with Node v24 `--experimental-strip-types`.
 */

import { SoundEngine } from './audio/SoundEngine.ts';
import { KiiLedgerService, KiiLedgerSnapshot } from './kii/KiiLedgerService.ts';
import { ExcaliburGameController, GameModeType } from './scenes/ExcaliburGameController.ts';
import { getAllMaps, getMapById, isSpaceMap, MapDefinition } from './scenes/LevelData.ts';
import { GamepadInput } from './input/GamepadInput.ts';
import { BOSS_OVERKILL_SON } from './scenes/BossFight.ts';

// ---------------------------------------------------------------------------
// Bootstrap Function
// ---------------------------------------------------------------------------

function initApp(): void {
  // 1. Initialize Audio Engine & KII Dual-Ledger
  const soundEngine = new SoundEngine({
    musicBasePath: '../Coelestis/ogg',
    initialMusicVolume: 0.7,
    initialSfxVolume: 1.0
  });

  const kiiLedger = new KiiLedgerService();

  // 2. Initialize Excalibur Game Controller
  let controller: ExcaliburGameController;
  try {
    controller = new ExcaliburGameController({
      canvasId: 'gameCanvas',
      soundEngine,
      kiiLedger
    });
  } catch (err) {
    console.error('Failed to initialize ExcaliburGameController:', err);
    return;
  }

  // -------------------------------------------------------------------------
  // DOM Elements
  // -------------------------------------------------------------------------

  // Control decks (swapped when the controller changes mode internally)
  const platformerControlsDeck = document.getElementById('platformerControlsDeck');
  const tosserControlsDeck = document.getElementById('tosserControlsDeck');

  // Map Navigation & Header
  const mapSubtitle = document.getElementById('mapSubtitle');
  const gravityBadge = document.getElementById('gravityBadge');

  // Score & KII Ledger HUD
  const scoreValue = document.getElementById('scoreValue');
  const levelGoalLabel = document.getElementById('levelGoalLabel');
  const coinPips = document.getElementById('coinPips');
  const totalKiiValue = document.getElementById('totalKiiValue');
  const cleanKiiValue = document.getElementById('cleanKiiValue');
  const quarantinedKiiValue = document.getElementById('quarantinedKiiValue');
  const rawKiiTooltip = document.getElementById('rawKiiTooltip');
  const payModeBadge = document.getElementById('payModeBadge');
  const walletPill = document.getElementById('walletPill');
  const btnCashOutStore = document.getElementById('btnCashOutStore') as HTMLButtonElement | null;
  const cashedOutValue = document.getElementById('cashedOutValue');

  // Jukebox Controls
  const jukeboxNowIcon = document.getElementById('jukeboxNowIcon');
  const jukeboxTrackNo = document.getElementById('jukeboxTrackNo');
  const jukeboxTrackTitle = document.getElementById('jukeboxTrackTitle');
  const jukeboxTrackMeta = document.getElementById('jukeboxTrackMeta');
  const jukeboxTime = document.getElementById('jukeboxTime');
  const sliderMusicVolume = document.getElementById('sliderMusicVolume') as HTMLInputElement | null;
  const sliderSfxVolume = document.getElementById('sliderSfxVolume') as HTMLInputElement | null;
  const musicVolumeReadout = document.getElementById('musicVolumeReadout');
  const sfxVolumeReadout = document.getElementById('sfxVolumeReadout');

  // Sliders & Controls
  const sliderAngle = document.getElementById('sliderAngle') as HTMLInputElement | null;
  const sliderPower = document.getElementById('sliderPower') as HTMLInputElement | null;
  const angleReadout = document.getElementById('angleReadout');
  const powerReadout = document.getElementById('powerReadout');
  const btnAngleDown = document.getElementById('btnAngleDown');
  const btnAngleUp = document.getElementById('btnAngleUp');
  const btnPowerDown = document.getElementById('btnPowerDown');
  const btnPowerUp = document.getElementById('btnPowerUp');
  const btnMoveLeft = document.getElementById('btnMoveLeft');
  const btnMoveRight = document.getElementById('btnMoveRight');
  const dwarfPosReadout = document.getElementById('dwarfPosReadout');
  const btnPresetHigh = document.getElementById('btnPresetHigh');
  const btnPresetDirect = document.getElementById('btnPresetDirect');
  const btnLobPickaxe = document.getElementById('btnLobPickaxe');
  const btnAimGuide = document.getElementById('btnAimGuide');
  const btnReset = document.getElementById('btnReset');
  const btnPlaytestSkip = document.getElementById('btnPlaytestSkip');

  // Platformer Mobile/Touch Buttons
  const btnPlatLeft = document.getElementById('btnPlatLeft');
  const btnPlatRight = document.getElementById('btnPlatRight');
  const btnPlatJump = document.getElementById('btnPlatJump');
  const btnPlatLob = document.getElementById('btnPlatLob');

  // Victory Modal
  const victoryModal = document.getElementById('victoryModal');
  const victoryBadge = document.getElementById('victoryBadge');
  const victoryTitle = document.getElementById('victoryTitle');
  const victorySummaryText = document.getElementById('victorySummaryText');
  const statThrows = document.getElementById('statThrows');
  const statDirectHits = document.getElementById('statDirectHits');
  const statCrushHits = document.getElementById('statCrushHits');
  const btnPlayAgain = document.getElementById('btnPlayAgain');
  const cashOutModal = document.getElementById('cashOutModal');
  const cashOutBadge = document.getElementById('cashOutBadge');
  const cashOutText = document.getElementById('cashOutText');
  const btnCashOutAccept = document.getElementById('btnCashOutAccept');
  const btnCashOutDecline = document.getElementById('btnCashOutDecline');
  const btnNextMap = document.getElementById('btnNextMap');

  // -------------------------------------------------------------------------
  // 3. UI Synchronization Functions
  // -------------------------------------------------------------------------

  function updateModeButtons(mode: GameModeType): void {
    if (mode === 'MANUAL_FAUCET') {
      if (tosserControlsDeck) tosserControlsDeck.classList.remove('hidden');
      if (platformerControlsDeck) platformerControlsDeck.classList.add('hidden');
    } else {
      if (platformerControlsDeck) platformerControlsDeck.classList.remove('hidden');
      if (tosserControlsDeck) tosserControlsDeck.classList.add('hidden');
    }
  }

  function freeLobLabel(): string {
    return controller.freeLobs > 1 ? `${controller.freeLobs} FREE LOBS!` : 'NEXT LOB FREE!';
  }

  function updateLedgerPill(snapshot: KiiLedgerSnapshot): void {
    if (cashedOutValue) {
      cashedOutValue.textContent = KiiLedgerService.formatKiiBalance(snapshot.totalCashedOutRaw, 2);
    }
    if (btnCashOutStore) {
      btnCashOutStore.title =
        `${snapshot.cashOutCount} cash-out${snapshot.cashOutCount === 1 ? '' : 's'} · ` +
        'burned until the KII network is live (no shop yet)';
    }
    if (totalKiiValue) {
      totalKiiValue.textContent = KiiLedgerService.formatKiiBalance(snapshot.totalKiiRaw, 2);
    }
    if (cleanKiiValue) {
      cleanKiiValue.textContent = KiiLedgerService.formatKiiBalance(snapshot.cleanKiiRaw, 2);
    }
    if (quarantinedKiiValue) {
      quarantinedKiiValue.textContent = KiiLedgerService.formatKiiBalance(snapshot.quarantinedKiiRaw, 2);
    }
    if (rawKiiTooltip) {
      rawKiiTooltip.textContent = `${snapshot.totalKiiRaw.toString()} raw units (10^-17)`;
    }

    if (payModeBadge) {
      if (controller.bossLobsFree()) {
        payModeBadge.textContent = '(free lobs · boss fight)';
        payModeBadge.className = 'text-[10px] font-extrabold text-emerald-400';
      } else if (controller.isPayToPlay()) {
        payModeBadge.textContent = controller.freeNextLob ? freeLobLabel() : `(-${controller.getLobFeeKii()} KII/lob)`;
        payModeBadge.className = controller.freeNextLob
          ? 'text-[10px] font-extrabold text-emerald-400'
          : 'text-[10px] font-extrabold text-rose-400';
      } else {
        payModeBadge.textContent = controller.freeNextLob ? freeLobLabel() : 'earned';
        payModeBadge.className = controller.freeNextLob
          ? 'text-[10px] font-extrabold text-emerald-400'
          : 'text-[10px] font-bold text-slate-400';
      }
    }

    if (walletPill) {
      if (controller.isPayToPlay()) {
        walletPill.className =
          'flex items-center gap-2 bg-rose-950/80 border border-rose-500/60 rounded-2xl px-3 py-1 shadow-inner';
      } else {
        walletPill.className =
          'flex items-center gap-2 bg-slate-950/90 border border-emerald-500/40 rounded-2xl px-3 py-1 shadow-inner';
      }
    }
  }

  function updateScoreDisplay(score: number, target: number): void {
    if (scoreValue) scoreValue.textContent = String(score);
    if (levelGoalLabel) {
      levelGoalLabel.textContent = `Stage ${controller.stage} Goal: ${target}+ KII`;
    }

    if (coinPips) {
      // Fixed row: `target` star pips plus an always-reserved overkill badge, so the HUD never shifts.
      coinPips.innerHTML = '';
      coinPips.style.alignItems = 'center';
      for (let i = 0; i < target; i++) {
        const filled = i < score;
        const dot = document.createElement('span');
        dot.style.cssText =
          'width:14px;height:14px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;' +
          'font-size:9px;font-weight:900;line-height:1;flex:none;' +
          (filled
            ? 'background:#fbbf24;border:1px solid #fde68a;color:#0f172a;box-shadow:0 0 4px rgba(251,191,36,0.5);'
            : 'background:#1e293b;border:1px solid #334155;color:transparent;');
        dot.textContent = '★';
        coinPips.appendChild(dot);
      }

      const overkill = Math.max(0, score - target);
      const tierColors = ['#38bdf8', '#34d399', '#a78bfa', '#f472b6', '#fb923c', '#f87171'];
      // The badge goes purple as soon as the son boss is earned (+15), not at the +20 tier
      const tier = overkill >= BOSS_OVERKILL_SON && overkill < 20 ? 2 : Math.floor(overkill / 10);
      const color = tierColors[tier % tierColors.length];
      const badge = document.createElement('span');
      badge.style.cssText =
        'min-width:34px;height:16px;padding:0 4px;margin-left:3px;border-radius:999px;display:inline-flex;' +
        'align-items:center;justify-content:center;font-size:10px;font-weight:900;flex:none;' +
        `font-variant-numeric:tabular-nums;color:#0f172a;background:${color};` +
        `visibility:${overkill > 0 ? 'visible' : 'hidden'};`;
      badge.textContent = `+${overkill}`;
      badge.title = 'Overkill: KII scored past the map goal';
      coinPips.appendChild(badge);
    }
  }

  function updateMapInfo(mapDef: MapDefinition): void {
    if (mapSubtitle) {
      // Stage rules, not the map's own blurb: maps arrive in random order
      let rules: string;
      if (!controller.birdsEnabled()) rules = 'No birds. Warm up!';
      else if (!controller.birdsShielded()) rules = 'Birds incoming. Smash them out of the sky!';
      else if (!controller.birdsReversible()) rules = 'Shielded birds. Bounce your axes off them!';
      else if (!controller.birdShieldsBreakable()) rules = 'Shielded birds reverse or change course when struck!';
      else rules = 'First hit breaks a bird\'s shield and turns it; the second hit kills!';
      if (controller.isPayToPlay()) rules += ` Pay-to-play: ${controller.getLobFeeKii()} KII per lob.`;
      const layout = controller.getLayoutName();
      const place = layout ? `${layout} · ${mapDef.name}` : mapDef.name;
      mapSubtitle.textContent = `Stage ${controller.stage} · ${place}. ${rules}`;
    }
    if (gravityBadge) {
      if (controller.mode === 'SIDE_SCROLLER' && mapDef.isSpace) {
        gravityBadge.textContent = '🌕 Space Half-Gravity (490 px/s²)';
        gravityBadge.className =
          'px-2 py-0.5 rounded-full bg-sky-500/20 text-sky-300 border border-sky-400/40 text-[10px] font-bold';
        gravityBadge.style.display = 'inline-block';
      } else {
        gravityBadge.style.display = 'none';
      }
    }
  }

  // -------------------------------------------------------------------------
  // 4. Wire Controller Callbacks
  // -------------------------------------------------------------------------

  controller.callbacks = {
    onScoreUpdate: (score, target, totalCoins, freeLob) => {
      updateScoreDisplay(score, target);
      updateLedgerPill(kiiLedger.getSnapshot());
      if (btnLobPickaxe) {
        if (controller.levelTransitioning) {
          const sec = Math.max(1, Math.ceil(controller.transitionCountdown));
          btnLobPickaxe.innerHTML = `<span class="text-base">⏳</span><span>NEXT MAP IN ${sec}...</span>`;
        } else if (controller.bossLobsFree()) {
          btnLobPickaxe.innerHTML = `<span class="text-base">⚔️</span><span>LOB (FREE · BOSS)</span>`;
        } else if (freeLob) {
          const n = controller.freeLobs;
          btnLobPickaxe.innerHTML = `<span class="text-base">🎁</span><span>${n > 1 ? `FREE LOB (${n} LEFT)` : 'FREE LOB READY!'}</span>`;
        } else if (controller.isPayToPlay()) {
          btnLobPickaxe.innerHTML = `<span class="text-base">⛏️</span><span>LOB (-${controller.getLobFeeKii()} KII)</span>`;
        } else {
          btnLobPickaxe.innerHTML = `<span class="text-base">⛏️</span><span>LOB PICKAXE!</span>`;
        }
      }
    },
    onDwarfStanceUpdate: (label) => {
      if (dwarfPosReadout) dwarfPosReadout.textContent = label;
    },
    onAimUpdate: (angle, power) => {
      if (sliderAngle) sliderAngle.value = String(angle);
      if (sliderPower) sliderPower.value = String(power);
      if (angleReadout) angleReadout.textContent = `${angle}°`;
      if (powerReadout) powerReadout.textContent = `${power}%`;
    },
    onVictoryCountdown: (secLeft, nextStage) => {
      if (btnLobPickaxe) {
        const bossKind = controller.pendingBossKind();
        btnLobPickaxe.innerHTML = bossKind
          ? `<span class="text-base">⚔️</span><span>${bossKind === 'son' ? 'SON' : 'DOG'} BOSS IN ${secLeft}s!</span>`
          : `<span class="text-base">⏳</span><span>NEXT: STAGE ${nextStage} (${secLeft}s)</span>`;
      }
    },
    onBossFight: (boss) => {
      if (!mapSubtitle) return;
      if (boss) {
        const deflect = boss.def.deflectChance > 0 ? ` Whips back ${+(boss.def.deflectChance * 100).toFixed(2)}% of axes. A swatted axe that hits you costs 1 KII.` : '';
        const birds = boss.birds ? ' Birds active.' : ' No birds (first encounter).';
        mapSubtitle.textContent =
          `Stage ${controller.stage} · BOSS: ${boss.def.name}. Land 10 hits! Jump with A / W (lob with X, B, RT).${controller.bossLobsFree() ? ' Lobs are FREE in boss fights through stage 150.' : ` Lobs cost ${controller.getLobFeeKii()} KII.`} Each hit you take knocks out 1 KII.${deflect}${birds}`;
      } else {
        updateMapInfo(getMapById(controller.currentMapId) || getAllMaps()[0]);
      }
    },
    onCashOutOffer: (stage, freeLobs, balanceKii) => {
      if (cashOutBadge) cashOutBadge.textContent = `Stage ${stage}`;
      if (cashOutText) {
        cashOutText.textContent =
          `You will be given ${freeLobs} free lobs. Your ${balanceKii} KII will be cashed out ` +
          `(burned for now — real KII payouts arrive when the network goes live).`;
      }
      if (cashOutModal) cashOutModal.classList.remove('hidden');
    },
    onGameOver: (reason, stats) => {
      if (victoryModal && victoryBadge && victoryTitle && victorySummaryText) {
        victoryBadge.textContent = `Stage ${controller.stage} • Pay-To-Play`;
        victoryTitle.textContent = 'OUT OF COINS! GAME OVER';
        victorySummaryText.textContent = `${reason} Final Stage Score: ${controller.score}/7 KII.`;
        if (statThrows) statThrows.textContent = String(stats.totalThrows);
        if (statDirectHits) statDirectHits.textContent = String(stats.directHits);
        if (statCrushHits) statCrushHits.textContent = String(stats.crushHits);
        victoryModal.classList.remove('hidden');
      }
    },
    onModeChange: (newMode) => {
      updateModeButtons(newMode);
      const mapDef = getMapById(controller.currentMapId) || getAllMaps()[0];
      updateMapInfo(mapDef);
    },
    onMapChange: (mapDef) => {
      updateMapInfo(mapDef);
      if (victoryModal) victoryModal.classList.add('hidden');
    }
  };

  // Subscribe to KII Ledger updates
  kiiLedger.subscribe((snapshot) => {
    updateLedgerPill(snapshot);
  });

  // -------------------------------------------------------------------------
  // 5. Connect UI Event Listeners
  // -------------------------------------------------------------------------

  // Sliders
  if (sliderAngle) {
    sliderAngle.addEventListener('input', () => {
      controller.setAim(parseFloat(sliderAngle.value), controller.aimPowerPct);
    });
  }
  if (sliderPower) {
    sliderPower.addEventListener('input', () => {
      controller.setAim(controller.aimAngleDeg, parseFloat(sliderPower.value));
    });
  }
  if (btnAngleDown) {
    btnAngleDown.addEventListener('click', () => {
      controller.setAim(controller.aimAngleDeg - 2, controller.aimPowerPct);
    });
  }
  if (btnAngleUp) {
    btnAngleUp.addEventListener('click', () => {
      controller.setAim(controller.aimAngleDeg + 2, controller.aimPowerPct);
    });
  }
  if (btnPowerDown) {
    btnPowerDown.addEventListener('click', () => {
      controller.setAim(controller.aimAngleDeg, controller.aimPowerPct - 3);
    });
  }
  if (btnPowerUp) {
    btnPowerUp.addEventListener('click', () => {
      controller.setAim(controller.aimAngleDeg, controller.aimPowerPct + 3);
    });
  }

  // Presets & Stance
  if (btnPresetHigh) {
    btnPresetHigh.addEventListener('click', () => {
      controller.setAimPreset('high');
    });
  }
  if (btnPresetDirect) {
    btnPresetDirect.addEventListener('click', () => {
      controller.setAimPreset('ore');
    });
  }
  if (btnMoveLeft) {
    btnMoveLeft.addEventListener('click', () => {
      controller.stepDwarf(-1);
    });
  }
  if (btnMoveRight) {
    btnMoveRight.addEventListener('click', () => {
      controller.stepDwarf(1);
    });
  }
  if (btnLobPickaxe) {
    btnLobPickaxe.addEventListener('click', () => {
      controller.lobPickaxe();
    });
  }

  // Platformer Mobile/Touch Buttons
  const handleTouch = (btn: HTMLElement | null, start: () => void, end: () => void) => {
    if (!btn) return;
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      soundEngine.unlockAudio();
      start();
    });
    btn.addEventListener('pointerup', (e) => {
      e.preventDefault();
      end();
    });
    btn.addEventListener('pointercancel', (e) => {
      e.preventDefault();
      end();
    });
  };

  handleTouch(
    btnPlatLeft,
    () => controller.platformerRun(-1),
    () => controller.platformerRun(0)
  );
  handleTouch(
    btnPlatRight,
    () => controller.platformerRun(1),
    () => controller.platformerRun(0)
  );
  handleTouch(
    btnPlatJump,
    () => controller.platformerJump(true),
    () => controller.platformerJump(false)
  );
  if (btnPlatLob) {
    btnPlatLob.addEventListener('click', () => {
      controller.lobPickaxe();
    });
  }

  // Aim Guide & Reset
  if (btnAimGuide) {
    btnAimGuide.addEventListener('click', () => {
      controller.showAimGuide = !controller.showAimGuide;
      btnAimGuide.className = controller.showAimGuide
        ? 'px-2.5 py-1.5 rounded-xl bg-amber-500/20 text-amber-300 border border-amber-500/40 text-xs font-semibold'
        : 'px-2.5 py-1.5 rounded-xl bg-slate-800 text-slate-400 border border-slate-700 text-xs font-semibold';
    });
  }
  // PLAYTEST ONLY: jump ahead to late-game milestone stages
  if (btnPlaytestSkip) {
    btnPlaytestSkip.addEventListener('click', () => {
      soundEngine.unlockAudio();
      controller.skipToNextMilestone();
    });
  }

  if (btnReset) {
    btnReset.addEventListener('click', () => {
      controller.resetStage();
    });
  }

  // Cash Out Store (Roadmap Hook)
  if (btnCashOutStore) {
    btnCashOutStore.addEventListener('click', () => {
      const snap = kiiLedger.getSnapshot();
      alert(
        `🔥 Cashed out so far: ${KiiLedgerService.formatKiiBalance(snap.totalCashedOutRaw, 2)} KII ` +
          `across ${snap.cashOutCount} cash-out${snap.cashOutCount === 1 ? '' : 's'}.\n\n` +
          'Cash-outs are offered every 50 stages. Until the KII network is live there is no shop, ' +
          'so cashed-out KII is burned. Every cash-out is logged in your ledger.'
      );
    });
  }

  // Victory Modal Actions
  if (btnCashOutAccept) {
    btnCashOutAccept.addEventListener('click', () => {
      soundEngine.unlockAudio();
      if (cashOutModal) cashOutModal.classList.add('hidden');
      controller.acceptCashOut();
    });
  }
  if (btnCashOutDecline) {
    btnCashOutDecline.addEventListener('click', () => {
      if (cashOutModal) cashOutModal.classList.add('hidden');
      controller.declineCashOut();
    });
  }

  if (btnPlayAgain) {
    btnPlayAgain.addEventListener('click', () => {
      controller.resetStage();
      if (victoryModal) victoryModal.classList.add('hidden');
    });
  }
  if (btnNextMap) {
    btnNextMap.addEventListener('click', () => {
      controller.restartRun();
      if (victoryModal) victoryModal.classList.add('hidden');
    });
  }

  // Gamepad / controller support
  const showGamepadToast = (text: string) => {
    const toast = document.createElement('div');
    toast.textContent = text;
    toast.style.cssText =
      'position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:9999;padding:6px 14px;' +
      'border-radius:999px;background:rgba(15,23,42,0.92);border:1px solid #f59e0b;color:#fde68a;' +
      'font:700 12px system-ui,sans-serif;pointer-events:none;transition:opacity 0.4s;';
    document.body.appendChild(toast);
    setTimeout(() => (toast.style.opacity = '0'), 2200);
    setTimeout(() => toast.remove(), 2700);
  };
  const gamepadInput = new GamepadInput(controller, {
    isModalOpen: () =>
      (!!victoryModal && !victoryModal.classList.contains('hidden')) || controller.cashOutOfferOpen,
    // Cash-out pop-up: A = keep KII (safe default while mashing), Start = cash out
    onModalPlayAgain: () => (controller.cashOutOfferOpen ? btnCashOutDecline?.click() : btnPlayAgain?.click()),
    onModalNewRun: () => (controller.cashOutOfferOpen ? btnCashOutAccept?.click() : btnNextMap?.click()),
    onToggleAimGuide: () => btnAimGuide?.click(),
    onPlaytestSkip: () => {
      soundEngine.unlockAudio();
      controller.skipToNextMilestone();
    },
    onConnectionChange: (connected) => showGamepadToast(connected ? '🎮 Controller connected' : '🎮 Controller disconnected')
  });

  // -------------------------------------------------------------------------
  // 6. Murderface Records "Coelestis" Jukebox Integration
  // -------------------------------------------------------------------------

  const formatTime = (sec: number): string => {
    const s = Math.max(0, Math.floor(sec));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  // Display-only now-playing readout; the album autoplays and loops on its own.
  soundEngine.onTrackChange((title, isPlaying) => {
    const track = soundEngine.getCurrentTrack();
    if (jukeboxTrackNo) jukeboxTrackNo.textContent = String(track.trackNo).padStart(2, '0');
    if (jukeboxTrackTitle) jukeboxTrackTitle.textContent = title;
    if (jukeboxTrackMeta) jukeboxTrackMeta.textContent = `${track.artist} · ${track.album} · ${track.year}`;
    if (jukeboxNowIcon) {
      jukeboxNowIcon.classList.toggle('playing', isPlaying);
    }
    if (jukeboxTime) {
      let text: string;
      if (soundEngine.hasMusicLoadFailed()) {
        text = 'Music files not found';
      } else if (soundEngine.isAwaitingGesture()) {
        text = 'Click or press any key to start music';
      } else {
        const t = soundEngine.getPlaybackTime();
        text = `${formatTime(t.current)} / ${formatTime(t.duration)}`;
      }
      jukeboxTime.textContent = text;
      jukeboxTime.classList.toggle('hint', soundEngine.isAwaitingGesture() || soundEngine.hasMusicLoadFailed());
    }
  });

  // Volume sliders (remembered per browser)
  const VOLUME_STORAGE_KEY = 'dwarfOreToss.volumes';
  let savedVolumes: { music?: number; sfx?: number } = {};
  try {
    savedVolumes = JSON.parse(localStorage.getItem(VOLUME_STORAGE_KEY) || '{}') || {};
  } catch {}
  const saveVolumes = () => {
    try {
      localStorage.setItem(
        VOLUME_STORAGE_KEY,
        JSON.stringify({ music: soundEngine.getMusicVolume(), sfx: soundEngine.getSfxVolume() })
      );
    } catch {}
  };
  const bindVolumeSlider = (
    slider: HTMLInputElement | null,
    readout: HTMLElement | null,
    initial: number,
    apply: (v: number) => void
  ) => {
    const pct = Math.round(Math.max(0, Math.min(1, initial)) * 100);
    apply(pct / 100);
    if (slider) slider.value = String(pct);
    if (readout) readout.textContent = String(pct);
    if (!slider) return;
    slider.addEventListener('input', () => {
      const v = Number(slider.value);
      apply(v / 100);
      if (readout) readout.textContent = String(v);
      saveVolumes();
    });
  };
  bindVolumeSlider(sliderMusicVolume, musicVolumeReadout, savedVolumes.music ?? 0.7, (v) => soundEngine.setMusicVolume(v));
  bindVolumeSlider(sliderSfxVolume, sfxVolumeReadout, savedVolumes.sfx ?? 1.0, (v) => soundEngine.setSfxVolume(v));

  // Try to autoplay right away; if the browser blocks it, the first click/keypress starts it.
  soundEngine.startPlaylist().catch(() => {});

  // Expose on window for debugging & automated testing
  (window as any).dwarfKiiApp = {
    controller,
    soundEngine,
    kiiLedger,
    gamepadInput
  };

  // Initial render
  updateModeButtons(controller.mode);
  const initialMap = getMapById(controller.currentMapId) || getAllMaps()[0];
  updateMapInfo(initialMap);
  updateLedgerPill(kiiLedger.getSnapshot());
}

// Auto-start when DOM is ready
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
  } else {
    initApp();
  }
}
