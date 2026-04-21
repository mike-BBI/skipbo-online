// Play Nine — pure engine, no network / rendering / randomness beyond
// shuffle. Rules summarized from the official Play Nine single-page
// instructions (https://playnine.com).
//
// Deck: 108 cards.
//   - 8 each of face values 0..12 (104 cards)
//   - 4 Hole-in-One cards at -5
//
// Setup: each player gets a 2×4 grid of face-down cards (8 total).
// Flip top deck card to start the discard. Every player "tees off" by
// flipping any two of their face-down cards before play starts.
//
// Turn: draw from deck or discard, then either
//   (a) replace any grid slot with the drawn card (replaced → discard), or
//   (b) [deck only] discard the drawn card and flip any face-down card.
// When exactly one face-down remains, the player may also "skip" —
// draw, discard, and leave the last face-down as is.
//
// Putting out: when a player reveals/replaces their 8th face-down
// card (all 8 face-up), play ends for them. Each other player takes
// exactly one more turn, then the hole is scored.
//
// Scoring: face-down cards are flipped before scoring. Columns where
// top and bottom match cancel to 0 (except Hole-in-One, which keeps
// its -5 face value). Bonus strokes off the total when multiple
// matching pairs share the same value:
//   1 pair (2 cards):          0 strokes, no bonus
//   2 pairs of same value:     0 strokes, -10 bonus
//   3 pairs of same value:     0 strokes, -15 bonus
//   4 pairs of same value:     0 strokes, -20 bonus
// Hole-in-One exception: matching H1O pairs do NOT cancel — each card
// still scores -5. Two matching pairs of H1O (all four cards in two
// matching columns) get a -10 bonus on top (total -30 for those 4).
//
// Match: nine holes (default). Lowest cumulative score wins. Dealer
// rotates left each hole; first player is the seat to dealer's left.

export const HOLE_IN_ONE = -5;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;
export const GRID_SIZE = 8;
export const COLS = 4;
export const ROWS = 2;

// Column pairs: each is [topIndex, bottomIndex].
export const COLUMNS = [[0, 4], [1, 5], [2, 6], [3, 7]];

export const DEFAULT_RULES = {
  targetHoles: 9,
};

export function buildDeck() {
  const deck = [];
  for (let v = 0; v <= 12; v += 1) {
    for (let i = 0; i < 8; i += 1) deck.push(v);
  }
  for (let i = 0; i < 4; i += 1) deck.push(HOLE_IN_ONE);
  return deck;
}

export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function cardLabel(card) {
  if (card === HOLE_IN_ONE) return 'H1O';
  return String(card);
}

// Count face-down slots for a player.
export function faceDownCount(player) {
  let n = 0;
  for (let i = 0; i < GRID_SIZE; i += 1) if (!player.flipped[i]) n += 1;
  return n;
}

// Score a grid assuming all cards have been revealed. Returns an
// integer (can be negative — H1O and bonuses drive that).
export function scoreGrid(grid) {
  // Match pairs by value across each of the 4 columns.
  const pairsByValue = new Map();
  const matchedIdx = new Set();
  for (const [top, bot] of COLUMNS) {
    if (grid[top] === grid[bot]) {
      pairsByValue.set(grid[top], (pairsByValue.get(grid[top]) || 0) + 1);
      matchedIdx.add(top);
      matchedIdx.add(bot);
    }
  }

  let score = 0;
  // Unmatched cards: straight face value.
  for (let i = 0; i < GRID_SIZE; i += 1) {
    if (!matchedIdx.has(i)) score += grid[i];
  }
  // Matched cards + bonuses per value.
  for (const [val, pairCount] of pairsByValue.entries()) {
    if (val === HOLE_IN_ONE) {
      // H1O never cancels — each card still scores -5.
      score += val * 2 * pairCount;
      // Two matching pairs of H1O = all four H1O cards → extra -10.
      if (pairCount >= 2) score += -10;
    } else {
      // Regular values: matching pairs cancel to 0.
      if (pairCount === 2) score += -10;
      else if (pairCount === 3) score += -15;
      else if (pairCount === 4) score += -20;
      // pairCount === 1: cancel to 0, no bonus.
    }
  }
  return score;
}

