// Play Nine CPU plans, three difficulty bands.
//
// All bands return one action at a time. When a draw+follow-up spans
// two actions (drawDeck + replace, drawDeck + discardAndFlip), the
// scheduler re-invokes cpuPlan after applying the first action so the
// follow-up gets to see the drawn card. Tee-off returns up to the 2
// remaining flips at once since they all belong to the same player.
//
//   easy   — random slot picks, takes any low-ish discard, never skips.
//   normal — completes column matches when possible, swaps high
//            face-ups for lower draws, discards-and-flips when the
//            draw is ≥ 8. Occasional skip.
//   hard   — normal + actively seeks 2+ matching pairs of the same
//            value for the -10/-15/-20 bonuses, guards H1O / zero,
//            takes discards more aggressively when they enable a
//            bonus, and skips more willingly when scoring looks good.

import {
  COLUMNS, GRID_SIZE, HOLE_IN_ONE, faceDownCount,
} from './engine.js';

const HIGH_CARD_THRESHOLD_NORMAL = 8;
const HIGH_CARD_THRESHOLD_HARD = 7;
// Values a beginner-bot treats as "always grab from discard".
const EASY_KEEPER = 3;
const NORMAL_KEEPER = 3;
const HARD_KEEPER = 4;

function matchCompletionSlot(p, val) {
  for (const [top, bot] of COLUMNS) {
    if (p.flipped[top] && p.grid[top] === val && (!p.flipped[bot] || p.grid[bot] !== val)) return bot;
    if (p.flipped[bot] && p.grid[bot] === val && (!p.flipped[top] || p.grid[top] !== val)) return top;
  }
  return -1;
}

// Count of already-matched pairs of the given value in our grid (both
// slots revealed + same value + same column).
function existingPairs(p, val) {
  let n = 0;
  for (const [top, bot] of COLUMNS) {
    if (p.flipped[top] && p.flipped[bot] && p.grid[top] === val && p.grid[bot] === val) n += 1;
  }
  return n;
}

// Highest face-up value in our grid (or -Infinity if all face-down).
function maxFaceUp(p) {
  let m = -Infinity;
  for (let i = 0; i < GRID_SIZE; i += 1) {
    if (p.flipped[i] && p.grid[i] > m) m = p.grid[i];
  }
  return m;
}

function pickFaceDownForFlip(p) {
  const faceDown = [];
  for (let i = 0; i < GRID_SIZE; i += 1) if (!p.flipped[i]) faceDown.push(i);
  if (faceDown.length === 0) return -1;
  // Prefer slots whose column partner is also face-down.
  for (const idx of faceDown) {
    const partner = idx < 4 ? idx + 4 : idx - 4;
    if (!p.flipped[partner]) return idx;
  }
  return faceDown[Math.floor(Math.random() * faceDown.length)];
}

function pickTeeOffFlips(p, count, diagonal = false) {
  const faceDown = [];
  for (let i = 0; i < GRID_SIZE; i += 1) if (!p.flipped[i]) faceDown.push(i);
  const actions = [];
  // Hard bot prefers revealing diagonal corners (slots in different
  // columns + different rows) to see the most independent info.
  if (diagonal && faceDown.length >= 2) {
    const first = faceDown[Math.floor(Math.random() * faceDown.length)];
    const firstCol = first % 4;
    const firstRow = first < 4 ? 0 : 1;
    const secondCandidates = faceDown.filter((i) => (i % 4) !== firstCol && (i < 4 ? 0 : 1) !== firstRow);
    const second = secondCandidates.length
      ? secondCandidates[Math.floor(Math.random() * secondCandidates.length)]
      : faceDown.find((i) => i !== first);
    if (count >= 1) actions.push({ type: 'teeOffFlip', slot: first });
    if (count >= 2 && second !== undefined) actions.push({ type: 'teeOffFlip', slot: second });
    return actions;
  }
  const pool = [...faceDown];
  for (let n = 0; n < count; n += 1) {
    if (pool.length === 0) break;
    const r = Math.floor(Math.random() * pool.length);
    const slot = pool.splice(r, 1)[0];
    actions.push({ type: 'teeOffFlip', slot });
  }
  return actions;
}

// ─────────────────────────── Easy ───────────────────────────

function easyShouldTakeDiscard(state) {
  const top = state.discard[state.discard.length - 1];
  if (top === undefined) return false;
  if (top === HOLE_IN_ONE) return true;
  return top <= EASY_KEEPER;
}

