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
//     * 10 of diamonds = 2 points
//     * 2 of clubs     = 1 point
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
  // First to this cumulative score wins. Evaluated at the end of
  // each round. 101 is the common "short game" target; 151 is a
  // longer match.
  targetScore: 101,
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

export function createGame(playerIds, names = {}, rulesIn = {}) {
  if (playerIds.length < MIN_PLAYERS) throw new Error(`Bastra needs at least ${MIN_PLAYERS} players`);
  if (playerIds.length > MAX_PLAYERS) throw new Error(`Bastra supports at most ${MAX_PLAYERS} players`);

  const rules = { ...DEFAULT_RULES, ...rulesIn };
  const deck = shuffle(buildDeck());

  // Spec quirk: if the first table card is a Jack the round can start
  // stacked in the dealer's favor. Re-seed by putting the jack back
  // and drawing again until the top table card isn't one.
  while (deck[0] && deck[0].rank === RANK_JACK) {
    const jack = deck.shift();
    deck.push(jack);
  }

  const table = deck.splice(0, rules.tableInitSize);

  const players = {};
  for (const id of playerIds) {
    players[id] = {
      id,
      name: names[id] || id,
      hand: deck.splice(0, rules.cardsPerHand),
      captures: [],
      bastraCount: 0,
      score: 0,
      // Persists across rounds; added to at each round's end.
      cumulativeScore: 0,
    };
  }

  return {
    rules,
    startedAt: Date.now(),
    turnNumber: 1,
    seed: Math.floor(Math.random() * 0x7fffffff),
    players,
    playerOrder: [...playerIds],
    turn: playerIds[0],
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
  while (deck[0] && deck[0].rank === RANK_JACK) {
    const jack = deck.shift();
    deck.push(jack);
  }
  state.table = deck.splice(0, state.rules.tableInitSize);
  state.lastCapturer = null;

  for (const id of state.playerOrder) {
    const p = state.players[id];
    p.hand = deck.splice(0, state.rules.cardsPerHand);
    p.captures = [];
    p.bastraCount = 0;
    p.score = 0;
  }
  state.deck = deck;

  // Rotate the opening seat so advantage moves around the table.
  const turnIdx = state.playerOrder.indexOf(state.turn);
  state.turn = state.playerOrder[(turnIdx + 1) % state.playerOrder.length];
  state.turnNumber = 1;
  state.log.push(`Round ${state.round} begins.`);
}

function applyCapture(next, playerId, card) {
  const p = next.players[playerId];
  let captured = null;
  let bastra = false;

  if (card.rank === RANK_JACK) {
    if (next.table.length > 0) {
      captured = [card, ...next.table];
      // Playing a J on a non-empty table always captures everything.
      // By Bastra convention it only counts as a Bastra if there was
      // more than just a single matching card — but a J always clears
      // the table, so we treat any non-empty-table J as a Bastra.
      bastra = true;
      next.table = [];
    } else {
      next.table.push(card);
    }
  } else {
    const matches = [];
    const remaining = [];
    for (const t of next.table) {
      if (t.rank === card.rank) matches.push(t);
      else remaining.push(t);
    }
    if (matches.length > 0) {
      captured = [card, ...matches];
      next.table = remaining;
      if (remaining.length === 0) bastra = true;
    } else {
      next.table.push(card);
    }
  }

  if (captured) {
    p.captures.push(...captured);
    next.lastCapturer = playerId;
    if (bastra) p.bastraCount += 1;
    next.log.push(
      `${p.name} played ${cardLabel(card)} → captured ${captured.length - 1} card${captured.length - 1 === 1 ? '' : 's'}${bastra ? ' (Bastra!)' : ''}.`,
    );
  } else {
    next.log.push(`${p.name} played ${cardLabel(card)} to the table.`);
  }
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
      if (c.rank === 10 && c.suit === 'D') score += 2;
      if (c.rank === 2 && c.suit === 'C') score += 1;
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

  // Target reached? End the match. Otherwise the UI will prompt for
  // another round via the 'nextRound' action.
  let leader = next.playerOrder[0];
  for (const id of next.playerOrder) {
    if (next.players[id].cumulativeScore > next.players[leader].cumulativeScore) leader = id;
  }
  const target = next.rules.targetScore ?? 101;
  if (next.players[leader].cumulativeScore >= target) {
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
  const card = p.hand.splice(action.handIndex, 1)[0];
  applyCapture(next, playerId, card);

  const turnIdx = next.playerOrder.indexOf(playerId);
  next.turn = next.playerOrder[(turnIdx + 1) % next.playerOrder.length];
  next.turnNumber = (next.turnNumber || 1) + 1;

  maybeRefillHands(next);
  endRoundIfDone(next);

  next.version += 1;
  return { ok: true, state: next };
}