// Compute a per-card scoring breakdown for UI display. Returns an
// array of length GRID_SIZE where each entry is
//   { value, matched, cancelled }.
// `matched` = the card is part of a matching column pair;
// `cancelled` = the card contributes 0 to the score (regular matched).
// Plus a `bonuses` array describing each bonus applied.
export function scoreBreakdown(grid) {
  const pairsByValue = new Map();
  const matchedIdx = new Set();
  for (const [top, bot] of COLUMNS) {
    if (grid[top] === grid[bot]) {
      pairsByValue.set(grid[top], (pairsByValue.get(grid[top]) || 0) + 1);
      matchedIdx.add(top);
      matchedIdx.add(bot);
    }
  }
  const cancelledIdx = new Set();
  const bonuses = [];
  for (const [val, pairCount] of pairsByValue.entries()) {
    if (val === HOLE_IN_ONE) {
      // H1O face value still counts; just note the bonus.
      if (pairCount >= 2) bonuses.push({ label: 'Four Hole-in-One', pts: -10 });
    } else {
      // All matched cards of this value cancel.
      for (const [top, bot] of COLUMNS) {
        if (grid[top] === val && grid[bot] === val) {
          cancelledIdx.add(top);
          cancelledIdx.add(bot);
        }
      }
      if (pairCount === 2) bonuses.push({ label: `Matching ${val}s ×2`, pts: -10 });
      else if (pairCount === 3) bonuses.push({ label: `Matching ${val}s ×3`, pts: -15 });
      else if (pairCount === 4) bonuses.push({ label: `Matching ${val}s ×4`, pts: -20 });
    }
  }
  const cards = [];
  for (let i = 0; i < GRID_SIZE; i += 1) {
    cards.push({
      value: grid[i],
      matched: matchedIdx.has(i),
      cancelled: cancelledIdx.has(i),
    });
  }
  return { cards, bonuses, total: scoreGrid(grid) };
}

// ────────────────────────── State lifecycle ──────────────────────────

function newPlayer(id, name, grid) {
  return {
    id,
    name,
    grid,
    flipped: Array(GRID_SIZE).fill(false),
    drawn: null,          // null | card (the value in hand waiting to be played)
    drawnSource: null,    // null | 'deck' | 'discard'
    puttedOut: false,
    roundScores: [],      // per-hole score history
    score: 0,             // just-finished hole's score (once tallied)
    cumulativeScore: 0,
  };
}

function dealHole(state) {
  const deck = shuffle(buildDeck());
  for (const id of state.playerOrder) {
    const p = state.players[id];
    p.grid = deck.splice(0, GRID_SIZE);
    p.flipped = Array(GRID_SIZE).fill(false);
    p.drawn = null;
    p.drawnSource = null;
    p.puttedOut = false;
    p.score = 0;
  }
  state.discard = [deck.shift()];
  state.deck = deck;
  state.phase = 'teeOff';
  state.teeOffFlips = Object.fromEntries(state.playerOrder.map((id) => [id, 0]));
  state.puttingOutBy = null;
  state.finalLapRemaining = null;
  state.holeEnded = false;
  state.roundScores = null;
}