function easyPostDrawAction(state, cpuId) {
  const p = state.players[cpuId];
  const drawn = p.drawn;

  // Low or match-completing draws go into the grid sensibly even for
  // a beginner — you wouldn't throw away a Hole-in-One.
  if (drawn === HOLE_IN_ONE || drawn <= EASY_KEEPER) {
    const matchSlot = matchCompletionSlot(p, drawn);
    if (matchSlot !== -1) return { type: 'replace', slot: matchSlot };
    const fdIdx = pickFaceDownForFlip(p);
    if (fdIdx !== -1) return { type: 'replace', slot: fdIdx };
  }

  // High deck-draws usually get tossed (discardAndFlip).
  if (p.drawnSource === 'deck' && drawn >= 9) {
    const fdIdx = pickFaceDownForFlip(p);
    if (fdIdx !== -1) return { type: 'discardAndFlip', slot: fdIdx };
  }

  // Otherwise a random replace — beginners don't always optimize.
  const fdIdx = pickFaceDownForFlip(p);
  if (fdIdx !== -1 && Math.random() < 0.7) return { type: 'replace', slot: fdIdx };
  const slot = Math.floor(Math.random() * GRID_SIZE);
  return { type: 'replace', slot };
}

function easyPlan(state, cpuId) {
  const p = state.players[cpuId];
  if (state.phase === 'teeOff') {
    const done = state.teeOffFlips?.[cpuId] || 0;
    return pickTeeOffFlips(p, 2 - done, false);
  }
  if (p.drawn !== null) return [easyPostDrawAction(state, cpuId)];
  if (easyShouldTakeDiscard(state)) return [{ type: 'drawDiscard' }];
  return [{ type: 'drawDeck' }];
}

// ─────────────────────────── Normal ───────────────────────────

function normalShouldTakeDiscard(state, cpuId) {
  const p = state.players[cpuId];
  const top = state.discard[state.discard.length - 1];
  if (top === undefined) return false;
  if (top === HOLE_IN_ONE || top <= NORMAL_KEEPER) return true;
  if (matchCompletionSlot(p, top) !== -1) return true;
  const hi = maxFaceUp(p);
  if (Number.isFinite(hi) && hi - top >= 3) return true;
  return false;
}

function normalPostDrawAction(state, cpuId) {
  const p = state.players[cpuId];
  const drawn = p.drawn;

  const matchSlot = matchCompletionSlot(p, drawn);
  if (matchSlot !== -1) return { type: 'replace', slot: matchSlot };

  let worstSlot = -1;
  let worstVal = drawn;
  for (let i = 0; i < GRID_SIZE; i += 1) {
    if (p.flipped[i] && p.grid[i] > worstVal) {
      worstVal = p.grid[i];
      worstSlot = i;
    }
  }
  if (worstSlot !== -1) return { type: 'replace', slot: worstSlot };

  if (p.drawnSource === 'deck' && drawn >= HIGH_CARD_THRESHOLD_NORMAL) {
    const fdIdx = pickFaceDownForFlip(p);
    if (fdIdx !== -1) return { type: 'discardAndFlip', slot: fdIdx };
  }

  const fdIdx = pickFaceDownForFlip(p);
  if (fdIdx !== -1) return { type: 'replace', slot: fdIdx };

  // No face-downs remain — swap the highest face-up regardless.
  let slot = 0;
  let maxVal = p.grid[0];
  for (let i = 1; i < GRID_SIZE; i += 1) {
    if (p.grid[i] > maxVal) { maxVal = p.grid[i]; slot = i; }
  }
  return { type: 'replace', slot };
}

function normalShouldSkip(state, cpuId) {
  if (state.puttingOutBy) return false;
  const p = state.players[cpuId];
  if (faceDownCount(p) !== 1) return false;
  for (const id of state.playerOrder) {
    if (id === cpuId) continue;
    if (faceDownCount(state.players[id]) <= 1) return false;
  }
  const top = state.discard[state.discard.length - 1];
  if (top !== undefined && (top === HOLE_IN_ONE || top <= NORMAL_KEEPER)) return false;
  return Math.random() < 0.35;
}

function normalPlan(state, cpuId) {
  const p = state.players[cpuId];
  if (state.phase === 'teeOff') {
    const done = state.teeOffFlips?.[cpuId] || 0;
    return pickTeeOffFlips(p, 2 - done, false);
  }
  if (p.drawn !== null) return [normalPostDrawAction(state, cpuId)];
  if (normalShouldSkip(state, cpuId)) return [{ type: 'skip' }];
  if (normalShouldTakeDiscard(state, cpuId)) return [{ type: 'drawDiscard' }];
  return [{ type: 'drawDeck' }];
}

// ─────────────────────────── Hard ───────────────────────────
//
// The killer numbers in Play Nine are the multi-pair bonuses: two
// matching pairs of the same value is -10 on top of the cancellation,
// three is -15, four is -20. Hard bot looks past the immediate
// exchange to see whether placing a card sets up (or finishes) one
// of those bigger bonuses.

// Potential bonus gained by placing `val` at `slot`. Takes the
// existing grid as given and asks: if I put this there (revealed),
// and all other face-down cards eventually turn up as their current
// underlying values, how many matching pairs of `val` would I have?
// This is optimistic but captures the value of building toward a
// multi-pair bonus on a value we already have a pair of.
function hardPlacementBonus(p, slot, val) {
  // Simulate the grid if slot were `val` and face-up.
  const grid = [...p.grid];
  grid[slot] = val;
  let pairs = 0;
  for (const [top, bot] of COLUMNS) {
    if (grid[top] === val && grid[bot] === val) pairs += 1;
  }
  if (pairs === 0) return 0;
  // Estimated bonus (ignoring face-value of matched cells since
  // non-H1O matched pairs cancel to 0 anyway).
  if (val === HOLE_IN_ONE) {
    return pairs >= 2 ? 10 : 0;
  }
  if (pairs === 2) return 10;
  if (pairs === 3) return 15;
  if (pairs === 4) return 20;
  return 0;
}

