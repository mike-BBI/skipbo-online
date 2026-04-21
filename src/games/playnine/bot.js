// Play Nine CPU. Returns a small list of actions (usually 1–2) that
// the scheduler applies sequentially. Follow-up actions like post-draw
// replace vs discard-and-flip rely on seeing the drawn card, so we
// return just the draw first and let the scheduler re-invoke cpuPlan
// on the resulting state for the follow-up. State is pure, so this
// introspects without side effects.
//
// v1 supports only "normal" difficulty. easy/hard stubs route to it
// for now — the app's CPU-difficulty dropdowns can stay wired for a
// later pass that adds proper strategy bands.

import {
  COLUMNS, GRID_SIZE, HOLE_IN_ONE, faceDownCount,
} from './engine.js';

// A card is "low" (worth keeping) if its face value is ≤ 3. H1O
// (-5) is always worth keeping.
function isLowKeeper(v) { return v === HOLE_IN_ONE || v <= 3; }

// Would drawing/placing this value complete a column match against an
// already-revealed face-up card? Returns the slot to replace, or -1.
function matchCompletionSlot(p, val) {
  for (const [top, bot] of COLUMNS) {
    // If top is face-up with same value, placing val at bot matches
    // (unless bot is already face-up matching — already matched).
    if (p.flipped[top] && p.grid[top] === val && (!p.flipped[bot] || p.grid[bot] !== val)) {
      return bot;
    }
    if (p.flipped[bot] && p.grid[bot] === val && (!p.flipped[top] || p.grid[top] !== val)) {
      return top;
    }
  }
  return -1;
}

function shouldTakeDiscard(state, cpuId) {
  const p = state.players[cpuId];
  const top = state.discard[state.discard.length - 1];
  if (top === undefined) return false;
  // Always grab a very low card or a Hole-in-One.
  if (top === HOLE_IN_ONE || top <= 3) return true;
  // Grab if it completes a column match.
  if (matchCompletionSlot(p, top) !== -1) return true;
  // Grab if it's at least 3 lower than the highest face-up card we
  // could replace — helps when we'd otherwise waste a blind deck draw.
  let highestFaceUp = -Infinity;
  for (let i = 0; i < GRID_SIZE; i += 1) {
    if (p.flipped[i] && p.grid[i] > highestFaceUp) highestFaceUp = p.grid[i];
  }
  if (highestFaceUp - top >= 3) return true;
  return false;
}

function choosePostDrawAction(state, cpuId) {
  const p = state.players[cpuId];
  const drawn = p.drawn;
  const fromDeck = p.drawnSource === 'deck';

  // 1. Complete a column match if we can.
  const matchSlot = matchCompletionSlot(p, drawn);
  if (matchSlot !== -1) return { type: 'replace', slot: matchSlot };

  // 2. Replace the highest face-up card if the drawn is strictly lower.
  let worstSlot = -1;
  let worstVal = drawn;
  for (let i = 0; i < GRID_SIZE; i += 1) {
    if (p.flipped[i] && p.grid[i] > worstVal) {
      worstVal = p.grid[i];
      worstSlot = i;
    }
  }
  if (worstSlot !== -1) return { type: 'replace', slot: worstSlot };

  // 3. Drawn card is genuinely high (≥ 8) and came from the deck —
  //    better to discard it and flip a face-down than put it in the
  //    grid. Prefer flipping the slot in a column where the opposing
  //    card is face-down too (more room for a future match) over one
  //    whose opposite slot is already face-up with a high value.
  if (fromDeck && drawn >= 8) {
    const fdIdx = pickFaceDownForFlip(p);
    if (fdIdx !== -1) return { type: 'discardAndFlip', slot: fdIdx };
  }

  // 4. Replace a face-down slot (swap in the drawn, reveal old card
  //    to discard). This loses info but advances us toward putting out
  //    and the drawn is presumably moderate.
  const fdIdx = pickFaceDownForFlip(p);
  if (fdIdx !== -1) return { type: 'replace', slot: fdIdx };

  // 5. Fallback: no face-downs left. Replace the highest face-up slot
  //    regardless of whether drawn is an improvement (required: the
  //    turn must end with either a replace or discardAndFlip, and
  //    discardAndFlip needs a face-down to flip).
  let slot = 0;
  let maxVal = p.grid[0];
  for (let i = 1; i < GRID_SIZE; i += 1) {
    if (p.grid[i] > maxVal) { maxVal = p.grid[i]; slot = i; }
  }
  return { type: 'replace', slot };
}

function pickFaceDownForFlip(p) {
  // Prefer slots whose column partner is face-up with a value we
  // might NOT be able to match later — flipping a fresh column
  // preserves match potential elsewhere. If no such slot, any
  // face-down works.
  const faceDownIndices = [];
  for (let i = 0; i < GRID_SIZE; i += 1) if (!p.flipped[i]) faceDownIndices.push(i);
  if (faceDownIndices.length === 0) return -1;

  // Prefer face-down slots whose column partner is also face-down
  // (reveals fresh info without committing a column direction).
  for (const idx of faceDownIndices) {
    const partner = idx < 4 ? idx + 4 : idx - 4;
    if (!p.flipped[partner]) return idx;
  }
  // Otherwise just pick a random face-down.
  return faceDownIndices[Math.floor(Math.random() * faceDownIndices.length)];
}

function shouldSkip(state, cpuId) {
  if (state.puttingOutBy) return false;
  const p = state.players[cpuId];
  if (faceDownCount(p) !== 1) return false;
  // Skip rarely — only when the top of the discard isn't useful AND
  // no opponent is close to putting out (give us time to fish for a
  // better swap). Opponent with ≤1 face-down likely ends the hole
  // soon, so we shouldn't waste turns.
  for (const id of state.playerOrder) {
    if (id === cpuId) continue;
    const fd = faceDownCount(state.players[id]);
    if (fd <= 1) return false;
  }
  const discardTop = state.discard[state.discard.length - 1];
  if (discardTop !== undefined && isLowKeeper(discardTop)) return false;
  // Light randomness so the bot doesn't always skip — the "perfect
  // final putt" idea is a gamble, not a guaranteed win.
  return Math.random() < 0.35;
}

function pickTeeOffFlips(p, count) {
  const candidates = [];
  for (let i = 0; i < GRID_SIZE; i += 1) if (!p.flipped[i]) candidates.push(i);
  const actions = [];
  for (let n = 0; n < count; n += 1) {
    if (candidates.length === 0) break;
    const r = Math.floor(Math.random() * candidates.length);
    const slot = candidates.splice(r, 1)[0];
    actions.push({ type: 'teeOffFlip', slot });
  }
  return actions;
}

export function cpuPlan(state, cpuId /* , difficulty = 'normal' */) {
  const p = state.players[cpuId];
  if (!p || state.winner || state.holeEnded) return [];

  if (state.phase === 'teeOff') {
    const done = state.teeOffFlips?.[cpuId] || 0;
    const remaining = 2 - done;
    if (remaining <= 0) return [];
    return pickTeeOffFlips(p, remaining);
  }

  if (state.phase !== 'play') return [];
  if (state.turn !== cpuId) return [];

  // Already holding a drawn card — the scheduler came back to us for
  // the follow-up action.
  if (p.drawn !== null) return [choosePostDrawAction(state, cpuId)];

  // Pre-draw. Skip is rare but available when only one face-down
  // remains and the stars align.
  if (shouldSkip(state, cpuId)) return [{ type: 'skip' }];
  if (shouldTakeDiscard(state, cpuId)) return [{ type: 'drawDiscard' }];
  return [{ type: 'drawDeck' }];
}