export function createGame(playerIds, names = {}, rulesIn = {}) {
  if (playerIds.length < MIN_PLAYERS) throw new Error(`Play Nine needs ≥${MIN_PLAYERS} players`);
  if (playerIds.length > MAX_PLAYERS) throw new Error(`Play Nine supports ≤${MAX_PLAYERS} players`);

  const rules = { ...DEFAULT_RULES, ...rulesIn };
  const players = {};
  for (const id of playerIds) {
    players[id] = newPlayer(id, names[id] || id, []);
  }
  const state = {
    rules,
    startedAt: Date.now(),
    turnNumber: 1,
    seed: Math.floor(Math.random() * 0x7fffffff),
    players,
    playerOrder: [...playerIds],
    hole: 1,
    dealer: playerIds[0],
    firstPlayer: playerIds[1 % playerIds.length],
    turn: playerIds[0],   // tee-off order starts at seat 0; real play starts with firstPlayer
    log: [`Hole 1 — ${playerIds.length} players tee off.`],
    winner: null,
    version: 0,
  };
  dealHole(state);
  // Tee-off order: seats rotate starting from the first player so the
  // player about to lead is the last to flip. Simpler: start tee-off
  // from seat 0 in playerOrder; nobody's at disadvantage since all
  // flip 2 before play starts.
  state.turn = state.playerOrder[0];
  return state;
}

function startNextHole(state) {
  state.hole = (state.hole || 1) + 1;
  // Rotate dealer one seat to the left; first player = dealer's left.
  const dealerIdx = state.playerOrder.indexOf(state.dealer);
  const newDealerIdx = (dealerIdx + 1) % state.playerOrder.length;
  state.dealer = state.playerOrder[newDealerIdx];
  state.firstPlayer = state.playerOrder[(newDealerIdx + 1) % state.playerOrder.length];
  dealHole(state);
  state.turn = state.playerOrder[0];  // tee-off starts seat 0
  state.turnNumber = (state.turnNumber || 1) + 1;
  state.log.push(`Hole ${state.hole} begins.`);
}

function endHole(state) {
  // Turn every face-down card face-up for scoring.
  for (const id of state.playerOrder) {
    const p = state.players[id];
    p.flipped = Array(GRID_SIZE).fill(true);
    p.score = scoreGrid(p.grid);
    p.cumulativeScore = (p.cumulativeScore || 0) + p.score;
    p.roundScores.push(p.score);
  }
  state.holeEnded = true;
  state.roundScores = Object.fromEntries(
    state.playerOrder.map((id) => [id, state.players[id].score]),
  );
  state.log.push(`Hole ${state.hole} scored.`);

  const target = state.rules.targetHoles ?? DEFAULT_RULES.targetHoles;
  if ((state.hole || 1) >= target) {
    // Lowest cumulative wins. Tie → sudden-death is out of scope for
    // v1; pick the first by seat so we have a deterministic winner.
    let winner = state.playerOrder[0];
    for (const id of state.playerOrder) {
      if (state.players[id].cumulativeScore < state.players[winner].cumulativeScore) winner = id;
    }
    state.winner = winner;
    state.log.push(`🏆 ${state.players[winner].name} wins the match at ${state.players[winner].cumulativeScore} strokes.`);
  }
}

// ────────────────────────── Action dispatch ──────────────────────────

function expectSlot(slot, current) {
  if (typeof slot !== 'number' || slot < 0 || slot >= GRID_SIZE) {
    return 'Bad slot.';
  }
  return null;
}

function applyTeeOffFlip(state, playerId, action) {
  if (state.phase !== 'teeOff') return { ok: false, error: 'Not in tee-off.' };
  const p = state.players[playerId];
  const err = expectSlot(action.slot, p);
  if (err) return { ok: false, error: err };
  if (p.flipped[action.slot]) return { ok: false, error: 'Already face-up.' };
  if ((state.teeOffFlips[playerId] || 0) >= 2) return { ok: false, error: 'Already flipped two for tee-off.' };

  p.flipped[action.slot] = true;
  state.teeOffFlips[playerId] = (state.teeOffFlips[playerId] || 0) + 1;

  if (state.teeOffFlips[playerId] >= 2) {
    const everyoneDone = state.playerOrder.every((id) => (state.teeOffFlips[id] || 0) >= 2);
    if (everyoneDone) {
      state.phase = 'play';
      state.turn = state.firstPlayer;
      state.log.push('All players teed off. Play begins.');
    } else {
      const idx = state.playerOrder.indexOf(playerId);
      state.turn = state.playerOrder[(idx + 1) % state.playerOrder.length];
    }
  }
  return { ok: true };
}