// Estimated net score improvement from placing `val` at `slot` vs.
// leaving the slot alone. Higher is better (we're minimizing score).
function hardPlacementGain(p, slot, val) {
  const existing = p.grid[slot];
  const existingRevealed = p.flipped[slot];
  // If the slot is face-down, treat the existing card as having the
  // deck's rough average (~6) — we don't actually know what it is.
  const existingScore = existingRevealed ? existing : 6;
  const bonus = hardPlacementBonus(p, slot, val);
  // Negative "val" for H1O is already score-reducing.
  return existingScore - val + bonus;
}

function hardShouldTakeDiscard(state, cpuId) {
  const p = state.players[cpuId];
  const top = state.discard[state.discard.length - 1];
  if (top === undefined) return false;
  if (top === HOLE_IN_ONE || top <= HARD_KEEPER) return true;
  // Would this card enable a bonus somewhere?
  for (let i = 0; i < GRID_SIZE; i += 1) {
    if (hardPlacementBonus(p, i, top) > 0) return true;
  }
  // Big swap win?
  const hi = maxFaceUp(p);
  if (Number.isFinite(hi) && hi - top >= 3) return true;
  return false;
}

function hardPostDrawAction(state, cpuId) {
  const p = state.players[cpuId];
  const drawn = p.drawn;

  // Rank every slot by estimated gain from replacing with `drawn`.
  // Best positive gain wins. If nothing is positive and we can toss
  // (deck-sourced draw + face-down available), toss instead.
  let bestSlot = -1;
  let bestGain = 0;
  for (let i = 0; i < GRID_SIZE; i += 1) {
    const g = hardPlacementGain(p, i, drawn);
    if (g > bestGain) { bestGain = g; bestSlot = i; }
  }
  if (bestSlot !== -1) return { type: 'replace', slot: bestSlot };

  // No positive placement: if the draw is high-ish and came from the
  // deck, toss + flip to make progress.
  if (p.drawnSource === 'deck' && drawn >= HIGH_CARD_THRESHOLD_HARD) {
    const fdIdx = pickFaceDownForFlip(p);
    if (fdIdx !== -1) return { type: 'discardAndFlip', slot: fdIdx };
  }

  // Forced to place — pick the least-bad slot (minimize net score
  // change). When all gains are ≤ 0, pick the one closest to 0.
  let slot = -1;
  let best = -Infinity;
  for (let i = 0; i < GRID_SIZE; i += 1) {
    const g = hardPlacementGain(p, i, drawn);
    if (g > best) { best = g; slot = i; }
  }
  if (slot === -1) slot = 0;
  return { type: 'replace', slot };
}

function hardShouldSkip(state, cpuId) {
  if (state.puttingOutBy) return false;
  const p = state.players[cpuId];
  if (faceDownCount(p) !== 1) return false;
  // If our revealed score is clearly low, skip to let the hole
  // settle in our favor — someone else triggers the final lap, then
  // our one face-down is flipped as a free reveal at scoring time.
  let revealedSum = 0;
  let revealed = 0;
  for (let i = 0; i < GRID_SIZE; i += 1) {
    if (p.flipped[i]) { revealedSum += p.grid[i]; revealed += 1; }
  }
  // With 7 revealed, average ≤ 4 is a solid position — skip eagerly.
  if (revealed >= 7 && revealedSum / Math.max(1, revealed) <= 4) return Math.random() < 0.75;
  // Otherwise be modest about skipping.
  for (const id of state.playerOrder) {
    if (id === cpuId) continue;
    if (faceDownCount(state.players[id]) <= 1) return false;
  }
  return Math.random() < 0.25;
}

function hardPlan(state, cpuId) {
  const p = state.players[cpuId];
  if (state.phase === 'teeOff') {
    const done = state.teeOffFlips?.[cpuId] || 0;
    return pickTeeOffFlips(p, 2 - done, true);
  }
  if (p.drawn !== null) return [hardPostDrawAction(state, cpuId)];
  if (hardShouldSkip(state, cpuId)) return [{ type: 'skip' }];
  if (hardShouldTakeDiscard(state, cpuId)) return [{ type: 'drawDiscard' }];
  return [{ type: 'drawDeck' }];
}

// ─────────────────────────── Entry ───────────────────────────

export function cpuPlan(state, cpuId, difficulty = 'normal') {
  const p = state.players[cpuId];
  if (!p || state.winner || state.holeEnded) return [];
  if (state.phase !== 'teeOff' && state.turn !== cpuId) return [];

  if (difficulty === 'easy') return easyPlan(state, cpuId);
  if (difficulty === 'hard') return hardPlan(state, cpuId);
  return normalPlan(state, cpuId);
}
