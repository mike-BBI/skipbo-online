// Simple greedy Skip-Bo CPU.
// Strategy:
//   1. Play stock-top whenever possible (winning = empty stock).
//   2. Play from discard tops to free them up.
//   3. Play hand cards; save Skip-Bo wilds for last unless they unblock stock.
//   4. Loop until no legal play, then discard the highest non-wild hand card,
//      preferring a discard pile that already has that value on top.

import { canPlayToBuild, applyAction, SKIPBO } from './engine.js';

function findPlayablePile(card, buildPiles) {
  for (let i = 0; i < buildPiles.length; i++) {
    if (canPlayToBuild(card, buildPiles[i])) return i;
  }
  return -1;
}

// Would playing `card` from `from` be useful (i.e. not a waste of a wild)?
// Wilds are only "useful" here if they (a) clear stock, or (b) extend a build
// pile that the next stock value can use, or (c) come from stock/discard
// themselves.
function wildIsWorthIt(state, cpuId, from) {
  if (from === 'stock' || from === 'discard') return true;
  const p = state.players[cpuId];
  const stockTop = p.stock[p.stock.length - 1];
  if (stockTop === undefined) return true;
  // Any build pile whose next+1 value is the stock top? Then playing the wild
  // as "next" sets up stock for next turn (or even this turn after redraw).
  for (const bp of state.buildPiles) {
    const next = bp.length + 1;
    if (next > 12) continue;
    if (stockTop === SKIPBO || stockTop === next + 1) return true;
    // If hand holds a (next+1) card too, playing the wild chains a play.
    if (p.hand.includes(next + 1)) return true;
  }
  return false;
}

function chooseDiscard(state, cpuId) {
  const p = state.players[cpuId];
  // Possible when the deck and completed piles are both exhausted and
  // drawHand had nothing left to deal. Caller should skip the discard
  // so we don't crash trying to read a card from an empty hand.
  if (p.hand.length === 0) return null;
  // Pick hand card: prefer highest non-wild, keep wilds.
  const sorted = p.hand.map((c, i) => ({ c, i })).sort((a, b) => {
    const av = a.c === SKIPBO ? -1 : a.c;
    const bv = b.c === SKIPBO ? -1 : b.c;
    return bv - av;
  });
  const pick = sorted[0];
  // Pick discard pile: match top value, else empty, else shortest.
  const piles = p.discards;
  for (let di = 0; di < piles.length; di++) {
    if (piles[di].length > 0 && piles[di][piles[di].length - 1] === pick.c) {
      return { handIndex: pick.i, discardPile: di };
    }
  }
  for (let di = 0; di < piles.length; di++) {
    if (piles[di].length === 0) return { handIndex: pick.i, discardPile: di };
  }
  let shortest = 0;
  for (let di = 1; di < piles.length; di++) {
    if (piles[di].length < piles[shortest].length) shortest = di;
  }
  return { handIndex: pick.i, discardPile: shortest };
}

// Returns an array of actions the bot wants to perform (for animation).
export function cpuPlan(state, cpuId) {
  const actions = [];
  let s = state;
  let safety = 200;
  while (safety-- > 0 && s.turn === cpuId && !s.winner) {
    const p = s.players[cpuId];
    let played = false;

    // 1. Stock
    if (p.stock.length > 0) {
      const top = p.stock[p.stock.length - 1];
      const bp = findPlayablePile(top, s.buildPiles);
      if (bp >= 0) {
        const act = { type: 'play', from: 'stock', buildPile: bp };
        const res = applyAction(s, cpuId, act);
        if (res.ok) { actions.push(act); s = res.state; played = true; continue; }
      }
    }

    // 2. Discard tops
    for (let di = 0; di < p.discards.length; di++) {
      const pile = p.discards[di];
      const top = pile[pile.length - 1];
      if (top === undefined) continue;
      const bp = findPlayablePile(top, s.buildPiles);
      if (bp >= 0) {
        const act = { type: 'play', from: 'discard', index: di, buildPile: bp };
        const res = applyAction(s, cpuId, act);
        if (res.ok) { actions.push(act); s = res.state; played = true; break; }
      }
    }
    if (played) continue;

    // 3. Hand — non-wild first
    const order = p.hand
      .map((c, i) => ({ c, i }))
      .sort((a, b) => {
        if (a.c === SKIPBO && b.c !== SKIPBO) return 1;
        if (b.c === SKIPBO && a.c !== SKIPBO) return -1;
        return a.c - b.c; // try small values first (they usually match sooner)
      });
    for (const { c, i } of order) {
      const bp = findPlayablePile(c, s.buildPiles);
      if (bp < 0) continue;
      if (c === SKIPBO && !wildIsWorthIt(s, cpuId, 'hand')) continue;
      const act = { type: 'play', from: 'hand', index: i, buildPile: bp };
      const res = applyAction(s, cpuId, act);
      if (res.ok) { actions.push(act); s = res.state; played = true; break; }
    }
    if (played) continue;

    break;
  }

  if (!s.winner && s.turn === cpuId) {
    const pick = chooseDiscard(s, cpuId);
    if (pick) actions.push({ type: 'discard', handIndex: pick.handIndex, discardPile: pick.discardPile });
  }
  return actions;
}