function applyDrawDeck(state, playerId) {
  if (state.phase !== 'play') return { ok: false, error: 'Not in play phase.' };
  const p = state.players[playerId];
  if (p.drawn !== null) return { ok: false, error: 'Already drew a card this turn.' };
  if (state.deck.length === 0) {
    // Reshuffle all but the top discard when the deck empties. Keeps
    // the same card-conservation logic the physical game uses.
    if (state.discard.length <= 1) return { ok: false, error: 'No cards left to draw.' };
    const top = state.discard[state.discard.length - 1];
    const rest = state.discard.slice(0, -1);
    state.deck = shuffle(rest);
    state.discard = [top];
    state.log.push('Reshuffled discard into the draw pile.');
  }
  p.drawn = state.deck.shift();
  p.drawnSource = 'deck';
  return { ok: true };
}

function applyDrawDiscard(state, playerId) {
  if (state.phase !== 'play') return { ok: false, error: 'Not in play phase.' };
  const p = state.players[playerId];
  if (p.drawn !== null) return { ok: false, error: 'Already drew a card this turn.' };
  if (state.discard.length === 0) return { ok: false, error: 'Discard pile is empty.' };
  p.drawn = state.discard.pop();
  p.drawnSource = 'discard';
  return { ok: true };
}

function applyReplace(state, playerId, action) {
  if (state.phase !== 'play') return { ok: false, error: 'Not in play phase.' };
  const p = state.players[playerId];
  if (p.drawn === null) return { ok: false, error: 'Draw a card first.' };
  const err = expectSlot(action.slot, p);
  if (err) return { ok: false, error: err };

  const replaced = p.grid[action.slot];
  p.grid[action.slot] = p.drawn;
  p.flipped[action.slot] = true;
  state.discard.push(replaced);
  p.drawn = null;
  p.drawnSource = null;
  return { ok: true };
}

function applyDiscardAndFlip(state, playerId, action) {
  if (state.phase !== 'play') return { ok: false, error: 'Not in play phase.' };
  const p = state.players[playerId];
  if (p.drawn === null) return { ok: false, error: 'Draw a card first.' };
  if (p.drawnSource !== 'deck') return { ok: false, error: 'Can only discard-and-flip a card drawn from the deck.' };
  const err = expectSlot(action.slot, p);
  if (err) return { ok: false, error: err };
  if (p.flipped[action.slot]) return { ok: false, error: 'That card is already face-up.' };

  state.discard.push(p.drawn);
  p.drawn = null;
  p.drawnSource = null;
  p.flipped[action.slot] = true;
  return { ok: true };
}

function applySkip(state, playerId) {
  // Only legal when exactly one face-down card remains.
  if (state.phase !== 'play') return { ok: false, error: 'Not in play phase.' };
  const p = state.players[playerId];
  if (p.drawn !== null) return { ok: false, error: 'Cannot skip after drawing — play or discard the drawn card.' };
  if (faceDownCount(p) !== 1) return { ok: false, error: 'Skip is only allowed when one face-down card remains.' };
  if (state.deck.length === 0) return { ok: false, error: 'No cards left to draw for skip.' };
  // Conceptually: draw, then discard without flipping anything.
  const drawn = state.deck.shift();
  state.discard.push(drawn);
  state.log.push(`${p.name} skipped.`);
  return { ok: true };
}

