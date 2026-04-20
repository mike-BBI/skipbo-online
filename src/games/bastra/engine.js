// Bastra (Greek card game) — pure engine. No network, no rendering,
// no randomness other than shuffle seeds. See
// https://en.wikipedia.org/wiki/Bastra for the rules this implements.
//
// Rules supported (MVP — one round, no teams):
// - Standard 52-card deck.
// - Deal 4 cards face-down to each player, 4 face-up to the table.
// - On your turn, play a card from hand:
//     * A Jack (rank 11) captures every table card.
//     * Any other card captures all table cards of the same rank.
//     * If nothing is captured, the card joins the table.
// - Clearing the table with a capture = "Bastra" (+10 points).
// - When all hands are empty, deal 4 more to each (no new table).
// - When deck + hands are exhausted, the last player to capture
//   sweeps any remaining table cards, then the round scores:
//     * 10 of diamonds = 3 points ("Good 10")
//     * 2 of clubs     = 2 points ("Good 2")
//     * Each Ace       = 1 point
//     * Each Jack      = 1 point
//     * Most captured cards = 3 points
//     * Each Bastra    = 10 points

export const SUITS = ['S', 'H', 'D', 'C']; // spades, hearts, diamonds, clubs
export const RANK_ACE = 1;
export const RANK_JACK = 11;
export const RANK_QUEEN = 12;
export const RANK_KING = 13;

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;

export const DEFAULT_RULES = {
  cardsPerHand: 4,
  tableInitSize: 4,
  bastraPoints: 10,
  mostCardsPoints: 3,
  // Match-length mode. 'target' ends when a player's cumulative
  // score reaches `targetScore`; 'rounds' ends after `targetRounds`
  // rounds have been played and the highest cumulative score wins.
  mode: 'target',
  targetScore: 100,
  targetRounds: 3,
};

export function buildDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (let rank = 1; rank <= 13; rank++) deck.push({ rank, suit });
  }
  return deck;
}

