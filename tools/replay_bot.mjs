// A test bot that plays through the same methods as the real input paths.
function mulberry(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Bot: aims at the node most of the time, moves and jumps at random, handles cash-out offers. */
export function playBot(game, { seconds, botSeed, cashOut = true }) {
  const c = game.app.controller;
  const rand = mulberry(botSeed);
  const seen = { lobs: 0, stages: new Set([c.stage]), bosses: new Set(), hits: 0, birds: 0, deflects: 0, cashOuts: 0 };
  if (c.boss) seen.bosses.add(c.boss.def.kind);
  const endTick = c.simTick + seconds * 60;
  let wall = 0;
  while (c.simTick < endTick && wall < seconds * 6000) {
    const ms = 4 + rand() * 40; // uneven frames, from fast displays to slow machines
    wall += ms;
    game.frame(ms);
    if (c.cashOutOfferOpen) {
      if (cashOut) { c.acceptCashOut(); seen.cashOuts += 1; } else c.declineCashOut();
    }
    if (c.boss) seen.bosses.add(c.boss.def.kind);
    seen.stages.add(c.stage);
    seen.birds = Math.max(seen.birds, c.arenaBirds.length);
    if (c.boss) seen.deflects = Math.max(seen.deflects, c.boss.deflections);
    const roll = rand();
    if (roll < 0.05) c.stepDwarf(rand() < 0.5 ? -1 : 1);
    else if (roll < 0.09) c.arenaJump();
    else if (roll < 0.5) {
      const shot = bestShot(c, rand);
      if (shot) c.setAim(shot.angle, shot.power);
      c.lobPickaxe();
      seen.lobs += 1;
    }
  }
  seen.hits = c.directHits + c.crushHits;
  return seen;
}

export function bestShot(c, rand) {
  const origin = c.getLaunchOrigin();
  const level = c.getArenaLevel();
  const target = c.boss
    ? { x: c.boss.x, y: c.boss.y - c.boss.def.height / 2 }
    : (level.miningNode || level.node);
  if (!target) return { angle: 15 + Math.floor(rand() * 66), power: 25 + Math.floor(rand() * 76) };
  const dx = target.x - origin.x;
  const dy = target.y - origin.y;
  const start = 20 + Math.floor(rand() * 50);
  for (let k = 0; k < 66; k++) {
    const angle = 15 + ((start - 15 + k) % 66);
    const rad = (angle * Math.PI) / 180;
    const denom = 2 * Math.cos(rad) ** 2 * (dy + dx * Math.tan(rad));
    if (denom <= 0) continue;
    const speed = Math.sqrt((980 * dx * dx) / denom);
    const v = c.getLaunchVelocity(angle, 100, true);
    const full = Math.hypot(v.vx, v.vy);
    const empty = Math.hypot(...Object.values(c.getLaunchVelocity(angle, 25, true)));
    const power = 25 + ((speed - empty) / (full - empty)) * 75;
    if (power >= 25 && power <= 100) return { angle, power };
  }
  return { angle: 45, power: 80 };
}