function advanceTurn(state, playerId) {
  const p = state.players[playerId];
  // If this action revealed their last face-down, they're putting out.
  if (!state.puttingOutBy && faceDownCount(p) === 0) {
    state.puttingOutBy = playerId;
    p.puttedOut = true;
    const idx = state.playerOrder.indexOf(playerId);
    const others = [];
    for (let i = 1; i < state.playerOrder.length; i += 1) {
      others.push(state.playerOrder[(idx + i) % state.playerOrder.length]);
    }
    state.finalLapRemaining = others;
    state.log.push(`${p.name} is putting out — last shot for everyone else!`);
  }
  if (state.finalLapRemaining !== null) {
    if (state.finalLapRemaining.length === 0) {
      endHole(state);
      return;
    }
    state.turn = state.finalLapRemaining[0];
    state.finalLapRemaining = state.finalLapRemaining.slice(1);
  } else {
    const idx = state.playerOrder.indexOf(state.turn);
    state.turn = state.playerOrder[(idx + 1) % state.playerOrder.length];
  }
  state.turnNumber = (state.turnNumber || 1) + 1;
}

// Actions that END a player's turn (as opposed to just advancing a
// sub-step within the turn like drawDeck).
const TURN_ENDING_ACTIONS = new Set(['replace', 'discardAndFlip', 'skip']);

export function applyAction(state, playerId, action) {
  if (state.winner) return { ok: false, error: 'Match is over.', state };
  if (!action) return { ok: false, error: 'No action.', state };

  // Undo restores the snapshot taken before the most recent action,
  // limited to the same player who took that action. Snapshot is
  // cleared after undo (no chained undos) and whenever the next
  // turn-ending event happens.
  if (action.type === 'undo') {
    const snap = state.undoSnapshot;
    if (!snap) return { ok: false, error: 'Nothing to undo.', state };
    if (snap.actor !== playerId) return { ok: false, error: 'You can only undo your own last action.', state };
    const next = structuredClone(snap.state);
    next.undoSnapshot = null;
    next.version = (state.version || 0) + 1;
    return { ok: true, state: next };
  }

  if (action.type === 'nextHole') {
    if (!state.holeEnded) return { ok: false, error: 'Hole still in progress.', state };
    if (state.winner) return { ok: false, error: 'Match is over.', state };
    const next = structuredClone(state);
    startNextHole(next);
    next.undoSnapshot = null;
    next.version = (next.version || 0) + 1;
    return { ok: true, state: next };
  }

  if (state.holeEnded) return { ok: false, error: 'Hole is over — advance to the next one.', state };
  if (playerId !== state.turn) return { ok: false, error: "Not your turn.", state };

  // Snapshot pre-action state so the player can undo their own move.
  // Strip the previous snapshot first so structuredClone doesn't nest
  // snapshots indefinitely over the course of a hole.
  const pre = structuredClone({ ...state, undoSnapshot: null });

  const next = structuredClone(state);
  let res;
  switch (action.type) {
    case 'teeOffFlip': res = applyTeeOffFlip(next, playerId, action); break;
    case 'drawDeck': res = applyDrawDeck(next, playerId); break;
    case 'drawDiscard': res = applyDrawDiscard(next, playerId); break;
    case 'replace': res = applyReplace(next, playerId, action); break;
    case 'discardAndFlip': res = applyDiscardAndFlip(next, playerId, action); break;
    case 'skip': res = applySkip(next, playerId); break;
    default: return { ok: false, error: `Unknown action '${action.type}'.`, state };
  }
  if (!res.ok) return { ok: false, error: res.error, state };

  next.undoSnapshot = { state: pre, actor: playerId };

  if (action.type === 'teeOffFlip') {
    next.version = (next.version || 0) + 1;
    return { ok: true, state: next };
  }

  if (TURN_ENDING_ACTIONS.has(action.type)) {
    advanceTurn(next, playerId);
    // If the turn-ending action put the hole to bed, the snapshot
    // references a pre-ended-hole state; clear it so we don't offer
    // to undo into a re-scorable position.
    if (next.holeEnded) next.undoSnapshot = null;
  }
  next.version = (next.version || 0) + 1;
  return { ok: true, state: next };
}