export function shuffle(deck) {
  const a = [...deck];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const RANK_LABELS = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' };
const SUIT_SYMBOLS = { S: '♠', H: '♥', D: '♦', C: '♣' };
export function cardLabel(card) {
  if (!card) return '';
  return `${RANK_LABELS[card.rank] || card.rank}${SUIT_SYMBOLS[card.suit] || card.suit}`;
}

// Deal the initial table, guaranteeing no Jacks end up face-up.
// Any Jack that would be dealt gets reinserted at a random spot in
// the deck and a fresh card is drawn until every table card is a
// non-Jack. Mutates `deck` in place and returns the table array.
function dealJacklessTable(deck, size) {
  const table = deck.splice(0, size);
  for (let i = 0; i < table.length; i++) {
    while (table[i] && table[i].rank === RANK_JACK) {
      const insertAt = Math.floor(Math.random() * (deck.length + 1));
      deck.splice(insertAt, 0, table[i]);
      table[i] = deck.shift();
    }
  }
  return table;
}

export function createGame(playerIds, names = {}, rulesIn = {}) {
  if (playerIds.length < MIN_PLAYERS) throw new Error(`Bastra needs at least ${MIN_PLAYERS} players`);
  if (playerIds.length > MAX_PLAYERS) throw new Error(`Bastra supports at most ${MAX_PLAYERS} players`);

  const rules = { ...DEFAULT_RULES, ...rulesIn };
  const deck = shuffle(buildDeck());
  const table = dealJacklessTable(deck, rules.tableInitSize);

  const players = {};
  for (const id of playerIds) {
    players[id] = {
      id,
      name: names[id] || id,
      hand: deck.splice(0, rules.cardsPerHand),
      captures: [],
      bastraCount: 0,
      // The card that was played to trigger each Bastra this round.
      // Used by the UI to show face-up "landmark" cards inside the
      // capture stack.
      bastraPlayedCards: [],
      score: 0,
      // Persists across rounds; added to at each round's end.
      cumulativeScore: 0,
    };
  }

  const starterId = playerIds[Math.floor(Math.random() * playerIds.length)];

  return {
    rules,
    startedAt: Date.now(),
    turnNumber: 1,
    seed: Math.floor(Math.random() * 0x7fffffff),
    players,
    playerOrder: [...playerIds],
    turn: starterId,
    // Starter is locked for the whole match — each new round begins
    // with this same seat, so the random first-to-act advantage only
    // lands once per match.
    firstPlayer: starterId,
    deck,
    table,
    lastCapturer: null,
    round: 1,
    roundScores: null,      // per-player round scores, set when a round ends
    log: [`Round 1 started with ${playerIds.length} players.`],
    winner: null,
    roundEnded: false,
    version: 0,
  };
}

// Reset the engine state for a fresh round after scores were tallied.
// Cumulative scores, player identities, and log are preserved.
function startNextRound(state) {
  state.round = (state.round || 1) + 1;
  state.roundEnded = false;
  state.roundScores = null;

  let deck = shuffle(buildDeck());
  state.table = dealJacklessTable(deck, state.rules.tableInitSize);
  state.lastCapturer = null;

  for (const id of state.playerOrder) {
    const p = state.players[id];
    p.hand = deck.splice(0, state.rules.cardsPerHand);
    p.captures = [];
    p.bastraCount = 0;
    p.bastraPlayedCards = [];
    p.score = 0;
  }
  state.deck = deck;

  // Same seat leads every round within a match — the starter was
  // chosen randomly at createGame and stays fixed until the match
  // ends. Fall back to seat 0 if an older save is missing the field.
  state.turn = state.firstPlayer || state.playerOrder[0];
  state.turnNumber = 1;
  state.log.push(`Round ${state.round} begins.`);
}

// Can the selected ranks be partitioned so each group either sums to
// the played rank, or (for face cards / Aces) is a same-rank group?
// Face cards (J/Q/K) and Aces can only rank-match — the Bastra
// convention doesn't let 11 / 12 / 13 / 1 participate in numeric sums.
// Jacks have a separate special rule (capture-all) handled elsewhere.
function canPartitionToTarget(ranks, target) {
  if (ranks.length === 0) return true;
  const n = ranks.length;
  for (let mask = 1; mask < (1 << n); mask++) {
    let sum = 0;
    for (let i = 0; i < n; i++) if (mask & (1 << i)) sum += ranks[i];
    if (sum !== target) continue;
    const rest = [];
    for (let i = 0; i < n; i++) if (!(mask & (1 << i))) rest.push(ranks[i]);
    if (canPartitionToTarget(rest, target)) return true;
  }
  return false;
}

export function isValidCapture(playedRank, selectedRanks) {
  if (selectedRanks.length === 0) return true;
  if (playedRank === RANK_ACE || playedRank === RANK_QUEEN || playedRank === RANK_KING) {
    return selectedRanks.every((r) => r === playedRank);
  }
  // Numbered cards (2-10) — sum-and-group partitioning.
  return canPartitionToTarget(selectedRanks, playedRank);
}

// Best (largest) valid capture for the given played card. Returns an
// array of table indices. Empty = no capture possible. Used by the
// bot and by the UI to hint "you can take N cards with this".
export function findBestCapture(playedCard, table) {
  if (!table.length) return [];
  if (playedCard.rank === RANK_JACK) {
    return table.map((_, i) => i);
  }
  if (playedCard.rank === RANK_ACE || playedCard.rank === RANK_QUEEN || playedCard.rank === RANK_KING) {
    const out = [];
    for (let i = 0; i < table.length; i++) if (table[i].rank === playedCard.rank) out.push(i);
    return out;
  }
  const n = table.length;
  let best = [];
  for (let mask = 1; mask < (1 << n); mask++) {
    const indices = [];
    const ranks = [];
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) { indices.push(i); ranks.push(table[i].rank); }
    }
    if (indices.length <= best.length) continue;
    if (isValidCapture(playedCard.rank, ranks)) best = indices;
  }
  return best;
}

function applyCapture(next, playerId, card, tableIndices) {
  const p = next.players[playerId];

  // Jack always sweeps the entire table, ignoring any selection.
  // A Jack sweep is NOT a Bastra — the Bastra bonus only applies when
  // a regular capture happens to clear the table, not when the Jack's
  // special "capture-all" rule does it.
  if (card.rank === RANK_JACK) {
    if (next.table.length === 0) {
      // House rule: a Jack played onto an empty table goes straight
      // to the player's capture pile (rather than sitting on the
      // table as a lone Jack waiting to be captured). Keeps Jacks
      // strictly positive-value for the player who holds them.
      p.captures.push(card);
      next.lastCapturer = playerId;
      next.log.push(`${p.name} played ${cardLabel(card)} — nothing to sweep, captured solo.`);
      next.lastMove = {
        playerId, card, capturedCards: [], capturedPositions: [], bastra: false, placed: false,
      };
      return { ok: true };
    }
    const swept = next.table.slice();
    const sweptPositions = swept.map((_, i) => i);
    p.captures.push(card, ...swept);
    next.lastCapturer = playerId;
    next.table = [];
    next.log.push(`${p.name} played ${cardLabel(card)} → captured ${swept.length}.`);
    next.lastMove = {
      playerId, card, capturedCards: swept, capturedPositions: sweptPositions, bastra: false, placed: false,
    };
    return { ok: true };
  }

  const selected = [];
  const selectedSet = new Set(tableIndices);
  for (const idx of tableIndices) {
    const t = next.table[idx];
    if (!t) return { ok: false, error: 'Selection points at a card that is not on the table.' };
    selected.push(t);
  }

  if (selected.length === 0) {
    const placedIndex = next.table.length;
    next.table.push(card);
    next.log.push(`${p.name} played ${cardLabel(card)} to the table.`);
    next.lastMove = {
      playerId, card, capturedCards: [], capturedPositions: [], bastra: false, placed: true, placedIndex,
    };
    return { ok: true };
  }

  if (!isValidCapture(card.rank, selected.map((c) => c.rank))) {
    return { ok: false, error: `Those cards don't form a valid capture for ${cardLabel(card)}.` };
  }

  const remaining = [];
  for (let i = 0; i < next.table.length; i++) {
    if (!selectedSet.has(i)) remaining.push(next.table[i]);
  }
  const bastra = remaining.length === 0;
  p.captures.push(card, ...selected);
  next.lastCapturer = playerId;
  if (bastra) {
    p.bastraCount += 1;
    p.bastraPlayedCards = [...(p.bastraPlayedCards || []), card];
  }
  next.table = remaining;
  next.log.push(
    `${p.name} played ${cardLabel(card)} → captured ${selected.length} card${selected.length === 1 ? '' : 's'}${bastra ? ' (Bastra!)' : ''}.`,
  );
  next.lastMove = {
    playerId, card, capturedCards: selected, capturedPositions: [...tableIndices], bastra, placed: false,
  };
  return { ok: true };
}

function maybeRefillHands(next) {
  const allEmpty = next.playerOrder.every((id) => next.players[id].hand.length === 0);
  if (!allEmpty) return;
  if (next.deck.length === 0) return; // nothing left to deal
  for (const id of next.playerOrder) {
    for (let i = 0; i < next.rules.cardsPerHand && next.deck.length > 0; i++) {
      next.players[id].hand.push(next.deck.shift());
    }
  }
  next.log.push('Fresh hands dealt.');
}

function scoreRound(state) {
  let mostCardsId = null;
  let mostCards = -1;
  for (const id of state.playerOrder) {
    const n = state.players[id].captures.length;
    if (n > mostCards) { mostCards = n; mostCardsId = id; }
  }
  const tied = state.playerOrder.filter((id) => state.players[id].captures.length === mostCards).length > 1;

  for (const id of state.playerOrder) {
    const p = state.players[id];
    let score = (p.bastraCount || 0) * state.rules.bastraPoints;
    for (const c of p.captures) {
      if (c.rank === RANK_ACE) score += 1;
      if (c.rank === RANK_JACK) score += 1;
      if (c.rank === 10 && c.suit === 'D') score += 3;
      if (c.rank === 2 && c.suit === 'C') score += 2;
    }
    if (!tied && id === mostCardsId && mostCards > 0) score += state.rules.mostCardsPoints;
    p.score = score;
  }
}

function endRoundIfDone(next) {
  const allEmpty = next.playerOrder.every((id) => next.players[id].hand.length === 0);
  if (!allEmpty || next.deck.length > 0) return;

  // Sweep any leftover table cards to the last capturer.
  if (next.table.length > 0 && next.lastCapturer) {
    const sweeper = next.players[next.lastCapturer];
    sweeper.captures.push(...next.table);
    next.log.push(`${sweeper.name} sweeps ${next.table.length} leftover table cards.`);
    next.table = [];
  }
  scoreRound(next);

  // Accumulate into the running totals and snapshot this round's
  // scores so the UI can show a round summary.
  const roundScores = {};
  for (const id of next.playerOrder) {
    const p = next.players[id];
    roundScores[id] = p.score;
    p.cumulativeScore = (p.cumulativeScore || 0) + p.score;
  }
  next.roundScores = roundScores;
  next.roundEnded = true;

  // Check match-end condition based on configured mode.
  let leader = next.playerOrder[0];
  for (const id of next.playerOrder) {
    if (next.players[id].cumulativeScore > next.players[leader].cumulativeScore) leader = id;
  }
  const mode = next.rules.mode || 'target';
  let matchOver = false;
  if (mode === 'rounds') {
    const targetRounds = next.rules.targetRounds ?? 3;
    if ((next.round || 1) >= targetRounds) matchOver = true;
  } else {
    const target = next.rules.targetScore ?? 100;
    if (next.players[leader].cumulativeScore >= target) matchOver = true;
  }
  if (matchOver) {
    next.winner = leader;
    next.log.push(`🎉 ${next.players[leader].name} wins the match at ${next.players[leader].cumulativeScore} points!`);
  } else {
    next.log.push(`Round ${next.round} complete.`);
  }
}

export function applyAction(state, playerId, action) {
  if (state.winner) return { ok: false, error: 'Match is over', state };
  if (!action) return { ok: false, error: 'No action', state };

  // Starting a new round bypasses the turn check — any seat can
  // advance the match once scoring has been displayed.
  if (action.type === 'nextRound') {
    if (!state.roundEnded) return { ok: false, error: 'Round still in progress', state };
    const next = structuredClone(state);
    startNextRound(next);
    next.version += 1;
    return { ok: true, state: next };
  }

  if (state.roundEnded) return { ok: false, error: 'Round is over — start the next one first', state };
  if (playerId !== state.turn) return { ok: false, error: "Not your turn", state };
  if (action.type !== 'play') return { ok: false, error: 'Unknown action', state };

  const next = structuredClone(state);
  const p = next.players[playerId];
  if (action.handIndex < 0 || action.handIndex >= p.hand.length) {
    return { ok: false, error: 'Bad card index', state };
  }
  const card = p.hand[action.handIndex];
  const tableIndices = Array.isArray(action.tableIndices) ? action.tableIndices : [];
  const res = applyCapture(next, playerId, card, tableIndices);
  if (!res.ok) return { ok: false, error: res.error, state };
  // Only remove the hand card after we've successfully committed it
  // (so a rejected capture doesn't leave the hand mutated).
  p.hand.splice(action.handIndex, 1);

  const turnIdx = next.playerOrder.indexOf(playerId);
  next.turn = next.playerOrder[(turnIdx + 1) % next.playerOrder.length];
  next.turnNumber = (next.turnNumber || 1) + 1;

  maybeRefillHands(next);
  endRoundIfDone(next);

  next.version += 1;
  if (import.meta.env?.DEV) debugAssertNoDuplicates(next);
  return { ok: true, state: next };
}

// Catch any bug that duplicates a card. Runs in dev only.
function debugAssertNoDuplicates(state) {
  const seen = new Map();
  const dups = [];
  const check = (card, where) => {
    if (!card || typeof card !== 'object') return;
    const k = `${card.rank}-${card.suit}`;
    if (seen.has(k)) {
      dups.push({ key: k, previously: seen.get(k), nowAlsoIn: where });
    } else {
      seen.set(k, where);
    }
  };
  for (let i = 0; i < (state.table || []).length; i++) check(state.table[i], `table[${i}]`);
  for (let i = 0; i < (state.deck || []).length; i++) check(state.deck[i], `deck[${i}]`);
  for (const id of state.playerOrder || []) {
    const p = state.players[id];
    for (let i = 0; i < (p.hand || []).length; i++) check(p.hand[i], `${id}.hand[${i}]`);
    for (let i = 0; i < (p.captures || []).length; i++) check(p.captures[i], `${id}.captures[${i}]`);
  }
  if (dups.length > 0) {
    // eslint-disable-next-line no-console
    console.error('[Bastra] DUPLICATE CARDS DETECTED', {
      dups,
      lastMove: state.lastMove,
      lastLog: state.log?.slice(-5),
    });
  }
}
